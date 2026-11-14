import { parseCsv } from '@opc/exports'
import type { ContactDetail, ContactImportResult, ContactSummary, Page } from '@opc/schemas'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client, createHarness, type Harness } from './testing/harness.js'

/**
 * Kontakte vervollständigen (P2.9): CSV-Export und -Import mit Vorschau, Filter Kunden/Typ/archiviert.
 */
describe.skipIf(!process.env.DATABASE_URL)('Kontakte CSV und Filter (integration)', () => {
  let h: Harness
  let admin: Client
  let worker: Client
  let customer: ContactDetail

  const names = async (query = '') =>
    ((await admin.get(`/api/v1/contacts?${query}`)).json() as Page<ContactSummary>).items.map(
      (c) => c.displayName,
    )

  beforeAll(async () => {
    h = await createHarness({ requireAdminMfa: false })
    admin = new Client(h.app)
    await admin.post('/api/v1/setup', {
      setupToken: h.setupToken,
      company: { name: 'Kontakt Bau GmbH' },
      admin: {
        email: 'chef@example.test',
        password: 'ein-sehr-langes-passwort',
        displayName: 'Chef',
      },
    })
    customer = (
      await admin.post('/api/v1/contacts', {
        kind: 'organization',
        organizationName: 'Wohnbau Nord eG',
        taxMode: 'reverse_charge_13b',
        buyerReference: '04011000-1234512345-06',
        addresses: [
          { kind: 'main', street: 'Lindenweg 4', postalCode: '30159', city: 'Hannover' },
          {
            kind: 'billing',
            recipientBlock: 'Wohnbau Nord eG\nBuchhaltung',
            street: 'Postfach 12',
            postalCode: '30001',
            city: 'Hannover',
          },
        ],
        channels: [
          { kind: 'email', value: 'info@wohnbau.example', isPrimary: true },
          { kind: 'phone', value: '0511 1234', isPrimary: true },
        ],
      })
    ).json()
    const supplier = await admin.post('/api/v1/contacts', {
      kind: 'organization',
      organizationName: 'Baustoff Meier KG',
      assignCustomerNumber: false,
    })
    await admin.post(`/api/v1/contacts/${supplier.json().id}/archive`, {})
    await admin.post('/api/v1/contacts', {
      kind: 'person',
      firstName: 'Anna',
      lastName: 'Berger',
      assignCustomerNumber: false,
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

  it('filters customers, kind and archived contacts', async () => {
    expect(await names()).toEqual(['Berger, Anna', 'Wohnbau Nord eG'])
    expect(await names('customer=true')).toEqual(['Wohnbau Nord eG'])
    expect(await names('customer=false')).toEqual(['Berger, Anna'])
    expect(await names('kind=person')).toEqual(['Berger, Anna'])
    expect(await names('archived=true')).toEqual(['Baustoff Meier KG'])
  })

  it('exports the list as CSV for Excel', async () => {
    const res = await admin.get('/api/v1/contacts/export.csv?customer=true')
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('text/csv')
    expect(res.body.startsWith('﻿Typ;Kundennummer;Firma')).toBe(true)
    const [header, row] = parseCsv(res.body)
    const record = Object.fromEntries((header ?? []).map((h, i) => [h, row?.[i]]))
    expect(record).toMatchObject({
      Typ: 'Organisation',
      Kundennummer: customer.number,
      Firma: 'Wohnbau Nord eG',
      Straße: 'Lindenweg 4',
      PLZ: '30159',
      Land: 'DE',
      'E-Mail': 'info@wohnbau.example',
      Telefon: '0511 1234',
      Steuerfall: '§ 13b UStG',
      'Leitweg-ID': '04011000-1234512345-06',
    })
    expect((await worker.get('/api/v1/contacts/export.csv')).statusCode).toBe(403)
  })

  it('imports contacts after a preview, skipping duplicates and reporting errors', async () => {
    const file = [
      'Firma;Vorname;Nachname;Straße;PLZ;Ort;Land;E-Mail;Mobil;Kundennummer;Steuerfall',
      '"Maler Schulz GmbH";;;Hauptstr. 1;30161;Hannover;Deutschland;info@schulz.example;;K-90001;§ 13b',
      ';Peter;Lustig;Am Hang 3;29221;Celle;;;0171 123456;;',
      'Wohnbau Nord eG;;;Lindenweg 4;30159;Hannover;;;;;',
      'Kaputt AG;;;;;;;keine-mail;;;',
      'Unbekannt GmbH;;;;;;;;;;Fantasie',
      `Doppelt GmbH;;;;;;;;;${customer.number};`,
    ].join('\r\n')
    const preview = await admin.post('/api/v1/contacts/import', { csv: file })
    expect(preview.statusCode, preview.body).toBe(200)
    const expected = [
      { line: 2, name: 'Maler Schulz GmbH', action: 'create' },
      { line: 3, name: 'Lustig, Peter', action: 'create' },
      { line: 4, name: 'Wohnbau Nord eG', action: 'skip' },
      {
        line: 5,
        name: 'Kaputt AG',
        action: 'error',
        message: 'Ungültige E-Mail-Adresse „keine-mail“.',
      },
      {
        line: 6,
        name: 'Unbekannt GmbH',
        action: 'error',
        message: 'Unbekannter Steuerfall „Fantasie“.',
      },
      {
        line: 7,
        name: 'Doppelt GmbH',
        action: 'skip',
        message: `Kundennummer ${customer.number} gibt es schon.`,
      },
    ]
    expect((preview.json() as ContactImportResult).rows).toMatchObject(expected)
    expect(preview.json()).toMatchObject({ dryRun: true, created: 2, skipped: 2, errors: 2 })
    // The preview writes nothing.
    expect(await names()).toEqual(['Berger, Anna', 'Wohnbau Nord eG'])

    const done = await admin.post('/api/v1/contacts/import', { csv: file, dryRun: false })
    expect(done.json()).toMatchObject({ dryRun: false, created: 2 })
    expect(await names()).toEqual([
      'Berger, Anna',
      'Lustig, Peter',
      'Maler Schulz GmbH',
      'Wohnbau Nord eG',
    ])
    const list = ((await admin.get('/api/v1/contacts?q=Schulz')).json() as Page<ContactSummary>)
      .items
    const schulz = (await admin.get(`/api/v1/contacts/${list[0]?.id}`)).json() as ContactDetail
    expect(schulz).toMatchObject({
      number: 'K-90001',
      taxMode: 'reverse_charge_13b',
      addresses: [{ kind: 'main', street: 'Hauptstr. 1', countryCode: 'DE' }],
      channels: [{ kind: 'email', value: 'info@schulz.example' }],
    })
    // Rows without number got the next Kundennummer.
    const lustig = ((await admin.get('/api/v1/contacts?q=Lustig')).json() as Page<ContactSummary>)
      .items[0]
    expect(lustig?.number).toMatch(/^K-\d+$/)
    // Importing again creates nothing new.
    expect(
      (await admin.post('/api/v1/contacts/import', { csv: file, dryRun: false })).json(),
    ).toMatchObject({
      created: 0,
    })
    const bad = await admin.post('/api/v1/contacts/import', { csv: 'Spalte1;Spalte2\r\na;b' })
    expect(bad.statusCode).toBe(400)
    expect((await worker.post('/api/v1/contacts/import', { csv: file })).statusCode).toBe(403)
  })

  it('asks before creating organizations for persons with Firma', async () => {
    const file = [
      'Firma;Vorname;Nachname;PLZ;Ort',
      'Holzbau Eiche GmbH;Jan;Eiche;31134;Hildesheim',
      'Holzbau Eiche GmbH;Mia;Eiche;31134;Hildesheim',
      'Wohnbau Nord eG;Tom;Kaiser;30159;Hannover',
    ].join('\n')
    const preview = (
      await admin.post('/api/v1/contacts/import', { csv: file })
    ).json() as ContactImportResult
    expect(preview.withOrganization).toBe(3)
    expect(preview.rows.map((r) => [r.name, r.organization, r.organizationAction])).toEqual([
      ['Eiche, Jan', 'Holzbau Eiche GmbH', 'create'],
      ['Eiche, Mia', 'Holzbau Eiche GmbH', 'link'],
      ['Kaiser, Tom', 'Wohnbau Nord eG', 'link'],
    ])

    // Without the option: only persons, nothing else.
    const plain = await admin.post('/api/v1/contacts/import', {
      csv: file.split('\n').slice(0, 2).join('\n'),
      dryRun: false,
    })
    expect(plain.json()).toMatchObject({ created: 1 })
    expect(await names('q=Holzbau')).toEqual([])

    // With the option: the organization is created once, everyone is linked as Ansprechpartner.
    const done = await admin.post('/api/v1/contacts/import', {
      csv: file,
      dryRun: false,
      createOrganizations: true,
    })
    expect(done.json()).toMatchObject({ created: 2, skipped: 1 })
    expect(await names('q=Holzbau')).toEqual(['Holzbau Eiche GmbH'])
    const holzbau = ((await admin.get('/api/v1/contacts?q=Holzbau')).json() as Page<ContactSummary>)
      .items[0]
    const detail = (await admin.get(`/api/v1/contacts/${holzbau?.id}`)).json() as ContactDetail
    expect(detail.number).toMatch(/^K-\d+$/)
    expect(detail.addresses).toMatchObject([{ postalCode: '31134', city: 'Hildesheim' }])
    expect(detail.links.map((l) => l.displayName)).toEqual(['Eiche, Mia'])
    const wohnbau = (await admin.get(`/api/v1/contacts/${customer.id}`)).json() as ContactDetail
    expect(wohnbau.links.map((l) => l.displayName)).toEqual(['Kaiser, Tom'])
  })
})
