import { amount, decimal, percent } from './format.js'
import {
  BUSINESS_PROCESS,
  type EinvoiceAllowanceCharge,
  type EinvoiceModel,
  type EinvoiceParty,
  type VatCategory,
  XRECHNUNG,
} from './model.js'
import { el, text, when, XML_DECLARATION } from './xml.js'

const CAC = 'urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2'
const CBC = 'urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2'

/**
 * XRechnung 3.0 in UBL 2.1 (Invoice, or CreditNote for type 381), as public authorities expect it
 * with a Leitweg-ID. The element order follows the UBL schema; KoSIT checks every file.
 */
export function toUbl(model: EinvoiceModel): string {
  const creditNote = model.typeCode === '381'
  const root = creditNote ? 'CreditNote' : 'Invoice'
  const lineTag = creditNote ? 'cac:CreditNoteLine' : 'cac:InvoiceLine'
  const quantityTag = creditNote ? 'cbc:CreditedQuantity' : 'cbc:InvoicedQuantity'
  const money = (name: string, cents: bigint) =>
    text(name, amount(cents), { currencyID: model.currency })
  const taxScheme = el('cac:TaxScheme', null, text('cbc:ID', 'VAT'))
  const category = (
    tag: string,
    code: VatCategory,
    rate: string,
    exemption?: { reason: string | null; code: string | null },
  ) =>
    el(
      tag,
      null,
      text('cbc:ID', code),
      text('cbc:Percent', percent(rate)),
      text('cbc:TaxExemptionReasonCode', exemption?.code),
      text('cbc:TaxExemptionReason', exemption?.reason),
      taxScheme,
    )

  const party = (tag: string, p: EinvoiceParty) =>
    el(
      tag,
      null,
      el(
        'cac:Party',
        null,
        when(p.electronicAddress, () =>
          text('cbc:EndpointID', p.electronicAddress?.value, {
            schemeID: p.electronicAddress?.scheme,
          }),
        ),
        when(p.id, () => el('cac:PartyIdentification', null, text('cbc:ID', p.id))),
        el('cac:PartyName', null, text('cbc:Name', p.name)),
        el(
          'cac:PostalAddress',
          null,
          text('cbc:StreetName', p.address.street),
          text('cbc:AdditionalStreetName', p.address.streetExtra),
          text('cbc:CityName', p.address.city),
          text('cbc:PostalZone', p.address.postalCode),
          el('cac:Country', null, text('cbc:IdentificationCode', p.address.countryCode)),
        ),
        when(p.vatId, () =>
          el('cac:PartyTaxScheme', null, text('cbc:CompanyID', p.vatId), taxScheme),
        ),
        when(p.taxNumber, () =>
          el(
            'cac:PartyTaxScheme',
            null,
            text('cbc:CompanyID', p.taxNumber),
            el('cac:TaxScheme', null, text('cbc:ID', 'FC')),
          ),
        ),
        el('cac:PartyLegalEntity', null, text('cbc:RegistrationName', p.name)),
        when(p.contact, () =>
          el(
            'cac:Contact',
            null,
            text('cbc:Name', p.contact?.name),
            text('cbc:Telephone', p.contact?.phone),
            text('cbc:ElectronicMail', p.contact?.email),
          ),
        ),
      ),
    )

  const allowanceCharge = (a: EinvoiceAllowanceCharge) =>
    el(
      'cac:AllowanceCharge',
      null,
      text('cbc:ChargeIndicator', a.charge ? 'true' : 'false'),
      text('cbc:AllowanceChargeReasonCode', a.reasonCode),
      text('cbc:AllowanceChargeReason', a.reason),
      money('cbc:Amount', a.amountCents),
      category('cac:TaxCategory', a.vatCategory, a.vatRate),
    )

  const { totals, payment } = model
  const body = el(
    root,
    {
      xmlns: `urn:oasis:names:specification:ubl:schema:xsd:${root}-2`,
      'xmlns:cac': CAC,
      'xmlns:cbc': CBC,
    },
    text('cbc:CustomizationID', XRECHNUNG),
    text('cbc:ProfileID', BUSINESS_PROCESS),
    text('cbc:ID', model.number),
    text('cbc:IssueDate', model.issueDate),
    // Invoice: due date in the header; CreditNote has none there (BT-9 goes to PaymentMeans).
    when(!creditNote, () => text('cbc:DueDate', model.dueDate)),
    text(creditNote ? 'cbc:CreditNoteTypeCode' : 'cbc:InvoiceTypeCode', model.typeCode),
    model.notes.map((note) => text('cbc:Note', note)),
    text('cbc:DocumentCurrencyCode', model.currency),
    text('cbc:BuyerReference', model.buyerReference),
    when(model.period, () =>
      el(
        'cac:InvoicePeriod',
        null,
        text('cbc:StartDate', model.period?.start),
        text('cbc:EndDate', model.period?.end),
      ),
    ),
    model.precedingInvoices.map((ref) =>
      el(
        'cac:BillingReference',
        null,
        el(
          'cac:InvoiceDocumentReference',
          null,
          text('cbc:ID', ref.number),
          text('cbc:IssueDate', ref.date),
        ),
      ),
    ),
    when(model.project && !creditNote, () =>
      el('cac:ProjectReference', null, text('cbc:ID', model.project?.id)),
    ),
    party('cac:AccountingSupplierParty', model.seller),
    party('cac:AccountingCustomerParty', { ...model.buyer, contact: null }),
    when(model.deliveryDate || model.deliveryCountry, () =>
      el(
        'cac:Delivery',
        null,
        text('cbc:ActualDeliveryDate', model.deliveryDate),
        when(model.deliveryCountry, () =>
          el(
            'cac:DeliveryLocation',
            null,
            el(
              'cac:Address',
              null,
              el('cac:Country', null, text('cbc:IdentificationCode', model.deliveryCountry)),
            ),
          ),
        ),
      ),
    ),
    el(
      'cac:PaymentMeans',
      null,
      text('cbc:PaymentMeansCode', payment.meansCode),
      when(creditNote, () => text('cbc:PaymentDueDate', model.dueDate)),
      text('cbc:PaymentID', payment.reference),
      when(payment.iban, () =>
        el(
          'cac:PayeeFinancialAccount',
          null,
          text('cbc:ID', payment.iban),
          text('cbc:Name', payment.accountName),
          when(payment.bic, () =>
            el('cac:FinancialInstitutionBranch', null, text('cbc:ID', payment.bic)),
          ),
        ),
      ),
    ),
    when(payment.terms, () => el('cac:PaymentTerms', null, text('cbc:Note', payment.terms))),
    model.allowancesCharges.map(allowanceCharge),
    el(
      'cac:TaxTotal',
      null,
      money('cbc:TaxAmount', totals.taxCents),
      model.vatBreakdown.map((v) =>
        el(
          'cac:TaxSubtotal',
          null,
          money('cbc:TaxableAmount', v.baseCents),
          money('cbc:TaxAmount', v.taxCents),
          category('cac:TaxCategory', v.category, v.rate, {
            reason: v.exemptionReason,
            code: v.exemptionCode,
          }),
        ),
      ),
    ),
    el(
      'cac:LegalMonetaryTotal',
      null,
      money('cbc:LineExtensionAmount', totals.lineNetCents),
      money('cbc:TaxExclusiveAmount', totals.netCents),
      money('cbc:TaxInclusiveAmount', totals.grossCents),
      money('cbc:AllowanceTotalAmount', totals.allowanceCents),
      money('cbc:ChargeTotalAmount', totals.chargeCents),
      money('cbc:PayableAmount', totals.dueCents),
    ),
    model.lines.map((line) =>
      el(
        lineTag,
        null,
        text('cbc:ID', line.id),
        text(quantityTag, decimal(line.quantity), { unitCode: line.unitCode }),
        money('cbc:LineExtensionAmount', line.netCents),
        el(
          'cac:Item',
          null,
          text('cbc:Description', line.description),
          text('cbc:Name', line.name),
          category('cac:ClassifiedTaxCategory', line.vatCategory, line.vatRate),
        ),
        el(
          'cac:Price',
          null,
          text('cbc:PriceAmount', line.netPrice, { currencyID: model.currency }),
          when(line.priceDiscount, () =>
            el(
              'cac:AllowanceCharge',
              null,
              text('cbc:ChargeIndicator', 'false'),
              text('cbc:Amount', line.priceDiscount, { currencyID: model.currency }),
              text('cbc:BaseAmount', line.grossPrice, { currencyID: model.currency }),
            ),
          ),
        ),
      ),
    ),
  )
  return XML_DECLARATION + body
}
