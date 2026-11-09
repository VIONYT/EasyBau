import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultLetterhead } from '@opc/domain'
import type { MeasurementSheetDetail, ReportDetail } from '@opc/schemas'
import { describe, expect, it } from 'vitest'
import { isUsableImage, renderLetterPdf } from './render.js'
import { reportLetter, type SiteLetterContext, sheetLetter } from './site.js'

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
)
const m2 = { id: 'u-m2', symbol: 'm²', decimals: 2 }

const context: SiteLetterContext = {
  issuerName: 'Muster Bau GmbH',
  layout: defaultLetterhead(),
  values: { Firma: 'Muster Bau GmbH', Straße: 'Werkstraße 2', PLZ: '30169', Ort: 'Hannover' },
  recipient: ['Wohnbau Nord eG', 'Lindenweg 4', '30159 Hannover'],
}

function text(pdf: Buffer): string {
  try {
    const dir = mkdtempSync(join(tmpdir(), 'opc-site-'))
    writeFileSync(join(dir, 'x.pdf'), pdf)
    if (process.env.PDF_SAMPLE_DIR)
      writeFileSync(join(process.env.PDF_SAMPLE_DIR, `site-${Date.now()}.pdf`), pdf)
    return execFileSync('pdftotext', ['-raw', join(dir, 'x.pdf'), '-'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString()
  } catch {
    return ''
  }
}

const item = {
  id: 'i1',
  document: {
    id: 'ab',
    type: 'order_confirmation' as const,
    invoiceKind: null,
    progressNo: null,
    number: 'AB-00101',
    status: 'finalized',
    changeOrderNumber: null,
  },
  oz: '1.1',
  shortText: 'Wandflächen spachteln Q2',
  quantity: '186.4',
  unit: m2,
  measuredQuantity: '39',
}

const sheet: MeasurementSheetDetail = {
  id: 's',
  projectId: 'p',
  kind: 'performance',
  title: 'Leistungsaufmaß Treppenhaus',
  measuredOn: '2026-11-06',
  status: 'signed',
  lineCount: 2,
  createdBy: null,
  updatedAt: '2026-11-06T10:00:00.000Z',
  project: { id: 'p', number: 'P-00101', name: 'Sanierung Lindenweg' },
  signedAt: '2026-11-06T15:30:00.000Z',
  signedByContractor: 'Erika Meister',
  signedByClient: 'Hans Berger',
  locations: [
    {
      id: 'eg',
      parentId: null,
      name: 'EG',
      variables: { B: '3.1', H: '2.8', L: '4.25', Z: '1' },
      path: 'Haus A › EG',
      level: 1,
    },
  ],
  lines: [
    {
      id: 'l1',
      locationId: 'eg',
      documentItemId: 'i1',
      description: 'Wände',
      formula: '(L+B)*2*H',
      variables: {},
      resultQty: '41.16',
      isDeduction: false,
      unit: m2,
      locked: true,
      createdAt: '2026-11-06T10:00:00.000Z',
    },
    {
      id: 'l2',
      locationId: 'eg',
      documentItemId: 'i1',
      description: 'Tür',
      formula: '1,01*2,135',
      variables: {},
      resultQty: '-2.16',
      isDeduction: true,
      unit: m2,
      locked: true,
      createdAt: '2026-11-06T10:00:00.000Z',
    },
  ],
  items: [
    {
      item,
      sheetQuantity: '39',
      variance: {
        difference: '-147.4',
        percent: '79.08',
        direction: 'less',
        exceedsThreshold: true,
      },
    },
  ],
  unassigned: [{ unit: 'm', decimals: 2, quantity: '12.5', count: 1 }],
}

const report: ReportDetail = {
  id: 'r',
  projectId: 'p',
  template: {
    id: 't',
    key: 'daily_site_report',
    name: 'Bautagesbericht',
    billable: false,
    sections: [
      { id: 'header', type: 'header' },
      { id: 'weather', type: 'weather' },
      { id: 'staff', type: 'staff' },
      { id: 'services', type: 'services' },
      { id: 'materials', type: 'materials' },
      { id: 'equipment', type: 'equipment' },
      { id: 'incidents', type: 'text', label: 'Besondere Vorkommnisse' },
      { id: 'safety', type: 'yes_no', label: 'Sicherheitsunterweisung erfolgt' },
      { id: 'due', type: 'deadline', label: 'Frist' },
      { id: 'photos', type: 'photos' },
      { id: 'signatures', type: 'signatures', roles: ['contractor', 'client'] },
    ],
  },
  reportDate: '2026-11-06',
  status: 'draft',
  totalHours: '18',
  staffCount: 2,
  photoCount: 1,
  weather: null,
  createdBy: null,
  updatedAt: '2026-11-06T10:00:00.000Z',
  project: { id: 'p', number: 'P-00101', name: 'Sanierung Lindenweg' },
  serviceFrom: null,
  serviceTo: null,
  header: {
    contractor: 'Muster Bau GmbH',
    client: 'Wohnbau Nord eG',
    placeOfPerformance: 'Lindenweg 4, 30159 Hannover',
  },
  data: {
    weather: {
      condition: 'partly_cloudy',
      temperatureMin: '6',
      temperatureMax: '11.5',
      note: 'trocken',
    },
    staff: {
      rows: [
        { name: 'Paul Polier', hours: '8', activity: 'Spachteln' },
        { name: 'Lena Maler', hours: '10', activity: null },
      ],
    },
    services: {
      rows: [{ description: 'Wände 1. OG gespachtelt', quantity: '41.16', unitId: 'u-m2' }],
    },
    materials: { rows: [{ description: 'Dispersionsfarbe', quantity: null, unitId: null }] },
    equipment: { rows: [{ description: 'Rollgerüst', hours: '8' }] },
    incidents: { text: 'Zugang Dachboden erst ab Montag.' },
    safety: { value: true },
    due: { date: '2026-11-13' },
  },
  photos: [],
  signatures: [],
  completedAt: null,
}

describe('Aufmaßblatt und Berichte als PDF/A', () => {
  it('renders the Aufmaßblatt with rooms, Rechenweg, quantities per position and signatures', () => {
    const { logoPosition: _, ...letter } = sheetLetter(sheet, context)
    expect(letter.body.blocks.map((b) => b.kind)).toEqual([
      'table',
      'heading',
      'table',
      'facts',
      'signatures',
    ])
    const pdf = renderLetterPdf({ ...letter, logo: null })
    expect(pdf.toString('latin1')).toMatch(/pdfaid:part(>|=")3/)
    const t = text(pdf)
    if (!t) return
    for (const expected of [
      'Leistungsaufmaß Treppenhaus',
      'Haus A › EG (L 4,25 · B 3,1 · H 2,8 · Z 1)',
      '(L+B)*2*H',
      '41,16 m²',
      'Tür (Abzug)',
      '-2,16 m²',
      'Mengen je LV-Position',
      '186,40 m²',
      '− 79,08 % (über 10 %)',
      'Ohne LV-Position',
      'Unterschrieben am 06.11.2026',
      'Auftraggeber: Hans Berger',
    ]) {
      expect(t).toContain(expected)
    }
  })

  it('renders an open sheet with empty signature lines', () => {
    const open = {
      ...sheet,
      status: 'draft' as const,
      signedAt: null,
      signedByClient: null,
      signedByContractor: null,
      items: [],
      unassigned: [],
    }
    const letter = sheetLetter(open, context)
    expect(letter.info.at(-1)).toEqual({ label: 'Stand', value: 'in Arbeit' })
    expect(letter.body.blocks.at(-1)).toEqual({
      kind: 'signatures',
      items: [
        { label: 'Auftragnehmer', name: '', date: null },
        { label: 'Auftraggeber', name: '', date: null },
      ],
    })
    const noLocation = sheetLetter(
      {
        ...open,
        lines: [
          {
            ...sheet.lines[0],
            locationId: null,
            documentItemId: null,
            unit: null,
          } as MeasurementSheetDetail['lines'][number],
        ],
      },
      context,
    )
    expect(noLocation.body.blocks[0]).toMatchObject({
      rows: [{ cells: ['Ohne Raum'] }, { cells: ['', 'Wände', '(L+B)*2*H', '41,16'] }],
    })
  })

  it('renders a Bautagesbericht section by section with photos and a draft watermark', () => {
    const { logoPosition: _, ...letter } = reportLetter(report, {
      ...context,
      units: new Map([['u-m2', m2]]),
      photos: [{ path: '/photo-1.png', caption: 'EG nach dem Spachteln' }],
    })
    expect(letter.watermark).toBe('ENTWURF')
    const pdf = renderLetterPdf(
      { ...letter, logo: null },
      { assets: [{ path: '/photo-1.png', data: PNG }] },
    )
    const t = text(pdf)
    if (!t) return
    for (const expected of [
      'Bautagesbericht vom 06.11.2026',
      'Wohnbau Nord eG',
      'Heiter bis wolkig',
      '6 bis 11,5 °C',
      'Paul Polier',
      'Summe',
      '41,16 m²',
      'Rollgerüst',
      'Zugang Dachboden erst ab Montag.',
      'Sicherheitsunterweisung',
      '13.11.2026',
      'EG nach dem Spachteln',
      'ENTWURF',
    ]) {
      expect(t).toContain(expected)
    }
  })

  it('leaves out photos that cannot be embedded and says so', () => {
    expect(isUsableImage('/photo-1.png', PNG)).toBe(true)
    expect(isUsableImage('/photo-2.jpg', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]))).toBe(
      false,
    )
    expect(isUsableImage('/../etc/passwd.png', PNG)).toBe(false)
    const letter = reportLetter(report, {
      ...context,
      units: new Map(),
      photos: [],
      skippedPhotos: 2,
    })
    expect(letter.body.blocks).toContainEqual({
      kind: 'text',
      text: '2 Fotos konnten nicht eingebunden werden (Format nicht darstellbar). Originale in der Projektablage.',
    })
    const one = reportLetter(report, { ...context, units: new Map(), photos: [], skippedPhotos: 1 })
    expect(one.body.blocks).toContainEqual({
      kind: 'text',
      text: '1 Foto konnte nicht eingebunden werden (Format nicht darstellbar). Original in der Projektablage.',
    })
  })

  it('shows signatures, the service period and empty values of a signed Regiebericht', () => {
    const signed = {
      ...report,
      status: 'signed' as const,
      template: {
        ...report.template,
        name: 'Regiebericht',
        sections: [
          { id: 'w', type: 'weather' as const },
          { id: 's', type: 'staff' as const },
          { id: 'y', type: 'yes_no' as const, label: 'Abgenommen' },
          { id: 'd', type: 'deadline' as const, label: 'Frist' },
          { id: 'n', type: 'text' as const },
          { id: 'p', type: 'photos' as const },
          { id: 'sig', type: 'signatures' as const },
        ],
      },
      serviceFrom: '2026-11-02',
      serviceTo: '2026-11-06',
      data: {
        w: { condition: null, temperatureMin: null, temperatureMax: null, note: null },
        y: { value: false },
      },
      signatures: [
        { role: 'client' as const, name: 'Hans Berger', signedAt: '2026-11-06T16:00:00.000Z' },
      ],
    }
    const letter = reportLetter(signed, { ...context, units: new Map(), photos: [] })
    expect(letter.watermark).toBeNull()
    expect(letter.info).toContainEqual({
      label: 'Leistungszeitraum',
      value: '02.11.2026 – 06.11.2026',
    })
    expect(letter.info.at(-1)).toEqual({ label: 'Stand', value: 'unterschrieben' })
    expect(letter.body.blocks).toEqual([
      { kind: 'heading', text: 'Wetter' },
      {
        kind: 'facts',
        rows: [
          { label: 'Wetterlage', value: '–' },
          { label: 'Temperatur', value: '–' },
        ],
      },
      { kind: 'facts', rows: [{ label: 'Abgenommen', value: 'Nein' }] },
      { kind: 'facts', rows: [{ label: 'Frist', value: '–' }] },
      {
        kind: 'signatures',
        items: [{ label: 'Auftraggeber', name: 'Hans Berger', date: '06.11.2026' }],
      },
    ])
  })
})
