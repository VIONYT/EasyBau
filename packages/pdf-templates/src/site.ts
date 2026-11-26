import { formatUnitQuantity, germanDate, type LetterheadValues } from '@easybau/domain'
import type {
  ChecklistValue,
  EquipmentValue,
  MeasurementSheetDetail,
  MeasurementValue,
  QuantityRowsValue,
  ReportDetail,
  StaffValue,
  TextValue,
  WeatherValue,
} from '@easybau/schemas'
import { EMPTY_BODY, type LogoPosition, letterFrame } from './frame.js'
import type { LetterBlock, LetterPdfInput } from './types.js'

/** Company frame shared by Aufmaßblatt and Berichte (live letterhead of the company). */
export interface SiteLetterContext {
  issuerName: string
  layout: Parameters<typeof letterFrame>[0]['layout']
  values: LetterheadValues
  recipient: string[]
  /** Handwritten signatures available as template assets: asset id → path (e.g. /sig-1.png). */
  signatureImages?: ReadonlyMap<string, string>
}

const signatureImage = (ctx: SiteLetterContext, assetId: string | null) =>
  (assetId && ctx.signatureImages?.get(assetId)) || null

type SiteLetter = Omit<LetterPdfInput, 'logo'> & { logoPosition: LogoPosition | null }

const qty = (value: string, unit: { symbol: string; decimals: number } | null) =>
  `${formatUnitQuantity(value, unit?.decimals ?? 2)} ${unit?.symbol ?? ''}`.trim()
const decimal = (value: string | null | undefined) => (value ? value.replace('.', ',') : '')
const timestamp = (iso: string) => germanDate(iso.slice(0, 10))

// ---- Aufmaßblatt -------------------------------------------------------------------------------

/** Room dimensions in the usual order L · B · H (jsonb does not keep the key order). */
const DIMENSIONS = ['L', 'B', 'H']
const dimensionOrder = (key: string) => {
  const index = DIMENSIONS.indexOf(key)
  return index === -1 ? DIMENSIONS.length : index
}

const SHEET_KIND: Record<string, string> = {
  survey: 'Angebotsaufmaß',
  performance: 'Leistungsaufmaß',
}

/** Lines of an Aufmaßblatt grouped by room (also used in reports that link the sheet). */
export function sheetLinesTable(sheet: MeasurementSheetDetail): LetterBlock {
  const itemOf = new Map(sheet.items.map((s) => [s.item.id, s.item]))
  const locationOf = new Map(sheet.locations.map((l) => [l.id, l]))
  const rows: Extract<LetterBlock, { kind: 'table' }>['rows'] = []
  let currentLocation: string | null | undefined
  for (const line of sheet.lines) {
    if (line.locationId !== currentLocation) {
      currentLocation = line.locationId
      const location = line.locationId ? locationOf.get(line.locationId) : null
      const dims = location
        ? Object.entries(location.variables)
            .sort(([a], [b]) => dimensionOrder(a) - dimensionOrder(b) || a.localeCompare(b))
            .map(([k, v]) => `${k} ${decimal(v)}`)
            .join(' · ')
        : ''
      rows.push({
        cells: [location ? `${location.path}${dims ? ` (${dims})` : ''}` : 'Ohne Raum'],
        group: true,
        strong: false,
      })
    }
    const item = line.documentItemId ? itemOf.get(line.documentItemId) : undefined
    rows.push({
      cells: [
        item?.oz ?? '',
        `${line.description ?? ''}${line.isDeduction ? ' (Abzug)' : ''}`.trim(),
        line.formula,
        qty(line.resultQty, line.unit),
      ],
      group: false,
      strong: false,
    })
  }

  return {
    kind: 'table',
    columns: ['Pos.', 'Beschreibung', 'Rechenweg', 'Menge'],
    widths: ['auto', '1fr', '1fr', 'auto'],
    align: ['left', 'left', 'left', 'right'],
    rows,
  }
}

/** Aufmaßblatt (DESIGN.md §4.3) as letter: lines per room, quantities per LV position, signatures. */
export function sheetLetter(sheet: MeasurementSheetDetail, ctx: SiteLetterContext): SiteLetter {
  const blocks: LetterBlock[] = [sheetLinesTable(sheet)]
  if (sheet.items.length) {
    blocks.push(
      { kind: 'heading', text: 'Mengen je LV-Position' },
      {
        kind: 'table',
        columns: ['Pos.', 'Leistung', 'Dieses Blatt', 'Aufmaß gesamt', 'LV-Menge', 'Abweichung'],
        widths: ['auto', '1fr', 'auto', 'auto', 'auto', 'auto'],
        align: ['left', 'left', 'right', 'right', 'right', 'right'],
        rows: sheet.items.map(({ item, sheetQuantity, variance }) => ({
          cells: [
            item.oz ?? '',
            item.shortText,
            qty(sheetQuantity, item.unit),
            qty(item.measuredQuantity, item.unit),
            qty(item.quantity, item.unit),
            variance.percent
              ? `${variance.direction === 'less' ? '−' : '+'} ${decimal(variance.percent.replace(/^-/, ''))} %${variance.exceedsThreshold ? ' (über 10 %)' : ''}`
              : '–',
          ],
          group: false,
          strong: false,
        })),
      },
    )
  }
  if (sheet.unassigned.length) {
    blocks.push({
      kind: 'facts',
      rows: sheet.unassigned.map((u) => ({
        label: 'Ohne LV-Position',
        value: `${formatUnitQuantity(u.quantity, u.decimals)} ${u.unit ?? ''} (${u.count} Zeilen)`,
      })),
    })
  }
  // Gemeinsames Aufmaß: names and time when signed, otherwise lines to sign on paper.
  blocks.push({
    kind: 'signatures',
    items: [
      {
        label: 'Auftragnehmer',
        name: sheet.signedByContractor ?? '',
        date: sheet.signedAt ? timestamp(sheet.signedAt) : null,
        image: signatureImage(ctx, sheet.contractorSignatureAssetId),
      },
      {
        label: 'Auftraggeber',
        name: sheet.signedByClient ?? '',
        date: sheet.signedAt ? timestamp(sheet.signedAt) : null,
        image: signatureImage(ctx, sheet.clientSignatureAssetId),
      },
    ],
  })

  const kind = SHEET_KIND[sheet.kind] ?? 'Aufmaß'
  return {
    ...letterFrame({
      issuerName: ctx.issuerName,
      layout: ctx.layout,
      values: ctx.values,
      recipient: ctx.recipient,
      info: [
        { label: 'Art', value: kind },
        { label: 'Aufmaß vom', value: germanDate(sheet.measuredOn) },
        {
          label: 'Projekt',
          value: [sheet.project.number, sheet.project.name].filter(Boolean).join(' · '),
        },
        sheet.signedAt
          ? { label: 'Unterschrieben am', value: timestamp(sheet.signedAt) }
          : { label: 'Stand', value: 'in Arbeit' },
      ],
      title: sheet.title,
      watermark: null,
    }),
    body: {
      ...EMPTY_BODY,
      heading: sheet.title,
      subject: kind,
      small: [],
      blocks,
    },
  }
}

// ---- Berichte / Bautagebuch ---------------------------------------------------------------------

const WEATHER: Record<string, string> = {
  sunny: 'Sonnig',
  partly_cloudy: 'Heiter bis wolkig',
  overcast: 'Bedeckt',
  rain: 'Regen',
  heavy_rain: 'Starkregen',
  snow: 'Schnee',
  frost: 'Frost',
  storm: 'Sturm',
  fog: 'Nebel',
}
const SECTION_LABEL: Record<string, string> = {
  header: 'Angaben',
  weather: 'Wetter',
  staff: 'Personal und Arbeitszeiten',
  services: 'Ausgeführte Leistungen',
  materials: 'Material',
  equipment: 'Geräte',
  text: 'Notizen',
  checklist: 'Checkliste',
  measurement: 'Aufmaß',
  photos: 'Fotos',
  signatures: 'Unterschriften',
}
const CHECKLIST: Record<string, string> = {
  ok: 'in Ordnung',
  issue: 'Mangel / offen',
  na: 'entfällt',
}
const ROLE: Record<string, string> = {
  contractor: 'Auftragnehmer',
  client: 'Auftraggeber',
  other: 'Weitere Person',
}
const STATUS: Record<string, string> = {
  draft: 'Entwurf',
  completed: 'abgeschlossen',
  signed: 'unterschrieben',
}

/**
 * Bericht (Bautagesbericht, Regiebericht …) as letter, section by section of its template.
 * `photos` are the image paths the caller maps into the template (see renderLetterPdf assets).
 */
export function reportLetter(
  report: ReportDetail,
  ctx: SiteLetterContext & {
    units: Map<string, { symbol: string; decimals: number }>
    photos: { path: string; caption: string | null }[]
    /** Photos that could not be embedded (format, damaged file). */
    skippedPhotos?: number
    /** Aufmaßblätter linked in measurement sections. */
    sheets?: Map<string, MeasurementSheetDetail>
  },
): SiteLetter {
  const blocks: LetterBlock[] = []
  const unit = (id: string | null | undefined) => (id ? (ctx.units.get(id) ?? null) : null)
  for (const section of report.template.sections) {
    const label = section.label ?? SECTION_LABEL[section.type] ?? section.type
    const value = report.data[section.id] as Record<string, unknown> | undefined
    switch (section.type) {
      case 'header':
        blocks.push({
          kind: 'facts',
          rows: [
            { label: 'Auftragnehmer', value: report.header.contractor },
            { label: 'Auftraggeber', value: report.header.client ?? '–' },
            { label: 'Leistungsort', value: report.header.placeOfPerformance ?? '–' },
          ],
        })
        break
      case 'weather': {
        const w = value as WeatherValue | undefined
        if (!w) break
        const temperature = [w.temperatureMin, w.temperatureMax].filter(Boolean).map(decimal)
        blocks.push(
          { kind: 'heading', text: label },
          {
            kind: 'facts',
            rows: [
              {
                label: 'Wetterlage',
                value: w.condition ? (WEATHER[w.condition] ?? w.condition) : '–',
              },
              {
                label: 'Temperatur',
                value: temperature.length ? `${temperature.join(' bis ')} °C` : '–',
              },
              ...(w.note ? [{ label: 'Bemerkung', value: w.note }] : []),
            ],
          },
        )
        break
      }
      case 'staff': {
        const s = value as StaffValue | undefined
        if (!s?.rows.length) break
        blocks.push(
          { kind: 'heading', text: label },
          {
            kind: 'table',
            columns: ['Name', 'Tätigkeit', 'Stunden'],
            widths: ['1fr', '1fr', 'auto'],
            align: ['left', 'left', 'right'],
            rows: [
              ...s.rows.map((r) => ({
                cells: [r.name, r.activity ?? '', decimal(r.hours)],
                group: false,
                strong: false,
              })),
              { cells: ['Summe', '', decimal(report.totalHours)], group: false, strong: true },
            ],
          },
        )
        break
      }
      case 'services':
      case 'materials': {
        const q = value as QuantityRowsValue | undefined
        if (!q?.rows.length) break
        blocks.push(
          { kind: 'heading', text: label },
          {
            kind: 'table',
            columns: ['Beschreibung', 'Menge'],
            widths: ['1fr', 'auto'],
            align: ['left', 'right'],
            rows: q.rows.map((r) => ({
              cells: [r.description, r.quantity ? qty(r.quantity, unit(r.unitId)) : ''],
              group: false,
              strong: false,
            })),
          },
        )
        break
      }
      case 'equipment': {
        const e = value as EquipmentValue | undefined
        if (!e?.rows.length) break
        blocks.push(
          { kind: 'heading', text: label },
          {
            kind: 'table',
            columns: ['Gerät', 'Stunden'],
            widths: ['1fr', 'auto'],
            align: ['left', 'right'],
            rows: e.rows.map((r) => ({
              cells: [r.description, decimal(r.hours)],
              group: false,
              strong: false,
            })),
          },
        )
        break
      }
      case 'text': {
        const t = value as TextValue | undefined
        if (t?.text?.trim())
          blocks.push({ kind: 'heading', text: label }, { kind: 'text', text: t.text })
        break
      }
      case 'yes_no': {
        const v = (value as { value?: boolean | null } | undefined)?.value
        blocks.push({
          kind: 'facts',
          rows: [{ label, value: v === true ? 'Ja' : v === false ? 'Nein' : '–' }],
        })
        break
      }
      case 'deadline': {
        const d = (value as { date?: string | null } | undefined)?.date
        blocks.push({ kind: 'facts', rows: [{ label, value: d ? germanDate(d) : '–' }] })
        break
      }
      case 'checklist': {
        const c = value as ChecklistValue | undefined
        if (!c?.rows.length) break
        blocks.push(
          { kind: 'heading', text: label },
          {
            kind: 'table',
            columns: ['Punkt', 'Ergebnis', 'Bemerkung'],
            widths: ['1fr', 'auto', '1fr'],
            align: ['left', 'left', 'left'],
            rows: c.rows.map((r) => ({
              cells: [r.label, r.state ? (CHECKLIST[r.state] ?? r.state) : '–', r.note ?? ''],
              group: false,
              strong: r.state === 'issue',
            })),
          },
        )
        break
      }
      case 'measurement': {
        const m = value as MeasurementValue | undefined
        const sheet = m?.sheetId ? ctx.sheets?.get(m.sheetId) : undefined
        if (!sheet && !m?.rows?.length) break
        blocks.push({ kind: 'heading', text: label })
        if (sheet) {
          blocks.push(
            {
              kind: 'facts',
              rows: [
                { label: 'Aufmaßblatt', value: sheet.title },
                { label: 'Aufmaß vom', value: germanDate(sheet.measuredOn) },
              ],
            },
            sheetLinesTable(sheet),
          )
        }
        if (m?.rows?.length) {
          blocks.push({
            kind: 'table',
            columns: ['Beschreibung', 'Maß / Menge'],
            widths: ['1fr', 'auto'],
            align: ['left', 'right'],
            rows: m.rows.map((r) => ({
              cells: [r.description, r.quantity ? qty(r.quantity, unit(r.unitId)) : ''],
              group: false,
              strong: false,
            })),
          })
        }
        break
      }
      case 'photos': {
        const skipped = ctx.skippedPhotos ?? 0
        if (ctx.photos.length || skipped) blocks.push({ kind: 'heading', text: label })
        if (ctx.photos.length) blocks.push({ kind: 'images', items: ctx.photos })
        if (skipped) {
          const one = skipped === 1
          blocks.push({
            kind: 'text',
            text: `${skipped} Foto${one ? '' : 's'} konnte${one ? '' : 'n'} nicht eingebunden werden (Format nicht darstellbar). Original${one ? '' : 'e'} in der Projektablage.`,
          })
        }
        break
      }
      case 'signatures': {
        const signed = report.signatures.map((s) => ({
          label: ROLE[s.role] ?? s.role,
          name: s.name,
          date: timestamp(s.signedAt),
          image: signatureImage(ctx, s.imageAssetId),
        }))
        const open = (section.roles ?? ['contractor', 'client']).map((role) => ({
          label: ROLE[role] ?? role,
          name: '',
          date: null,
        }))
        blocks.push({ kind: 'signatures', items: signed.length ? signed : open })
        break
      }
    }
  }

  const date = germanDate(report.reportDate)
  const info = [
    { label: 'Datum', value: date },
    {
      label: 'Projekt',
      value: [report.project.number, report.project.name].filter(Boolean).join(' · '),
    },
  ]
  if (report.serviceFrom || report.serviceTo) {
    info.push({
      label: 'Leistungszeitraum',
      value: [report.serviceFrom, report.serviceTo]
        .filter((d, i, all): d is string => !!d && all.indexOf(d) === i)
        .map(germanDate)
        .join(' – '),
    })
  }
  info.push({ label: 'Stand', value: STATUS[report.status] ?? report.status })
  const title = `${report.template.name} vom ${date}`
  return {
    ...letterFrame({
      issuerName: ctx.issuerName,
      layout: ctx.layout,
      values: ctx.values,
      recipient: ctx.recipient,
      info,
      title,
      watermark: report.status === 'draft' ? 'ENTWURF' : null,
    }),
    body: { ...EMPTY_BODY, heading: title, subject: null, small: [], blocks },
  }
}
