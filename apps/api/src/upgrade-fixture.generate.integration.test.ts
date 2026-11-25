import { writeFileSync } from 'node:fs'
import { withTenant } from '@easybau/db'
import type { DocumentDetail } from '@easybau/schemas'
import { describe, expect, it } from 'vitest'
import { Client, createHarness } from './testing/harness.js'

/**
 * Generator for the data of the migration upgrade test (packages/db/src/upgrade.integration.test.ts).
 * Runs only by hand, before a release (see packages/db/fixtures/README.md):
 *
 *   UPGRADE_FIXTURE_OUT=/tmp/db-name DATABASE_URL=… pnpm vitest run apps/api/src/upgrade-fixture
 *
 * It fills one database through the real API with what a firm has after a few weeks – two firms,
 * contacts, Stammdaten with a DATANORM catalog, quote → order → measurement → invoices (progress,
 * final, cancellation), payments, a dunning notice, a change order accepted in part, a signed
 * report, an incoming e-invoice with cost allocation – and keeps the database for pg_dump.
 */
const out = process.env.UPGRADE_FIXTURE_OUT

const UBL = (number: string) => `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"
  xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"
  xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
  <cbc:CustomizationID>urn:cen.eu:en16931:2017#compliant#urn:xeinkauf.de:kosit:xrechnung_3.0</cbc:CustomizationID>
  <cbc:ID>${number}</cbc:ID>
  <cbc:IssueDate>2026-11-03</cbc:IssueDate>
  <cbc:DueDate>2026-11-17</cbc:DueDate>
  <cbc:InvoiceTypeCode>380</cbc:InvoiceTypeCode>
  <cbc:DocumentCurrencyCode>EUR</cbc:DocumentCurrencyCode>
  <cbc:BuyerReference>Lindenweg</cbc:BuyerReference>
  <cac:AccountingSupplierParty><cac:Party>
    <cbc:EndpointID schemeID="EM">rechnung@trockenbau.example</cbc:EndpointID>
    <cac:PartyName><cbc:Name>Trockenbau Süd GmbH</cbc:Name></cac:PartyName>
    <cac:PostalAddress><cbc:StreetName>Gipsweg 3</cbc:StreetName><cbc:CityName>Hildesheim</cbc:CityName>
      <cbc:PostalZone>31134</cbc:PostalZone><cac:Country><cbc:IdentificationCode>DE</cbc:IdentificationCode></cac:Country></cac:PostalAddress>
    <cac:PartyTaxScheme><cbc:CompanyID>DE 123 456 789</cbc:CompanyID><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:PartyTaxScheme>
  </cac:Party></cac:AccountingSupplierParty>
  <cac:AccountingCustomerParty><cac:Party><cac:PartyName><cbc:Name>Muster Bau GmbH</cbc:Name></cac:PartyName></cac:Party></cac:AccountingCustomerParty>
  <cac:PaymentMeans><cbc:PaymentMeansCode>58</cbc:PaymentMeansCode>
    <cac:PayeeFinancialAccount><cbc:ID>DE02120300000000202051</cbc:ID></cac:PayeeFinancialAccount></cac:PaymentMeans>
  <cac:TaxTotal><cbc:TaxAmount currencyID="EUR">190.00</cbc:TaxAmount>
    <cac:TaxSubtotal><cbc:TaxableAmount currencyID="EUR">1000.00</cbc:TaxableAmount><cbc:TaxAmount currencyID="EUR">190.00</cbc:TaxAmount>
      <cac:TaxCategory><cbc:ID>S</cbc:ID><cbc:Percent>19</cbc:Percent><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:TaxCategory>
    </cac:TaxSubtotal></cac:TaxTotal>
  <cac:LegalMonetaryTotal><cbc:LineExtensionAmount currencyID="EUR">1000.00</cbc:LineExtensionAmount>
    <cbc:TaxExclusiveAmount currencyID="EUR">1000.00</cbc:TaxExclusiveAmount>
    <cbc:TaxInclusiveAmount currencyID="EUR">1190.00</cbc:TaxInclusiveAmount>
    <cbc:PayableAmount currencyID="EUR">1190.00</cbc:PayableAmount></cac:LegalMonetaryTotal>
  <cac:InvoiceLine><cbc:ID>1</cbc:ID><cbc:InvoicedQuantity unitCode="MTK">80</cbc:InvoicedQuantity>
    <cbc:LineExtensionAmount currencyID="EUR">1000.00</cbc:LineExtensionAmount>
    <cac:Item><cbc:Name>Trockenbauwände</cbc:Name><cac:ClassifiedTaxCategory><cbc:ID>S</cbc:ID><cbc:Percent>19</cbc:Percent>
      <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:ClassifiedTaxCategory></cac:Item>
    <cac:Price><cbc:PriceAmount currencyID="EUR">12.50</cbc:PriceAmount></cac:Price></cac:InvoiceLine>
</Invoice>`

describe.skipIf(!process.env.DATABASE_URL || !out)('Upgrade fixture (generator)', () => {
  it('fills a database through the API and keeps it', async () => {
    const h = await createHarness({ requireAdminMfa: false })
    const admin = new Client(h.app)
    const at = (iso: string) => {
      h.clock.now = Date.parse(`${iso}T10:00:00Z`)
    }
    const ok = async (res: Promise<{ statusCode: number; body: string; json: () => unknown }>) => {
      const r = await res
      expect(r.statusCode, r.body).toBeLessThan(300)
      return r.json() as Record<string, unknown> & { id: string }
    }
    const doc = (r: unknown) => r as DocumentDetail

    at('2026-10-01')
    await ok(
      admin.post('/api/v1/setup', {
        setupToken: h.setupToken,
        company: { name: 'Muster Bau GmbH' },
        admin: {
          email: 'chef@muster-bau.example',
          password: 'ein-sehr-langes-passwort',
          displayName: 'Erika Meister',
        },
      }),
    )
    await ok(
      admin.patch('/api/v1/settings/company', {
        street: 'Werkstraße 2',
        postalCode: '30169',
        city: 'Hannover',
        taxNumber: '25/123/45678',
        iban: 'DE89370400440532013000',
        bankName: 'Sparkasse Hannover',
        email: 'buero@muster-bau.example',
      }),
    )
    const units = (await admin.get('/api/v1/units')).json() as { id: string; symbol: string }[]
    const unit = (symbol: string) => units.find((u) => u.symbol === symbol)?.id as string

    // Kontakte
    const customer = await ok(
      admin.post('/api/v1/contacts', {
        kind: 'organization',
        organizationName: 'Wohnbau Nord eG',
        assignCustomerNumber: true,
        addresses: [{ kind: 'main', street: 'Lindenweg 4', postalCode: '30159', city: 'Hannover' }],
        channels: [{ kind: 'email', value: 'einkauf@wohnbau-nord.example' }],
      }),
    )
    await ok(
      admin.post('/api/v1/contacts', {
        kind: 'person',
        firstName: 'Max',
        lastName: 'Mustermann',
        assignCustomerNumber: true,
        addresses: [{ kind: 'main', street: 'Musterweg 1', postalCode: '30159', city: 'Hannover' }],
        channels: [{ kind: 'phone', value: '0511 987654' }],
      }),
    )

    // Stammdaten und DATANORM-Katalog
    await ok(
      admin.post('/api/v1/catalog/items', {
        kind: 'material',
        shortText: 'Dispersionsfarbe weiß 12,5 l',
        unitId: unit('Eimer'),
        costCents: 3500,
        markupPercent: '20',
      }),
    )
    await ok(
      admin.upload(
        '/api/v1/supplier-catalogs/import?filename=NORD.001',
        Buffer.from(
          [
            'V;050;01102026;Baustoff Nord GmbH;Testkatalog;;EUR',
            'A;N;4711;00;Tiefengrund;10 l;1;0;Eim;2899;R10;MAL;T4711',
            'T;N;T4711;1;0;Lösemittelfrei;2;0;für innen',
            'R;N;R10;1;2500;Malerbedarf',
          ].join('\r\n'),
        ),
      ),
    )

    // Projekt: Angebot → AB → Aufmaß → Abschlag → Schlussrechnung
    const project = await ok(
      admin.post('/api/v1/projects', { name: 'Sanierung Lindenweg', customerId: customer.id }),
    )
    const projectId = project.id
    const create = (body: Record<string, unknown>) =>
      ok(admin.post(`/api/v1/projects/${projectId}/documents`, body)).then(doc)
    const addItem = (id: string, body: Record<string, unknown>) =>
      ok(admin.post(`/api/v1/documents/${id}/items`, { positionType: 'item', ...body })).then(doc)
    const finalize = (id: string) =>
      ok(admin.post(`/api/v1/documents/${id}/finalize`, { acknowledgeWarnings: true })).then(doc)
    const dates = (id: string, documentDate: string) =>
      ok(
        admin.patch(`/api/v1/documents/${id}`, {
          documentDate,
          serviceFrom: '2026-10-01',
          serviceTo: documentDate,
          paymentDueDays: 14,
        }),
      )

    const quote = await create({ type: 'quote' })
    await addItem(quote.id, {
      shortText: 'Wand streichen',
      quantity: '120',
      unitId: unit('m²'),
      unitPriceCents: 1200,
    })
    await addItem(quote.id, {
      shortText: 'Fliesen verlegen',
      quantity: '20',
      unitId: unit('m²'),
      unitPriceCents: 5800,
    })
    await finalize(quote.id)
    const ab = await create({ type: 'order_confirmation', sourceDocumentId: quote.id })
    const contract = await finalize(ab.id)

    const sheet = await ok(
      admin.post(`/api/v1/projects/${projectId}/measurement-sheets`, { kind: 'performance' }),
    )
    const wall = contract.items.find((i) => i.shortText === 'Wand streichen')?.id
    await ok(
      admin.post(`/api/v1/measurement-sheets/${sheet.id}/lines`, {
        formula: '2,5 * (4 + 3,5) * 2',
        documentItemId: wall,
      }),
    )

    at('2026-10-20')
    const progress = await create({
      type: 'invoice',
      invoiceKind: 'progress',
      sourceDocumentId: ab.id,
    })
    await ok(admin.post(`/api/v1/documents/${progress.id}/apply-measurements`))
    await dates(progress.id, '2026-10-20')
    const progressDone = await finalize(progress.id)
    at('2026-10-28')
    await ok(
      admin.post(`/api/v1/documents/${progressDone.id}/payments`, {
        paidOn: '2026-10-28',
        amountCents: progressDone.totals.grossCents,
      }),
    )

    // Rechnung mit Storno und Korrektur
    const wrong = await create({ type: 'invoice', invoiceKind: 'standard' })
    await addItem(wrong.id, {
      shortText: 'Regiestunden',
      quantity: '6',
      unitId: unit('Std'),
      unitPriceCents: 6500,
    })
    await dates(wrong.id, '2026-10-22')
    const wrongDone = await finalize(wrong.id)
    await ok(admin.post(`/api/v1/documents/${wrongDone.id}/cancel`, { reason: 'Falscher Kunde' }))

    // Überfällige Rechnung mit Zahlungserinnerung
    const overdue = await create({ type: 'invoice', invoiceKind: 'standard' })
    await addItem(overdue.id, {
      shortText: 'Gerüst Standzeit',
      quantity: '1',
      unitId: unit('psch'),
      unitPriceCents: 48000,
    })
    await dates(overdue.id, '2026-10-23')
    const overdueDone = await finalize(overdue.id)
    at('2026-11-20')
    await ok(admin.post(`/api/v1/documents/${overdueDone.id}/dunning`, {}))

    // Nachtrag, teilweise beauftragt
    const order = await create({ type: 'change_order', basis: 'additional_work' })
    const co1 = await addItem(order.id, {
      shortText: 'Zusätzliche Steckdosen',
      quantity: '4',
      unitId: unit('Stk.'),
      unitPriceCents: 4500,
    })
    await addItem(order.id, {
      shortText: 'Leitung verlegen',
      quantity: '12',
      unitId: unit('m'),
      unitPriceCents: 900,
    })
    await finalize(order.id)
    await ok(
      admin.post(`/api/v1/documents/${order.id}/status`, {
        status: 'partially_accepted',
        acceptedItemIds: [co1.items.find((i) => i.shortText === 'Zusätzliche Steckdosen')?.id],
      }),
    )

    // Bautagebuch, unterschrieben
    const report = await ok(
      admin.post(`/api/v1/projects/${projectId}/reports`, { reportDate: '2026-11-19' }),
    )
    await ok(
      admin.post(`/api/v1/reports/${report.id}/sign`, {
        signatures: [{ role: 'contractor', name: 'Erika Meister' }],
      }),
    )

    // Schlussrechnung
    const final = await create({ type: 'invoice', invoiceKind: 'final', sourceDocumentId: ab.id })
    await ok(admin.post(`/api/v1/documents/${final.id}/apply-measurements`))
    await dates(final.id, '2026-11-20')
    await finalize(final.id)

    // Eingangsrechnung mit Kostenzuweisung
    const incoming = await ok(
      admin.upload(
        '/api/v1/incoming-invoices?filename=trockenbau.xml',
        Buffer.from(UBL('TS-2026-77')),
      ),
    )
    const current = await admin.get(`/api/v1/incoming-invoices/${incoming.id}`)
    await ok(
      admin.patch(
        `/api/v1/incoming-invoices/${incoming.id}`,
        {
          allocations: [
            { projectId, costType: 'subcontract', ratePercent: '19', netCents: 100_000 },
          ],
        },
        { 'if-match': current.headers.etag as string },
      ),
    )
    await ok(admin.post(`/api/v1/incoming-invoices/${incoming.id}/confirm`, {}))

    // Zweite Firma (Mandantentrennung), wie createTenant() in @easybau/db/test-support
    const [ids] = (await h.sql`select uuid_v7() as tenant, uuid_v7() as "user"`) as unknown as [
      { tenant: string; user: string },
    ]
    await h.sql`insert into app_user (id, email, display_name)
      values (${ids.user}, 'inhaber@zweitbetrieb.example', 'Jonas Zweit')`
    await withTenant(h.sql, { tenantId: ids.tenant, userId: ids.user }, async (tx) => {
      await tx`insert into tenant (id, name) values (${ids.tenant}, 'Zweitbetrieb Malerei')`
      await tx`select seed_tenant_defaults()`
      await tx`insert into membership (tenant_id, user_id, role_id)
        select ${ids.tenant}, ${ids.user}, id from role where key = 'admin'`
      await tx`insert into contact (tenant_id, kind, organization_name)
        values (${ids.tenant}, 'organization', 'Hausverwaltung Süd')`
    })

    const [{ name }] = (await h.sql`select current_database() as name`) as unknown as [
      { name: string },
    ]
    writeFileSync(out as string, name)
    // Deliberately no h.close(): it would drop the database before pg_dump.
    await h.app.close()
  }, 120_000)
})
