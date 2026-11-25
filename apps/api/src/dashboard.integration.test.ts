import type {
  DashboardDto,
  DocumentDetail,
  NotificationList,
  ReportDetail,
  SearchResult,
} from '@easybau/schemas'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client, createHarness, type Harness } from './testing/harness.js'

/**
 * Übersicht, globale Suche und Benachrichtigungen (P2.8): each part only with the right to see
 * it; notifications per person.
 */
describe.skipIf(!process.env.DATABASE_URL)(
  'Übersicht, Suche, Benachrichtigungen (integration)',
  () => {
    let h: Harness
    let admin: Client
    let worker: Client
    let projectId: string
    let quote: DocumentDetail
    let invoice: DocumentDetail
    let changeOrder: DocumentDetail
    let units: { id: string; symbol: string }[]
    const at = (iso: string) => {
      h.clock.now = Date.parse(`${iso}T10:00:00Z`)
    }
    const create = async (body: Record<string, unknown>) => {
      const res = await admin.post(`/api/v1/projects/${projectId}/documents`, body)
      expect(res.statusCode, res.body).toBe(201)
      return res.json() as DocumentDetail
    }
    const addItem = (docId: string, shortText: string, cents: number) =>
      admin.post(`/api/v1/documents/${docId}/items`, {
        positionType: 'item',
        shortText,
        quantity: '10',
        unitId: units.find((u) => u.symbol === 'm²')?.id,
        unitPriceCents: cents,
      })
    const finalize = async (id: string) => {
      const res = await admin.post(`/api/v1/documents/${id}/finalize`, {
        acknowledgeWarnings: true,
      })
      expect(res.statusCode, res.body).toBe(200)
      return res.json() as DocumentDetail
    }
    const notifications = async (client: Client) =>
      (await client.get('/api/v1/notifications')).json() as NotificationList

    beforeAll(async () => {
      h = await createHarness({ requireAdminMfa: false })
      admin = new Client(h.app)
      await admin.post('/api/v1/setup', {
        setupToken: h.setupToken,
        company: { name: 'Übersicht Bau GmbH' },
        admin: {
          email: 'chef@example.test',
          password: 'ein-sehr-langes-passwort',
          displayName: 'Chef',
        },
      })
      await admin.patch('/api/v1/settings/company', {
        street: 'Werkstraße 2',
        postalCode: '30169',
        city: 'Hannover',
        taxNumber: '25/123/45678',
      })
      const customerId = (
        await admin.post('/api/v1/contacts', {
          kind: 'organization',
          organizationName: 'Wohnbau Nord eG',
          addresses: [
            { kind: 'main', street: 'Lindenweg 4', postalCode: '30159', city: 'Hannover' },
          ],
        })
      ).json().id
      const invite = await admin.post('/api/v1/invitations', {
        email: 'monteur@example.test',
        roleKey: 'team_member',
      })
      worker = new Client(h.app)
      const accepted = await worker.post('/api/v1/invitations/accept', {
        token: new URL(invite.json().acceptUrl).hash.slice(1),
        displayName: 'Monteur',
        password: 'monteur-passwort-1',
      })
      projectId = (
        await admin.post('/api/v1/projects', {
          name: 'Sanierung Lindenweg',
          customerId,
          startDate: '2026-11-01',
          endDate: '2026-12-20',
          site: { street: 'Lindenweg 4', postalCode: '30159', city: 'Hannover' },
          memberIds: [accepted.json().me.user.id],
        })
      ).json().id
      units = (await admin.get('/api/v1/units')).json()
      at('2026-11-02')
      quote = await create({ type: 'quote', subject: 'Malerarbeiten Treppenhaus' })
      await addItem(quote.id, 'Wände streichen', 1000)
      quote = await finalize(quote.id)
      const ab = await create({ type: 'order_confirmation', sourceDocumentId: quote.id })
      await finalize(ab.id)
      changeOrder = await create({ type: 'change_order', subject: 'Zusätzliche Steckdosen' })
      await addItem(changeOrder.id, 'Steckdose setzen', 4500)
      changeOrder = await finalize(changeOrder.id)
      expect(
        (await admin.post(`/api/v1/documents/${changeOrder.id}/status`, { status: 'sent' }))
          .statusCode,
      ).toBe(200)
      invoice = await create({ type: 'invoice', invoiceKind: 'standard', sourceDocumentId: ab.id })
      await admin.patch(`/api/v1/documents/${invoice.id}`, {
        documentDate: '2026-11-02',
        serviceFrom: '2026-11-02',
        paymentDueDays: 14,
      })
      invoice = await finalize(invoice.id)
      at('2026-11-20')
    })

    afterAll(async () => {
      await h?.close()
    })

    it('shows receivables, open offers and today’s sites to the office', async () => {
      const res = await admin.get('/api/v1/dashboard')
      expect(res.statusCode, res.body).toBe(200)
      const dashboard = res.json() as DashboardDto
      expect(dashboard.today).toBe('2026-11-20')
      expect(dashboard.receivables).toEqual({
        open: { count: 0, cents: 0 },
        overdue: { count: 1, cents: 11_900 },
        dunned: { count: 0, cents: 0 },
        total: { count: 1, cents: 11_900 },
        dunningDueCount: 1,
      })
      expect(dashboard.incomingReviewCount).toBe(0)
      expect(dashboard.recentProjects.map((p) => p.name)).toEqual(['Sanierung Lindenweg'])
      expect(dashboard.openOffers?.map((o) => [o.type, o.status, o.netCents])).toEqual([
        ['change_order', 'sent', 45_000],
      ])
      expect(dashboard.todaysSites).toMatchObject([
        { id: projectId, site: 'Lindenweg 4, 30159 Hannover', endDate: '2026-12-20' },
      ])
    })

    it('hides money from people on site', async () => {
      const dashboard = (await worker.get('/api/v1/dashboard')).json() as DashboardDto
      expect(dashboard.receivables).toBeNull()
      expect(dashboard.openOffers).toBeNull()
      expect(dashboard.incomingReviewCount).toBeNull()
      expect(dashboard.todaysSites.map((s) => s.id)).toEqual([projectId])
    })

    it('serves the part without amounts for the start page without network', async () => {
      const res = await worker.get('/api/v1/dashboard/site')
      expect(res.statusCode, res.body).toBe(200)
      const site = res.json() as Record<string, unknown>
      expect(Object.keys(site).sort()).toEqual(['recentProjects', 'today', 'todaysSites'])
      expect(JSON.stringify(site)).not.toMatch(/Cents/)
      expect((site.todaysSites as { id: string }[]).map((s) => s.id)).toEqual([projectId])
    })

    it('searches projects, contacts and documents within the rights', async () => {
      const search = async (client: Client, q: string) =>
        (await client.get(`/api/v1/search?q=${encodeURIComponent(q)}`)).json() as SearchResult
      const office = await search(admin, 'Lindenweg')
      expect(office.groups.map((g) => g.kind)).toEqual(['project'])
      const result = await search(admin, 'wohnbau')
      expect(result.groups.map((g) => [g.kind, g.hits.length])).toEqual([
        ['project', 1],
        ['contact', 1],
        ['document', 4],
      ])
      expect((await search(admin, 'Steckdosen')).groups[0]?.hits[0]).toMatchObject({
        kind: 'document',
        id: changeOrder.id,
        projectId,
        label: expect.stringMatching(/^Nachtrag · .*\/N01 · Zusätzliche Steckdosen$/),
      })
      // The site team finds its project, but neither contacts nor documents.
      expect((await search(worker, 'wohnbau')).groups.map((g) => g.kind)).toEqual(['project'])
      expect((await admin.get('/api/v1/search?q=a')).statusCode).toBe(400)
    })

    it('notifies about decided change orders, signed reports and overdue invoices', async () => {
      expect(
        (await admin.post(`/api/v1/documents/${changeOrder.id}/status`, { status: 'accepted' }))
          .statusCode,
      ).toBe(200)
      const report = (
        await admin.post(`/api/v1/projects/${projectId}/reports`, {
          templateKey: 'daily_site_report',
          reportDate: '2026-11-19',
        })
      ).json() as ReportDetail
      const signed = await admin.post(`/api/v1/reports/${report.id}/sign`, {
        signatures: [{ role: 'contractor', name: 'Chef' }],
      })
      expect(signed.statusCode, signed.body).toBe(200)

      const mine = await notifications(worker)
      expect(mine.unreadCount).toBe(2)
      expect(mine.items.map((n) => [n.kind, n.title, n.route])).toEqual([
        [
          'report_signed',
          'Bautagesbericht vom 19.11.2026 unterschrieben',
          `/berichte/${report.id}`,
        ],
        ['change_order_decided', 'Nachtrag N01 beauftragt', `/dokumente/${changeOrder.id}`],
      ])
      // The office sees the overdue invoice (once, also when asking again), not its own actions.
      const office = await notifications(admin)
      expect(office.items.map((n) => [n.kind, n.title])).toEqual([
        ['invoice_overdue', `Rechnung ${invoice.number} ist überfällig`],
      ])
      expect(office.items[0]?.body).toBe(
        'Wohnbau Nord eG · offen 119,00 € · fällig seit 16.11.2026',
      )
      expect((await notifications(admin)).items).toHaveLength(1)

      // Read: only own notifications.
      const first = mine.items[0]?.id as string
      expect((await admin.post(`/api/v1/notifications/${first}/read`, {})).statusCode).toBe(404)
      const read = (
        await worker.post(`/api/v1/notifications/${first}/read`, {})
      ).json() as NotificationList
      expect(read.unreadCount).toBe(1)
      expect(read.items[0]?.read).toBe(true)
      const all = (
        await worker.post('/api/v1/notifications/read-all', {})
      ).json() as NotificationList
      expect(all.unreadCount).toBe(0)
    })
  },
)
