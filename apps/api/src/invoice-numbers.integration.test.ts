import type { DocumentDetail } from '@easybau/schemas'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { EinvoiceValidator } from './kosit.js'
import { acceptingValidator, Client, createHarness, type Harness } from './testing/harness.js'

/**
 * Rechnungsnummern unter Parallelität (CLAUDE.md Regel 3): many invoices are finalized at the same
 * time through the API. Numbers must be gapless and unique, also when some of them fail in the
 * middle of the finalize transaction (E-Rechnung rejected → rollback without a number).
 */
const REJECT = 'ABLEHNEN'
const markerValidator: EinvoiceValidator = {
  async validate(xml) {
    if (!xml.includes(REJECT)) return acceptingValidator.validate(xml)
    // A little delay so that other finalizations queue up behind the number lock.
    await new Promise((resolve) => setTimeout(resolve, 20))
    return {
      valid: false,
      report: '<rep:report valid="false"/>',
      result: {
        valid: false,
        scenario: null,
        engine: 'Test stub',
        messages: [{ level: 'error', code: 'TEST', text: 'Absichtlich abgelehnt.' }],
      },
    }
  },
}

describe.skipIf(!process.env.DATABASE_URL)(
  'Rechnungsnummern unter Parallelität (integration)',
  () => {
    let h: Harness
    let admin: Client
    let projectId: string
    let unitId: string

    beforeAll(async () => {
      h = await createHarness({ requireAdminMfa: false, einvoiceValidator: markerValidator })
      admin = new Client(h.app)
      await admin.post('/api/v1/setup', {
        setupToken: h.setupToken,
        company: { name: 'Takt Bau GmbH' },
        admin: {
          email: 'chef@example.test',
          password: 'ein-sehr-langes-passwort',
          displayName: 'C',
        },
      })
      await admin.patch('/api/v1/settings/company', {
        street: 'Werkstraße 2',
        postalCode: '30169',
        city: 'Hannover',
        taxNumber: '25/123/45678',
      })
      const customer = await admin.post('/api/v1/contacts', {
        kind: 'organization',
        organizationName: 'Wohnbau Nord eG',
        assignCustomerNumber: true,
        addresses: [{ kind: 'main', street: 'Lindenweg 4', postalCode: '30159', city: 'Hannover' }],
      })
      const project = await admin.post('/api/v1/projects', {
        name: 'Viele Rechnungen',
        customerId: customer.json().id,
      })
      projectId = project.json().id
      const units = (await admin.get('/api/v1/units')).json() as { id: string; symbol: string }[]
      unitId = units.find((u) => u.symbol === 'Std')?.id as string
    })

    afterAll(async () => {
      await h?.close()
    })

    const draftInvoice = async (text: string) => {
      const created = await admin.post(`/api/v1/projects/${projectId}/documents`, {
        type: 'invoice',
        invoiceKind: 'standard',
      })
      expect(created.statusCode, created.body).toBe(201)
      const doc = created.json() as DocumentDetail
      const item = await admin.post(`/api/v1/documents/${doc.id}/items`, {
        positionType: 'item',
        shortText: text,
        quantity: '2',
        unitId,
        unitPriceCents: 6500,
      })
      expect(item.statusCode, item.body).toBe(201)
      const patched = await admin.patch(`/api/v1/documents/${doc.id}`, {
        documentDate: '2026-11-20',
        serviceFrom: '2026-11-18',
        serviceTo: '2026-11-19',
        paymentDueDays: 14,
      })
      expect(patched.statusCode, patched.body).toBe(200)
      return doc.id
    }

    it('gives gapless, unique numbers when invoices are finalized at the same time', async () => {
      const texts = Array.from({ length: 15 }, (_, i) =>
        i % 5 === 2 ? `Regiestunden ${REJECT} ${i}` : `Regiestunden ${i}`,
      )
      const ids: string[] = []
      for (const text of texts) ids.push(await draftInvoice(text))

      const results = await Promise.all(
        ids.map((id) => admin.post(`/api/v1/documents/${id}/finalize`, {})),
      )
      const ok = results.filter((r) => r.statusCode === 200)
      const failed = results.filter((r) => r.statusCode !== 200)
      expect(failed).toHaveLength(3)
      for (const r of failed) expect(r.statusCode, r.body).toBeGreaterThanOrEqual(400)

      const numbers = ok.map((r) => (r.json() as DocumentDetail).number as string)
      expect(new Set(numbers).size).toBe(12)
      expect([...numbers].sort()).toEqual(
        Array.from({ length: 12 }, (_, i) => `R-${String(101 + i).padStart(5, '0')}`),
      )

      // The rejected invoices stay drafts without a number; the next one continues the series.
      for (const [index, id] of ids.entries()) {
        if (!texts[index]?.includes(REJECT)) continue
        const doc = (await admin.get(`/api/v1/documents/${id}`)).json() as DocumentDetail
        expect(doc).toMatchObject({ status: 'draft', number: null })
      }
      const next = await draftInvoice('Nachzügler')
      const last = await admin.post(`/api/v1/documents/${next}/finalize`, {})
      expect(last.statusCode, last.body).toBe(200)
      expect((last.json() as DocumentDetail).number).toBe('R-00113')
    }, 60_000)
  },
)
