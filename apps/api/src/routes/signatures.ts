import { Readable } from 'node:stream'
import type { Tx } from '@easybau/db'
import { type MySignature, saveMySignatureRequest, type UploadedSignature } from '@easybau/schemas'
import { TooLargeError } from '@easybau/storage'
import type { FastifyInstance } from 'fastify'
import { type AuthContext, inTenant, requireAuth, type Services } from '../context.js'
import { HttpError, parse } from '../http.js'

/** A drawn signature is a small PNG (canvas export); 512 KB is plenty even on high-DPI tablets. */
export const SIGNATURE_MAX_BYTES = 512 * 1024
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/**
 * A signature image may only be used by the user who drew it (own signature from the account or
 * the client's signature drawn on site in this user's session). Returns the asset id or null.
 */
export async function ownSignature(
  tx: Tx,
  auth: AuthContext,
  assetId: string | null | undefined,
  field: string,
): Promise<string | null> {
  if (!assetId) return null
  const [asset] = await tx`
    select 1 from tenant_asset
    where id = ${assetId} and kind = 'signature' and created_by = ${auth.userId}`
  if (!asset) {
    throw new HttpError(400, 'Die Eingaben sind unvollständig oder ungültig.', {
      [field]: 'Die Unterschrift wurde nicht gefunden. Bitte erneut zeichnen.',
    })
  }
  return assetId
}

async function loadMySignature(tx: Tx, auth: AuthContext): Promise<MySignature | null> {
  const [row] = await tx<{ assetId: string; updatedAt: string }[]>`
    select asset_id as "assetId", to_char(updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "updatedAt"
    from user_signature where user_id = ${auth.userId}`
  return row ? { ...row, url: `/api/v1/assets/${row.assetId}` } : null
}

export function registerSignatureRoutes(app: FastifyInstance, services: Services) {
  // Upload of a drawn signature: raw PNG bytes (application/octet-stream), owner = current user.
  app.post('/api/v1/signatures', async (request, reply) => {
    const auth = requireAuth(request)
    const body = request.body
    if (!(body instanceof Readable)) {
      throw new HttpError(415, 'Bitte die Unterschrift als application/octet-stream senden.')
    }
    const tooLarge = () => new HttpError(413, 'Die Unterschrift ist zu groß (höchstens 512 KB).')
    if (Number(request.headers['content-length'] ?? 0) > SIGNATURE_MAX_BYTES) {
      body.resume()
      throw tooLarge()
    }
    let pending: Awaited<ReturnType<typeof services.storage.receive>>
    try {
      pending = await services.storage.receive(body, { maxBytes: SIGNATURE_MAX_BYTES })
    } catch (error) {
      body.resume()
      if (error instanceof TooLargeError) throw tooLarge()
      throw error
    }
    try {
      if (!pending.head.subarray(0, 8).equals(PNG_MAGIC)) {
        throw new HttpError(415, 'Die Unterschrift muss ein PNG-Bild sein.')
      }
      const upload = pending
      const assetId = await inTenant(services, auth, async (tx) => {
        const [existing] = await tx<{ id: string; kind: string; createdBy: string | null }[]>`
          select id, kind, created_by as "createdBy" from tenant_asset where sha256 = ${upload.sha256}`
        if (existing) {
          if (existing.kind === 'signature' && existing.createdBy === auth.userId)
            return existing.id
          throw new HttpError(
            409,
            'Diese Unterschrift kann nicht verwendet werden. Bitte neu zeichnen.',
          )
        }
        const [ids] = await tx<{ id: string }[]>`select uuid_v7() as id`
        const id = (ids as { id: string }).id
        const key = `${auth.tenantId}/assets/${id}`
        await tx`
          insert into tenant_asset (id, tenant_id, kind, storage_key, sha256, mime_type, size_bytes, created_by)
          values (${id}, ${auth.tenantId}, 'signature', ${key}, ${upload.sha256}, 'image/png',
                  ${upload.sizeBytes}, ${auth.userId})`
        await upload.commit(key)
        return id
      })
      const result: UploadedSignature = { assetId, url: `/api/v1/assets/${assetId}` }
      return reply.status(201).send(result)
    } finally {
      await pending.discard()
    }
  })

  app.get('/api/v1/me/signature', async (request): Promise<{ signature: MySignature | null }> => {
    const auth = requireAuth(request)
    return inTenant(services, auth, async (tx) => ({ signature: await loadMySignature(tx, auth) }))
  })

  // Keep a drawn signature in the account; later documents of this user start with it.
  app.put('/api/v1/me/signature', async (request): Promise<{ signature: MySignature | null }> => {
    const auth = requireAuth(request)
    const { assetId } = parse(saveMySignatureRequest, request.body)
    return inTenant(services, auth, async (tx) => {
      await ownSignature(tx, auth, assetId, 'assetId')
      await tx`
        insert into user_signature (tenant_id, user_id, asset_id)
        values (${auth.tenantId}, ${auth.userId}, ${assetId})
        on conflict (tenant_id, user_id) do update set asset_id = excluded.asset_id`
      return { signature: await loadMySignature(tx, auth) }
    })
  })

  // Removes only the copy in the account; signed reports and sheets keep their image.
  app.delete('/api/v1/me/signature', async (request, reply) => {
    const auth = requireAuth(request)
    await inTenant(services, auth, async (tx) => {
      await tx`delete from user_signature where user_id = ${auth.userId}`
    })
    return reply.status(204).send()
  })
}
