import type { CatalogImportResult, CatalogItem } from '@opc/schemas'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client, createHarness, type Harness } from './testing/harness.js'

/** Stammdaten als CSV (P2.12): export, import with preview, update of prices. */
describe.skipIf(!process.env.DATABASE_URL)('Stammdaten CSV (integration)', () => {
  let h: Harness
  let admin: Client
  let worker: Client

  const items = async (kind: 'service' | 'material') =>
    (await admin.get(`/api/v1/catalog/items?kind=${kind}`)).json() as CatalogItem[]

  beforeAll(async () => {
    h = await createHarness({ requireAdminMfa: false })
    admin = new Client(h.app)
    await admin.post('/api/v1/setup', {
      setupToken: h.setupToken,
      company: { name: 'Stamm Bau GmbH' },
      admin: {
        email: 'chef@example.test',
        password: 'ein-sehr-langes-passwort',
        displayName: 'Chef',
      },
    })
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

  const FILE = [
    'Art;Warengruppe;Art.-Nr.;Hersteller;EAN;Bezeichnung;Langtext;ME;Einkaufspreis;Aufschlag;VK;Gebinde',
    'Material;Fliesen;F-100;Keramo;4006381333931;Bodenfliese 30x60;"grau, matt";m²;"1.234,50";20;;',
    'Material;Fliesen;F-200;Keramo;;Wandfliese 20x40;;m²;18,00;;25,00;1,44',
    'Leistung;Sanitär;;;;Silikonfuge erneuern;;m;;;12,50;',
    'Material;;F-300;;;Kleber;;Sack;abc;;;',
    'Material;;F-400;;;Fugenmasse;;Kiste;5;;;',
    'Material;Fliesen;F-200;Keramo;;doppelt;;m²;1;;;',
    'Werkzeug;;;;;Hammer;;Stk;1;;;',
    ';;;;;;;;;;;',
  ].join('\r\n')

  it('previews an import without saving anything', async () => {
    expect((await worker.post('/api/v1/catalog/import', { csv: FILE })).statusCode).toBe(403)
    const res = await admin.post('/api/v1/catalog/import', { csv: FILE })
    expect(res.statusCode, res.body).toBe(200)
    const preview = res.json() as CatalogImportResult
    expect(preview).toMatchObject({ dryRun: true, created: 3, updated: 0, skipped: 1, errors: 3 })
    expect(preview.newFolders).toEqual(['Material: Fliesen', 'Leistung: Sanitär'])
    expect(preview.rows.map((r) => [r.line, r.action])).toEqual([
      [2, 'create'],
      [3, 'create'],
      [4, 'create'],
      [5, 'error'],
      [6, 'error'],
      [7, 'skip'],
      [8, 'error'],
    ])
    expect(preview.rows[3]?.message).toBe('EK: „abc“ ist keine Zahl.')
    expect(preview.rows[4]?.message).toMatch(/Unbekannte Einheit „Kiste“/)
    expect(preview.rows[6]?.message).toMatch(/Unbekannte Art „Werkzeug“/)
    expect(await items('material')).toEqual([])
    expect(
      (await admin.post('/api/v1/catalog/import', { csv: 'Name;Preis\r\nx;1' })).statusCode,
    ).toBe(400)
  })

  it('imports, exports and updates prices', async () => {
    const res = (
      await admin.post('/api/v1/catalog/import', { csv: FILE, dryRun: false })
    ).json() as CatalogImportResult
    expect(res).toMatchObject({ dryRun: false, created: 3, errors: 3 })
    const materials = await items('material')
    const floor = materials.find((m) => m.articleNo === 'F-100')
    // EK 1234,50 + default Zuschlag of materials (EK × 1,2 with 20 %)
    expect(floor).toMatchObject({
      shortText: 'Bodenfliese 30x60',
      longText: 'grau, matt',
      manufacturer: 'Keramo',
      ean: '4006381333931',
      costCents: 123_450,
      markupPercent: '20',
      priceCents: 148_140,
    })
    expect(materials.find((m) => m.articleNo === 'F-200')).toMatchObject({
      costCents: 1800,
      priceCents: 2500,
      packSize: '1.44',
    })
    expect((await items('service')).map((s) => [s.shortText, s.priceCents])).toEqual([
      ['Silikonfuge erneuern', 1250],
    ])

    const exported = await admin.get('/api/v1/catalog/export.csv?kind=material')
    expect(exported.statusCode).toBe(200)
    expect(exported.headers['content-disposition']).toMatch(/Stammdaten_\d{4}-\d{2}-\d{2}\.csv/)
    const lines = exported.body.replace('﻿', '').trim().split('\r\n')
    expect(lines[0]).toBe(
      'Art;Ordner;Artikelnummer;Hersteller;EAN;Kurztext;Langtext;Einheit;EK;Zuschlag %;VK;Gebindeinhalt',
    )
    expect(lines).toContain(
      'Material;Fliesen;F-100;Keramo;4006381333931;Bodenfliese 30x60;grau, matt;m²;1234,50;20;1481,40;',
    )

    // The export is the template: a second import skips, with updateExisting it updates prices
    const again = (
      await admin.post('/api/v1/catalog/import', { csv: exported.body, dryRun: false })
    ).json() as CatalogImportResult
    expect(again).toMatchObject({ created: 0, skipped: 2 })
    const changed = exported.body.replace('1234,50;20;1481,40', '1300,00;20;')
    const updated = (
      await admin.post('/api/v1/catalog/import', {
        csv: changed,
        dryRun: false,
        updateExisting: true,
      })
    ).json() as CatalogImportResult
    expect(updated).toMatchObject({ created: 0, updated: 2 })
    expect((await items('material')).find((m) => m.articleNo === 'F-100')).toMatchObject({
      costCents: 130_000,
      priceCents: 156_000,
    })
  })
})
