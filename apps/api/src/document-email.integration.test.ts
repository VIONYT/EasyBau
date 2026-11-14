import { withTenant } from '@opc/db'
import type { DocumentDetail, DocumentEmailDraft, EmailTemplateSettings } from '@opc/schemas'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client, createHarness, type Harness } from './testing/harness.js'

/**
 * Dokumente per E-Mail (P2.1): prefilled dialog from the templates, archived originals as
 * attachments (ZUGFeRD PDF, XRechnung), CC/BCC, history and status "versendet" once the SMTP
 * server accepted the message.
 */
describe.skipIf(!process.env.DATABASE_URL)('Dokumente per E-Mail (integration)', () => {
  let h: Harness
  let admin: Client
  let worker: Client
  let tenantId: string
  let projectId: string
  let customerId: string
  let units: { id: string; symbol: string }[]
  let invoice: DocumentDetail

  async function document(type: 'invoice' | 'quote') {
    const draft = (
      await admin.post(`/api/v1/projects/${projectId}/documents`, {
        type,
        ...(type === 'invoice' ? { invoiceKind: 'standard' } : {}),
      })
    ).json() as DocumentDetail
    await admin.patch(`/api/v1/documents/${draft.id}`, {
      contactId: customerId,
      documentDate: '2026-11-02',
      ...(type === 'invoice' ? { serviceFrom: '2026-10-26', paymentDueDays: 14 } : {}),
    })
    await admin.post(`/api/v1/documents/${draft.id}/items`, {
      positionType: 'item',
      shortText: 'Wände streichen',
      quantity: '80',
      unitId: units.find((u) => u.symbol === 'm²')?.id,
      unitPriceCents: 1250,
    })
    return draft
  }

  /** What the worker does after the SMTP server accepted (or refused) the message. */
  async function deliver(ok: boolean) {
    const claimed = await h.sql<{ id: string }[]>`select id from claim_email_messages(10)`
    for (const { id } of claimed) {
      await h.sql`select finish_email_message(${id}, ${ok}, ${ok ? null : 'Postfach voll'})`
    }
    return claimed.length
  }

  beforeAll(async () => {
    h = await createHarness({ requireAdminMfa: false, smtp: true })
    admin = new Client(h.app)
    const setup = await admin.post('/api/v1/setup', {
      setupToken: h.setupToken,
      company: { name: 'Versand Bau GmbH' },
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
      email: 'buero@versand-bau.example',
      phone: '0511 123456',
      iban: 'DE89370400440532013000',
    })
    const customer = await admin.post('/api/v1/contacts', {
      kind: 'organization',
      organizationName: 'Stadt Hannover',
      addresses: [{ kind: 'main', street: 'Trammplatz 2', postalCode: '30159', city: 'Hannover' }],
      channels: [{ kind: 'email', value: 'bauamt@hannover.example', isPrimary: true }],
      buyerReference: '03241-12345-67',
      einvoiceEmail: 'erechnung@hannover.example',
      einvoiceFormat: 'xrechnung_ubl',
    })
    expect(customer.statusCode, customer.body).toBe(201)
    customerId = customer.json().id
    projectId = (
      await admin.post('/api/v1/projects', { name: 'Schule Lindenweg', customerId })
    ).json().id
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

  it('does not send drafts', async () => {
    const draft = await document('invoice')
    const dialog = (
      await admin.get(`/api/v1/documents/${draft.id}/email`)
    ).json() as DocumentEmailDraft
    expect(dialog.blocked).toMatch(/zuerst festschreiben/)
    const res = await admin.post(`/api/v1/documents/${draft.id}/email`, {
      to: 'a@example.test',
      subject: 'x',
      text: 'y',
    })
    expect(res.statusCode).toBe(409)
    const finalized = await admin.post(`/api/v1/documents/${draft.id}/finalize`, {})
    expect(finalized.statusCode, finalized.body).toBe(200)
    invoice = finalized.json()
  })

  it('prefills the dialog for an invoice to the e-invoice address with ZUGFeRD PDF and XRechnung', async () => {
    const dialog = (
      await admin.get(`/api/v1/documents/${invoice.id}/email`)
    ).json() as DocumentEmailDraft
    expect(dialog).toMatchObject({
      enabled: true,
      blocked: null,
      to: 'erechnung@hannover.example',
      cc: [],
      bcc: [],
      subject: `Rechnung ${invoice.number} – Versand Bau GmbH`,
      attachments: [{ filename: `Rechnung_${invoice.number}.pdf`, kind: 'pdf' }],
      xrechnung: {
        available: true,
        recommended: true,
        filenames: [`${invoice.number}_xrechnung.xml`],
      },
      history: [],
    })
    expect(dialog.text).toContain(
      `unsere Rechnung ${invoice.number} vom 02.11.2026 für Schule Lindenweg`,
    )
    expect(dialog.text).toContain('über 1.190,00 €')
    expect(dialog.text).toContain('bis zum 16.11.2026')
    expect(dialog.text).toMatch(/Mit freundlichen Grüßen\nVersand Bau GmbH$/)
  })

  it('stores own templates and a default BCC', async () => {
    const defaults = (
      await admin.get('/api/v1/settings/email-templates')
    ).json() as EmailTemplateSettings
    expect(defaults.bcc).toBeNull()
    expect(defaults.templates.invoice.custom).toBe(false)
    expect(defaults.placeholders).toContain('Fällig')
    const saved = await admin.put('/api/v1/settings/email-templates', {
      bcc: 'ablage@versand-bau.example',
      templates: {
        invoice: {
          subject: 'Ihre {Dokument} {Nummer}',
          body: 'Guten Tag,\nanbei {Dokument} {Nummer}.\n{Firma}',
        },
        quote: defaults.templates.quote,
      },
    })
    expect(saved.statusCode, saved.body).toBe(200)
    const settings = saved.json() as EmailTemplateSettings
    expect(settings.templates.invoice).toMatchObject({
      custom: true,
      subject: 'Ihre {Dokument} {Nummer}',
    })
    // A template equal to the default is not stored as own text.
    expect(settings.templates.quote.custom).toBe(false)
    const dialog = (
      await admin.get(`/api/v1/documents/${invoice.id}/email`)
    ).json() as DocumentEmailDraft
    expect(dialog).toMatchObject({
      subject: `Ihre Rechnung ${invoice.number}`,
      text: `Guten Tag,\nanbei Rechnung ${invoice.number}.\nVersand Bau GmbH`,
      bcc: ['ablage@versand-bau.example'],
    })
    expect((await worker.get('/api/v1/settings/email-templates')).statusCode).toBe(403)
    expect(
      (await admin.put('/api/v1/settings/email-templates', { bcc: 'keine-adresse', templates: {} }))
        .statusCode,
    ).toBe(400)
  })

  it('queues the e-mail with attachments, CC and BCC and marks the invoice as sent after delivery', async () => {
    expect(
      (
        await worker.post(`/api/v1/documents/${invoice.id}/email`, {
          to: 'x@example.test',
          subject: 'x',
          text: 'y',
        })
      ).statusCode,
    ).toBe(403)
    const res = await admin.post(`/api/v1/documents/${invoice.id}/email`, {
      to: 'erechnung@hannover.example',
      cc: ['bauamt@hannover.example'],
      bcc: ['ablage@versand-bau.example'],
      subject: `Rechnung ${invoice.number}`,
      text: 'Anbei unsere Rechnung.',
      attachXrechnung: true,
    })
    expect(res.statusCode, res.body).toBe(202)
    const dialog = res.json() as DocumentEmailDraft
    expect(dialog.history).toMatchObject([
      {
        to: 'erechnung@hannover.example',
        cc: ['bauamt@hannover.example'],
        bcc: ['ablage@versand-bau.example'],
        status: 'queued',
        attachments: [`Rechnung_${invoice.number}.pdf`, `${invoice.number}_xrechnung.xml`],
        createdBy: 'Chef',
      },
    ])
    // The attachments are exactly the archived, KoSIT-validated originals.
    const kinds = await withTenant(
      h.sql,
      { tenantId },
      (tx) => tx<{ kind: string; validated: boolean }[]>`
        select a.kind, a.validated_at is not null as validated from email_attachment e
        join document_artifact a on a.id = e.artifact_id order by e.position, e.id`,
    )
    expect(kinds).toEqual([
      { kind: 'zugferd_pdf', validated: true },
      { kind: 'xrechnung_xml', validated: true },
    ])
    // Still "finalized" while the server has not accepted it.
    expect((await admin.get(`/api/v1/documents/${invoice.id}`)).json().status).toBe('finalized')
    expect(await deliver(false)).toBe(1)
    expect((await admin.get(`/api/v1/documents/${invoice.id}`)).json().status).toBe('finalized')
    await h.adminSql`update email_message set next_attempt_at = now()`
    expect(await deliver(true)).toBe(1)
    const sent = (await admin.get(`/api/v1/documents/${invoice.id}`)).json() as DocumentDetail
    expect(sent.status).toBe('sent')
    const after = (
      await admin.get(`/api/v1/documents/${invoice.id}/email`)
    ).json() as DocumentEmailDraft
    expect(after.history[0]).toMatchObject({ status: 'sent', attempts: 2, lastError: null })
    // A sent invoice can still take payments and be sent again.
    const pay = await admin.post(`/api/v1/documents/${invoice.id}/payments`, {
      paidOn: '2026-11-08',
      amountCents: 1000,
    })
    expect(pay.statusCode, pay.body).toBe(201)
    expect(after.blocked).toBeNull()
  })

  it('sends a quote with its PDF and marks it as offered', async () => {
    const quote = await document('quote')
    expect((await admin.post(`/api/v1/documents/${quote.id}/finalize`, {})).statusCode).toBe(200)
    const dialog = (
      await admin.get(`/api/v1/documents/${quote.id}/email`)
    ).json() as DocumentEmailDraft
    expect(dialog).toMatchObject({
      to: 'bauamt@hannover.example',
      xrechnung: { available: false, recommended: false },
      subject: expect.stringMatching(/^Angebot A-\d+ – Schule Lindenweg$/),
    })
    expect(
      (
        await admin.post(`/api/v1/documents/${quote.id}/email`, {
          to: 'bauamt@hannover.example',
          subject: dialog.subject,
          text: dialog.text,
          attachXrechnung: true,
        })
      ).statusCode,
    ).toBe(409)
    const res = await admin.post(`/api/v1/documents/${quote.id}/email`, {
      to: 'bauamt@hannover.example',
      subject: dialog.subject,
      text: dialog.text,
    })
    expect(res.statusCode, res.body).toBe(202)
    expect(res.json().history[0].attachments).toEqual([
      expect.stringMatching(/^Angebot_A-\d+\.pdf$/),
    ])
    await deliver(true)
    expect((await admin.get(`/api/v1/documents/${quote.id}`)).json().status).toBe('sent')
  })

  it('refuses sending without SMTP', async () => {
    const plain = await createHarness({ requireAdminMfa: false })
    try {
      const client = new Client(plain.app)
      await client.post('/api/v1/setup', {
        setupToken: plain.setupToken,
        company: { name: 'Ohne Mail GmbH' },
        admin: { email: 'a@example.test', password: 'ein-sehr-langes-passwort', displayName: 'A' },
      })
      const res = await client.post(
        `/api/v1/documents/00000000-0000-7000-8000-000000000000/email`,
        {
          to: 'a@example.test',
          subject: 'x',
          text: 'y',
        },
      )
      expect(res.statusCode).toBe(409)
      expect(res.json().detail).toMatch(/nicht eingerichtet/)
    } finally {
      await plain.close()
    }
  })
})
