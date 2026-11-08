import { withTenant } from '@opc/db'
import type {
  DocumentDetail,
  MeasurableItem,
  MeasurementSheetDetail,
  UnitSummary,
} from '@opc/schemas'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client, createHarness, type Harness } from './testing/harness.js'

describe.skipIf(!process.env.DATABASE_URL)('measurements / Aufmaß (integration)', () => {
  let h: Harness
  let admin: Client
  let worker: Client
  let workerId: string
  let tenantId: string
  let projectId: string
  let otherProjectId: string
  let quote: DocumentDetail
  let otherItemId: string
  let units: UnitSummary[]
  let sheet: MeasurementSheetDetail
  const unit = (symbol: string) => units.find((u) => u.symbol === symbol)?.id as string
  const wall = () => quote.items.find((i) => i.shortText === 'Wandfläche streichen')?.id as string
  const tiles = () => quote.items.find((i) => i.shortText === 'Fliesen')?.id as string
  const sheetUrl = () => `/api/v1/measurement-sheets/${sheet.id}`
  const room = (name: string) => sheet.locations.find((l) => l.name === name)?.id as string

  async function projectWithQuote(name: string) {
    const project = (await admin.post('/api/v1/projects', { name })).json()
    let doc: DocumentDetail = (
      await admin.post(`/api/v1/projects/${project.id}/documents`, { type: 'quote' })
    ).json()
    const add = async (body: Record<string, unknown>) => {
      const res = await admin.post(`/api/v1/documents/${doc.id}/items`, body)
      expect(res.statusCode, res.body).toBe(201)
      doc = res.json()
    }
    await add({ positionType: 'title', shortText: 'Maler' })
    await add({
      positionType: 'item',
      parentId: doc.items[0]?.id,
      shortText: 'Wandfläche streichen',
      quantity: '10',
      unitId: unit('m²'),
      unitPriceCents: 1000,
    })
    await add({
      positionType: 'item',
      shortText: 'Fliesen',
      quantity: '5',
      unitId: unit('m²'),
      unitPriceCents: 5000,
    })
    return { project, doc }
  }

  beforeAll(async () => {
    h = await createHarness({ requireAdminMfa: false })
    admin = new Client(h.app)
    const setup = await admin.post('/api/v1/setup', {
      setupToken: h.setupToken,
      company: { name: 'Aufmaß Bau GmbH' },
      admin: {
        email: 'chef@example.test',
        password: 'ein-sehr-langes-passwort',
        displayName: 'Chef',
      },
    })
    tenantId = setup.json().tenant.id
    units = (await admin.get('/api/v1/units')).json()
    const a = await projectWithQuote('Bad Müller')
    projectId = a.project.id
    quote = a.doc
    const b = await projectWithQuote('Anderes Projekt')
    otherProjectId = b.project.id
    otherItemId = b.doc.items[1]?.id as string

    const invite = await admin.post('/api/v1/invitations', {
      email: 'mess@example.test',
      roleKey: 'team_member',
    })
    worker = new Client(h.app)
    const accepted = await worker.post('/api/v1/invitations/accept', {
      token: new URL(invite.json().acceptUrl).hash.slice(1),
      displayName: 'Mia Messtechnik',
      password: 'messen-passwort-1',
    })
    workerId = accepted.json().me.user.id
  })

  afterAll(async () => {
    await h?.close()
  })

  it('lists the LV positions of the project for assignment, without prices', async () => {
    const res = await admin.get(`/api/v1/projects/${projectId}/measurable-items?kind=survey`)
    const items: MeasurableItem[] = res.json()
    expect(
      items.map((i) => [i.oz, i.shortText, i.quantity, i.unit?.symbol, i.measuredQuantity]),
    ).toEqual([
      ['1.1', 'Wandfläche streichen', '10', 'm²', '0'],
      ['2', 'Fliesen', '5', 'm²', '0'],
    ])
    expect(items[0]?.document).toMatchObject({ type: 'quote', status: 'draft', number: null })
    expect(JSON.stringify(items)).not.toContain('Cents')
  })

  it('creates a measurement sheet that belongs to the project', async () => {
    const res = await admin.post(`/api/v1/projects/${projectId}/measurement-sheets`, {
      kind: 'survey',
    })
    expect(res.statusCode).toBe(201)
    sheet = res.json()
    expect(sheet).toMatchObject({
      projectId,
      kind: 'survey',
      title: 'Angebotsaufmaß 1',
      status: 'draft',
      lineCount: 0,
      project: { id: projectId, name: 'Bad Müller' },
      createdBy: { displayName: 'Chef' },
    })
    expect(
      (await admin.post(`/api/v1/projects/${projectId}/measurement-sheets`, { kind: 'x' }))
        .statusCode,
    ).toBe(400)
    const list = (await admin.get(`/api/v1/projects/${projectId}/measurement-sheets`)).json()
    expect(list.map((s: { id: string }) => s.id)).toEqual([sheet.id])
    expect(
      (await admin.get(`/api/v1/projects/${otherProjectId}/measurement-sheets`)).json(),
    ).toEqual([])
  })

  it('structures rooms with dimensions as variables', async () => {
    const url = `${sheetUrl()}/locations`
    sheet = (await admin.post(url, { name: 'Haus A' })).json()
    sheet = (
      await admin.post(url, { name: 'EG', parentId: room('Haus A'), variables: { H: '2,6' } })
    ).json()
    const res = await admin.post(url, {
      name: 'Bad',
      parentId: room('EG'),
      variables: { L: '4,25', B: '3,1' },
    })
    expect(res.statusCode).toBe(201)
    sheet = res.json()
    expect(sheet.locations.map((l) => [l.path, l.level, l.variables])).toEqual([
      ['Haus A', 0, {}],
      ['Haus A › EG', 1, { H: '2.6' }],
      ['Haus A › EG › Bad', 2, { L: '4.25', B: '3.1' }],
    ])
    const bad = await admin.post(url, { name: 'X', variables: { '1x': '2' } })
    expect(bad.statusCode).toBe(400)
  })

  it('calculates lines on the server from formula and room dimensions', async () => {
    const url = `${sheetUrl()}/lines`
    let res = await admin.post(url, {
      locationId: room('Bad'),
      documentItemId: wall(),
      description: 'Wände Bad',
      formula: '2*(L+B)*H',
    })
    expect(res.statusCode, res.body).toBe(201)
    res = await admin.post(url, {
      locationId: room('Bad'),
      documentItemId: wall(),
      description: 'Tür',
      formula: 'B*H',
      variables: { B: '0,885', H: '2,01' },
      isDeduction: true,
      unitId: unit('Stk.'),
    })
    sheet = res.json()
    expect(
      sheet.lines.map((l) => [l.description, l.resultQty, l.unit?.symbol, l.isDeduction]),
    ).toEqual([
      ['Wände Bad', '38.22', 'm²', false],
      ['Tür', '-1.7789', 'm²', true],
    ])
    expect(sheet.items).toEqual([
      expect.objectContaining({
        sheetQuantity: '36.4411',
        item: expect.objectContaining({ id: wall(), measuredQuantity: '36.4411' }),
        variance: {
          difference: '26.4411',
          percent: '264.41',
          direction: 'more',
          exceedsThreshold: true,
        },
      }),
    ])
  })

  it('reports formula errors in German with the position', async () => {
    const url = `${sheetUrl()}/lines`
    const broken = await admin.post(url, { formula: '4,25*' })
    expect(broken.statusCode).toBe(400)
    expect(broken.json().errors.formula).toMatch(/Zeichen \d+/)
    const unknown = await admin.post(url, { formula: 'X*2' })
    expect(unknown.json().errors.formula).toMatch(/X/)
    expect((await admin.post(url, { formula: '' })).statusCode).toBe(400)
  })

  it('keeps everything inside the project', async () => {
    const url = `${sheetUrl()}/lines`
    const foreign = await admin.post(url, { formula: '1', documentItemId: otherItemId })
    expect(foreign.json().errors).toEqual({
      documentItemId: 'Diese LV-Position gehört nicht zu diesem Projekt.',
    })
    const other = (
      await admin.post(`/api/v1/projects/${otherProjectId}/measurement-sheets`, { kind: 'survey' })
    ).json()
    const otherRoom = (
      await admin.post(`/api/v1/measurement-sheets/${other.id}/locations`, { name: 'Küche' })
    ).json()
    const wrongRoom = await admin.post(url, { formula: '1', locationId: otherRoom.locations[0].id })
    expect(wrongRoom.json().errors).toEqual({ locationId: 'Unbekannter Raum.' })
    // Last line of defence: the database refuses cross-project references.
    await expect(
      withTenant(
        h.sql,
        { tenantId },
        (tx) => tx`
        insert into measurement_line (tenant_id, sheet_id, formula, result_qty, document_item_id)
        values (${tenantId}, ${sheet.id}, '1', 1, ${otherItemId})`,
      ),
    ).rejects.toThrow(/another project/)
    await expect(
      withTenant(
        h.sql,
        { tenantId },
        (tx) =>
          tx`update measurement_sheet set project_id = ${otherProjectId} where id = ${sheet.id}`,
      ),
    ).rejects.toThrow(/cannot be moved to another project/)
    await expect(
      withTenant(
        h.sql,
        { tenantId },
        (tx) => tx`update document set project_id = ${otherProjectId} where id = ${quote.id}`,
      ),
    ).rejects.toThrow(/cannot be moved to another project/)
    await admin.delete(`/api/v1/measurement-sheets/${other.id}`)
  })

  it('recalculates all lines when room dimensions change', async () => {
    const res = await admin.patch(`${sheetUrl()}/locations/${room('EG')}`, {
      variables: { H: '2,5' },
    })
    expect(res.statusCode).toBe(200)
    sheet = res.json()
    expect(sheet.lines[0]?.resultQty).toBe('36.75')
    expect(sheet.items[0]?.sheetQuantity).toBe('34.9711')
    const missing = await admin.patch(`${sheetUrl()}/locations/${room('Bad')}`, {
      variables: { L: '4' },
    })
    expect(missing.statusCode).toBe(400)
    expect(missing.json().detail).toMatch(/„Wände Bad“ lässt sich damit nicht mehr berechnen/)
    expect((await admin.delete(`${sheetUrl()}/locations/${room('Bad')}`)).statusCode).toBe(409)
  })

  it('edits and deletes lines; unassigned lines are summed per unit', async () => {
    let res = await admin.post(`${sheetUrl()}/lines`, {
      formula: '3',
      description: 'Steckdosen',
      unitId: unit('Stk.'),
    })
    sheet = res.json()
    expect(sheet.unassigned).toEqual([{ unit: 'Stk.', quantity: '3', count: 1 }])
    const line = sheet.lines.find((l) => l.description === 'Steckdosen')?.id as string
    res = await admin.patch(`${sheetUrl()}/lines/${line}`, {
      formula: '2+2',
      documentItemId: tiles(),
    })
    sheet = res.json()
    expect(sheet.lines.find((l) => l.id === line)).toMatchObject({
      resultQty: '4',
      unit: { symbol: 'm²' },
    })
    expect(sheet.unassigned).toEqual([])
    res = await admin.patch(`${sheetUrl()}/lines/${line}`, { formula: '(' })
    expect(res.statusCode).toBe(400)
    res = await admin.delete(`${sheetUrl()}/lines/${line}`)
    sheet = res.json()
    expect(sheet.lines).toHaveLength(2)
  })

  it('takes the measured quantities into the draft (Mengen übernehmen)', async () => {
    const res = await admin.post(`/api/v1/documents/${quote.id}/apply-measurements`)
    expect(res.statusCode, res.body).toBe(200)
    quote = res.json()
    const item = quote.items.find((i) => i.id === wall())
    expect(item).toMatchObject({ quantity: '34.9711', fromMeasurement: true, totalCents: 34_971 })
    expect(quote.items.find((i) => i.id === tiles())).toMatchObject({
      quantity: '5',
      fromMeasurement: false,
    })
    expect(quote.totals.netCents).toBe(34_971 + 25_000)
    // Typing a quantity by hand ends the link to the measurement.
    const manual = await admin.patch(`/api/v1/documents/${quote.id}/items/${wall()}`, {
      quantity: '35',
    })
    expect(manual.json().items.find((i: { id: string }) => i.id === wall()).fromMeasurement).toBe(
      false,
    )
    const empty = (
      await admin.post(`/api/v1/projects/${projectId}/documents`, { type: 'quote' })
    ).json()
    expect((await admin.post(`/api/v1/documents/${empty.id}/apply-measurements`)).statusCode).toBe(
      409,
    )
  })

  it('site workers measure on their projects but cannot change documents', async () => {
    expect((await worker.get(`/api/v1/projects/${projectId}/measurement-sheets`)).statusCode).toBe(
      404,
    )
    await admin.patch(`/api/v1/projects/${projectId}`, { memberIds: [workerId] })
    expect((await worker.get(sheetUrl())).statusCode).toBe(200)
    const own = await worker.post(`/api/v1/projects/${projectId}/measurement-sheets`, {
      kind: 'performance',
    })
    expect(own.statusCode).toBe(201)
    expect(own.json().title).toBe('Leistungsaufmaß 1')
    const line = await worker.post(`/api/v1/measurement-sheets/${own.json().id}/lines`, {
      formula: '12,5',
      documentItemId: wall(),
    })
    expect(line.statusCode).toBe(201)
    // Leistungsaufmaß and Angebotsaufmaß are summed separately.
    expect(line.json().items[0].item.measuredQuantity).toBe('12.5')
    expect((await worker.post(`/api/v1/documents/${quote.id}/apply-measurements`)).statusCode).toBe(
      403,
    )
  })

  it('locks the sheet after the joint measurement is signed (gemeinsames Aufmaß)', async () => {
    const empty = (
      await admin.post(`/api/v1/projects/${projectId}/measurement-sheets`, { kind: 'survey' })
    ).json()
    const emptySign = await admin.post(`/api/v1/measurement-sheets/${empty.id}/sign`, {
      contractorName: 'Chef',
      clientName: 'Frau Müller',
    })
    expect(emptySign.statusCode).toBe(409)
    expect((await admin.delete(`/api/v1/measurement-sheets/${empty.id}`)).statusCode).toBe(204)

    const res = await admin.post(`${sheetUrl()}/sign`, {
      contractorName: 'Chef',
      clientName: 'Frau Müller',
    })
    expect(res.statusCode).toBe(200)
    sheet = res.json()
    expect(sheet).toMatchObject({
      status: 'signed',
      signedByContractor: 'Chef',
      signedByClient: 'Frau Müller',
    })
    expect(sheet.signedAt).toMatch(/Z$/)
    expect(sheet.lines.every((l) => l.locked)).toBe(true)
    for (const attempt of [
      await admin.post(`${sheetUrl()}/lines`, { formula: '1' }),
      await admin.patch(`${sheetUrl()}/lines/${sheet.lines[0]?.id}`, { formula: '1' }),
      await admin.post(`${sheetUrl()}/locations`, { name: 'Flur' }),
      await admin.patch(sheetUrl(), { title: 'Neu' }),
      await admin.delete(sheetUrl()),
    ]) {
      expect(attempt.statusCode).toBe(409)
      expect(attempt.json().detail).toMatch(/unterschrieben/)
    }
    await expect(
      withTenant(
        h.sql,
        { tenantId },
        (tx) => tx`update measurement_location set name = 'x' where sheet_id = ${sheet.id}`,
      ),
    ).rejects.toThrow(/signed/)
  })

  it('writes measurement changes to the audit log', async () => {
    const events = await withTenant(
      h.sql,
      { tenantId },
      (tx) => tx<{ entity: string; action: string }[]>`
        select distinct entity, action from audit_event where entity like 'measurement%' order by 1, 2`,
    )
    expect(events).toEqual(
      expect.arrayContaining([
        { entity: 'measurement_line', action: 'insert' },
        { entity: 'measurement_line', action: 'update' },
        { entity: 'measurement_line', action: 'delete' },
        { entity: 'measurement_sheet', action: 'update' },
      ]),
    )
  })
})
