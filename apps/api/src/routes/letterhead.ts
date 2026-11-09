import { Readable } from 'node:stream'
import type { Tx } from '@opc/db'
import { defaultLetterhead, formatIban, type LetterheadValues } from '@opc/domain'
import { type LetterheadLayout, type LetterheadSettings, letterheadRequest } from '@opc/schemas'
import { TooLargeError } from '@opc/storage'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { inTenant, requireAuth, requirePermission, type Services, servicesOf } from '../context.js'
import { HttpError, notFound, parse } from '../http.js'

const LOGO_MAX_BYTES = 2 * 1024 * 1024

/** Values of the letterhead placeholders from Einstellungen › Firma (IBAN decrypted). */
export async function companyValues(tx: Tx): Promise<LetterheadValues> {
  const [t] = await tx<
    {
      name: string
      street: string | null
      postalCode: string | null
      city: string | null
      phone: string | null
      email: string | null
      website: string | null
      vatId: string | null
      taxNumber: string | null
      registerCourt: string | null
      registerNumber: string | null
      managerName: string | null
      bankName: string | null
      ibanEnc: Buffer | null
      bic: string | null
    }[]
  >`
    select name, street, postal_code as "postalCode", city, phone, email, website, vat_id as "vatId",
           tax_number as "taxNumber", register_court as "registerCourt", register_number as "registerNumber",
           manager_name as "managerName", bank_name as "bankName", iban_enc as "ibanEnc", bic
    from tenant where id = current_tenant_id()`
  if (!t) return {}
  const cipher = servicesOf(tx)?.cipher
  const iban = t.ibanEnc && cipher ? cipher.decrypt(t.ibanEnc) : null
  return {
    Firma: t.name,
    Straße: t.street,
    PLZ: t.postalCode,
    Ort: t.city,
    Telefon: t.phone,
    'E-Mail': t.email,
    Web: t.website,
    'USt-IdNr': t.vatId,
    Steuernummer: t.taxNumber,
    Registergericht: t.registerCourt,
    Registernummer: t.registerNumber,
    Geschäftsführung: t.managerName,
    Bank: t.bankName,
    IBAN: iban ? formatIban(iban) : null,
    BIC: t.bic,
  }
}

export async function loadLetterhead(tx: Tx): Promise<LetterheadLayout> {
  const [row] = await tx<{ layout: LetterheadLayout }[]>`select layout from letterhead`
  return row?.layout ?? defaultLetterhead()
}

/** Image type by content (magic numbers); SVG is not accepted (scripts). */
function imageType(head: Buffer): 'image/png' | 'image/jpeg' | 'image/webp' | null {
  if (head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png'
  }
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg'
  if (head.toString('latin1', 0, 4) === 'RIFF' && head.toString('latin1', 8, 12) === 'WEBP') {
    return 'image/webp'
  }
  return null
}

const assetParam = z.object({ id: z.uuid('Ungültige ID.') })

export function registerLetterheadRoutes(app: FastifyInstance, services: Services) {
  app.get('/api/v1/settings/letterhead', async (request): Promise<LetterheadSettings> => {
    const auth = requirePermission(request, 'settings.read')
    return inTenant(services, auth, async (tx) => ({
      layout: await loadLetterhead(tx),
      values: (await companyValues(tx)) as Record<string, string | null>,
    }))
  })

  app.put('/api/v1/settings/letterhead', async (request): Promise<LetterheadSettings> => {
    const auth = requirePermission(request, 'settings.write')
    const layout = parse(letterheadRequest, request.body)
    return inTenant(services, auth, async (tx) => {
      if (layout.logo) {
        const [asset] = await tx`select 1 from tenant_asset where id = ${layout.logo.assetId}`
        if (!asset) {
          throw new HttpError(400, 'Die Eingaben sind unvollständig oder ungültig.', {
            logo: 'Das Logo wurde nicht gefunden. Bitte erneut hochladen.',
          })
        }
      }
      await tx`
        insert into letterhead (tenant_id, layout, updated_by)
        values (current_tenant_id(), ${tx.json(layout as never)}, ${auth.userId})
        on conflict (tenant_id) do update set layout = excluded.layout, updated_by = excluded.updated_by`
      return {
        layout: await loadLetterhead(tx),
        values: (await companyValues(tx)) as Record<string, string | null>,
      }
    })
  })

  // Logo upload: raw bytes (application/octet-stream), PNG, JPEG or WebP, at most 2 MB.
  app.post('/api/v1/settings/letterhead/logo', async (request, reply) => {
    const auth = requirePermission(request, 'settings.write')
    const body = request.body
    if (!(body instanceof Readable)) {
      throw new HttpError(415, 'Bitte das Bild als application/octet-stream senden.')
    }
    const tooLarge = () => new HttpError(413, 'Das Logo ist zu groß (höchstens 2 MB).')
    if (Number(request.headers['content-length'] ?? 0) > LOGO_MAX_BYTES) {
      body.resume()
      throw tooLarge()
    }
    let pending: Awaited<ReturnType<typeof services.storage.receive>>
    try {
      pending = await services.storage.receive(body, { maxBytes: LOGO_MAX_BYTES })
    } catch (error) {
      body.resume()
      if (error instanceof TooLargeError) throw tooLarge()
      throw error
    }
    try {
      const mime = imageType(pending.head)
      if (!mime) {
        throw new HttpError(415, 'Als Logo sind PNG, JPEG oder WebP erlaubt.')
      }
      const upload = pending
      const asset = await inTenant(services, auth, async (tx) => {
        const [existing] = await tx<{ id: string }[]>`
          select id from tenant_asset where sha256 = ${upload.sha256}`
        if (existing) return existing
        const [ids] = await tx<{ id: string }[]>`select uuid_v7() as id`
        const assetId = (ids as { id: string }).id
        const key = `${auth.tenantId}/assets/${assetId}`
        await tx`
          insert into tenant_asset (id, tenant_id, kind, storage_key, sha256, mime_type, size_bytes, created_by)
          values (${assetId}, ${auth.tenantId}, 'logo', ${key}, ${upload.sha256}, ${mime},
                  ${upload.sizeBytes}, ${auth.userId})`
        await upload.commit(key)
        return { id: assetId }
      })
      return reply.status(201).send({ assetId: asset.id, url: `/api/v1/assets/${asset.id}` })
    } finally {
      await pending.discard()
    }
  })

  // Company assets (logo) for every member: used in documents and their print view.
  app.get('/api/v1/assets/:id', async (request, reply) => {
    const auth = requireAuth(request)
    const { id } = parse(assetParam, request.params)
    const asset = await inTenant(services, auth, async (tx) => {
      const [row] = await tx<{ key: string; mime: string; size: string }[]>`
        select storage_key as key, mime_type as mime, size_bytes::text as size
        from tenant_asset where id = ${id}`
      return row
    })
    if (!asset) throw notFound('Das Bild')
    return reply
      .header('content-type', asset.mime)
      .header('content-length', asset.size)
      .header('x-content-type-options', 'nosniff')
      .header('cache-control', 'private, max-age=31536000, immutable')
      .send(services.storage.read(asset.key))
  })
}
