import { withTenant } from '@opc/db'
import type {
  CatalogFolder,
  CatalogItem,
  DocumentDetail,
  ImportResult,
  SupplierArticle,
  UnitSummary,
} from '@opc/schemas'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client, createHarness, type Harness } from './testing/harness.js'

/** Encodes text in code page 850 like DOS-based wholesaler systems do (only the umlauts we need). */
function cp850(text: string): Buffer {
  const map: Record<string, number> = {
    ä: 0x84,
    ö: 0x94,
    ü: 0x81,
    ß: 0xe1,
    Ä: 0x8e,
    Ö: 0x99,
    Ü: 0x9a,
  }
  return Buffer.from([...text].map((ch) => map[ch] ?? ch.charCodeAt(0)))
}

const DATANORM = [
  'V;050;01112026;Baustoff Nord GmbH;Testkatalog;;EUR',
  'A;N;4711;00;Dispersionsfarbe weiß;12,5 l;1;0;Eim;4599;R10;MAL;T4711',
  'B;N;4711;FARBE WEISS;;;;;4012345678901;;',
  'T;N;T4711;1;0;Hochdeckende Innenfarbe;2;0;für Wand und Decke',
  'A;N;0815;00;Spax Schraube 4x40;;2;2;Stck;1234;;;',
  'A;N;9999;00;Kleber im Fass;;1;0;Fass;1000;;;',
  'R;N;R10;30',
  '',
].join('\r\n')

describe.skipIf(!process.env.DATABASE_URL)('Stammdaten und DATANORM-Kataloge (integration)', () => {
  let h: Harness
  let admin: Client
  let tenantId: string
  let units: UnitSummary[]
  let catalogId: string
  let service: CatalogItem
  const unit = (symbol: string) => units.find((u) => u.symbol === symbol)?.id as string
  const importFile = (content: Buffer, query: string) =>
    admin.upload(`/api/v1/supplier-catalogs/import?${query}`, content)
  const search = async (q: string) =>
    (
      await admin.get(`/api/v1/supplier-articles?q=${encodeURIComponent(q)}`)
    ).json() as SupplierArticle[]

  beforeAll(async () => {
    h = await createHarness({ requireAdminMfa: false })
    admin = new Client(h.app)
    const setup = await admin.post('/api/v1/setup', {
      setupToken: h.setupToken,
      company: { name: 'Stamm Bau GmbH' },
      admin: {
        email: 'chef@example.test',
        password: 'ein-sehr-langes-passwort',
        displayName: 'Chef',
      },
    })
    tenantId = setup.json().tenant.id
    await withTenant(
      h.sql,
      { tenantId },
      (tx) => tx`update surcharge set percent = 20 where cost_kind = 'material'`,
    )
    units = (await admin.get('/api/v1/units')).json()
  })

  afterAll(async () => {
    await h?.close()
  })

  describe('Stammdaten', () => {
    it('has a default folder for Leistungen and Materialien', async () => {
      const folders: CatalogFolder[] = (await admin.get('/api/v1/catalog/folders')).json()
      expect(folders.map((f) => [f.kind, f.name])).toEqual([
        ['material', 'Allgemein'],
        ['service', 'Allgemein'],
      ])
    })

    it('prices materials from EK and markup, or takes a VK as entered', async () => {
      const paint = await admin.post('/api/v1/catalog/items', {
        kind: 'material',
        shortText: 'Tiefgrund',
        unitId: unit('l'),
        articleNo: 'TG-1',
        costCents: 1000,
      })
      expect(paint.statusCode, paint.body).toBe(201)
      expect(paint.json()).toMatchObject({
        costCents: 1000,
        markupPercent: '20',
        priceCents: 1200,
        source: 'manual',
      })
      const fixed = await admin.post('/api/v1/catalog/items', {
        kind: 'material',
        shortText: 'Abdeckfolie',
        unitId: unit('Rolle'),
        costCents: 1000,
        priceCents: 1500,
      })
      expect(fixed.json()).toMatchObject({ priceCents: 1500, markupPercent: '50' })
      const changed = await admin.patch(`/api/v1/catalog/items/${paint.json().id}`, {
        markupPercent: '30',
      })
      expect(changed.json()).toMatchObject({ priceCents: 1300, markupPercent: '30' })
    })

    it('calculates Leistungen from their components', async () => {
      const res = await admin.post('/api/v1/catalog/items', {
        kind: 'service',
        shortText: 'Wandfläche streichen',
        longText: 'zweimal, Dispersionsfarbe',
        unitId: unit('m²'),
        components: [
          {
            kind: 'labor',
            description: 'Geselle',
            quantity: '30',
            unitId: unit('min'),
            unitCostCents: 5400,
          },
          {
            kind: 'material',
            description: 'Farbe',
            quantity: '0,5',
            unitId: unit('l'),
            unitCostCents: 800,
          },
        ],
      })
      expect(res.statusCode, res.body).toBe(201)
      service = res.json()
      // 30 min × 0,90 € + 0,5 l × 8,00 € × 1,2 = 27,00 + 4,80 = 31,80 €
      expect(service).toMatchObject({
        costCents: 3100,
        priceCents: 3180,
        laborHours: '0.50',
        kind: 'service',
      })
      expect(service.components.map((c) => c.kind)).toEqual(['labor', 'material'])
    })

    it('lists, searches and deletes entries', async () => {
      const materials: CatalogItem[] = (
        await admin.get('/api/v1/catalog/items?kind=material')
      ).json()
      expect(materials.map((m) => m.shortText)).toEqual(['Abdeckfolie', 'Tiefgrund'])
      const found: CatalogItem[] = (
        await admin.get('/api/v1/catalog/items?kind=material&q=tg-1')
      ).json()
      expect(found.map((m) => m.shortText)).toEqual(['Tiefgrund'])
      expect(
        (
          await admin.post('/api/v1/catalog/items', {
            kind: 'material',
            shortText: '',
            unitId: unit('l'),
          })
        ).statusCode,
      ).toBe(400)
      expect((await admin.delete(`/api/v1/catalog/items/${materials[0]?.id}`)).statusCode).toBe(204)
    })
  })

  describe('DATANORM', () => {
    it('imports a DATANORM file in the DOS character set', async () => {
      const res = await importFile(cp850(DATANORM), 'filename=NORD2027.001')
      expect(res.statusCode, res.body).toBe(201)
      const result: ImportResult = res.json()
      catalogId = result.catalog.id
      expect(result.catalog).toMatchObject({
        name: 'NORD2027',
        supplier: 'Baustoff Nord GmbH',
        version: '050',
        articleCount: 3,
      })
      expect(result.stats).toEqual({
        lines: 7,
        articles: 3,
        deleted: 0,
        prices: 0,
        texts: 2,
        skipped: 1,
        encoding: 'cp850',
        unknownUnits: ['Fass'],
      })
    })

    it('finds articles by text, number and EAN with the purchase price per unit', async () => {
      const [paint] = await search('dispersionsfarbe')
      expect(paint).toMatchObject({
        articleNo: '4711',
        shortText: 'Dispersionsfarbe weiß 12,5 l',
        longText: 'Hochdeckende Innenfarbe\nfür Wand und Decke',
        unit: { symbol: 'Eimer' },
        ean: '4012345678901',
        priceKind: 'list',
        priceCents: '4599',
        unitCostCents: '4599',
        catalogName: 'NORD2027',
      })
      expect((await search('4012345678901'))[0]?.articleNo).toBe('4711')
      const [screw] = await search('0815')
      expect(screw).toMatchObject({
        priceKind: 'net',
        priceUnit: 100,
        unitCostCents: '12.34',
        unit: { symbol: 'Stk.' },
      })
      expect((await admin.get('/api/v1/supplier-articles?q=x')).statusCode).toBe(400)
    })

    it('applies the wholesaler discount (catalog and discount group)', async () => {
      const res = await admin.patch(`/api/v1/supplier-catalogs/${catalogId}`, {
        discountPercent: '10',
        discounts: [{ discountGroup: 'R10', percent: '30' }],
      })
      expect(res.json()).toMatchObject({
        discountPercent: '10',
        discounts: [{ discountGroup: 'R10', percent: '30' }],
      })
      expect((await search('dispersionsfarbe'))[0]?.unitCostCents).toBe('3219.3')
      expect((await search('Kleber'))[0]?.unitCostCents).toBe('900')
    })

    it('takes articles over into the Stammdaten', async () => {
      const [paint] = await search('dispersionsfarbe')
      const res = await admin.post('/api/v1/catalog/items/from-supplier', {
        supplierArticleId: paint?.id,
      })
      expect(res.statusCode, res.body).toBe(201)
      expect(res.json()).toMatchObject({
        kind: 'material',
        articleNo: '4711',
        ean: '4012345678901',
        costCents: 3219,
        markupPercent: '20',
        priceCents: 3863,
        source: 'datanorm',
        supplierName: 'Baustoff Nord GmbH',
        unit: { symbol: 'Eimer' },
      })
      const [glue] = await search('Kleber')
      const unknown = await admin.post('/api/v1/catalog/items/from-supplier', {
        supplierArticleId: glue?.id,
      })
      expect(unknown.json().errors.unitId).toMatch(/„Fass“ ist unbekannt/)
      const withUnit = await admin.post('/api/v1/catalog/items/from-supplier', {
        supplierArticleId: glue?.id,
        unitId: unit('kg'),
      })
      expect(withUnit.json().unit.symbol).toBe('kg')
    })

    it('applies update files: deletions and price changes', async () => {
      const update = [
        'V;050;01122026;Baustoff Nord GmbH;Update;;EUR',
        'A;L;9999;;;;;;;;;;',
        'P;A;0815;2;1500',
      ].join('\n')
      const res = await importFile(
        Buffer.from(update),
        `filename=update.002&catalogId=${catalogId}`,
      )
      expect(res.json().stats).toMatchObject({ deleted: 1, prices: 1, encoding: 'utf-8' })
      expect(res.json().catalog.articleCount).toBe(2)
      expect((await search('0815'))[0]?.unitCostCents).toBe('15')
      expect(await search('Kleber')).toEqual([])
    })

    it('rejects files that are not DATANORM 4/5 and keeps nothing of them', async () => {
      const before = (await admin.get('/api/v1/supplier-catalogs')).json().length
      const res = await importFile(
        Buffer.from('A0000815Schraube  fest formatiert\n'),
        'filename=alt.dat',
      )
      expect(res.statusCode).toBe(400)
      expect(res.json().detail).toMatch(/^DATANORM: Zeile 1: Keine DATANORM-4\/5-Datei/)
      expect((await admin.get('/api/v1/supplier-catalogs')).json()).toHaveLength(before)
      expect((await importFile(Buffer.alloc(0), 'filename=leer.dat')).statusCode).toBe(400)
    })
  })

  describe('Positionen aus Stammdaten und Katalog', () => {
    it('inserts Leistungen and catalog articles with their Kalkulation into a quote', async () => {
      const project = (await admin.post('/api/v1/projects', { name: 'Bad' })).json()
      const quote: DocumentDetail = (
        await admin.post(`/api/v1/projects/${project.id}/documents`, { type: 'quote' })
      ).json()
      const url = `/api/v1/documents/${quote.id}/items/from-catalog`
      let res = await admin.post(url, { catalogItemId: service.id, quantity: '10' })
      expect(res.statusCode, res.body).toBe(201)
      let doc: DocumentDetail = res.json()
      expect(doc.items[0]).toMatchObject({
        shortText: 'Wandfläche streichen',
        longText: 'zweimal, Dispersionsfarbe',
        quantity: '10',
        unit: { symbol: 'm²' },
        unitPriceCents: 3180,
        totalCents: 31_800,
        calculation: { costCents: 31_000, laborHours: '5.00' },
      })
      const [screw] = await search('0815')
      res = await admin.post(url, { supplierArticleId: screw?.id, quantity: '100' })
      doc = res.json()
      // 0,15 € net per piece, 20 % material markup → 0,18 €
      expect(doc.items[1]).toMatchObject({
        shortText: 'Spax Schraube 4x40',
        unitPriceCents: 18,
        totalCents: 1800,
      })
      expect(doc.items[1]?.costLines[0]).toMatchObject({
        kind: 'material',
        unitCostCents: 15,
        markupPercent: '20',
      })
      expect(
        (await admin.post(url, { supplierArticleId: screw?.id, quantity: '1,5' })).json().errors,
      ).toEqual({
        quantity: 'Menge in Stk. bitte ohne Nachkommastellen angeben.',
      })
      expect(
        (await admin.post(url, { catalogItemId: service.id, supplierArticleId: screw?.id }))
          .statusCode,
      ).toBe(400)
    })
  })

  it('keeps Stammdaten away from site roles', async () => {
    const invite = await admin.post('/api/v1/invitations', {
      email: 'helfer@example.test',
      roleKey: 'team_member',
    })
    const worker = new Client(h.app)
    await worker.post('/api/v1/invitations/accept', {
      token: new URL(invite.json().acceptUrl).hash.slice(1),
      displayName: 'Helfer',
      password: 'helfer-passwort-1',
    })
    expect((await worker.get('/api/v1/catalog/items?kind=material')).statusCode).toBe(403)
    expect((await worker.get('/api/v1/supplier-articles?q=farbe')).statusCode).toBe(403)
  })
})
