import { withTenant } from '@opc/db'
import type { NumberSequence, PaymentTerm, UnitSetting, WageGroup } from '@opc/schemas'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client, createHarness, type Harness } from './testing/harness.js'

describe.skipIf(!process.env.DATABASE_URL)('Einstellungen (integration)', () => {
  let h: Harness
  let admin: Client
  let worker: Client
  let tenantId: string

  beforeAll(async () => {
    h = await createHarness({ requireAdminMfa: false })
    admin = new Client(h.app)
    const setup = await admin.post('/api/v1/setup', {
      setupToken: h.setupToken,
      company: { name: 'Einstell Bau GmbH' },
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
  })

  afterAll(async () => {
    await h?.close()
  })

  it('edits company data and stores the IBAN encrypted', async () => {
    const res = await admin.patch('/api/v1/settings/company', {
      legalForm: 'GmbH',
      street: 'Werkstraße 2',
      postalCode: '30169',
      city: 'Hannover',
      vatId: 'DE123456789',
      registerCourt: 'Amtsgericht Hannover',
      registerNumber: 'HRB 12345',
      managerName: 'Erika Meister',
      iban: 'DE89 3704 0044 0532 0130 00',
      bic: 'COBADEFFXXX',
    })
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json()).toMatchObject({
      name: 'Einstell Bau GmbH',
      iban: 'DE89370400440532013000',
      city: 'Hannover',
    })
    const [row] = await withTenant(
      h.sql,
      { tenantId },
      (tx) => tx<{ enc: Buffer }[]>`select iban_enc as enc from tenant where id = ${tenantId}`,
    )
    expect(row?.enc.toString('latin1')).not.toContain('DE89')
    expect(
      (await admin.patch('/api/v1/settings/company', { iban: 'DE89370400440532013001' })).json()
        .errors,
    ).toEqual({
      iban: 'Die Prüfziffer der IBAN stimmt nicht.',
    })
    expect((await admin.patch('/api/v1/settings/company', { name: '' })).statusCode).toBe(400)
  })

  it('is closed to site roles', async () => {
    expect((await worker.get('/api/v1/settings/company')).statusCode).toBe(403)
    expect((await worker.patch('/api/v1/settings/surcharges', { labor: '10' })).statusCode).toBe(
      403,
    )
  })

  it('configures number sequences but never lets invoice numbers go back', async () => {
    let list: NumberSequence[] = (await admin.get('/api/v1/settings/number-sequences')).json()
    expect(list.find((s) => s.kind === 'invoice')).toMatchObject({
      prefix: 'R-',
      nextValue: 101,
      preview: 'R-00101',
    })
    const res = await admin.patch('/api/v1/settings/number-sequences/invoice', {
      prefix: 'RE-',
      includeYear: true,
      nextValue: 500,
    })
    expect(res.json()).toMatchObject({ prefix: 'RE-', nextValue: 500 })
    expect(res.json().preview).toMatch(/^RE-\d{4}-00500$/)
    const back = await admin.patch('/api/v1/settings/number-sequences/invoice', { nextValue: 100 })
    expect(back.json().errors.nextValue).toMatch(/nicht zurückgesetzt/)
    expect(
      (await admin.patch('/api/v1/settings/number-sequences/quote', { nextValue: 1 })).statusCode,
    ).toBe(200)
    list = (await admin.get('/api/v1/settings/number-sequences')).json()
    expect(list.map((s) => s.kind)).toEqual([
      'contact',
      'project',
      'quote',
      'cost_estimate',
      'order_confirmation',
      'delivery_note',
      'invoice',
      'credit_note',
    ])
  })

  it('manages payment terms with exactly one default', async () => {
    const created = await admin.post('/api/v1/settings/payment-terms', {
      name: '14 Tage, 2 % Skonto bei 7 Tagen',
      dueDays: 14,
      cashDiscountPercent: '2',
      cashDiscountDays: 7,
      isDefault: true,
    })
    expect(created.statusCode, created.body).toBe(201)
    const terms: PaymentTerm[] = (await admin.get('/api/v1/settings/payment-terms')).json()
    expect(terms.filter((t) => t.isDefault).map((t) => t.name)).toEqual([
      '14 Tage, 2 % Skonto bei 7 Tagen',
    ])
    expect(
      (await admin.delete(`/api/v1/settings/payment-terms/${created.json().id}`)).statusCode,
    ).toBe(409)
    const other = terms.find((t) => !t.isDefault) as PaymentTerm
    expect((await admin.delete(`/api/v1/settings/payment-terms/${other.id}`)).statusCode).toBe(204)
    // New invoices use the default term.
    const project = (await admin.post('/api/v1/projects', { name: 'P' })).json()
    const invoice = (
      await admin.post(`/api/v1/projects/${project.id}/documents`, {
        type: 'invoice',
        invoiceKind: 'standard',
      })
    ).json()
    expect(invoice.paymentDueDays).toBe(14)
  })

  it('adds tax rates but keeps rate and category of existing ones', async () => {
    const res = await admin.post('/api/v1/settings/tax-rates', {
      name: 'Sonderfall 10,7 %',
      percent: '10,7',
      categoryCode: 'S',
    })
    expect(res.json()).toMatchObject({ percent: '10.7', isDefault: false })
    const change = await admin.patch(`/api/v1/settings/tax-rates/${res.json().id}`, {
      percent: '11',
    })
    expect(change.statusCode).toBe(400)
  })

  it('sets surcharges and wage groups with the hourly rate', async () => {
    const surcharges = await admin.patch('/api/v1/settings/surcharges', {
      labor: '10',
      material: '20',
    })
    expect(surcharges.json()).toMatchObject({ labor: '10', material: '20', equipment: '0' })
    const res = await admin.post('/api/v1/settings/wage-groups', {
      name: 'Geselle',
      costPerHourCents: 4000,
      markupPercent: '25',
    })
    const group: WageGroup = res.json()
    expect(group).toMatchObject({ name: 'Geselle', hourlyRateCents: 5000, isActive: true })
    const changed = await admin.patch(`/api/v1/settings/wage-groups/${group.id}`, {
      costPerHourCents: 4400,
    })
    expect(changed.json().hourlyRateCents).toBe(5500)
    expect(
      (await admin.post('/api/v1/settings/wage-groups', { name: 'Geselle', costPerHourCents: 1 }))
        .statusCode,
    ).toBe(400)
  })

  it('adds own units with UN/ECE code; system units keep symbol and code', async () => {
    const res = await admin.post('/api/v1/settings/units', {
      symbol: 'Fass',
      name: 'Fass',
      dimension: 'container',
      uneceCode: 'dr',
      decimals: 0,
    })
    expect(res.json()).toMatchObject({ symbol: 'Fass', uneceCode: 'DR', isSystem: false })
    const units: UnitSetting[] = (await admin.get('/api/v1/settings/units')).json()
    const m3 = units.find((u) => u.symbol === 'm³') as UnitSetting
    expect(
      (await admin.patch(`/api/v1/settings/units/${m3.id}`, { uneceCode: 'XYZ' })).statusCode,
    ).toBe(400)
    expect(
      (await admin.patch(`/api/v1/settings/units/${m3.id}`, { decimals: 2 })).json().decimals,
    ).toBe(2)
    expect(
      (await admin.post('/api/v1/settings/units', { symbol: 'x', name: 'x', dimension: 'count' }))
        .statusCode,
    ).toBe(400)
  })

  it('stores working hours, used to prefill the Bautagebuch', async () => {
    const days = Array.from({ length: 7 }, (_, i) => ({
      weekday: i + 1,
      startTime: i < 5 ? '06:30' : i === 5 ? '07:00' : null,
      endTime: i < 5 ? '15:30' : i === 5 ? '12:00' : null,
      breakMinutes: i < 5 ? 30 : 0,
    }))
    expect((await admin.put('/api/v1/settings/working-hours', days)).statusCode).toBe(200)
    const saved = (await admin.get('/api/v1/settings/working-hours')).json()
    expect(saved[5]).toEqual({ weekday: 6, startTime: '07:00', endTime: '12:00', breakMinutes: 0 })
    expect(saved[6]).toEqual({ weekday: 7, startTime: null, endTime: null, breakMinutes: 0 })
    const bad = await admin.put('/api/v1/settings/working-hours', [
      { weekday: 1, startTime: '16:00', endTime: '07:00', breakMinutes: 0 },
    ])
    expect(bad.statusCode).toBe(400)
  })

  it('uses default text templates for new documents', async () => {
    const res = await admin.post('/api/v1/settings/text-templates', {
      documentType: 'quote',
      placement: 'intro',
      name: 'Standard',
      body: 'Sehr geehrte Damen und Herren,\nvielen Dank für Ihre Anfrage.',
      isDefault: true,
    })
    expect(res.statusCode, res.body).toBe(201)
    const project = (await admin.post('/api/v1/projects', { name: 'Texte' })).json()
    const quote = (
      await admin.post(`/api/v1/projects/${project.id}/documents`, { type: 'quote' })
    ).json()
    expect(quote.introText).toBe('Sehr geehrte Damen und Herren,\nvielen Dank für Ihre Anfrage.')
    expect(
      (await admin.delete(`/api/v1/settings/text-templates/${res.json().id}`)).statusCode,
    ).toBe(204)
  })

  it('changes the filing folders for new projects', async () => {
    const res = await admin.put('/api/v1/settings/filing-template', {
      folders: ['Pläne', 'Fotos', 'Abnahme', 'fotos'],
    })
    expect(res.json()).toEqual({ folders: ['Pläne', 'fotos', 'Abnahme'] })
    const project = (await admin.post('/api/v1/projects', { name: 'Ordner' })).json()
    const folders = (await admin.get(`/api/v1/projects/${project.id}/folders`)).json()
    expect(folders.map((f: { name: string }) => f.name)).toEqual(['Pläne', 'fotos', 'Abnahme'])
  })

  it('stores the DATEV settings', async () => {
    expect((await admin.get('/api/v1/settings/datev')).json()).toMatchObject({
      chart: 'SKR03',
      accountLength: 4,
    })
    const res = await admin.put('/api/v1/settings/datev', {
      consultantNumber: '1234567',
      clientNumber: '10001',
      chart: 'SKR04',
      fiscalYearStartMonth: 1,
      accountLength: 4,
      revenueAccounts: { standard19: '4400' },
      bankAccount: '1800',
    })
    expect(res.json()).toMatchObject({ chart: 'SKR04', consultantNumber: '1234567' })
    expect((await admin.put('/api/v1/settings/datev', { chart: 'SKR99' })).statusCode).toBe(400)
  })
})
