import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { withTenant } from '@opc/db'
import type { DocumentDetail } from '@opc/schemas'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client, createHarness, type Harness } from './testing/harness.js'

const PDF = Buffer.from('%PDF-1.7\n1 0 obj << >> endobj\n%%EOF\n')

/** XRechnung (UBL) of a supplier: 1.000 € + 19 % for materials. */
const SUPPLIER_INVOICE = `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"
  xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"
  xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
  <cbc:CustomizationID>urn:cen.eu:en16931:2017#compliant#urn:xeinkauf.de:kosit:xrechnung_3.0</cbc:CustomizationID>
  <cbc:ID>ER-4711</cbc:ID><cbc:IssueDate>2026-11-03</cbc:IssueDate><cbc:InvoiceTypeCode>380</cbc:InvoiceTypeCode>
  <cbc:DocumentCurrencyCode>EUR</cbc:DocumentCurrencyCode>
  <cac:AccountingSupplierParty><cac:Party><cac:PartyName><cbc:Name>Baustoff/Nord GmbH</cbc:Name></cac:PartyName></cac:Party></cac:AccountingSupplierParty>
  <cac:TaxTotal><cbc:TaxAmount currencyID="EUR">190.00</cbc:TaxAmount><cac:TaxSubtotal>
    <cbc:TaxableAmount currencyID="EUR">1000.00</cbc:TaxableAmount><cbc:TaxAmount currencyID="EUR">190.00</cbc:TaxAmount>
    <cac:TaxCategory><cbc:ID>S</cbc:ID><cbc:Percent>19</cbc:Percent></cac:TaxCategory></cac:TaxSubtotal></cac:TaxTotal>
  <cac:LegalMonetaryTotal><cbc:TaxExclusiveAmount currencyID="EUR">1000.00</cbc:TaxExclusiveAmount>
    <cbc:TaxInclusiveAmount currencyID="EUR">1190.00</cbc:TaxInclusiveAmount></cac:LegalMonetaryTotal>
</Invoice>`

/** Lists the entries of a ZIP (central directory) without extracting. */
function zipEntries(zip: Buffer): Map<string, Buffer> {
  const entries = new Map<string, Buffer>()
  const eocd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  const count = zip.readUInt16LE(eocd + 10)
  let p = zip.readUInt32LE(eocd + 16)
  for (let i = 0; i < count; i++) {
    const size = zip.readUInt32LE(p + 24)
    const nameLen = zip.readUInt16LE(p + 28)
    const extraLen = zip.readUInt16LE(p + 30)
    const commentLen = zip.readUInt16LE(p + 32)
    const local = zip.readUInt32LE(p + 42)
    const name = zip.toString('utf8', p + 46, p + 46 + nameLen)
    const localName = zip.readUInt16LE(local + 26)
    const localExtra = zip.readUInt16LE(local + 28)
    const start = local + 30 + localName + localExtra
    entries.set(name, zip.subarray(start, start + size))
    p += 46 + nameLen + extraLen + commentLen
  }
  return entries
}

describe.skipIf(!process.env.DATABASE_URL)('Exporte (integration)', () => {
  let h: Harness
  let admin: Client
  let worker: Client
  let tenantId: string
  let projectId: string

  const finalize = (id: string, number: string, date: string) =>
    withTenant(
      h.sql,
      { tenantId },
      (tx) => tx`
      update document set status = 'finalized', finalized_at = now(), number = ${number},
             document_date = ${date}::date, content_hash = sha256(${number}::bytea),
             recipient_snapshot = '{"name":"Wohnbau Nord eG","lines":["Lindenweg 4","30159 Hannover"]}',
             issuer_snapshot = '{"name":"Export Bau GmbH","lines":["Werkstraße 2","30169 Hannover"],"contact":[],"legal":[]}'
      where id = ${id}`,
    )

  beforeAll(async () => {
    h = await createHarness({ requireAdminMfa: false })
    admin = new Client(h.app)
    const setup = await admin.post('/api/v1/setup', {
      setupToken: h.setupToken,
      company: { name: 'Export Bau GmbH' },
      admin: {
        email: 'chef@example.test',
        password: 'ein-sehr-langes-passwort',
        displayName: 'Chef',
      },
    })
    tenantId = setup.json().tenant.id
    await admin.patch('/api/v1/settings/company', {
      city: 'Hannover',
      iban: 'DE89 3704 0044 0532 0130 00',
    })
    const customer = await admin.post('/api/v1/contacts', {
      kind: 'organization',
      organizationName: 'Wohnbau Nord eG',
      assignCustomerNumber: true,
    })
    expect(customer.statusCode, customer.body).toBe(201)
    const project = await admin.post('/api/v1/projects', {
      name: 'Sanierung Lindenweg',
      customerId: customer.json().id,
    })
    projectId = project.json().id
    const units = (await admin.get('/api/v1/units')).json() as { id: string; symbol: string }[]
    const unit = (s: string) => units.find((u) => u.symbol === s)?.id

    const invoice = (
      await admin.post(`/api/v1/projects/${projectId}/documents`, {
        type: 'invoice',
        invoiceKind: 'standard',
      })
    ).json() as DocumentDetail
    for (const item of [
      { shortText: 'Wand streichen', quantity: '10', unitId: unit('m²'), unitPriceCents: 4500 },
      {
        shortText: 'Fachbuch',
        quantity: '1',
        unitId: unit('Stk.'),
        unitPriceCents: 2000,
        taxRatePercent: '7',
      },
    ]) {
      const res = await admin.post(`/api/v1/documents/${invoice.id}/items`, {
        positionType: 'item',
        ...item,
      })
      expect(res.statusCode, res.body).toBe(201)
    }
    await finalize(invoice.id, 'R-00101', '2026-11-05')
    // A draft is never exported.
    await admin.post(`/api/v1/projects/${projectId}/documents`, {
      type: 'invoice',
      invoiceKind: 'standard',
    })
    await withTenant(
      h.sql,
      { tenantId },
      (tx) => tx`
      insert into payment (tenant_id, invoice_id, paid_on, amount_cents, method, reference)
      values (${tenantId}, ${invoice.id}, '2026-11-20', 30000, 'transfer', 'R-00101 Teil')`,
    )
    // Accepted Kürzung goes to DATEV; Skonto and a bestrittene Kürzung do not.
    await withTenant(
      h.sql,
      { tenantId },
      (tx) => tx`
      insert into receivable_adjustment (tenant_id, invoice_id, kind, amount_cents, reason, disputed, created_at)
      values (${tenantId}, ${invoice.id}, 'other', 1070, 'Rabatt Mängel', false, '2026-11-21T10:00:00+01:00'),
             (${tenantId}, ${invoice.id}, 'cash_discount', 500, null, false, '2026-11-21T10:00:00+01:00'),
             (${tenantId}, ${invoice.id}, 'short_payment', 300, 'Kürzung strittig', true, '2026-11-21T10:00:00+01:00')`,
    )

    const folders = (await admin.get(`/api/v1/projects/${projectId}/folders`)).json() as {
      id: string
      name: string
    }[]
    const upload = await admin.upload(
      `/api/v1/projects/${projectId}/files?filename=${encodeURIComponent('Plan EG.pdf')}&folderId=${folders[0]?.id}`,
      PDF,
    )
    expect(upload.statusCode, upload.body).toBe(201)

    // A received invoice (Eingangsrechnung), allocated to the project, confirmed and paid.
    const received = await admin.upload(
      '/api/v1/incoming-invoices?filename=er.xml',
      Buffer.from(SUPPLIER_INVOICE),
    )
    expect(received.statusCode, received.body).toBe(201)
    const allocated = await admin.patch(
      `/api/v1/incoming-invoices/${received.json().id}`,
      { allocations: [{ projectId, costType: 'material', ratePercent: '19', netCents: 100_000 }] },
      { 'if-match': received.headers.etag as string },
    )
    expect(allocated.json().problems).toEqual([])
    await admin.post(`/api/v1/incoming-invoices/${received.json().id}/confirm`, {})
    await admin.post(`/api/v1/incoming-invoices/${received.json().id}/payment`, {
      paidOn: '2026-11-07',
    })

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

  const period = '?from=2026-11-01&to=2026-11-30'

  it('needs consultant and client number for DATEV', async () => {
    const res = await admin.get(`/api/v1/exports/datev${period}`)
    expect(res.statusCode).toBe(409)
    expect(res.json().detail).toContain('Mandantennummer')
    expect(
      (await admin.get('/api/v1/exports/datev?from=2026-11-30&to=2026-11-01')).statusCode,
    ).toBe(400)
  })

  it('writes a DATEV Buchungsstapel per tax rate with the payment and accepted Kürzungen', async () => {
    const put = await admin.put('/api/v1/settings/datev', {
      consultantNumber: '1234567',
      clientNumber: '10001',
      chart: 'SKR03',
      fiscalYearStartMonth: 1,
      accountLength: 4,
      revenueAccounts: {},
      bankAccount: null,
    })
    expect(put.statusCode, put.body).toBe(200)
    const res = await admin.get(`/api/v1/exports/datev${period}`)
    expect(res.statusCode, res.body).toBe(200)
    expect(res.headers['content-type']).toBe('text/csv; charset=windows-1252')
    expect(res.headers['content-disposition']).toContain(
      'EXTF_Buchungsstapel_2026-11-01_2026-11-30.csv',
    )
    const lines = res.rawPayload.toString('latin1').trim().split('\r\n')
    expect(lines[0]).toMatch(/^"EXTF";700;21;"Buchungsstapel";/)
    expect(lines[0]).toContain(';1234567;10001;20260101;4;20261101;20261130;')
    const bookings = lines.slice(2)
    expect(bookings).toHaveLength(7)
    // Eingangsrechnung: Wareneingang an Sammelkreditor with 19 % Vorsteuer (BU 9), payment Kreditor an Bank.
    expect(bookings).toContain(
      '1190,00;"S";"EUR";;;;3200;70000;"9";0311;"ER-4711";"";;"Baustoff/Nord GmbH"',
    )
    expect(bookings).toContain(
      '1190,00;"S";"EUR";;;;70000;1200;;0711;"ER-4711";"";;"Zahlung Baustoff/Nord GmbH"',
    )
    // 10 × 45,00 € net + 19 % = 535,50 €; 20,00 € + 7 % = 21,40 €; payment 300,00 €
    expect(bookings.join('\n')).toContain('535,50;"S"')
    expect(bookings.join('\n')).toContain('21,40;"S"')
    expect(bookings.join('\n')).toContain('300,00;"S";"EUR";;;;1200;10001;')
    expect(bookings.join('\n')).toContain('"R-00101"')
    expect(bookings.join('\n')).toContain(';8400;')
    expect(bookings.join('\n')).toContain(';8300;')
    expect(bookings.join('\n')).toContain(';1200;')
    // Kürzung 10,70 € split by gross share (535,50 : 21,40), Erlöse an Debitor; no Skonto.
    expect(bookings.join('\n')).toContain('10,29;"S";"EUR";;;;8400;10001;;2111;"R-00101"')
    expect(bookings.join('\n')).toContain('0,41;"S";"EUR";;;;8300;10001;;2111;"R-00101"')
    expect(bookings.join('\n')).not.toContain('5,00;')
    expect(bookings.join('\n')).not.toContain('3,00;')
  })

  it('writes the GoBD Datenträgerüberlassung with index.xml and CSV tables', async () => {
    const res = await admin.get(`/api/v1/exports/gobd${period}`)
    expect(res.statusCode, res.body).toBe(200)
    expect(res.headers['content-type']).toBe('application/zip')
    const zip = zipEntries(res.rawPayload)
    expect([...zip.keys()]).toEqual([
      'index.xml',
      'rechnungen.csv',
      'rechnungspositionen.csv',
      'umsatzsteuer.csv',
      'zahlungen.csv',
      'eingangsrechnungen.csv',
      'eingangsrechnungen_steuer.csv',
      'eingangsrechnungen_zuweisung.csv',
      'kunden.csv',
      'protokoll.csv',
      'belege.csv',
      'belege/R-00101.pdf',
      expect.stringMatching(/^belege\/eingang\/Baustoff_Nord_GmbH_ER-4711_[0-9a-f]{8}\.xml$/),
    ])
    const incoming = zip.get('eingangsrechnungen.csv')?.toString('latin1') ?? ''
    expect(incoming).toContain('"Baustoff/Nord GmbH"')
    expect(incoming).toContain('"ER-4711"')
    expect(incoming).toContain('1190,00')
    expect(incoming).toMatch(/"gepr.{1,2}ft"/)
    expect(zip.get('eingangsrechnungen_zuweisung.csv')?.toString('latin1')).toContain(
      '"Sanierung Lindenweg"',
    )
    expect(zip.get('eingangsrechnungen_zuweisung.csv')?.toString('latin1')).toContain('190,00')
    const receivedOriginal = [...zip.entries()].find(([k]) => k.startsWith('belege/eingang/'))?.[1]
    expect(receivedOriginal?.toString('utf8')).toBe(SUPPLIER_INVOICE)
    const index = zip.get('index.xml')?.toString('utf8') ?? ''
    expect(index).toContain('<!DOCTYPE DataSet SYSTEM "gdpdu-01-09-2004.dtd">')
    expect(index).toContain('<Name>Export Bau GmbH</Name>')
    expect(index).toContain('<URL>rechnungen.csv</URL>')
    const invoices = zip.get('rechnungen.csv')?.toString('latin1') ?? ''
    expect(invoices.trim().split('\r\n')).toHaveLength(1)
    expect(invoices).toContain('"R-00101"')
    expect(invoices).toContain('556,90')
    expect(zip.get('zahlungen.csv')?.toString('latin1')).toContain('300,00')
    expect(zip.get('kunden.csv')?.toString('latin1')).toContain('Wohnbau Nord eG')
    // Belege: the unchanged PDF/A original (created and archived on demand) with its SHA-256.
    const original = zip.get('belege/R-00101.pdf') as Buffer
    expect(original.subarray(0, 5).toString()).toBe('%PDF-')
    const belege = zip.get('belege.csv')?.toString('latin1') ?? ''
    expect(belege).toContain('"belege/R-00101.pdf"')
    expect(belege).toContain(createHash('sha256').update(original).digest('hex'))
    expect(index).toContain('<URL>belege.csv</URL>')
    // The same original on the second export (archived once, never rendered again).
    const again = zipEntries((await admin.get(`/api/v1/exports/gobd${period}`)).rawPayload)
    expect(again.get('belege/R-00101.pdf')?.equals(original)).toBe(true)
  })

  it('adds the PDF originals to the DATEV export on request', async () => {
    const res = await admin.get(`/api/v1/exports/datev${period}&belege=true`)
    expect(res.statusCode, res.body).toBe(200)
    expect(res.headers['content-type']).toBe('application/zip')
    expect(res.headers['content-disposition']).toContain('DATEV_2026-11-01_2026-11-30.zip')
    const zip = zipEntries(res.rawPayload)
    expect([...zip.keys()]).toEqual([
      'EXTF_Buchungsstapel_2026-11-01_2026-11-30.csv',
      'Belege/R-00101.pdf',
      expect.stringMatching(/^Belege\/eingang\/Baustoff_Nord_GmbH_ER-4711_[0-9a-f]{8}\.xml$/),
    ])
    expect(zip.get('EXTF_Buchungsstapel_2026-11-01_2026-11-30.csv')?.toString('latin1')).toMatch(
      /^"EXTF"/,
    )
  })

  it('exports all company data with the Ablage, but without secrets', async () => {
    const res = await admin.get('/api/v1/exports/full')
    expect(res.statusCode, res.body).toBe(200)
    const zip = zipEntries(res.rawPayload)
    const manifest = JSON.parse(zip.get('manifest.json')?.toString('utf8') ?? '{}')
    expect(manifest).toMatchObject({ format: 'openplancraft-export', version: 1 })
    expect(manifest.tables.document).toBe(2)
    expect(manifest.files).toHaveLength(1)
    expect(manifest.tables.incoming_invoice).toBe(1)
    expect(manifest.tables.incoming_invoice_allocation).toBe(1)
    expect(manifest.tables.business_area).toBe(6)
    expect(manifest.belege).toEqual([
      { path: 'belege/R-00101.pdf', sha256: expect.any(String) },
      { path: expect.stringMatching(/^belege\/eingang\//), sha256: expect.any(String) },
    ])
    expect(zip.get('belege/R-00101.pdf')?.subarray(0, 5).toString()).toBe('%PDF-')
    const filePath = manifest.files[0].path as string
    expect(filePath).toMatch(/^ablage\/.+\/.+_Plan EG\.pdf$/)
    expect(zip.get(filePath)?.equals(PDF)).toBe(true)
    const tenant = zip.get('daten/tenant.json')?.toString('utf8') ?? ''
    expect(tenant).toContain('Export Bau GmbH')
    expect(tenant).not.toContain('iban_enc')
    const members = zip.get('daten/member.json')?.toString('utf8') ?? ''
    expect(members).toContain('chef@example.test')
    expect(members).not.toMatch(/password|argon/)

    // The archive is a valid ZIP for standard tools. Info-ZIP and BusyBox (Alpine test image)
    // print different messages, but both exit non-zero on a damaged archive (execFileSync throws).
    const dir = await mkdtemp(join(tmpdir(), 'opc-export-'))
    await writeFile(join(dir, 'export.zip'), res.rawPayload)
    try {
      execFileSync('unzip', ['-tq', join(dir, 'export.zip')], { stdio: 'pipe' })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  })

  it('is closed to site roles and logged in the audit trail', async () => {
    for (const url of ['/api/v1/exports/full', `/api/v1/exports/gobd${period}`]) {
      expect((await worker.get(url)).statusCode).toBe(403)
    }
    const actions = await withTenant(
      h.sql,
      { tenantId },
      (tx) => tx<{ action: string }[]>`
      select action from audit_event where action like 'export:%' order by seq`,
    )
    expect(actions.map((a) => a.action)).toEqual([
      'export:datev',
      'export:gobd',
      'export:gobd',
      'export:datev+belege',
      'export:full',
    ])
  })
})
