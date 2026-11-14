import type { CatalogItem, DocumentDetail, TargetPriceResult } from '@opc/schemas'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client, createHarness, type Harness } from './testing/harness.js'

/** 1 × 1 px PNG. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

/**
 * Angebot (P2.12): Zielpreis („Preis anpassen“), Bild-Positionen, Angebotsversionen,
 * „In Stammdaten speichern“.
 */
describe.skipIf(!process.env.DATABASE_URL)(
  'Angebot: Zielpreis, Bilder, Versionen (integration)',
  () => {
    let h: Harness
    let admin: Client
    let projectId: string
    let quote: DocumentDetail
    let unit: (symbol: string) => string

    async function calculate(doc: DocumentDetail, text: string, labor: number, material: number) {
      const item = doc.items.find((i) => i.shortText === text)
      const res = await admin.post(`/api/v1/documents/${doc.id}/items/${item?.id}/calculation`, {
        lines: [
          {
            kind: 'labor',
            description: 'Geselle',
            quantity: '60',
            unitId: unit('min'),
            unitCostCents: labor,
          },
          {
            kind: 'material',
            description: 'Material',
            quantity: '1',
            unitId: unit('m²'),
            unitCostCents: material,
          },
        ],
      })
      expect(res.statusCode, res.body).toBe(200)
      return res.json() as DocumentDetail
    }

    beforeAll(async () => {
      h = await createHarness({ requireAdminMfa: false })
      admin = new Client(h.app)
      await admin.post('/api/v1/setup', {
        setupToken: h.setupToken,
        company: { name: 'Angebot Bau GmbH' },
        admin: {
          email: 'chef@example.test',
          password: 'ein-sehr-langes-passwort',
          displayName: 'Chef',
        },
      })
      const customer = (
        await admin.post('/api/v1/contacts', {
          kind: 'organization',
          organizationName: 'Wohnbau AG',
          addresses: [{ kind: 'main', street: 'Ring 5', postalCode: '80333', city: 'München' }],
        })
      ).json()
      projectId = (
        await admin.post('/api/v1/projects', { name: 'Bad', customerId: customer.id })
      ).json().id
      const units = (await admin.get('/api/v1/units')).json() as { id: string; symbol: string }[]
      unit = (symbol) => units.find((u) => u.symbol === symbol)?.id as string
      quote = (
        await admin.post(`/api/v1/projects/${projectId}/documents`, { type: 'quote' })
      ).json()
      for (const text of ['Fliesen', 'Abdichtung']) {
        await admin.post(`/api/v1/documents/${quote.id}/items`, {
          positionType: 'item',
          shortText: text,
          quantity: '10',
          unitId: unit('m²'),
        })
      }
      await admin.post(`/api/v1/documents/${quote.id}/items`, {
        positionType: 'item',
        shortText: 'Anfahrt',
        quantity: '1',
        unitId: unit('psch'),
        unitPriceCents: 5000,
      })
      quote = (await admin.get(`/api/v1/documents/${quote.id}`)).json()
      quote = await calculate(quote, 'Fliesen', 5000, 2000)
      quote = await calculate(quote, 'Abdichtung', 4000, 1000)
    })

    afterAll(async () => {
      await h?.close()
    })

    it('previews and applies a target price by scaling the markups', async () => {
      const before = quote.totals.netCents
      expect(before).toBeGreaterThan(0)
      const preview = await admin.post(`/api/v1/documents/${quote.id}/target-price`, {
        targetNetCents: 150_000,
      })
      expect(preview.statusCode, preview.body).toBe(200)
      expect(preview.json()).toMatchObject({
        currentNetCents: before,
        targetNetCents: 150_000,
        adjustedCount: 2,
        fixedCount: 1,
        applied: false,
        document: null,
      })
      // Nothing changed yet
      expect(
        ((await admin.get(`/api/v1/documents/${quote.id}`)).json() as DocumentDetail).totals
          .netCents,
      ).toBe(before)

      const applied = (
        await admin.post(`/api/v1/documents/${quote.id}/target-price`, {
          targetNetCents: 150_000,
          apply: true,
        })
      ).json() as TargetPriceResult
      expect(applied.applied).toBe(true)
      expect(Math.abs(applied.residualCents)).toBeLessThanOrEqual(10)
      const doc = applied.document as DocumentDetail
      expect(doc.totals.netCents).toBe(applied.netCents)
      // Fixed price stays, costs stay, only markups changed
      expect(doc.items.find((i) => i.shortText === 'Anfahrt')?.totalCents).toBe(5000)
      const tiles = doc.items.find((i) => i.shortText === 'Fliesen')
      expect(tiles?.calculation?.costCents).toBe(70_000)
      quote = doc

      // Below cost is reported; impossible targets are refused
      const low = (
        await admin.post(`/api/v1/documents/${quote.id}/target-price`, { targetNetCents: 100_000 })
      ).json() as TargetPriceResult
      expect(low.belowCost.map((b) => b.shortText).sort()).toEqual(['Abdichtung', 'Fliesen'])
      const zero = await admin.post(`/api/v1/documents/${quote.id}/target-price`, {
        targetNetCents: 1000,
        apply: true,
      })
      expect(zero.statusCode).toBe(409)
      // Locked: Fliesen stays
      const lockedId = tiles?.id as string
      const locked = (
        await admin.post(`/api/v1/documents/${quote.id}/target-price`, {
          targetNetCents: 160_000,
          lockedItemIds: [lockedId],
          apply: true,
        })
      ).json() as TargetPriceResult
      expect(locked.adjustedCount).toBe(1)
      expect(locked.document?.items.find((i) => i.id === lockedId)?.totalCents).toBe(
        tiles?.totalCents,
      )
      quote = locked.document as DocumentDetail
    })

    it('adds an image of the project files as a position and prints it', async () => {
      const folders = (await admin.get(`/api/v1/projects/${projectId}/folders`)).json() as {
        id: string
      }[]
      const file = await admin.upload(
        `/api/v1/projects/${projectId}/files?filename=Fliesenmuster.png&folderId=${folders[0]?.id}`,
        PNG,
      )
      expect(file.statusCode, file.body).toBe(201)
      const fileId = file.json().id
      const pdfFile = await admin.upload(
        `/api/v1/projects/${projectId}/files?filename=Plan.pdf&folderId=${folders[0]?.id}`,
        Buffer.from('%PDF-1.7\n%%EOF\n'),
      )
      expect(
        (
          await admin.post(`/api/v1/documents/${quote.id}/items`, {
            positionType: 'image',
            imageFileId: pdfFile.json().id,
          })
        ).statusCode,
      ).toBe(400)
      expect(
        (await admin.post(`/api/v1/documents/${quote.id}/items`, { positionType: 'image' }))
          .statusCode,
      ).toBe(400)
      const res = await admin.post(`/api/v1/documents/${quote.id}/items`, {
        positionType: 'image',
        imageFileId: fileId,
        shortText: 'Fliesenmuster Bad',
      })
      expect(res.statusCode, res.body).toBe(201)
      const doc = res.json() as DocumentDetail
      const image = doc.items.find((i) => i.positionType === 'image')
      expect(image?.image).toEqual({
        fileId,
        name: 'Fliesenmuster.png',
        url: `/api/v1/files/${fileId}/content`,
      })
      expect(doc.totals.netCents).toBe(quote.totals.netCents)
      // A file used as image cannot be deleted
      expect((await admin.delete(`/api/v1/files/${fileId}`)).statusCode).toBe(409)
      const pdf = await admin.get(`/api/v1/documents/${quote.id}/pdf`)
      expect(pdf.statusCode).toBe(200)
      expect(pdf.headers['content-type']).toBe('application/pdf')
      quote = doc
    })

    it('saves a position with its calculation in the Stammdaten', async () => {
      const tiles = quote.items.find((i) => i.shortText === 'Fliesen')
      const res = await admin.post(
        `/api/v1/documents/${quote.id}/items/${tiles?.id}/to-catalog`,
        {},
      )
      expect(res.statusCode, res.body).toBe(201)
      const item = res.json() as CatalogItem
      expect(item).toMatchObject({ kind: 'service', shortText: 'Fliesen', source: 'manual' })
      expect(item.components.map((c) => [c.kind, c.unitCostCents])).toEqual([
        ['labor', 5000],
        ['material', 2000],
      ])
      expect(item.priceCents).toBe(tiles?.unitPriceCents)
      const linked = (await admin.get(`/api/v1/documents/${quote.id}`)).json() as DocumentDetail
      expect(linked.items.find((i) => i.id === tiles?.id)?.catalogItemId).toBe(item.id)
      // Without Kalkulation: EP becomes the Verkaufspreis
      const travel = quote.items.find((i) => i.shortText === 'Anfahrt')
      const flat = (
        await admin.post(`/api/v1/documents/${quote.id}/items/${travel?.id}/to-catalog`, {})
      ).json() as CatalogItem
      expect(flat).toMatchObject({ priceCents: 5000, components: [] })
      const image = quote.items.find((i) => i.positionType === 'image')
      expect(
        (await admin.post(`/api/v1/documents/${quote.id}/items/${image?.id}/to-catalog`, {}))
          .statusCode,
      ).toBe(400)
    })

    it('creates versions of a finished quote with their own number suffix', async () => {
      expect((await admin.post(`/api/v1/documents/${quote.id}/versions`, {})).statusCode).toBe(409)
      const finished = (
        await admin.post(`/api/v1/documents/${quote.id}/finalize`, {})
      ).json() as DocumentDetail
      expect(finished.number).toBeTruthy()
      const v2res = await admin.post(`/api/v1/documents/${quote.id}/versions`, {})
      expect(v2res.statusCode, v2res.body).toBe(201)
      const v2 = v2res.json() as DocumentDetail
      expect(v2).toMatchObject({ status: 'draft', version: 2, number: null })
      expect(v2.items.map((i) => i.shortText)).toEqual(finished.items.map((i) => i.shortText))
      expect(v2.totals.netCents).toBe(finished.totals.netCents)
      expect(v2.versions.map((v) => [v.version, v.number])).toEqual([
        [1, finished.number],
        [2, null],
      ])
      // Only one newer version per version
      expect((await admin.post(`/api/v1/documents/${quote.id}/versions`, {})).statusCode).toBe(409)
      const v2final = (
        await admin.post(`/api/v1/documents/${v2.id}/finalize`, {})
      ).json() as DocumentDetail
      expect(v2final.number).toBe(`${finished.number}-V2`)
      const v3 = (
        await admin.post(`/api/v1/documents/${v2.id}/versions`, {})
      ).json() as DocumentDetail
      const v3final = (
        await admin.post(`/api/v1/documents/${v3.id}/finalize`, {})
      ).json() as DocumentDetail
      expect(v3final.number).toBe(`${finished.number}-V3`)
      const old = (await admin.get(`/api/v1/documents/${quote.id}`)).json() as DocumentDetail
      expect(old.versions.map((v) => v.number)).toEqual([
        finished.number,
        `${finished.number}-V2`,
        `${finished.number}-V3`,
      ])
      // Dashboard: only the newest version is an open offer
      const dashboard = (await admin.get('/api/v1/dashboard')).json()
      expect(dashboard.openOffers.map((o: { number: string }) => o.number)).toEqual([
        `${finished.number}-V3`,
      ])
    })
  },
)
