import type {
  CompanyNoticeEntry,
  DocumentDetail,
  DocumentEmailDraft,
  DocumentSettings,
  HolidayList,
} from '@easybau/schemas'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client, createHarness, type Harness } from './testing/harness.js'

/**
 * Einstellungen ergänzen (P2.11): Feiertage nach Bundesland, Lohnkostenanteil § 35a,
 * Abschlagsart, Dateinamen-Muster, automatische Anhänge und Hinweisleiste.
 */
describe.skipIf(!process.env.DATABASE_URL)(
  'Einstellungen › Dokumente, Feiertage (integration)',
  () => {
    let h: Harness
    let admin: Client
    let worker: Client
    let projectId: string
    let personId: string
    let organizationId: string
    let units: { id: string; symbol: string }[]
    const PDF = Buffer.from('%PDF-1.7\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n')

    const upload = (client: Client, data: Buffer, name: string) =>
      client.upload(`/api/v1/settings/attachments?name=${encodeURIComponent(name)}`, data)

    async function documentFor(
      contactId: string,
      type: 'invoice' | 'quote',
      invoiceKind?: 'standard' | 'progress',
    ) {
      const draft = (
        await admin.post(`/api/v1/projects/${projectId}/documents`, {
          type,
          ...(invoiceKind ? { invoiceKind } : {}),
        })
      ).json() as DocumentDetail
      const updated = await admin.patch(`/api/v1/documents/${draft.id}`, {
        contactId,
        documentDate: '2026-11-02',
        ...(type === 'invoice' ? { serviceFrom: '2026-10-26', paymentDueDays: 14 } : {}),
      })
      expect(updated.statusCode, updated.body).toBe(200)
      const item = await admin.post(`/api/v1/documents/${draft.id}/items`, {
        positionType: 'item',
        shortText: 'Fliesen verlegen',
        quantity: '10',
        unitId: units.find((u) => u.symbol === 'm²')?.id,
      })
      expect(item.statusCode, item.body).toBe(201)
      const itemId = (item.json() as DocumentDetail).items.at(-1)?.id
      // Kalkulation: 1 h Lohn à 50 € + Material 20 € per m².
      const calc = await admin.post(`/api/v1/documents/${draft.id}/items/${itemId}/calculation`, {
        lines: [
          {
            kind: 'labor',
            description: 'Fliesenleger',
            quantity: '60',
            unitId: units.find((u) => u.symbol === 'min')?.id,
            unitCostCents: 5000,
          },
          {
            kind: 'material',
            description: 'Fliesen',
            quantity: '1',
            unitId: units.find((u) => u.symbol === 'm²')?.id,
            unitCostCents: 2000,
          },
        ],
      })
      expect(calc.statusCode, calc.body).toBe(200)
      return (await admin.get(`/api/v1/documents/${draft.id}`)).json() as DocumentDetail
    }

    beforeAll(async () => {
      h = await createHarness({ requireAdminMfa: false, smtp: true })
      admin = new Client(h.app)
      await admin.post('/api/v1/setup', {
        setupToken: h.setupToken,
        company: { name: 'Vorgaben Bau GmbH' },
        admin: {
          email: 'chef@example.test',
          password: 'ein-sehr-langes-passwort',
          displayName: 'Chef',
        },
      })
      const person = await admin.post('/api/v1/contacts', {
        kind: 'person',
        firstName: 'Erika',
        lastName: 'Muster',
        addresses: [{ kind: 'main', street: 'Gartenweg 1', postalCode: '80331', city: 'München' }],
      })
      expect(person.statusCode, person.body).toBe(201)
      personId = person.json().id
      organizationId = (
        await admin.post('/api/v1/contacts', {
          kind: 'organization',
          organizationName: 'Wohnbau AG',
          addresses: [{ kind: 'main', street: 'Ring 5', postalCode: '80333', city: 'München' }],
        })
      ).json().id
      projectId = (
        await admin.post('/api/v1/projects', { name: 'Bad Muster', customerId: personId })
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

    it('shows missing company data in the notice bar, only to people who can fix it', async () => {
      const notices = (await admin.get('/api/v1/notices')).json() as CompanyNoticeEntry[]
      expect(notices.map((n) => n.key)).toEqual([
        'company_address',
        'company_tax_id',
        'company_iban',
        'company_email',
        'company_federal_state',
        'email_unverified',
      ])
      // The invitation link proved the inbox; company data is not the team member's business.
      expect((await worker.get('/api/v1/notices')).json()).toEqual([])
      expect(
        (await admin.patch('/api/v1/settings/company', { federalState: 'Bayern' })).statusCode,
      ).toBe(400)
      const saved = await admin.patch('/api/v1/settings/company', {
        street: 'Werkstraße 2',
        postalCode: '80335',
        city: 'München',
        taxNumber: '143/123/45678',
        email: 'buero@vorgaben.example',
        iban: 'DE89370400440532013000',
        federalState: 'BY',
      })
      expect(saved.statusCode, saved.body).toBe(200)
      expect(
        ((await admin.get('/api/v1/notices')).json() as CompanyNoticeEntry[]).map((n) => n.key),
      ).toEqual(['email_unverified'])
    })

    it('lists the statutory holidays of the state plus own ones', async () => {
      const list = (await worker.get('/api/v1/settings/holidays?year=2026')).json() as HolidayList
      expect(list.federalState).toBe('BY')
      expect(list.holidays.map((d) => `${d.date} ${d.name}`)).toContain('2026-06-04 Fronleichnam')
      expect(list.holidays).toHaveLength(12)
      expect(
        (
          await worker.post('/api/v1/settings/holidays', {
            date: '2026-12-24',
            name: 'Heiligabend',
          })
        ).statusCode,
      ).toBe(403)
      const added = await admin.post('/api/v1/settings/holidays', {
        date: '2026-12-24',
        name: 'Heiligabend (Betriebsruhe)',
      })
      expect(added.statusCode, added.body).toBe(201)
      const own = (added.json() as HolidayList).holidays.find((d) => d.custom)
      expect(own).toMatchObject({ date: '2026-12-24', name: 'Heiligabend (Betriebsruhe)' })
      expect(
        (await admin.post('/api/v1/settings/holidays', { date: '2026-12-24', name: 'Doppelt' }))
          .statusCode,
      ).toBe(400)
      expect((await admin.get('/api/v1/settings/holidays?year=1990')).statusCode).toBe(400)
      expect((await admin.delete(`/api/v1/settings/holidays/${own?.id}`)).statusCode).toBe(204)
      expect((await admin.delete(`/api/v1/settings/holidays/${own?.id}`)).statusCode).toBe(404)
    })

    it('shows the labor share (§ 35a) by default on invoices to persons', async () => {
      const invoice = await documentFor(personId, 'invoice', 'standard')
      expect(invoice.showLaborShare).toBe(true)
      // 10 m² × (50 € Lohn + 20 € Material, without markups) → Lohn 500 € netto, 595 € brutto.
      expect(invoice.totals.laborShare).toEqual({ netCents: 50_000, grossCents: 59_500 })
      expect(invoice.legalNotes).toContain(
        'Im Betrag enthaltene Arbeitskosten (Lohn-, Maschinen- und Fahrtkosten) nach § 35a EStG: 595,00 € inkl. USt (netto 500,00 €).',
      )
      // Changing the recipient to an organization applies the matrix again.
      const toOrganization = (
        await admin.patch(`/api/v1/documents/${invoice.id}`, { contactId: organizationId })
      ).json() as DocumentDetail
      expect(toOrganization.showLaborShare).toBe(false)
      expect(toOrganization.legalNotes.join(' ')).not.toMatch(/35a/)
      const manual = (
        await admin.patch(`/api/v1/documents/${invoice.id}`, { showLaborShare: true })
      ).json() as DocumentDetail
      expect(manual.legalNotes.join(' ')).toMatch(/35a/)
      // Saving the header with the same recipient keeps the own choice.
      const same = (
        await admin.patch(`/api/v1/documents/${invoice.id}`, { contactId: organizationId })
      ).json() as DocumentDetail
      expect(same.showLaborShare).toBe(true)
      // Quotes: off by default.
      expect((await documentFor(personId, 'quote')).showLaborShare).toBe(false)
    })

    it('stores document defaults: § 35a matrix, Abschlagsart, file names', async () => {
      const defaults = (await admin.get('/api/v1/settings/documents')).json() as DocumentSettings
      expect(defaults).toMatchObject({
        laborShare: {
          invoice: { person: true, organization: false },
          offer: { person: false, organization: false },
        },
        progressBillingMode: 'cumulative',
        fileNamePattern: '{Typ}_{Nummer}',
        example: 'Rechnung_R2026-00101.pdf',
        files: [],
      })
      const body = {
        laborShare: {
          invoice: { person: true, organization: false },
          offer: { person: true, organization: false },
        },
        progressBillingMode: 'individual',
        fileNamePattern: '{Typ}_{Nummer}_{Kunde}',
        attachments: {},
      }
      expect(
        (await admin.put('/api/v1/settings/documents', { ...body, fileNamePattern: '{Kunde}' }))
          .statusCode,
      ).toBe(400)
      expect((await worker.put('/api/v1/settings/documents', body)).statusCode).toBe(403)
      const saved = await admin.put('/api/v1/settings/documents', body)
      expect(saved.statusCode, saved.body).toBe(200)
      expect(saved.json().example).toBe('Rechnung_R2026-00101_Mustermann,_Max.pdf')

      expect((await documentFor(personId, 'quote')).showLaborShare).toBe(true)
      const progress = await documentFor(personId, 'invoice', 'progress')
      expect(progress.progressBillingMode).toBe('individual')
      const pdf = await admin.get(`/api/v1/documents/${progress.id}/pdf`)
      expect(pdf.statusCode).toBe(200)
      expect(pdf.headers['content-disposition']).toContain(
        `filename*=UTF-8''1_Abschlagsrechnung_Entwurf_${encodeURIComponent('Muster,_Erika')}.pdf`,
      )
    })

    it('attaches company files (AGB) automatically to e-mails of a document type', async () => {
      expect((await upload(admin, Buffer.from('kein pdf'), 'AGB')).statusCode).toBe(415)
      expect((await upload(worker, PDF, 'AGB')).statusCode).toBe(403)
      const uploaded = await upload(admin, PDF, 'AGB 2026')
      expect(uploaded.statusCode, uploaded.body).toBe(201)
      const file = uploaded.json()
      expect(file).toMatchObject({ name: 'AGB 2026.pdf', sizeBytes: PDF.length })
      // Same content again: the existing file.
      expect((await upload(admin, PDF, 'AGB neu')).json().id).toBe(file.id)

      const current = (await admin.get('/api/v1/settings/documents')).json() as DocumentSettings
      const bad = await admin.put('/api/v1/settings/documents', {
        ...current,
        attachments: { quote: ['0190d6c0-0000-7000-8000-000000000000'] },
      })
      expect(bad.statusCode).toBe(400)
      const saved = await admin.put('/api/v1/settings/documents', {
        laborShare: current.laborShare,
        progressBillingMode: current.progressBillingMode,
        fileNamePattern: '{Typ}_{Nummer}',
        attachments: { quote: [file.id], invoice: [] },
      })
      expect(saved.statusCode, saved.body).toBe(200)
      expect((saved.json() as DocumentSettings).attachments).toEqual({ quote: [file.id] })

      const quote = await documentFor(organizationId, 'quote')
      const finalized = await admin.post(`/api/v1/documents/${quote.id}/finalize`, {})
      expect(finalized.statusCode, finalized.body).toBe(200)
      const dialog = (
        await admin.get(`/api/v1/documents/${quote.id}/email`)
      ).json() as DocumentEmailDraft
      expect(dialog.files).toEqual([
        { id: file.id, filename: 'AGB 2026.pdf', sizeBytes: PDF.length, selected: true },
      ])
      expect((saved.json() as DocumentSettings).files[0]).toMatchObject({ retired: false })
      expect(dialog.attachments[0]?.filename).toBe(`Angebot_${finalized.json().number}.pdf`)

      const sent = await admin.post(`/api/v1/documents/${quote.id}/email`, {
        to: 'kunde@example.test',
        subject: 'Angebot',
        text: 'Anbei',
      })
      expect(sent.statusCode, sent.body).toBe(202)
      expect((sent.json() as DocumentEmailDraft).history[0]?.attachments).toEqual([
        `Angebot_${finalized.json().number}.pdf`,
        'AGB 2026.pdf',
      ])
      // The worker reads the company file like an archived original.
      const claimed = await h.sql<{ id: string }[]>`select id from claim_email_messages(10)`
      const files = await h.sql<{ filename: string; mime_type: string; storage_key: string }[]>`
      select * from email_message_attachments(${claimed[0]?.id as string})`
      expect(files.map((f) => [f.filename, f.mime_type])).toEqual([
        [`Angebot_${finalized.json().number}.pdf`, 'application/pdf'],
        ['AGB 2026.pdf', 'application/pdf'],
      ])
      expect(files[1]?.storage_key).toMatch(/\/assets\//)

      // Deselected in the dialog: only the PDF.
      const without = await admin.post(`/api/v1/documents/${quote.id}/email`, {
        to: 'kunde@example.test',
        subject: 'Angebot',
        text: 'Anbei',
        fileIds: [],
      })
      expect((without.json() as DocumentEmailDraft).history[0]?.attachments).toHaveLength(1)
      expect(
        (
          await admin.post(`/api/v1/documents/${quote.id}/email`, {
            to: 'kunde@example.test',
            subject: 'Angebot',
            text: 'Anbei',
            fileIds: [quote.id],
          })
        ).statusCode,
      ).toBe(400)

      // „Nicht mehr anbieten“: no longer offered nor attached automatically, but kept.
      const retired = await admin.put('/api/v1/settings/documents', {
        laborShare: current.laborShare,
        progressBillingMode: current.progressBillingMode,
        fileNamePattern: '{Typ}_{Nummer}',
        attachments: { quote: [file.id], dunning_notice: [file.id] },
        retiredAttachments: [file.id],
      })
      expect(retired.statusCode, retired.body).toBe(200)
      const settings = retired.json() as DocumentSettings
      expect(settings.files[0]).toMatchObject({ id: file.id, retired: true })
      expect(settings.attachments).toEqual({ quote: [file.id], dunning_notice: [file.id] })
      const after = (
        await admin.get(`/api/v1/documents/${quote.id}/email`)
      ).json() as DocumentEmailDraft
      expect(after.files).toEqual([])
      const plain = await admin.post(`/api/v1/documents/${quote.id}/email`, {
        to: 'kunde@example.test',
        subject: 'Angebot',
        text: 'Anbei',
      })
      expect((plain.json() as DocumentEmailDraft).history[0]?.attachments).toHaveLength(1)
    })
  },
)
