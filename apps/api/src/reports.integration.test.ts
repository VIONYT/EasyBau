import { withTenant } from '@opc/db'
import type { ReportDetail, ReportSummary, ReportTemplateSummary, UnitSummary } from '@opc/schemas'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client, createHarness, type Harness } from './testing/harness.js'

const JPEG = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]),
  Buffer.alloc(500, 1),
])
const PDF = Buffer.from('%PDF-1.7\n%%EOF\n')

describe.skipIf(!process.env.DATABASE_URL)('Bautagebuch / reports (integration)', () => {
  let h: Harness
  let admin: Client
  let worker: Client
  let workerId: string
  let tenantId: string
  let projectId: string
  let customerId: string
  let report: ReportDetail
  let units: UnitSummary[]
  const url = () => `/api/v1/reports/${report.id}`
  const upload = async (client: Client, project: string, name: string, content: Buffer) =>
    (
      await client.upload(
        `/api/v1/projects/${project}/files?filename=${encodeURIComponent(name)}`,
        content,
      )
    ).json()

  beforeAll(async () => {
    h = await createHarness({ requireAdminMfa: false })
    admin = new Client(h.app)
    const setup = await admin.post('/api/v1/setup', {
      setupToken: h.setupToken,
      company: { name: 'Tagebuch Bau GmbH' },
      admin: {
        email: 'chef@example.test',
        password: 'ein-sehr-langes-passwort',
        displayName: 'Chef',
      },
    })
    tenantId = setup.json().tenant.id
    units = (await admin.get('/api/v1/units')).json()
    customerId = (
      await admin.post('/api/v1/contacts', { kind: 'organization', organizationName: 'Stadtwerke' })
    ).json().id
    const invite = await admin.post('/api/v1/invitations', {
      email: 'polier@example.test',
      roleKey: 'team_member',
    })
    worker = new Client(h.app)
    const accepted = await worker.post('/api/v1/invitations/accept', {
      token: new URL(invite.json().acceptUrl).hash.slice(1),
      displayName: 'Paul Polier',
      password: 'polier-passwort-1',
    })
    workerId = accepted.json().me.user.id
    projectId = (
      await admin.post('/api/v1/projects', {
        name: 'Kanal Hauptstraße',
        customerId,
        site: { street: 'Hauptstraße 1', postalCode: '30159', city: 'Hannover' },
        memberIds: [workerId],
      })
    ).json().id
  })

  afterAll(async () => {
    await h?.close()
  })

  it('offers the report templates this version can fill in', async () => {
    const templates: ReportTemplateSummary[] = (await admin.get('/api/v1/report-templates')).json()
    const keys = templates.map((t) => t.key)
    expect(keys).toEqual(
      expect.arrayContaining(['daily_site_report', 'daywork_report', 'acceptance_protocol']),
    )
    expect(keys).not.toContain('measurement_report')
    const daily = templates.find((t) => t.key === 'daily_site_report')
    expect(daily?.sections.map((s) => s.type)).toEqual([
      'header',
      'weather',
      'staff',
      'services',
      'materials',
      'equipment',
      'text',
      'photos',
      'signatures',
    ])
  })

  it('creates a daily report bound to the project, with team and working hours', async () => {
    // 2026-11-09 is a Monday: 07:00–16:00 minus 30 min break = 8,5 h.
    const res = await admin.post(`/api/v1/projects/${projectId}/reports`, {
      reportDate: '2026-11-09',
    })
    expect(res.statusCode, res.body).toBe(201)
    report = res.json()
    expect(report).toMatchObject({
      projectId,
      template: { key: 'daily_site_report', name: 'Bautagesbericht' },
      reportDate: '2026-11-09',
      status: 'draft',
      header: {
        contractor: 'Tagebuch Bau GmbH',
        client: 'Stadtwerke',
        placeOfPerformance: 'Hauptstraße 1, 30159 Hannover',
      },
      staffCount: 2,
      totalHours: '17',
      photos: [],
      signatures: [],
    })
    expect(report.data.staff).toEqual({
      rows: [
        { name: 'Chef', userId: expect.any(String), hours: '8.5', activity: null },
        { name: 'Paul Polier', userId: workerId, hours: '8.5', activity: null },
      ],
    })
    expect(report.data.weather).toEqual({
      condition: null,
      temperatureMin: null,
      temperatureMax: null,
      note: null,
    })
    expect(report.data.incidents).toEqual({ text: '' })
  })

  it('allows only one open daily report per project and day', async () => {
    const again = await admin.post(`/api/v1/projects/${projectId}/reports`, {
      reportDate: '2026-11-09',
    })
    expect(again.statusCode).toBe(409)
    // Friday: 07:00–13:00 minus 30 min = 5,5 h; Saturday: no working hours.
    const friday = (
      await admin.post(`/api/v1/projects/${projectId}/reports`, { reportDate: '2026-11-13' })
    ).json()
    expect(friday.data.staff.rows[0].hours).toBe('5.5')
    const saturday = (
      await admin.post(`/api/v1/projects/${projectId}/reports`, { reportDate: '2026-11-14' })
    ).json()
    expect(saturday.totalHours).toBe('0')
    expect((await admin.delete(`/api/v1/reports/${saturday.id}`)).statusCode).toBe(204)
    const otherProject = (await admin.post('/api/v1/projects', { name: 'Anderes' })).json()
    const elsewhere = await admin.post(`/api/v1/projects/${otherProject.id}/reports`, {
      reportDate: '2026-11-09',
    })
    expect(elsewhere.statusCode).toBe(201)
  })

  it('saves weather, staff, work done, materials and incidents', async () => {
    const res = await admin.patch(url(), {
      data: {
        weather: {
          condition: 'rain',
          temperatureMin: '3',
          temperatureMax: '8,5',
          note: 'ab Mittag Regen',
        },
        staff: {
          rows: [
            { name: 'Chef', hours: '2' },
            { name: 'Paul Polier', userId: workerId, hours: '9,25', activity: 'Rohrgraben' },
          ],
        },
        services: {
          rows: [
            {
              description: 'Rohrgraben ausgehoben',
              quantity: '12,5',
              unitId: units.find((u) => u.symbol === 'm³')?.id,
            },
          ],
        },
        materials: {
          rows: [
            {
              description: 'KG-Rohr DN 150',
              quantity: '24',
              unitId: units.find((u) => u.symbol === 'm')?.id,
            },
          ],
        },
        equipment: { rows: [{ description: 'Minibagger', hours: '7' }] },
        incidents: { text: 'Leitung der Telekom nicht im Plan, Arbeiten 2 h unterbrochen.' },
      },
    })
    expect(res.statusCode, res.body).toBe(200)
    report = res.json()
    expect(report.data.weather).toEqual({
      condition: 'rain',
      temperatureMin: '3',
      temperatureMax: '8.5',
      note: 'ab Mittag Regen',
    })
    expect(report).toMatchObject({ totalHours: '11.25', staffCount: 2 })
    expect(report.data.services).toEqual({
      rows: [
        { description: 'Rohrgraben ausgehoben', quantity: '12.5', unitId: expect.any(String) },
      ],
    })
    const list: ReportSummary[] = (
      await admin.get(`/api/v1/projects/${projectId}/reports?template=daily_site_report`)
    ).json()
    expect(list.map((r) => [r.reportDate, r.totalHours])).toEqual([
      ['2026-11-13', '11'],
      ['2026-11-09', '11.25'],
    ])
    expect(list[1]?.weather?.condition).toBe('rain')
  })

  it('validates the sections', async () => {
    const hours = await admin.patch(url(), {
      data: { staff: { rows: [{ name: 'X', hours: '25' }] } },
    })
    expect(hours.json().errors).toEqual({ 'data.staff.rows.0.hours': 'Stunden: 0 bis 24.' })
    const unknown = await admin.patch(url(), { data: { lunch: { text: 'x' } } })
    expect(unknown.json().errors).toEqual({
      'data.lunch': 'Diesen Abschnitt gibt es in der Vorlage nicht.',
    })
    const badUnit = await admin.patch(url(), {
      data: {
        materials: { rows: [{ description: 'x', unitId: '0190f4a0-0000-7000-8000-000000000000' }] },
      },
    })
    expect(badUnit.json().errors).toEqual({ data: 'Unbekannte Einheit.' })
    const weather = await admin.patch(url(), { data: { weather: { condition: 'hagel' } } })
    expect(weather.statusCode).toBe(400)
    const stale = await admin.request(
      'PATCH',
      url(),
      { reportDate: '2026-11-10' },
      { 'if-match': '"alt"' },
    )
    expect(stale.statusCode).toBe(412)
  })

  it('adds photos from the project filing (only images of this project)', async () => {
    const photo = await upload(worker, projectId, 'Leitung.jpg', JPEG)
    let res = await worker.post(`${url()}/photos`, { fileId: photo.id, caption: 'Telekom-Leitung' })
    expect(res.statusCode, res.body).toBe(201)
    report = res.json()
    expect(report.photos).toEqual([
      { fileId: photo.id, filename: 'Leitung.jpg', caption: 'Telekom-Leitung', isEvidence: false },
    ])
    const pdf = await upload(admin, projectId, 'Plan.pdf', PDF)
    res = await admin.post(`${url()}/photos`, { fileId: pdf.id })
    expect(res.json().errors).toEqual({ fileId: 'Bitte ein Foto auswählen.' })
    const other = (await admin.post('/api/v1/projects', { name: 'Fremd' })).json()
    const foreign = await upload(admin, other.id, 'fremd.jpg', JPEG)
    res = await admin.post(`${url()}/photos`, { fileId: foreign.id })
    expect(res.json().errors).toEqual({ fileId: 'Diese Datei gehört nicht zu diesem Projekt.' })
    await expect(
      withTenant(
        h.sql,
        { tenantId },
        (tx) => tx`
        insert into report_photo (tenant_id, report_id, file_id) values (${tenantId}, ${report.id}, ${foreign.id})`,
      ),
    ).rejects.toThrow(/another project/)
    const extra = await upload(admin, projectId, 'weg.jpg', JPEG)
    await admin.post(`${url()}/photos`, { fileId: extra.id })
    res = await admin.delete(`${url()}/photos/${extra.id}`)
    expect(res.json().photos).toHaveLength(1)
  })

  it('site workers write reports on their projects but cannot sign', async () => {
    expect((await worker.get(url())).statusCode).toBe(200)
    const res = await worker.patch(url(), { data: { notes: { text: 'x' } } })
    expect(res.statusCode).toBe(400)
    expect(
      (await worker.post(`${url()}/sign`, { signatures: [{ role: 'contractor', name: 'Paul' }] }))
        .statusCode,
    ).toBe(403)
    await admin.patch(`/api/v1/projects/${projectId}`, { memberIds: [] })
    expect((await worker.get(url())).statusCode).toBe(404)
    await admin.patch(`/api/v1/projects/${projectId}`, { memberIds: [workerId] })
  })

  it('signing freezes the report and its photos (Beweisfunktion)', async () => {
    const missing = await admin.post(`${url()}/sign`, {
      signatures: [{ role: 'client', name: 'Herr Amt' }],
    })
    expect(missing.json().errors).toEqual({
      signatures: 'Es fehlt die Unterschrift für: Auftragnehmer.',
    })
    const res = await admin.post(`${url()}/sign`, {
      signatures: [{ role: 'contractor', name: 'Chef' }],
    })
    expect(res.statusCode, res.body).toBe(200)
    report = res.json()
    expect(report).toMatchObject({
      status: 'signed',
      signatures: [{ role: 'contractor', name: 'Chef' }],
    })
    expect(report.completedAt).toMatch(/Z$/)
    expect(report.photos[0]?.isEvidence).toBe(true)

    // The header is a snapshot: later changes to the customer do not alter the report.
    await admin.patch(`/api/v1/contacts/${customerId}`, { organizationName: 'Stadtwerke Neu' })
    expect((await admin.get(url())).json().header.client).toBe('Stadtwerke')

    for (const attempt of [
      await admin.patch(url(), { data: { incidents: { text: 'geändert' } } }),
      await admin.post(`${url()}/photos`, { fileId: report.photos[0]?.fileId }),
      await admin.delete(`${url()}/photos/${report.photos[0]?.fileId}`),
      await admin.delete(url()),
      await admin.post(`${url()}/sign`, { signatures: [{ role: 'contractor', name: 'Chef' }] }),
    ]) {
      expect(attempt.statusCode).toBe(409)
      expect(attempt.json().detail).toMatch(/unterschrieben/)
    }
    expect((await admin.delete(`/api/v1/files/${report.photos[0]?.fileId}`)).statusCode).toBe(409)
    await expect(
      withTenant(
        h.sql,
        { tenantId },
        (tx) => tx`update report set data = '{}' where id = ${report.id}`,
      ),
    ).rejects.toThrow(/signed/)
    await expect(
      withTenant(
        h.sql,
        { tenantId },
        (tx) => tx`
        insert into report_signature (tenant_id, report_id, signer_name, signer_role)
        values (${tenantId}, ${report.id}, 'X', 'other')`,
      ),
    ).rejects.toThrow(/already signed/)

    // A supplement for the same day is possible as a new report.
    const supplement = await admin.post(`/api/v1/projects/${projectId}/reports`, {
      reportDate: '2026-11-09',
    })
    expect(supplement.statusCode).toBe(201)
  })

  it('a Regiebericht needs both signatures', async () => {
    const daywork = (
      await admin.post(`/api/v1/projects/${projectId}/reports`, {
        templateKey: 'daywork_report',
        reportDate: '2026-11-10',
      })
    ).json()
    expect(daywork.template.name).toBe('Regiebericht')
    const res = await admin.post(`/api/v1/reports/${daywork.id}/sign`, {
      signatures: [{ role: 'contractor', name: 'Chef' }],
    })
    expect(res.json().errors.signatures).toBe('Es fehlt die Unterschrift für: Auftraggeber.')
    const unknown = await admin.post(`/api/v1/projects/${projectId}/reports`, {
      templateKey: 'measurement_report',
    })
    expect(unknown.statusCode).toBe(400)
  })

  it('records report changes in the audit log', async () => {
    const events = await withTenant(
      h.sql,
      { tenantId },
      (tx) =>
        tx<
          { entity: string }[]
        >`select distinct entity from audit_event where entity like 'report%' order by 1`,
    )
    expect(events.map((e) => e.entity)).toEqual(['report', 'report_photo', 'report_signature'])
  })
})
