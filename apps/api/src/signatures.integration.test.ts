import { randomUUID } from 'node:crypto'
import { withTenant } from '@opc/db'
import type { MeasurementSheetDetail, MySignature, ReportDetail } from '@opc/schemas'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client, createHarness, type Harness } from './testing/harness.js'

// Two different small PNGs (1 × 1 px), as the signature pad would export them.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
)
const PNG_CLIENT = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGPgEjkBAAESAOfqWC7cAAAAAElFTkSuQmCC',
  'base64',
)
const PNG_OTHER = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGM4wcUFAAJ6AN1nJ0J9AAAAAElFTkSuQmCC',
  'base64',
)

describe.skipIf(!process.env.DATABASE_URL)('Handschriftliche Unterschrift (integration)', () => {
  let h: Harness
  let admin: Client
  let worker: Client
  let outsider: Client
  let tenantId: string
  const otherTenantId = randomUUID()
  let projectId: string

  beforeAll(async () => {
    h = await createHarness({ requireAdminMfa: false })
    admin = new Client(h.app)
    const setup = await admin.post('/api/v1/setup', {
      setupToken: h.setupToken,
      company: { name: 'Signum Bau GmbH' },
      admin: {
        email: 'chef@example.test',
        password: 'ein-sehr-langes-passwort',
        displayName: 'Chef',
      },
    })
    tenantId = setup.json().tenant.id
    const invite = await admin.post('/api/v1/invitations', {
      email: 'monteur@example.test',
      roleKey: 'team_member',
    })
    worker = new Client(h.app)
    await worker.post('/api/v1/invitations/accept', {
      token: new URL(invite.json().acceptUrl).hash.slice(1),
      displayName: 'Monteur',
      password: 'monteur-passwort-1',
    })
    projectId = (await admin.post('/api/v1/projects', { name: 'Lindenweg' })).json().id
    outsider = new Client(h.app)
  })

  afterAll(async () => {
    await h?.close()
  })

  let mine: string

  it('uploads a drawn signature (PNG only) owned by the user who drew it', async () => {
    const res = await admin.upload('/api/v1/signatures', PNG)
    expect(res.statusCode, res.body).toBe(201)
    mine = res.json().assetId
    expect(res.json().url).toBe(`/api/v1/assets/${mine}`)
    expect((await admin.upload('/api/v1/signatures', PNG)).json().assetId).toBe(mine)
    // The same image drawn by someone else is not handed over.
    expect((await worker.upload('/api/v1/signatures', PNG)).statusCode).toBe(409)

    const jpeg = await admin.upload('/api/v1/signatures', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1]))
    expect(jpeg.statusCode).toBe(415)
    const huge = await admin.upload(
      '/api/v1/signatures',
      Buffer.concat([PNG, Buffer.alloc(600 * 1024)]),
    )
    expect(huge.statusCode).toBe(413)
    expect((await outsider.upload('/api/v1/signatures', PNG)).statusCode).toBe(401)

    const image = await admin.get(`/api/v1/assets/${mine}`)
    expect(image.headers['content-type']).toBe('image/png')
    // A signature is not a logo.
    expect((await admin.upload('/api/v1/settings/letterhead/logo', PNG)).statusCode).toBe(409)
  })

  it('keeps one signature in the account and only the own one', async () => {
    expect((await admin.get('/api/v1/me/signature')).json()).toEqual({ signature: null })
    const saved = await admin.put('/api/v1/me/signature', { assetId: mine })
    expect(saved.statusCode, saved.body).toBe(200)
    const signature = saved.json().signature as MySignature
    expect(signature).toMatchObject({ assetId: mine, url: `/api/v1/assets/${mine}` })
    expect(signature.updatedAt).toMatch(/Z$/)
    expect((await admin.get('/api/v1/me/signature')).json().signature.assetId).toBe(mine)

    const foreign = await worker.put('/api/v1/me/signature', { assetId: mine })
    expect(foreign.statusCode).toBe(400)
    expect(foreign.json().errors.assetId).toMatch(/nicht gefunden/)
    expect((await worker.get('/api/v1/me/signature')).json()).toEqual({ signature: null })

    // Row level security: another company sees neither the signature nor the image.
    const rows = await withTenant(
      h.sql,
      { tenantId: otherTenantId },
      (tx) => tx`select asset_id from user_signature union all select id from tenant_asset`,
    )
    expect(rows).toHaveLength(0)
    const own = await withTenant(h.sql, { tenantId }, (tx) => tx`select 1 from user_signature`)
    expect(own).toHaveLength(1)
  })

  it('signs a report with the handwritten signatures and puts them into the PDF', async () => {
    const report = (
      await admin.post(`/api/v1/projects/${projectId}/reports`, { reportDate: '2026-11-09' })
    ).json() as ReportDetail
    const client = (await admin.upload('/api/v1/signatures', PNG_CLIENT)).json().assetId
    const foreign = (await worker.upload('/api/v1/signatures', PNG_OTHER)).json().assetId

    const stolen = await admin.post(`/api/v1/reports/${report.id}/sign`, {
      signatures: [{ role: 'contractor', name: 'Chef', signatureAssetId: foreign }],
    })
    expect(stolen.statusCode).toBe(400)
    expect(stolen.json().errors['signatures.0.signatureAssetId']).toMatch(/nicht gefunden/)

    const plain = await admin.get(`/api/v1/reports/${report.id}/pdf`)
    const res = await admin.post(`/api/v1/reports/${report.id}/sign`, {
      signatures: [
        { role: 'contractor', name: 'Chef', signatureAssetId: mine },
        { role: 'client', name: 'Frau Berger', signatureAssetId: client },
      ],
    })
    expect(res.statusCode, res.body).toBe(200)
    expect((res.json() as ReportDetail).signatures).toMatchObject([
      { role: 'contractor', name: 'Chef', imageAssetId: mine },
      { role: 'client', name: 'Frau Berger', imageAssetId: client },
    ])
    const pdf = await admin.get(`/api/v1/reports/${report.id}/pdf`)
    expect(pdf.statusCode).toBe(200)
    expect(pdf.rawPayload.length).toBeGreaterThan(plain.rawPayload.length)

    // Removing the signature from the account does not touch signed records.
    expect((await admin.delete('/api/v1/me/signature')).statusCode).toBe(204)
    expect((await admin.get('/api/v1/me/signature')).json()).toEqual({ signature: null })
    const again = (await admin.get(`/api/v1/reports/${report.id}`)).json() as ReportDetail
    expect(again.signatures[0]?.imageAssetId).toBe(mine)
  })

  it('signs a joint measurement with both drawn signatures', async () => {
    const sheet = (
      await admin.post(`/api/v1/projects/${projectId}/measurement-sheets`, { kind: 'performance' })
    ).json() as MeasurementSheetDetail
    const url = `/api/v1/measurement-sheets/${sheet.id}`
    expect((await admin.post(`${url}/lines`, { formula: '2*3' })).statusCode).toBe(201)
    const client = (await worker.upload('/api/v1/signatures', PNG_CLIENT)).statusCode
    expect(client).toBe(409)

    const foreign = await admin.post(`${url}/sign`, {
      contractorName: 'Chef',
      clientName: 'Frau Berger',
      clientSignatureAssetId: (await worker.upload('/api/v1/signatures', PNG_OTHER)).json().assetId,
    })
    expect(foreign.statusCode).toBe(400)
    expect(foreign.json().errors.clientSignatureAssetId).toMatch(/nicht gefunden/)

    const clientAsset = (await admin.upload('/api/v1/signatures', PNG_CLIENT)).json().assetId
    const res = await admin.post(`${url}/sign`, {
      contractorName: 'Chef',
      clientName: 'Frau Berger',
      contractorSignatureAssetId: mine,
      clientSignatureAssetId: clientAsset,
    })
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json()).toMatchObject({
      status: 'signed',
      contractorSignatureAssetId: mine,
      clientSignatureAssetId: clientAsset,
    })
    const pdf = await admin.get(`${url}/pdf`)
    expect(pdf.statusCode).toBe(200)
    expect(pdf.headers['content-type']).toBe('application/pdf')
  })
})
