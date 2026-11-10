import { withTenant } from '@opc/db'
import type {
  BaseInterestRate,
  DocumentDetail,
  DunningAmounts,
  DunningNotice,
  DunningOverview,
  DunningSettings,
} from '@opc/schemas'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client, createHarness, type Harness } from './testing/harness.js'

/**
 * Mahnwesen (DESIGN.md §2, §4.6): Zahlungserinnerung → 1. Mahnung → letzte Mahnung with deadlines,
 * fees, Verzugszinsen (§ 288 BGB) and Pauschale; PDF archived, e-mail with attachment, never changed.
 */
describe.skipIf(!process.env.DATABASE_URL)('Mahnwesen (integration)', () => {
  let h: Harness
  let admin: Client
  let worker: Client
  let tenantId: string
  let invoice: DocumentDetail

  const overview = async () =>
    (await admin.get(`/api/v1/documents/${invoice.id}/dunning`)).json() as DunningOverview
  const at = (iso: string) => {
    h.clock.now = Date.parse(`${iso}T10:00:00Z`)
  }

  beforeAll(async () => {
    h = await createHarness({ requireAdminMfa: false, smtp: true })
    admin = new Client(h.app)
    const setup = await admin.post('/api/v1/setup', {
      setupToken: h.setupToken,
      company: { name: 'Mahn Bau GmbH' },
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
      channels: [{ kind: 'email', value: 'buchhaltung@wohnbau.example', isPrimary: true }],
    })
    expect(customer.statusCode, customer.body).toBe(201)
    const customerId = customer.json().id
    const projectId = (
      await admin.post('/api/v1/projects', { name: 'Lindenweg', customerId })
    ).json().id
    const units = (await admin.get('/api/v1/units')).json() as { id: string; symbol: string }[]
    const draft = (
      await admin.post(`/api/v1/projects/${projectId}/documents`, {
        type: 'invoice',
        invoiceKind: 'standard',
      })
    ).json() as DocumentDetail
    await admin.patch(`/api/v1/documents/${draft.id}`, {
      contactId: customerId,
      documentDate: '2026-11-02',
      serviceFrom: '2026-10-26',
      paymentDueDays: 14,
    })
    await admin.post(`/api/v1/documents/${draft.id}/items`, {
      positionType: 'item',
      shortText: 'Wände streichen',
      quantity: '80',
      unitId: units.find((u) => u.symbol === 'm²')?.id,
      unitPriceCents: 1250,
    })
    const res = await admin.post(`/api/v1/documents/${draft.id}/finalize`, {})
    expect(res.statusCode, res.body).toBe(200)
    invoice = res.json()
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

  it('does not dun before the due date', async () => {
    at('2026-11-16')
    const view = await overview()
    expect(view).toMatchObject({
      notices: [],
      next: null,
      blocked: 'Die Rechnung ist erst am 16.11.2026 fällig.',
      emailEnabled: true,
      suggestedEmail: 'buchhaltung@wohnbau.example',
    })
    expect((await admin.post(`/api/v1/documents/${invoice.id}/dunning`, {})).statusCode).toBe(409)
  })

  it('issues a Zahlungserinnerung with PDF/A and e-mail attachment', async () => {
    at('2026-11-20')
    const view = await overview()
    expect(view.blocked).toBeNull()
    expect(view.next).toMatchObject({
      level: 'reminder',
      noticeDate: '2026-11-20',
      dueDate: '2026-11-30',
      business: true,
      interest: false,
      openCents: 119_000,
      feeCents: 0,
      interestCents: 0,
      totalCents: 119_000,
    })
    expect(view.next?.text).toContain('Rechnung R')
    expect(view.next?.text).toContain('vom 02.11.2026')
    expect(view.next?.text).toContain('1.190,00')

    const preview = await admin.post(`/api/v1/documents/${invoice.id}/dunning/preview`, {
      feeCents: 250,
    })
    expect(preview.statusCode, preview.body).toBe(200)
    expect((preview.json() as DunningAmounts).totalCents).toBe(119_250)
    expect((await worker.post(`/api/v1/documents/${invoice.id}/dunning`, {})).statusCode).toBe(403)

    const res = await admin.post(`/api/v1/documents/${invoice.id}/dunning`, {
      email: { to: 'buchhaltung@wohnbau.example' },
    })
    expect(res.statusCode, res.body).toBe(201)
    const notice = res.json() as DunningNotice
    expect(notice).toMatchObject({
      level: 'reminder',
      totalCents: 119_000,
      createdBy: 'Chef',
      email: { to: 'buchhaltung@wohnbau.example', status: 'queued', sentAt: null },
    })
    const pdf = await admin.get(`/api/v1/dunning-notices/${notice.id}/pdf`)
    expect(pdf.statusCode).toBe(200)
    expect(pdf.headers['content-type']).toBe('application/pdf')
    expect(pdf.rawPayload.subarray(0, 5).toString()).toBe('%PDF-')
    const doc = (await admin.get(`/api/v1/documents/${invoice.id}`)).json() as DocumentDetail
    expect(doc.receivable?.status).toBe('dunned')

    await withTenant(h.sql, { tenantId }, async (tx) => {
      const [artifact] = await tx<{ lockedUntil: string; kind: string }[]>`
        select to_char(locked_until, 'YYYY-MM-DD') as "lockedUntil", kind from document_artifact
        where dunning_notice_id = ${notice.id}`
      // Handelsbrief: 6 years from the end of 2026.
      expect(artifact).toEqual({ lockedUntil: '2032-12-31', kind: 'dunning_pdf' })
      const [mail] = await tx<{ kind: string; subject: string; files: string[] }[]>`
        select m.kind, m.subject,
               array(select filename from email_attachment where email_message_id = m.id) as files
        from email_message m where m.dunning_notice_id = ${notice.id}`
      expect(mail?.kind).toBe('dunning')
      expect(mail?.subject).toMatch(/^Zahlungserinnerung zur Rechnung R.* – Mahn Bau GmbH$/)
      expect(mail?.files).toEqual([`Zahlungserinnerung_${invoice.number}.pdf`])
      // Issued notices are never changed or deleted (rule 7).
      await expect(
        tx.savepoint((s) => s`update dunning_notice set fee_cents = 1 where id = ${notice.id}`),
      ).rejects.toThrow()
      await expect(
        tx.savepoint((s) => s`delete from dunning_notice where id = ${notice.id}`),
      ).rejects.toThrow()
    })
  })

  it('waits for the deadline, then charges fee, Pauschale and Verzugszinsen', async () => {
    const early = await admin.post(`/api/v1/documents/${invoice.id}/dunning`, {})
    expect(early.statusCode).toBe(409)
    expect(early.json().detail).toBe(
      'Die Frist der Zahlungserinnerung läuft noch bis zum 30.11.2026.',
    )
    at('2026-12-15')
    const res = await admin.post(`/api/v1/documents/${invoice.id}/dunning`, { flatFee: true })
    expect(res.statusCode, res.body).toBe(201)
    // 1.190,00 € × 10,52 % (1,52 + 9) × 15/365 = 5,14 €
    expect(res.json()).toMatchObject({
      level: 'first',
      dueDate: '2026-12-22',
      feeCents: 500,
      flatFeeCents: 4000,
      interestCents: 514,
      interestRatePercent: '10.52',
      interestFrom: '2026-12-01',
      interestTo: '2026-12-15',
      earlierChargesCents: 0,
      totalCents: 119_000 + 500 + 4000 + 514,
      email: null,
    })
  })

  it('uses the settings and claims earlier charges in the final notice', async () => {
    const settings = (await admin.get('/api/v1/settings/dunning')).json() as DunningSettings
    expect(settings.first).toMatchObject({ days: 7, feeCents: 500, interest: true })
    const put = await admin.put('/api/v1/settings/dunning', {
      ...settings,
      final: { ...settings.final, feeCents: 1500, days: 10 },
    })
    expect(put.statusCode, put.body).toBe(200)
    expect(
      (await admin.put('/api/v1/settings/dunning', { ...settings, first: { days: 0 } })).statusCode,
    ).toBe(400)

    at('2027-01-05')
    const paid = await admin.post(`/api/v1/documents/${invoice.id}/payments`, {
      paidOn: '2026-12-20',
      amountCents: 19_000,
    })
    expect(paid.statusCode, paid.body).toBe(201)
    const res = await admin.post(`/api/v1/documents/${invoice.id}/dunning`, {})
    expect(res.statusCode, res.body).toBe(201)
    // 10,52 % on 1.190,00 € for 20 days (until the payment on 20.12.), then on 1.000,00 € for
    // 16 days: (1.190 × 20 + 1.000 × 16) × 10,52 % / 365 = 11,47 €; Pauschale only once
    expect(res.json()).toMatchObject({
      level: 'final',
      dueDate: '2027-01-15',
      openCents: 100_000,
      feeCents: 1500,
      flatFeeCents: 0,
      interestCents: 1147,
      earlierChargesCents: 4500,
      totalCents: 100_000 + 4500 + 1500 + 1147,
    })
    const view = await overview()
    expect(view.notices.map((n) => n.level)).toEqual(['reminder', 'first', 'final'])
    expect(view).toMatchObject({ next: null, blocked: 'Die letzte Mahnung ist bereits erstellt.' })

    const resend = await admin.post(`/api/v1/dunning-notices/${view.notices[2]?.id}/email`, {
      to: 'chef@wohnbau.example',
    })
    expect(resend.statusCode, resend.body).toBe(202)
    expect((await overview()).notices[2]?.email?.to).toBe('chef@wohnbau.example')
  })

  it('keeps a table of Basiszinssätze; own rates are visible only to the company', async () => {
    let rates = (
      await admin.get('/api/v1/settings/base-interest-rates')
    ).json() as BaseInterestRate[]
    expect(rates[0]).toMatchObject({ validFrom: '2026-07-01', ratePercent: '1.52', own: false })
    const added = await admin.post('/api/v1/settings/base-interest-rates', {
      validFrom: '2027-01-01',
      ratePercent: '1,77',
    })
    expect(added.statusCode, added.body).toBe(201)
    rates = added.json()
    expect(rates[0]).toMatchObject({ validFrom: '2027-01-01', ratePercent: '1.77', own: true })
    expect(
      (
        await admin.post('/api/v1/settings/base-interest-rates', {
          validFrom: '2027-01-01',
          ratePercent: '2',
        })
      ).statusCode,
    ).toBe(409)
    expect(
      (
        await admin.post('/api/v1/settings/base-interest-rates', {
          validFrom: '2027-01-01',
          ratePercent: 'viel',
        })
      ).statusCode,
    ).toBe(400)
    // RLS: another company sees only the shipped rates, not this company's row.
    const other = '00000000-0000-7000-8000-000000000001'
    const visible = await withTenant(
      h.sql,
      { tenantId: other },
      (tx) => tx<{ own: boolean }[]>`select tenant_id is not null as own from base_interest_rate`,
    )
    expect(visible.length).toBeGreaterThan(0)
    expect(visible.some((r) => r.own)).toBe(false)
    const attachments = await withTenant(
      h.sql,
      { tenantId: other },
      (tx) => tx`select id from email_attachment`,
    )
    expect(attachments).toHaveLength(0)

    const ownId = rates[0]?.id
    const removed = await admin.request('DELETE', `/api/v1/settings/base-interest-rates/${ownId}`)
    expect(removed.statusCode, removed.body).toBe(200)
    const shipped = rates.find((r) => !r.own)?.id
    expect(
      (await admin.request('DELETE', `/api/v1/settings/base-interest-rates/${shipped}`)).statusCode,
    ).toBe(404)
  })

  it('refuses notices for unknown invoices and hides PDFs of other ids', async () => {
    const missing = '00000000-0000-7000-8000-0000000000ff'
    expect((await admin.get(`/api/v1/documents/${missing}/dunning`)).statusCode).toBe(404)
    expect((await admin.get(`/api/v1/dunning-notices/${missing}/pdf`)).statusCode).toBe(404)
    expect(
      (await admin.post(`/api/v1/dunning-notices/${missing}/email`, { to: 'a@b.example' }))
        .statusCode,
    ).toBe(404)
  })
})
