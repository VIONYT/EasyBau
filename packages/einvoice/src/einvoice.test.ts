import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { invoice, item, kosit, standardItems, UNIT_CODES } from './fixtures.test-support.js'
import {
  buildEinvoice,
  einvoiceFormatsOf,
  einvoiceFromDocument,
  einvoiceProblems,
  isLeitwegId,
  parseKositReport,
} from './index.js'
import { escapeXml } from './xml.js'

const ctx = { unitCodes: UNIT_CODES, cancelledInvoiceDate: '2026-11-10' }

/** Writes the XML for inspection (EINVOICE_SAMPLE_DIR) and validates it with KoSIT if available. */
async function expectValid(name: string, xml: string) {
  if (process.env.EINVOICE_SAMPLE_DIR) {
    mkdirSync(process.env.EINVOICE_SAMPLE_DIR, { recursive: true })
    writeFileSync(join(process.env.EINVOICE_SAMPLE_DIR, `${name}.xml`), xml)
  }
  const result = await kosit(xml)
  if (!result) return
  const parsed = parseKositReport(result.report)
  const problems = parsed.messages
    .filter((m) => m.level !== 'information')
    .map((m) => `${m.level} ${m.code}: ${m.text}`)
  expect({ status: result.status, valid: parsed.valid, problems }).toEqual({
    status: 200,
    valid: true,
    problems: [],
  })
}

describe('E-Rechnung aus festgeschriebener Rechnung', () => {
  it('maps a standard invoice to EN 16931 with VAT per rate and a discounted line', () => {
    const doc = invoice(
      [
        ...standardItems(),
        item({
          oz: '02.01',
          text: 'Fachbuch',
          quantity: '2',
          unit: 'stk',
          priceCents: 2490,
          rate: '7',
        }),
      ],
      { cashDiscount: { percent: '2', days: 10 } },
    )
    const model = einvoiceFromDocument(doc, ctx, 'zugferd')
    expect(model).toMatchObject({ number: 'R2026-00103', typeCode: '380', buyerReference: null })
    expect(model.lines.map((l) => [l.id, l.quantity, l.unitCode, l.netPrice, l.netCents])).toEqual([
      ['01.01', '186.4', 'MTK', '12.5', 233000n],
      ['01.02', '7.5', 'HUR', '55.1', 41325n],
      ['01.03', '1', 'LS', '250', 25000n],
      ['02.01', '2', 'H87', '24.9', 4980n],
    ])
    // 5 % on 58,00 € → net price 55,10 €, discount 2,90 € (BT-147/148).
    expect(model.lines[1]).toMatchObject({ grossPrice: '58', priceDiscount: '2.9' })
    expect(model.vatBreakdown.map((v) => [v.category, v.rate, v.baseCents, v.taxCents])).toEqual([
      ['S', '19.00', 299325n, 56872n],
      ['S', '7.00', 4980n, 349n],
    ])
    expect(model.totals).toEqual({
      lineNetCents: 304305n,
      allowanceCents: 0n,
      chargeCents: 0n,
      netCents: 304305n,
      taxCents: 57221n,
      grossCents: 361526n,
      dueCents: 361526n,
    })
    expect(model.payment.terms).toBe(
      'Zahlbar ohne Abzug bis 05.12.2026.\n#SKONTO#TAGE=10#PROZENT=2.00#\n',
    )
    expect(model.period).toEqual({ start: '2026-10-01', end: '2026-11-20' })
  })

  it('writes ZUGFeRD (CII EN 16931) that KoSIT accepts', async () => {
    const doc = invoice(standardItems(), { cashDiscount: { percent: '2', days: 10 } })
    const file = buildEinvoice(doc, ctx, 'zugferd')
    expect(file.filename).toBe('factur-x.xml')
    expect(file.xml).toContain('<ram:ID>urn:cen.eu:en16931:2017</ram:ID>')
    expect(file.xml).toContain(
      '<ram:Description>Untergrund prüfen, zweimal deckend &lt;weiß&gt;.</ram:Description>',
    )
    expect(file.xml).toContain('<ram:IBANID>DE89370400440532013000</ram:IBANID>')
    await expectValid('zugferd-standard', file.xml)
  })

  it('writes XRechnung UBL with Leitweg-ID that KoSIT accepts', async () => {
    const doc = invoice(standardItems(), {
      recipient: {
        buyerReference: '04011000-12345-67',
        einvoiceFormat: null,
        name: 'Stadt Hannover',
      },
    })
    expect(einvoiceFormatsOf(doc.recipient)).toEqual(['zugferd', 'xrechnung_ubl'])
    expect(einvoiceProblems(doc, ctx)).toEqual([])
    const file = buildEinvoice(doc, ctx, 'xrechnung_ubl')
    expect(file.filename).toBe('R2026-00103_xrechnung.xml')
    expect(file.xml).toContain('<cbc:BuyerReference>04011000-12345-67</cbc:BuyerReference>')
    expect(file.xml).toContain('<cbc:EndpointID schemeID="0204">04011000-12345-67</cbc:EndpointID>')
    await expectValid('xrechnung-ubl', file.xml)
  })

  it('writes XRechnung CII for customers that want it', async () => {
    const doc = invoice(standardItems(), {
      recipient: { einvoiceFormat: 'xrechnung_cii', einvoiceEmail: 'rechnung@wohnbau.example' },
    })
    expect(einvoiceFormatsOf(doc.recipient)).toEqual(['zugferd', 'xrechnung_cii'])
    const file = buildEinvoice(doc, ctx, 'xrechnung_cii')
    expect(file.xml).toContain('xrechnung_3.0</ram:ID>')
    // BT-10 falls back to the customer number when there is no Leitweg-ID.
    expect(file.xml).toContain('<ram:BuyerReference>K-10042</ram:BuyerReference>')
    await expectValid('xrechnung-cii', file.xml)
  })

  it('names the buyer contact (BT-56, „z. Hd.“) in all formats', async () => {
    const doc = invoice(standardItems(), {
      recipient: {
        buyerReference: '04011000-12345-67',
        name: 'Stadt Hannover',
        contactPerson: 'Dr. Erika Muster',
      },
    })
    const cii = buildEinvoice(doc, ctx, 'zugferd').xml
    expect(cii).toMatch(
      /<ram:BuyerTradeParty>[\s\S]*<ram:DefinedTradeContact>\s*<ram:PersonName>Dr\. Erika Muster<\/ram:PersonName>/,
    )
    await expectValid('zugferd-buyer-contact', cii)
    const ubl = buildEinvoice(doc, ctx, 'xrechnung_ubl').xml
    expect(ubl).toMatch(
      /<cac:AccountingCustomerParty>[\s\S]*<cac:Contact>\s*<cbc:Name>Dr\. Erika Muster<\/cbc:Name>/,
    )
    await expectValid('xrechnung-ubl-buyer-contact', ubl)
    await expectValid('xrechnung-cii-buyer-contact', buildEinvoice(doc, ctx, 'xrechnung_cii').xml)
    // Without „z. Hd.“ no buyer contact.
    expect(buildEinvoice(invoice(standardItems()), ctx, 'zugferd').xml).not.toMatch(
      /<ram:BuyerTradeParty>[\s\S]*DefinedTradeContact[\s\S]*<\/ram:BuyerTradeParty>/,
    )
  })

  it('applies the document discount as allowance per VAT rate', async () => {
    const doc = invoice(
      [
        ...standardItems(),
        item({
          oz: '02.01',
          text: 'Fachbuch',
          quantity: '2',
          unit: 'stk',
          priceCents: 2490,
          rate: '7',
        }),
      ],
      { discountPercent: '3' },
    )
    const model = einvoiceFromDocument(doc, ctx, 'zugferd')
    expect(
      model.allowancesCharges.map((a) => [a.charge, a.amountCents, a.reasonCode, a.vatRate]),
    ).toEqual([
      [false, 8980n, '95', '19.00'],
      [false, 149n, '95', '7.00'],
    ])
    expect(model.totals.lineNetCents - model.totals.allowanceCents).toBe(model.totals.netCents)
    await expectValid('zugferd-discount', buildEinvoice(doc, ctx, 'zugferd').xml)
    await expectValid(
      'xrechnung-discount',
      buildEinvoice(
        {
          ...doc,
          recipient: {
            ...(doc.recipient as NonNullable<typeof doc.recipient>),
            einvoiceEmail: 'r@x.example',
          },
        },
        ctx,
        'xrechnung_ubl',
      ).xml,
    )
  })

  it('deducts earlier Abschläge in a Schlussrechnung, with retention as note', async () => {
    const doc = invoice(standardItems(), {
      kind: 'final',
      retentionPercent: '5',
      deductions: [
        { number: 'R2026-00090', date: '2026-10-15', netCents: 120000 },
        { number: 'R2026-00095', date: '2026-11-01', netCents: 80000 },
      ],
    })
    const model = einvoiceFromDocument(doc, ctx, 'zugferd')
    expect(model.typeCode).toBe('877')
    expect(model.allowancesCharges).toEqual([
      {
        charge: false,
        amountCents: 200000n,
        reason: 'Abzug bereits abgerechneter Leistungen (R2026-00090, R2026-00095)',
        reasonCode: null,
        vatCategory: 'S',
        vatRate: '19.00',
      },
    ])
    expect(model.precedingInvoices).toEqual([
      { number: 'R2026-00090', date: '2026-10-15' },
      { number: 'R2026-00095', date: '2026-11-01' },
    ])
    expect(model.notes.join('\n')).toMatch(/Sicherheitseinbehalt 5 %: .*Auszahlungsbetrag/)
    await expectValid('zugferd-final', buildEinvoice(doc, ctx, 'zugferd').xml)
    const xr = {
      ...doc,
      recipient: {
        ...(doc.recipient as NonNullable<typeof doc.recipient>),
        einvoiceEmail: 'r@x.example',
      },
    }
    await expectValid('xrechnung-final', buildEinvoice(xr, ctx, 'xrechnung_ubl').xml)
  })

  it('marks Abschlagsrechnungen as partial construction invoice', async () => {
    const doc = invoice(standardItems(), { kind: 'progress' })
    expect(einvoiceFromDocument(doc, ctx, 'zugferd').typeCode).toBe('875')
    await expectValid('zugferd-progress', buildEinvoice(doc, ctx, 'zugferd').xml)
  })

  it('writes § 13b reverse charge with the buyer VAT ID and exemption reason', async () => {
    const ok = invoice(standardItems(), {
      taxMode: 'reverse_charge_13b',
      recipient: { vatId: 'DE987654321', name: 'Generalbau AG' },
    })
    const model = einvoiceFromDocument(ok, ctx, 'zugferd')
    expect(model.vatBreakdown).toEqual([
      {
        category: 'AE',
        rate: '0.00',
        baseCents: 299325n,
        taxCents: 0n,
        exemptionReason: 'Steuerschuldnerschaft des Leistungsempfängers (§ 13b UStG).',
        exemptionCode: 'VATEX-EU-AE',
      },
    ])
    expect(model.lines.every((l) => l.vatCategory === 'AE' && l.vatRate === '0')).toBe(true)
    await expectValid('zugferd-13b', buildEinvoice(ok, ctx, 'zugferd').xml)
    const missing = invoice(standardItems(), { taxMode: 'reverse_charge_13b' })
    expect(einvoiceProblems(missing, ctx).map((p) => p.field)).toEqual(['contactId'])
  })

  it('writes Kleinunternehmer (§ 19 UStG) invoices with category E', async () => {
    const doc = invoice(standardItems(), {
      taxMode: 'small_business',
      issuer: { vatId: null },
    })
    const model = einvoiceFromDocument(doc, ctx, 'zugferd')
    expect(model.vatBreakdown[0]).toMatchObject({
      category: 'E',
      taxCents: 0n,
      exemptionCode: null,
    })
    expect(model.seller).toMatchObject({ vatId: null, id: '25/123/45678' })
    await expectValid(
      'xrechnung-19',
      buildEinvoice(
        {
          ...doc,
          recipient: {
            ...(doc.recipient as NonNullable<typeof doc.recipient>),
            einvoiceEmail: 'r@x.example',
          },
        },
        ctx,
        'xrechnung_ubl',
      ).xml,
    )
    await expectValid('zugferd-19', buildEinvoice(doc, ctx, 'zugferd').xml)
  })

  it('writes intra-community services with deliver-to country', async () => {
    const doc = invoice(standardItems(), {
      taxMode: 'intra_eu',
      recipient: {
        vatId: 'ATU12345678',
        name: 'Bau Wien GmbH',
        address: {
          street: 'Ringstraße 1',
          streetExtra: null,
          postalCode: '1010',
          city: 'Wien',
          countryCode: 'AT',
        },
      },
    })
    const model = einvoiceFromDocument(doc, ctx, 'zugferd')
    expect(model.deliveryCountry).toBe('AT')
    await expectValid('zugferd-intra-eu', buildEinvoice(doc, ctx, 'zugferd').xml)
  })

  it('writes a Stornorechnung as corrected invoice with negative quantities', async () => {
    const original = standardItems()
    const items = original.map((i) => ({
      ...i,
      quantity: `-${i.quantity}`,
      totalCents: -(i.totalCents ?? 0),
    }))
    const doc = invoice(items, {
      kind: 'cancellation',
      number: 'R2026-00110',
      cancels: { id: 'orig', number: 'R2026-00103' },
    })
    const model = einvoiceFromDocument(doc, ctx, 'zugferd')
    expect(model.typeCode).toBe('384')
    expect(model.lines[0]).toMatchObject({
      quantity: '-186.4',
      netPrice: '12.5',
      netCents: -233000n,
    })
    expect(model.precedingInvoices).toEqual([{ number: 'R2026-00103', date: '2026-11-10' }])
    expect(model.totals.dueCents).toBeLessThan(0n)
    await expectValid('zugferd-storno', buildEinvoice(doc, ctx, 'zugferd').xml)
    const xr = {
      ...doc,
      recipient: {
        ...(doc.recipient as NonNullable<typeof doc.recipient>),
        einvoiceEmail: 'r@x.example',
      },
    }
    await expectValid('xrechnung-storno', buildEinvoice(xr, ctx, 'xrechnung_ubl').xml)
  })

  it('writes a Gutschrift as UBL CreditNote', async () => {
    const doc = invoice(standardItems().slice(0, 1), {
      type: 'credit_note',
      number: 'G2026-00001',
      recipient: { einvoiceEmail: 'r@x.example' },
    })
    const model = einvoiceFromDocument(doc, ctx, 'xrechnung_ubl')
    expect(model.typeCode).toBe('381')
    const xml = buildEinvoice(doc, ctx, 'xrechnung_ubl').xml
    expect(xml).toContain(
      '<CreditNote xmlns="urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2"',
    )
    expect(xml).toContain('<cbc:CreditedQuantity unitCode="MTK">186.4</cbc:CreditedQuantity>')
    await expectValid('xrechnung-credit-note', xml)
    await expectValid('zugferd-credit-note', buildEinvoice(doc, ctx, 'zugferd').xml)
  })

  it('names missing data before a number is drawn', () => {
    const doc = invoice(standardItems(), {
      issuer: { email: null, iban: null },
      recipient: {
        einvoiceFormat: 'xrechnung_ubl',
        address: {
          street: null,
          streetExtra: null,
          postalCode: null,
          city: null,
          countryCode: 'DE',
        },
      },
    })
    expect(einvoiceProblems(doc, { unitCodes: new Map() })).toEqual([
      { field: 'contactId', message: expect.stringMatching(/PLZ und Ort des Empfängers/) },
      { field: 'items', message: expect.stringMatching(/„m²“ fehlt der UN\/ECE-Code/) },
      { field: 'items', message: expect.stringMatching(/„Std“/) },
      { field: 'items', message: expect.stringMatching(/„psch“/) },
      { field: 'company', message: expect.stringMatching(/E-Mail-Adresse und Telefonnummer/) },
      { field: 'company', message: expect.stringMatching(/IBAN/) },
      { field: 'contactId', message: expect.stringMatching(/Leitweg-ID oder E-Mail-Adresse/) },
    ])
    expect(() => einvoiceFromDocument({ ...doc, number: null }, ctx, 'zugferd')).toThrow(
      /finalized/,
    )
  })

  it('recognises Leitweg-IDs and escapes XML', () => {
    expect(isLeitwegId('04011000-12345-67')).toBe(true)
    expect(isLeitwegId('991-01234-44')).toBe(true)
    expect(isLeitwegId('K-10042')).toBe(false)
    expect(isLeitwegId(null)).toBe(false)
    expect(escapeXml(`a<b>&"c"'\u0001`)).toBe('a&lt;b&gt;&amp;&quot;c&quot;&apos;')
  })
})

describe('KoSIT-Prüfbericht', () => {
  it('reads acceptance, scenario and messages', () => {
    const report = `<rep:report valid="false"><rep:engine><rep:name>KoSIT Validator 1.6.3</rep:name></rep:engine>
      <rep:scenarioMatched><s:scenario><s:name>EN16931 XRechnung (UBL Invoice)</s:name></s:scenario>
      <rep:validationStepResult id="val-sch.1" valid="false">
        <rep:message id="m1" level="error" code="BR-DE-15" xpathLocation="/x">[BR-DE-15] Das Element &quot;Buyer reference&quot; (BT-10) muss übermittelt werden.</rep:message>
        <rep:message id="m2" level="warning" code="PEPPOL-EN16931-R001">Business process &lt;MUST&gt; be provided.</rep:message>
      </rep:validationStepResult></rep:scenarioMatched>
      <rep:assessment><rep:reject><rep:explanation/></rep:reject></rep:assessment></rep:report>`
    expect(parseKositReport(report)).toEqual({
      valid: false,
      scenario: 'EN16931 XRechnung (UBL Invoice)',
      engine: 'KoSIT Validator 1.6.3',
      messages: [
        {
          level: 'error',
          code: 'BR-DE-15',
          text: '[BR-DE-15] Das Element "Buyer reference" (BT-10) muss übermittelt werden.',
        },
        {
          level: 'warning',
          code: 'PEPPOL-EN16931-R001',
          text: 'Business process <MUST> be provided.',
        },
      ],
    })
    expect(parseKositReport('<rep:assessment><rep:accept/></rep:assessment>').valid).toBe(true)
  })
})
