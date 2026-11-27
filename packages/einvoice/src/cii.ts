import { amount, cefactDate, decimal, percent } from './format.js'
import {
  BUSINESS_PROCESS,
  type EinvoiceAllowanceCharge,
  type EinvoiceModel,
  type EinvoiceParty,
  type EinvoiceVatBreakdown,
  EN16931,
  XRECHNUNG,
} from './model.js'
import { el, text, when, XML_DECLARATION, type XmlNode } from './xml.js'

/**
 * UN/CEFACT Cross Industry Invoice (D16B, uncoupled): the XML of ZUGFeRD 2.x / Factur-X profile
 * EN 16931 (embedded in the PDF/A-3 as factur-x.xml) and of XRechnung CII. The element order follows
 * the XML schema; KoSIT checks every file before it is used.
 */
export function toCii(model: EinvoiceModel, profile: 'en16931' | 'xrechnung'): string {
  const date = (iso: string) => el('udt:DateTimeString', { format: '102' }, cefactDate(iso))
  const tax = (category: string, rate: string) => [
    text('ram:TypeCode', 'VAT'),
    text('ram:CategoryCode', category),
    text('ram:RateApplicablePercent', percent(rate)),
  ]
  const xrechnung = profile === 'xrechnung'

  const party = (tag: string, p: EinvoiceParty, withContact: boolean) =>
    el(
      tag,
      null,
      text('ram:ID', p.id),
      text('ram:Name', p.name),
      when(withContact && p.contact, () =>
        el(
          'ram:DefinedTradeContact',
          null,
          text('ram:PersonName', p.contact?.name),
          when(p.contact?.phone, () =>
            el(
              'ram:TelephoneUniversalCommunication',
              null,
              text('ram:CompleteNumber', p.contact?.phone),
            ),
          ),
          when(p.contact?.email, () =>
            el('ram:EmailURIUniversalCommunication', null, text('ram:URIID', p.contact?.email)),
          ),
        ),
      ),
      el(
        'ram:PostalTradeAddress',
        null,
        text('ram:PostcodeCode', p.address.postalCode),
        text('ram:LineOne', p.address.street),
        text('ram:LineTwo', p.address.streetExtra),
        text('ram:CityName', p.address.city),
        text('ram:CountryID', p.address.countryCode),
      ),
      when(p.electronicAddress, () =>
        el(
          'ram:URIUniversalCommunication',
          null,
          text('ram:URIID', p.electronicAddress?.value, { schemeID: p.electronicAddress?.scheme }),
        ),
      ),
      when(p.vatId, () =>
        el('ram:SpecifiedTaxRegistration', null, text('ram:ID', p.vatId, { schemeID: 'VA' })),
      ),
      when(p.taxNumber, () =>
        el('ram:SpecifiedTaxRegistration', null, text('ram:ID', p.taxNumber, { schemeID: 'FC' })),
      ),
    )

  const allowanceCharge = (a: EinvoiceAllowanceCharge) =>
    el(
      'ram:SpecifiedTradeAllowanceCharge',
      null,
      el('ram:ChargeIndicator', null, text('udt:Indicator', a.charge ? 'true' : 'false')),
      text('ram:ActualAmount', amount(a.amountCents)),
      text('ram:ReasonCode', a.reasonCode),
      text('ram:Reason', a.reason),
      el('ram:CategoryTradeTax', null, tax(a.vatCategory, a.vatRate)),
    )

  const vat = (v: EinvoiceVatBreakdown) =>
    el(
      'ram:ApplicableTradeTax',
      null,
      text('ram:CalculatedAmount', amount(v.taxCents)),
      text('ram:TypeCode', 'VAT'),
      text('ram:ExemptionReason', v.exemptionReason),
      text('ram:BasisAmount', amount(v.baseCents)),
      text('ram:CategoryCode', v.category),
      text('ram:ExemptionReasonCode', v.exemptionCode),
      text('ram:RateApplicablePercent', percent(v.rate)),
    )

  const lines: XmlNode[] = model.lines.map((line) =>
    el(
      'ram:IncludedSupplyChainTradeLineItem',
      null,
      el('ram:AssociatedDocumentLineDocument', null, text('ram:LineID', line.id)),
      el(
        'ram:SpecifiedTradeProduct',
        null,
        text('ram:Name', line.name),
        text('ram:Description', line.description),
      ),
      el(
        'ram:SpecifiedLineTradeAgreement',
        null,
        when(line.grossPrice, () =>
          el(
            'ram:GrossPriceProductTradePrice',
            null,
            text('ram:ChargeAmount', line.grossPrice),
            when(line.priceDiscount, () =>
              el(
                'ram:AppliedTradeAllowanceCharge',
                null,
                el('ram:ChargeIndicator', null, text('udt:Indicator', 'false')),
                text('ram:ActualAmount', line.priceDiscount),
              ),
            ),
          ),
        ),
        el('ram:NetPriceProductTradePrice', null, text('ram:ChargeAmount', line.netPrice)),
      ),
      el(
        'ram:SpecifiedLineTradeDelivery',
        null,
        text('ram:BilledQuantity', decimal(line.quantity), { unitCode: line.unitCode }),
      ),
      el(
        'ram:SpecifiedLineTradeSettlement',
        null,
        el('ram:ApplicableTradeTax', null, tax(line.vatCategory, line.vatRate)),
        el(
          'ram:SpecifiedTradeSettlementLineMonetarySummation',
          null,
          text('ram:LineTotalAmount', amount(line.netCents)),
        ),
      ),
    ),
  )

  const { totals, payment } = model
  const settlement = el(
    'ram:ApplicableHeaderTradeSettlement',
    null,
    text('ram:PaymentReference', payment.reference),
    text('ram:InvoiceCurrencyCode', model.currency),
    el(
      'ram:SpecifiedTradeSettlementPaymentMeans',
      null,
      text('ram:TypeCode', payment.meansCode),
      when(payment.iban, () =>
        el(
          'ram:PayeePartyCreditorFinancialAccount',
          null,
          text('ram:IBANID', payment.iban),
          text('ram:AccountName', payment.accountName),
        ),
      ),
      when(payment.bic, () =>
        el('ram:PayeeSpecifiedCreditorFinancialInstitution', null, text('ram:BICID', payment.bic)),
      ),
    ),
    model.vatBreakdown.map(vat),
    when(model.period, () =>
      el(
        'ram:BillingSpecifiedPeriod',
        null,
        el('ram:StartDateTime', null, date(model.period?.start as string)),
        el('ram:EndDateTime', null, date(model.period?.end as string)),
      ),
    ),
    model.allowancesCharges.map(allowanceCharge),
    when(payment.terms || model.dueDate, () =>
      el(
        'ram:SpecifiedTradePaymentTerms',
        null,
        text('ram:Description', payment.terms),
        when(model.dueDate, () => el('ram:DueDateDateTime', null, date(model.dueDate as string))),
      ),
    ),
    el(
      'ram:SpecifiedTradeSettlementHeaderMonetarySummation',
      null,
      text('ram:LineTotalAmount', amount(totals.lineNetCents)),
      text('ram:ChargeTotalAmount', amount(totals.chargeCents)),
      text('ram:AllowanceTotalAmount', amount(totals.allowanceCents)),
      text('ram:TaxBasisTotalAmount', amount(totals.netCents)),
      text('ram:TaxTotalAmount', amount(totals.taxCents), { currencyID: model.currency }),
      text('ram:GrandTotalAmount', amount(totals.grossCents)),
      text('ram:DuePayableAmount', amount(totals.dueCents)),
    ),
    // CII (Factur-X EN 16931) allows one preceding invoice; all of them are listed in the notes.
    when(model.precedingInvoices[0], () => {
      const ref = model.precedingInvoices[0] as { number: string; date: string | null }
      return el(
        'ram:InvoiceReferencedDocument',
        null,
        text('ram:IssuerAssignedID', ref.number),
        when(ref.date, () =>
          el(
            'ram:FormattedIssueDateTime',
            null,
            el('qdt:DateTimeString', { format: '102' }, cefactDate(ref.date as string)),
          ),
        ),
      )
    }),
  )

  const body = el(
    'rsm:CrossIndustryInvoice',
    {
      'xmlns:rsm': 'urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100',
      'xmlns:ram':
        'urn:un:unece:uncefact:data:standard:ReusableAggregateBusinessInformationEntity:100',
      'xmlns:qdt': 'urn:un:unece:uncefact:data:standard:QualifiedDataType:100',
      'xmlns:udt': 'urn:un:unece:uncefact:data:standard:UnqualifiedDataType:100',
    },
    el(
      'rsm:ExchangedDocumentContext',
      null,
      el(
        'ram:BusinessProcessSpecifiedDocumentContextParameter',
        null,
        text('ram:ID', BUSINESS_PROCESS),
      ),
      el(
        'ram:GuidelineSpecifiedDocumentContextParameter',
        null,
        text('ram:ID', xrechnung ? XRECHNUNG : EN16931),
      ),
    ),
    el(
      'rsm:ExchangedDocument',
      null,
      text('ram:ID', model.number),
      text('ram:TypeCode', model.typeCode),
      el('ram:IssueDateTime', null, date(model.issueDate)),
      model.notes.map((note) => el('ram:IncludedNote', null, text('ram:Content', note))),
    ),
    el(
      'rsm:SupplyChainTradeTransaction',
      null,
      lines,
      el(
        'ram:ApplicableHeaderTradeAgreement',
        null,
        text('ram:BuyerReference', model.buyerReference),
        party('ram:SellerTradeParty', model.seller, true),
        party('ram:BuyerTradeParty', model.buyer, true),
        when(model.project, () =>
          el(
            'ram:SpecifiedProcuringProject',
            null,
            text('ram:ID', model.project?.id),
            text('ram:Name', model.project?.name),
          ),
        ),
      ),
      el(
        'ram:ApplicableHeaderTradeDelivery',
        null,
        when(model.deliveryCountry, () =>
          el(
            'ram:ShipToTradeParty',
            null,
            el('ram:PostalTradeAddress', null, text('ram:CountryID', model.deliveryCountry)),
          ),
        ),
        when(model.deliveryDate, () =>
          el(
            'ram:ActualDeliverySupplyChainEvent',
            null,
            el('ram:OccurrenceDateTime', null, date(model.deliveryDate as string)),
          ),
        ),
      ),
      settlement,
    ),
  )
  return XML_DECLARATION + body
}
