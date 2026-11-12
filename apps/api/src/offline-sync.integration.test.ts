import { randomUUID } from 'node:crypto'
import type { MeasurementSheetDetail, ReportDetail } from '@opc/schemas'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client, createHarness, type Harness } from './testing/harness.js'

/**
 * Offline-Sync (P2.3, DESIGN.md §6): lines and reports captured offline carry their own id, so
 * the outbox can send them again after a lost answer without duplicates; photos go into the
 * report in one request.
 */
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]), Buffer.from('Foto')])

describe.skipIf(!process.env.DATABASE_URL)('Offline-Sync (integration)', () => {
  let h: Harness
  let admin: Client
  let projectId: string
  let sheet: MeasurementSheetDetail
  let other: MeasurementSheetDetail

  beforeAll(async () => {
    h = await createHarness({ requireAdminMfa: false })
    admin = new Client(h.app)
    await admin.post('/api/v1/setup', {
      setupToken: h.setupToken,
      company: { name: 'Offline Bau GmbH' },
      admin: {
        email: 'chef@example.test',
        password: 'ein-sehr-langes-passwort',
        displayName: 'Chef',
      },
    })
    projectId = (await admin.post('/api/v1/projects', { name: 'Funkloch' })).json().id
    sheet = (
      await admin.post(`/api/v1/projects/${projectId}/measurement-sheets`, { kind: 'performance' })
    ).json()
    other = (
      await admin.post(`/api/v1/projects/${projectId}/measurement-sheets`, { kind: 'survey' })
    ).json()
  })

  afterAll(async () => {
    await h?.close()
  })

  it('creates a measurement line with the client id once, even when sent again', async () => {
    const id = randomUUID()
    const line = { id, formula: '4,25*2,6', description: 'Wand Nord' }
    const first = await admin.post(`/api/v1/measurement-sheets/${sheet.id}/lines`, line)
    expect(first.statusCode, first.body).toBe(201)
    expect(first.json().lines).toMatchObject([{ id, formula: '4,25*2,6', resultQty: '11.05' }])
    // Same line again (answer lost, other Idempotency-Key): nothing changes.
    const again = await admin.post(`/api/v1/measurement-sheets/${sheet.id}/lines`, line)
    expect(again.statusCode).toBe(200)
    expect(again.json().lines).toHaveLength(1)
    // The id cannot be used on another sheet.
    expect(
      (await admin.post(`/api/v1/measurement-sheets/${other.id}/lines`, line)).statusCode,
    ).toBe(409)
    // Later changes from the outbox address the same id.
    const patched = await admin.patch(`/api/v1/measurement-sheets/${sheet.id}/lines/${id}`, {
      formula: '4,25*2,5',
    })
    expect(patched.json().lines[0].resultQty).toBe('10.63')
  })

  it('creates a report with the client id once and takes photos in one request', async () => {
    const id = randomUUID()
    const body = { id, templateKey: 'daily_site_report', reportDate: '2026-11-07' }
    const first = await admin.post(`/api/v1/projects/${projectId}/reports`, body)
    expect(first.statusCode, first.body).toBe(201)
    expect(first.json().id).toBe(id)
    const again = await admin.post(`/api/v1/projects/${projectId}/reports`, body)
    expect(again.statusCode).toBe(200)
    expect(again.json().id).toBe(id)

    const photo = await admin.upload(
      `/api/v1/reports/${id}/photos/upload?filename=${encodeURIComponent('Baustelle 1.jpg')}&caption=Ostseite`,
      JPEG,
    )
    expect(photo.statusCode, photo.body).toBe(201)
    const report = photo.json() as ReportDetail
    expect(report.photos).toMatchObject([{ caption: 'Ostseite' }])
    const files = (await admin.get(`/api/v1/projects/${projectId}/files`)).json()
    const folders = (await admin.get(`/api/v1/projects/${projectId}/folders`)).json() as {
      id: string
      name: string
    }[]
    expect(files).toMatchObject([
      {
        filename: 'Baustelle 1.jpg',
        folderId: folders.find((f) => f.name === 'Fotos')?.id ?? null,
      },
    ])
    // Only pictures; nothing is kept when the attachment is refused.
    const pdf = await admin.upload(
      `/api/v1/reports/${id}/photos/upload?filename=plan.pdf`,
      Buffer.from('%PDF-1.7\n'),
    )
    expect(pdf.statusCode).toBe(415)
    expect((await admin.get(`/api/v1/projects/${projectId}/files`)).json()).toHaveLength(1)
  })
})
