import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { withTenant } from '@easybau/db'
import type { FileSummary, FolderSummary } from '@easybau/schemas'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client, createHarness, type Harness } from './testing/harness.js'

const JPEG = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]),
  Buffer.alloc(2000, 1),
])
const PDF = Buffer.from('%PDF-1.7\n1 0 obj << >> endobj\n%%EOF\n')

describe.skipIf(!process.env.DATABASE_URL)('project filing / Ablage (integration)', () => {
  let h: Harness
  let admin: Client
  let worker: Client
  let workerId: string
  let tenantId: string
  let projectId: string
  let folders: FolderSummary[]
  const folder = (name: string) => folders.find((f) => f.name === name) as FolderSummary
  const filesUrl = () => `/api/v1/projects/${projectId}/files`
  const upload = (client: Client, name: string, content: Buffer, query = '', headers = {}) =>
    client.upload(`${filesUrl()}?filename=${encodeURIComponent(name)}${query}`, content, headers)

  beforeAll(async () => {
    h = await createHarness({ requireAdminMfa: false, uploadMaxMb: 1 })
    admin = new Client(h.app)
    const setup = await admin.post('/api/v1/setup', {
      setupToken: h.setupToken,
      company: { name: 'Ablage Bau GmbH' },
      admin: {
        email: 'chef@example.test',
        password: 'ein-sehr-langes-passwort',
        displayName: 'Chef',
      },
    })
    expect(setup.statusCode).toBe(201)
    tenantId = setup.json().tenant.id
    const project = await admin.post('/api/v1/projects', { name: 'Fassade Hauptstraße' })
    expect(project.statusCode).toBe(201)
    projectId = project.json().id

    // A site worker (Teammitglied), not yet member of the project.
    const invite = await admin.post('/api/v1/invitations', {
      email: 'monteur@example.test',
      roleKey: 'team_member',
    })
    const token = new URL(invite.json().acceptUrl).hash.slice(1)
    worker = new Client(h.app)
    const accepted = await worker.post('/api/v1/invitations/accept', {
      token,
      displayName: 'Max Monteur',
      password: 'monteur-passwort-1',
    })
    expect(accepted.statusCode).toBe(200)
    workerId = accepted.json().me.user.id
  })

  afterAll(async () => {
    await h?.close()
  })

  describe('Ordner', () => {
    it('creates the company folder structure for every new project', async () => {
      const res = await admin.get(`/api/v1/projects/${projectId}/folders`)
      expect(res.statusCode).toBe(200)
      folders = res.json()
      expect(folders.map((f) => f.name)).toEqual([
        'Pläne',
        'Fotos',
        'Verträge & Angebote',
        'Schriftverkehr',
        'Genehmigungen & Nachweise',
        'Sonstiges',
      ])
      expect(folders.every((f) => f.fileCount === 0)).toBe(true)
    })

    it('adds, renames and removes folders; names are unique per project', async () => {
      const url = `/api/v1/projects/${projectId}/folders`
      const created = await admin.post(url, { name: 'Aufmaß-Skizzen' })
      expect(created.statusCode).toBe(201)
      expect(created.json()).toMatchObject({ name: 'Aufmaß-Skizzen', sort: 70, fileCount: 0 })
      const id = created.json().id
      expect((await admin.post(url, { name: 'fotos' })).statusCode).toBe(409)
      expect((await admin.post(url, { name: '' })).statusCode).toBe(400)
      const renamed = await admin.patch(`${url}/${id}`, { name: 'Skizzen' })
      expect(renamed.json().name).toBe('Skizzen')
      expect((await admin.patch(`${url}/${id}`, { name: 'Pläne' })).statusCode).toBe(409)
      expect((await admin.delete(`${url}/${id}`)).statusCode).toBe(204)
      expect((await admin.delete(`${url}/${id}`)).statusCode).toBe(404)
    })
  })

  describe('Hochladen', () => {
    let photo: FileSummary

    it('uploads a photo into a folder and lists it', async () => {
      const res = await upload(
        admin,
        'Fassade Süd.jpg',
        JPEG,
        `&folderId=${folder('Fotos').id}&caption=${encodeURIComponent('Vorher')}`,
        { 'idempotency-key': 'upload-key-0001' },
      )
      expect(res.statusCode).toBe(201)
      photo = res.json()
      expect(photo).toMatchObject({
        projectId,
        folderId: folder('Fotos').id,
        filename: 'Fassade Süd.jpg',
        mimeType: 'image/jpeg',
        category: 'image',
        inline: true,
        sizeBytes: JPEG.length,
        caption: 'Vorher',
        isEvidence: false,
        canDelete: true,
        uploadedBy: { displayName: 'Chef' },
      })
      expect(photo.createdAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/)

      const list = (await admin.get(`${filesUrl()}?folderId=${folder('Fotos').id}`)).json()
      expect(list.map((f: FileSummary) => f.id)).toEqual([photo.id])
      expect((await admin.get(`${filesUrl()}?folderId=none`)).json()).toEqual([])
      const counts = (await admin.get(`/api/v1/projects/${projectId}/folders`)).json()
      expect(counts.find((f: FolderSummary) => f.name === 'Fotos').fileCount).toBe(1)
    })

    it('replays an upload with the same Idempotency-Key instead of storing it twice', async () => {
      const again = await upload(
        admin,
        'Fassade Süd.jpg',
        JPEG,
        `&folderId=${folder('Fotos').id}&caption=${encodeURIComponent('Vorher')}`,
        { 'idempotency-key': 'upload-key-0001' },
      )
      expect(again.statusCode).toBe(201)
      expect(again.headers['idempotency-replayed']).toBe('true')
      expect(again.json().id).toBe(photo.id)
      expect((await admin.get(filesUrl())).json()).toHaveLength(1)
    })

    it('serves the file inline with safe headers, or as download', async () => {
      const res = await admin.get(`/api/v1/files/${photo.id}/content`)
      expect(res.statusCode).toBe(200)
      expect(res.rawPayload.equals(JPEG)).toBe(true)
      expect(res.headers['content-type']).toBe('image/jpeg')
      expect(res.headers['content-disposition']).toBe(
        `inline; filename="Fassade S_d.jpg"; filename*=UTF-8''Fassade%20S%C3%BCd.jpg`,
      )
      expect(res.headers['x-content-type-options']).toBe('nosniff')
      expect(res.headers['content-security-policy']).toContain('sandbox')
      const download = await admin.get(`/api/v1/files/${photo.id}/content?download=1`)
      expect(download.headers['content-disposition']).toMatch(/^attachment;/)
    })

    it('stores PDFs and office files; office files are always downloaded', async () => {
      const pdf = await upload(admin, 'Grundriss EG.pdf', PDF, `&folderId=${folder('Pläne').id}`)
      expect(pdf.json()).toMatchObject({ category: 'pdf', inline: true })
      const xlsx = await upload(admin, 'Mengen.xlsx', Buffer.from('PK\x03\x04-rest-of-zip'))
      expect(xlsx.json()).toMatchObject({ category: 'office', inline: false, folderId: null })
      const res = await admin.get(`/api/v1/files/${xlsx.json().id}/content`)
      expect(res.headers['content-disposition']).toMatch(/^attachment;/)
    })

    it('rejects disguised, dangerous, empty and oversized files and leaves nothing behind', async () => {
      const html = await upload(
        admin,
        'rechnung.pdf',
        Buffer.from('<html><script>alert(1)</script>'),
      )
      expect(html.statusCode).toBe(415)
      expect(html.json().detail).toMatch(/Dateityp ist nicht erlaubt/)
      expect((await upload(admin, 'bild.svg', Buffer.from('<svg/>'))).statusCode).toBe(415)
      expect((await upload(admin, 'setup.exe', Buffer.from('MZ\x90\x00'))).statusCode).toBe(415)
      expect((await upload(admin, 'leer.txt', Buffer.alloc(0))).statusCode).toBe(400)
      const big = Buffer.concat([JPEG, Buffer.alloc(1024 * 1024)])
      const tooLarge = await upload(admin, 'riesig.jpg', big)
      expect(tooLarge.statusCode).toBe(413)
      expect(tooLarge.json().detail).toBe('Die Datei ist zu groß (höchstens 1 MB).')
      const json = await admin.post(`${filesUrl()}?filename=a.pdf`, { not: 'a file' })
      expect(json.statusCode).toBe(415)
      expect((await upload(admin, '', JPEG)).statusCode).toBe(400)
      const otherFolder = await upload(admin, 'a.jpg', JPEG, `&folderId=${projectId}`)
      expect(otherFolder.json().errors).toEqual({ folderId: 'Unbekannter Ordner.' })
      const unknownProject = await admin.upload(
        '/api/v1/projects/0190f4a0-0000-7000-8000-000000000000/files?filename=a.jpg',
        JPEG,
      )
      expect(unknownProject.statusCode).toBe(404)
      expect(await readdir(join(h.storageDir, 'tmp'))).toEqual([])
      expect((await admin.get(filesUrl())).json()).toHaveLength(3)
    })

    it('sanitizes file names, keeps the extension on rename and moves between folders', async () => {
      const res = await upload(admin, '../../etc/Plan<1>.pdf', PDF)
      expect(res.json().filename).toBe('Plan1.pdf')
      const id = res.json().id
      const renamed = await admin.patch(`/api/v1/files/${id}`, {
        filename: 'Ansicht Nord.exe',
        folderId: folder('Pläne').id,
        caption: 'Stand 11/2026',
      })
      expect(renamed.json()).toMatchObject({
        filename: 'Ansicht Nord.exe.pdf',
        folderId: folder('Pläne').id,
        caption: 'Stand 11/2026',
      })
      const moved = await admin.patch(`/api/v1/files/${id}`, { folderId: null })
      expect(moved.json().folderId).toBeNull()
      const bad = await admin.patch(`/api/v1/files/${id}`, {
        folderId: '0190f4a0-0000-7000-8000-000000000000',
      })
      expect(bad.statusCode).toBe(400)
      expect((await admin.delete(`/api/v1/files/${id}`)).statusCode).toBe(204)
      expect((await admin.get(`/api/v1/files/${id}`)).statusCode).toBe(404)
      expect(await readdir(join(h.storageDir, 'objects', tenantId, 'files'))).toHaveLength(3)
    })

    it('does not delete folders that still contain files', async () => {
      const res = await admin.delete(`/api/v1/projects/${projectId}/folders/${folder('Fotos').id}`)
      expect(res.statusCode).toBe(409)
    })

    it('protects evidence files (signed reports, finalized invoices)', async () => {
      await withTenant(
        h.sql,
        { tenantId },
        (tx) => tx`update file set is_evidence = true where id = ${photo.id}`,
      )
      const res = await admin.delete(`/api/v1/files/${photo.id}`)
      expect(res.statusCode).toBe(409)
      expect((await admin.get(`/api/v1/files/${photo.id}`)).json().canDelete).toBe(false)
      expect((await admin.patch(`/api/v1/files/${photo.id}`, { filename: 'x' })).statusCode).toBe(
        403,
      )
    })
  })

  describe('Baustelle', () => {
    it('site workers only see projects they work on', async () => {
      expect((await worker.get(filesUrl())).statusCode).toBe(404)
      expect((await upload(worker, 'a.jpg', JPEG)).statusCode).toBe(404)
      const res = await admin.patch(`/api/v1/projects/${projectId}`, { memberIds: [workerId] })
      expect(res.statusCode).toBe(200)
      expect((await worker.get(filesUrl())).json().length).toBeGreaterThan(0)
    })

    it('site workers upload photos and may delete only their own files', async () => {
      const own = await upload(worker, 'IMG_0001.JPG', JPEG, `&folderId=${folder('Fotos').id}`)
      expect(own.statusCode).toBe(201)
      expect(own.json()).toMatchObject({
        canDelete: true,
        uploadedBy: { displayName: 'Max Monteur' },
      })
      const list: FileSummary[] = (await worker.get(filesUrl())).json()
      const foreign = list.find(
        (f) => f.uploadedBy?.displayName === 'Chef' && !f.isEvidence,
      ) as FileSummary
      expect(foreign.canDelete).toBe(false)
      expect((await worker.delete(`/api/v1/files/${foreign.id}`)).statusCode).toBe(403)
      expect((await worker.patch(`/api/v1/files/${foreign.id}`, { caption: 'x' })).statusCode).toBe(
        403,
      )
      expect(
        (await worker.post(`/api/v1/projects/${projectId}/folders`, { name: 'Meins' })).statusCode,
      ).toBe(403)
      expect((await worker.delete(`/api/v1/files/${own.json().id}`)).statusCode).toBe(204)
    })
  })

  it('records file changes in the audit log', async () => {
    const events = await withTenant(
      h.sql,
      { tenantId },
      (tx) =>
        tx<{ action: string }[]>`select action from audit_event where entity = 'file' order by id`,
    )
    expect(events.map((e) => e.action)).toEqual(
      expect.arrayContaining(['insert', 'update', 'delete']),
    )
  })
})
