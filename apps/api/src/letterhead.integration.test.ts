import type { DocumentDetail, LetterheadSettings } from '@opc/schemas'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client, createHarness, type Harness } from './testing/harness.js'

// Smallest valid PNG (1 × 1 px).
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
)

describe.skipIf(!process.env.DATABASE_URL)('Briefpapier (integration)', () => {
  let h: Harness
  let admin: Client
  let worker: Client

  beforeAll(async () => {
    h = await createHarness({ requireAdminMfa: false })
    admin = new Client(h.app)
    await admin.post('/api/v1/setup', {
      setupToken: h.setupToken,
      company: { name: 'Brief Bau GmbH' },
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
      bankName: 'Sparkasse Hannover',
      iban: 'DE89370400440532013000',
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

  it('starts with a DIN 5008 default layout and the company values', async () => {
    const res = await admin.get('/api/v1/settings/letterhead')
    expect(res.statusCode).toBe(200)
    const settings = res.json() as LetterheadSettings
    expect(settings.layout).toMatchObject({ version: 1, font: 'sans', foldMarks: true, logo: null })
    expect(settings.layout.footer).toHaveLength(4)
    expect(settings.values).toMatchObject({
      Firma: 'Brief Bau GmbH',
      Ort: 'Hannover',
      IBAN: 'DE89 3704 0044 0532 0130 00',
    })
  })

  let assetId: string

  it('uploads a logo once per content and refuses other file types', async () => {
    const res = await admin.upload('/api/v1/settings/letterhead/logo', PNG)
    expect(res.statusCode, res.body).toBe(201)
    assetId = res.json().assetId
    expect(res.json().url).toBe(`/api/v1/assets/${assetId}`)
    expect((await admin.upload('/api/v1/settings/letterhead/logo', PNG)).json().assetId).toBe(
      assetId,
    )
    const svg = await admin.upload(
      '/api/v1/settings/letterhead/logo',
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
    )
    expect(svg.statusCode).toBe(415)
    const big = await admin.upload(
      '/api/v1/settings/letterhead/logo',
      Buffer.concat([PNG, Buffer.alloc(2 * 1024 * 1024)]),
    )
    expect(big.statusCode).toBe(413)
    // Every member may load the logo (documents, print view), with safe headers.
    const image = await worker.get(`/api/v1/assets/${assetId}`)
    expect(image.statusCode).toBe(200)
    expect(image.headers['content-type']).toBe('image/png')
    expect(image.headers['x-content-type-options']).toBe('nosniff')
    expect(image.rawPayload.equals(PNG)).toBe(true)
  })

  it('saves the designed layout and validates positions', async () => {
    const { layout } = (await admin.get('/api/v1/settings/letterhead')).json() as LetterheadSettings
    const designed = {
      ...layout,
      font: 'serif',
      accentColor: '#8a1c1c',
      logo: { assetId, x: 20, y: 10, width: 40 },
      texts: [{ ...layout.texts[0], text: '{Firma}\nMeisterbetrieb', y: 12 }],
      footer: ['{Firma}', '{Bank} · IBAN {IBAN}'],
    }
    const res = await admin.put('/api/v1/settings/letterhead', designed)
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json().layout).toMatchObject({
      font: 'serif',
      logo: { assetId, width: 40 },
      footer: ['{Firma}', '{Bank} · IBAN {IBAN}'],
    })
    // Outside the Briefkopf (Form B: 45 mm) or with an unknown logo: refused.
    expect(
      (
        await admin.put('/api/v1/settings/letterhead', {
          ...designed,
          texts: [{ ...designed.texts[0], y: 60 }],
        })
      ).statusCode,
    ).toBe(400)
    const unknown = await admin.put('/api/v1/settings/letterhead', {
      ...designed,
      logo: { ...designed.logo, assetId: '0190f4a0-0000-7000-8000-000000000000' },
    })
    expect(unknown.json().errors.logo).toMatch(/nicht gefunden/)
    expect((await worker.put('/api/v1/settings/letterhead', designed)).statusCode).toBe(403)
  })

  it('freezes the letterhead with every finalized document (rule 4)', async () => {
    const customer = await admin.post('/api/v1/contacts', {
      kind: 'organization',
      organizationName: 'Wohnbau Nord eG',
    })
    const project = await admin.post('/api/v1/projects', {
      name: 'Neubau',
      customerId: customer.json().id,
    })
    const quote = (
      await admin.post(`/api/v1/projects/${project.json().id}/documents`, { type: 'quote' })
    ).json() as DocumentDetail
    const units = (await admin.get('/api/v1/units')).json() as { id: string; symbol: string }[]
    await admin.post(`/api/v1/documents/${quote.id}/items`, {
      positionType: 'item',
      shortText: 'Wand streichen',
      quantity: '10',
      unitId: units.find((u) => u.symbol === 'm²')?.id,
      unitPriceCents: 1000,
    })
    // Drafts show the current letterhead …
    let draft = (await admin.get(`/api/v1/documents/${quote.id}`)).json() as DocumentDetail
    expect(draft.issuer.letterhead?.font).toBe('serif')
    expect(draft.issuer.values?.IBAN).toBe('DE89 3704 0044 0532 0130 00')
    const done = await admin.post(`/api/v1/documents/${quote.id}/finalize`)
    expect(done.statusCode, done.body).toBe(200)

    // … a later change of the letterhead or the company does not change the finalized document.
    const { layout } = (await admin.get('/api/v1/settings/letterhead')).json() as LetterheadSettings
    await admin.put('/api/v1/settings/letterhead', { ...layout, font: 'sans', logo: null })
    await admin.patch('/api/v1/settings/company', { bankName: 'Neue Bank' })
    draft = (await admin.get(`/api/v1/documents/${quote.id}`)).json() as DocumentDetail
    expect(draft.issuer.letterhead).toMatchObject({ font: 'serif', logo: { assetId } })
    expect(draft.issuer.values?.Bank).toBe('Sparkasse Hannover')
  })
})
