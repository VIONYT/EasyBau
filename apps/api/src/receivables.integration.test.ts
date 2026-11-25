import { withTenant } from '@easybau/db'
import type { DocumentDetail, InvoiceList, Receivable } from '@easybau/schemas'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client, createHarness, type Harness } from './testing/harness.js'

/**
 * Zahlungen & Forderungen (DESIGN.md §4.6): payments, deductions, reversals, status and the invoice
 * list. No bookkeeping: entries per invoice, never deleted (rule 7).
 */
describe.skipIf(!process.env.DATABASE_URL)('Zahlungen und Forderungen (integration)', () => {
  let h: Harness
  let admin: Client
  let worker: Client
  let tenantId: string
  let projectId: string
  let customerId: string
  let units: { id: string; symbol: string }[]

  /** 1.000 € netto, 19 % → 1.190 €; 5 % Einbehalt (59,50 €); 2 % Skonto 14 Tage; Ziel 14 Tage. */
  async function invoice(documentDate = '2026-11-02') {
    const draft = (
      await admin.post(`/api/v1/projects/${projectId}/documents`, {
        type: 'invoice',
        invoiceKind: 'standard',
      })
    ).json() as DocumentDetail
    const patched = await admin.patch(`/api/v1/documents/${draft.id}`, {
      contactId: customerId,
      documentDate,
      serviceFrom: '2026-10-26',
      paymentDueDays: 14,
      cashDiscountPercent: '2',
      cashDiscountDays: 14,
      retentionPercent: '5',
    })
    expect(patched.statusCode, patched.body).toBe(200)
    await admin.post(`/api/v1/documents/${draft.id}/items`, {
      positionType: 'item',
      shortText: 'Wände streichen',
      quantity: '80',
      unitId: units.find((u) => u.symbol === 'm²')?.id,
      unitPriceCents: 1250,
    })
    const res = await admin.post(`/api/v1/documents/${draft.id}/finalize`, {})
    expect(res.statusCode, res.body).toBe(200)
    return res.json() as DocumentDetail
  }
  const receivableOf = async (id: string) =>
    ((await admin.get(`/api/v1/documents/${id}`)).json() as DocumentDetail).receivable as Receivable

  beforeAll(async () => {
    h = await createHarness({ requireAdminMfa: false })
    admin = new Client(h.app)
    const setup = await admin.post('/api/v1/setup', {
      setupToken: h.setupToken,
      company: { name: 'Zahl Bau GmbH' },
      admin: {
        email: 'chef@example.test',
        password: 'ein-sehr-langes-passwort',
        displayName: 'Chef',
      },
    })
    tenantId = setup.json().tenant.id
    await admin.patch('/api/v1/settings/company', {
      street: 'Werkstraße 2',
      postalCode: '30169',
      city: 'Hannover',
      taxNumber: '25/123/45678',
      iban: 'DE89370400440532013000',
    })
    const customer = await admin.post('/api/v1/contacts', {
      kind: 'organization',
      organizationName: 'Wohnbau Nord eG',
      addresses: [{ kind: 'main', street: 'Lindenweg 4', postalCode: '30159', city: 'Hannover' }],
    })
    customerId = customer.json().id
    projectId = (await admin.post('/api/v1/projects', { name: 'Lindenweg', customerId })).json().id
    units = (await admin.get('/api/v1/units')).json()
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

  let first: DocumentDetail

  it('shows the open receivable of a finalized invoice', async () => {
    first = await invoice()
    expect(first.receivable).toMatchObject({
      status: 'open',
      grossCents: 119_000,
      payableCents: 113_050,
      openCents: 119_000,
      paidCents: 0,
      dueDate: '2026-11-16',
      retentionCents: 5_950,
      cashDiscount: { percent: '2', days: 14, until: '2026-11-16', amountCents: 2_261 },
      payments: [],
      adjustments: [],
    })
    // Payments only for finalized invoices, only with the right permission.
    const draft = (
      await admin.post(`/api/v1/projects/${projectId}/documents`, {
        type: 'invoice',
        invoiceKind: 'standard',
      })
    ).json()
    const onDraft = await admin.post(`/api/v1/documents/${draft.id}/payments`, {
      paidOn: '2026-11-05',
      amountCents: 100,
    })
    expect(onDraft.statusCode).toBe(409)
    const denied = await worker.post(`/api/v1/documents/${first.id}/payments`, {
      paidOn: '2026-11-05',
      amountCents: 100,
    })
    expect(denied.statusCode).toBe(403)
  })

  it('records a partial payment and settles the rest with retention and Skonto', async () => {
    let res = await admin.post(`/api/v1/documents/${first.id}/payments`, {
      paidOn: '2026-11-05',
      amountCents: 50_000,
      reference: 'Überweisung Teil 1',
    })
    expect(res.statusCode, res.body).toBe(201)
    expect(res.json().receivable).toMatchObject({
      status: 'partially_paid',
      openCents: 69_000,
      paidCents: 50_000,
    })

    // Rest within the Skonto period: 1.130,50 − 22,61 Skonto − 500,00 = 607,89 €.
    const tooMuch = await admin.post(`/api/v1/documents/${first.id}/payments`, {
      paidOn: '2026-11-07',
      amountCents: 60_789,
      settle: [{ kind: 'retention', amountCents: 9_000 }],
    })
    expect(tooMuch.statusCode).toBe(400)
    expect(tooMuch.json().errors.settle).toMatch(/höher als der verbleibende Rest/)
    const future = await admin.post(`/api/v1/documents/${first.id}/payments`, {
      paidOn: '2027-01-01',
      amountCents: 100,
    })
    expect(future.json().errors.paidOn).toMatch(/Zukunft/)

    res = await admin.post(`/api/v1/documents/${first.id}/payments`, {
      paidOn: '2026-11-07',
      amountCents: 60_789,
      settle: [
        { kind: 'retention', amountCents: 5_950 },
        { kind: 'cash_discount', amountCents: 2_261 },
      ],
    })
    expect(res.statusCode, res.body).toBe(201)
    const receivable = res.json().receivable as Receivable
    expect(receivable).toMatchObject({
      status: 'paid',
      openCents: 0,
      paidCents: 110_789,
      adjustedCents: 8_211,
      retentionHeldCents: 5_950,
    })
    expect(receivable.payments.map((p) => [p.paidOn, p.amountCents, p.createdBy])).toEqual([
      ['2026-11-05', 50_000, 'Chef'],
      ['2026-11-07', 60_789, 'Chef'],
    ])
    expect(receivable.adjustments.map((a) => [a.kind, a.amountCents])).toEqual([
      ['retention', 5_950],
      ['cash_discount', 2_261],
    ])
  })

  it('corrects mistakes only by reversal, never by deleting', async () => {
    const before = await receivableOf(first.id)
    const payment = before.payments[1]?.id as string
    let res = await admin.post(`/api/v1/payments/${payment}/reverse`, { reason: 'Doppelt erfasst' })
    expect(res.statusCode, res.body).toBe(201)
    const after = res.json().receivable as Receivable
    expect(after).toMatchObject({ status: 'partially_paid', openCents: 60_789 })
    const reversal = after.payments.find((p) => p.reversesId === payment)
    expect(reversal).toMatchObject({ amountCents: -60_789, reference: 'Storno: Doppelt erfasst' })
    expect(after.payments.find((p) => p.id === payment)?.reversedById).toBe(reversal?.id)
    expect((await admin.post(`/api/v1/payments/${payment}/reverse`, {})).statusCode).toBe(409)
    expect((await admin.post(`/api/v1/payments/${reversal?.id}/reverse`, {})).statusCode).toBe(409)

    // The database keeps every entry (rule 7) and refuses wrong reversals.
    await expect(
      withTenant(h.sql, { tenantId }, (tx) => tx`delete from payment where id = ${payment}`),
    ).rejects.toThrow(/permission denied|cannot be deleted/)
    await expect(
      withTenant(
        h.sql,
        { tenantId },
        (tx) => tx`update payment set amount_cents = 1 where id = ${payment}`,
      ),
    ).rejects.toThrow(/cannot be changed/)
    await expect(
      withTenant(
        h.sql,
        { tenantId },
        (tx) =>
          tx`insert into payment (tenant_id, invoice_id, paid_on, amount_cents, reverses_payment_id)
           values (${tenantId}, ${first.id}, '2026-11-08', -1, ${before.payments[0]?.id as string})`,
      ),
    ).rejects.toThrow(/mirror its original/)

    // Paid again correctly.
    res = await admin.post(`/api/v1/documents/${first.id}/payments`, {
      paidOn: '2026-11-08',
      amountCents: 60_789,
    })
    expect(res.json().receivable).toMatchObject({ status: 'paid', openCents: 0 })
  })

  it('pays out the Sicherheitseinbehalt later', async () => {
    const tooMuch = await admin.post(`/api/v1/documents/${first.id}/retention-release`, {
      paidOn: '2026-11-08',
      amountCents: 6_000,
    })
    expect(tooMuch.statusCode).toBe(400)
    const res = await admin.post(`/api/v1/documents/${first.id}/retention-release`, {
      paidOn: '2026-11-08',
      amountCents: 5_950,
    })
    expect(res.statusCode, res.body).toBe(201)
    expect(res.json().receivable).toMatchObject({
      status: 'paid',
      openCents: 0,
      retentionHeldCents: 0,
    })
  })

  let second: DocumentDetail

  it('records a disputed Kürzung that needs a reason, and becomes overdue after the due date', async () => {
    second = await invoice('2026-11-03')
    const noReason = await admin.post(`/api/v1/documents/${second.id}/adjustments`, {
      kind: 'short_payment',
      amountCents: 10_000,
    })
    expect(noReason.json().errors.reason).toBe('Bitte einen Grund angeben.')
    let res = await admin.post(`/api/v1/documents/${second.id}/adjustments`, {
      kind: 'short_payment',
      amountCents: 10_000,
      reason: 'Mängel Treppenhaus (Bauherr)',
      disputed: true,
    })
    expect(res.statusCode, res.body).toBe(201)
    const adjustment = (res.json().receivable as Receivable).adjustments[0]
    expect(adjustment).toMatchObject({ kind: 'short_payment', disputed: true })
    res = await admin.patch(`/api/v1/adjustments/${adjustment?.id}`, { disputed: false })
    expect(res.json().receivable.adjustments[0].disputed).toBe(false)
    expect(
      (
        await admin.post(`/api/v1/documents/${second.id}/adjustments`, {
          kind: 'bank_fee',
          amountCents: 200_000,
        })
      ).statusCode,
    ).toBe(400)

    h.clock.now = Date.parse('2026-12-01T10:00:00Z')
    expect(await receivableOf(second.id)).toMatchObject({
      status: 'overdue',
      openCents: 109_000,
      overdueDays: 14,
    })
  })

  it('lists invoices with status, filters, sums and CSV', async () => {
    const draft = (
      await admin.post(`/api/v1/projects/${projectId}/documents`, {
        type: 'invoice',
        invoiceKind: 'standard',
      })
    ).json()
    const list = (await admin.get('/api/v1/invoices')).json() as InvoiceList
    expect(list.items.map((i) => [i.id, i.status])).toEqual(
      expect.arrayContaining([
        [first.id, 'paid'],
        [second.id, 'overdue'],
        [draft.id, 'draft'],
      ]),
    )
    // Drafts are listed but not counted.
    expect(list.sums).toMatchObject({
      grossCents: 238_000,
      openCents: 109_000,
      overdueCents: 109_000,
    })
    const overdue = (await admin.get('/api/v1/invoices?status=overdue')).json() as InvoiceList
    expect(overdue.items.map((i) => i.id)).toEqual([second.id])
    expect(overdue.items[0]).toMatchObject({
      recipient: 'Wohnbau Nord eG',
      openCents: 109_000,
      overdueDays: 14,
    })
    const retained = (await admin.get('/api/v1/invoices?retention=true')).json() as InvoiceList
    expect(retained.items).toHaveLength(2)
    const search = (
      await admin.get(`/api/v1/invoices?q=${encodeURIComponent(first.number as string)}`)
    ).json()
    expect(search.items.map((i: { id: string }) => i.id)).toEqual([first.id])
    const page = (await admin.get('/api/v1/invoices?limit=1')).json() as InvoiceList
    expect(page.items).toHaveLength(1)
    const next = (await admin.get(`/api/v1/invoices?limit=1&cursor=${page.nextCursor}`)).json()
    expect(next.items[0].id).not.toBe(page.items[0]?.id)

    const csv = await admin.get('/api/v1/invoices/export.csv?status=overdue')
    expect(csv.headers['content-type']).toBe('text/csv; charset=utf-8')
    const lines = csv.body.replace(/^﻿/, '').trim().split('\r\n')
    expect(lines[0]).toBe(
      'Nummer;Art;Rechnungsdatum;Fällig am;Empfänger;Projekt;Netto;Brutto;Bezahlt;Abzüge;Offen;Einbehalt;Status;Mahnstufe;Nächste Mahnstufe ab',
    )
    expect(lines[1]).toContain('"Wohnbau Nord eG"')
    expect(lines[1]).toContain('"1090,00"')
    expect(lines[1]).toMatch(/"überfällig";"";"Zahlungserinnerung ab \d{2}\.\d{2}\.2026"$/)
  })

  it('takes no new payments on a cancelled invoice, but reversals of earlier ones', async () => {
    const third = await invoice('2026-11-04')
    const paid = await admin.post(`/api/v1/documents/${third.id}/payments`, {
      paidOn: '2026-11-20',
      amountCents: 10_000,
    })
    const paymentId = (paid.json().receivable as Receivable).payments[0]?.id
    expect(
      (await admin.post(`/api/v1/documents/${third.id}/cancel`, { reason: 'Falscher Kunde' }))
        .statusCode,
    ).toBe(201)
    const blocked = await admin.post(`/api/v1/documents/${third.id}/payments`, {
      paidOn: '2026-11-21',
      amountCents: 100,
    })
    expect(blocked.statusCode).toBe(409)
    const reversed = await admin.post(`/api/v1/payments/${paymentId}/reverse`, {
      reason: 'Rückzahlung',
    })
    expect(reversed.statusCode, reversed.body).toBe(201)
    expect(reversed.json().receivable.status).toBe('cancelled')
    const list = (await admin.get('/api/v1/invoices?status=cancelled')).json() as InvoiceList
    expect(list.items).toHaveLength(2) // the invoice and its Stornorechnung
  })
})
