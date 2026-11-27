import type { Tx } from '@easybau/db'
import { Decimal, toCents } from '@easybau/domain'
import { csv, germanAmount, parseCsv } from '@easybau/exports'
import {
  CATALOG_CSV_COLUMNS,
  type CatalogImportResult,
  type CatalogImportRow,
  catalogExportQuery,
  importCatalogCsvRequest,
  type UpdateCatalogItemRequest,
  updateCatalogItemRequest,
} from '@easybau/schemas'
import type { FastifyInstance } from 'fastify'
import { inTenant, requirePermission, type Services } from '../context.js'
import { HttpError, parse } from '../http.js'
import { saveItem } from './catalog.js'
import { todayIn } from './receivables.js'

/**
 * Stammdaten als CSV (P2.12): export of Leistungen/Materialien and import with preview (like
 * the contact import). Prices only – a Kalkulation (Bestandteile) is neither exported nor
 * imported; entries with Kalkulation are never overwritten by an import.
 */

type Column = (typeof CATALOG_CSV_COLUMNS)[number]
const MAX_ROWS = 10_000

const normalize = (header: string) =>
  header
    .toLowerCase()
    .replace(/[\s.\-_%]/g, '')
    .replace('ß', 'ss')
const ALIASES: Record<string, Column> = {
  ...Object.fromEntries(CATALOG_CSV_COLUMNS.map((c) => [normalize(c), c])),
  typ: 'Art',
  kategorie: 'Ordner',
  gruppe: 'Ordner',
  warengruppe: 'Ordner',
  artikelnr: 'Artikelnummer',
  artnr: 'Artikelnummer',
  nummer: 'Artikelnummer',
  bezeichnung: 'Kurztext',
  name: 'Kurztext',
  beschreibung: 'Langtext',
  me: 'Einheit',
  mengeneinheit: 'Einheit',
  einkaufspreis: 'EK',
  zuschlag: 'Zuschlag %',
  aufschlag: 'Zuschlag %',
  verkaufspreis: 'VK',
  preis: 'VK',
  gebinde: 'Gebindeinhalt',
  gtin: 'EAN',
}

/** "1.234,56", "1234,56", "1234.56", "12 €" → Decimal; '' → null; invalid → undefined. */
function germanNumber(value: string): Decimal | null | undefined {
  const v = value.replace(/[\s€%]/g, '')
  if (!v) return null
  const normalized = v.includes(',') ? v.replace(/\./g, '').replace(',', '.') : v
  if (!/^-?\d+(\.\d+)?$/.test(normalized)) return undefined
  return new Decimal(normalized)
}

const KIND_LABEL = { service: 'Leistung', material: 'Material' } as const

function kindOf(value: string, fallback: 'service' | 'material') {
  const v = value.trim().toLowerCase()
  if (!v) return fallback
  if (v.startsWith('l') || v === 'service') return 'service'
  if (v.startsWith('m')) return 'material'
  return null
}

async function importCatalog(
  tx: Tx,
  auth: Parameters<typeof saveItem>[1],
  input: ReturnType<typeof importCatalogCsvRequest.parse>,
): Promise<CatalogImportResult> {
  const [header, ...lines] = parseCsv(input.csv)
  if (!header) throw new HttpError(400, 'Die Datei ist leer.', { csv: 'Keine Zeilen gefunden.' })
  const columns = header.map((h) => ALIASES[normalize(h)] ?? null)
  if (!columns.includes('Kurztext') || !columns.includes('Einheit')) {
    throw new HttpError(
      400,
      'Die Kopfzeile braucht mindestens „Kurztext“ und „Einheit“. Bitte die Vorlage aus dem Export verwenden.',
      { csv: 'Unbekannte Spalten.' },
    )
  }
  if (lines.length > MAX_ROWS) {
    throw new HttpError(400, `Höchstens ${MAX_ROWS} Einträge je Import.`, {
      csv: 'Zu viele Zeilen.',
    })
  }
  const units = await tx<{ id: string; symbol: string; name: string; aliases: string[] }[]>`
    select id, symbol, name, aliases from unit where is_active`
  const unitOf = (value: string) => {
    const v = value.trim().toLowerCase()
    return units.find(
      (u) =>
        u.symbol.toLowerCase() === v ||
        u.name.toLowerCase() === v ||
        u.aliases.some((a) => a.toLowerCase() === v),
    )
  }
  const folders = new Map(
    (
      await tx<{ id: string; kind: string; name: string }[]>`
        select id, kind, lower(name) as name from catalog_folder where parent_id is null`
    ).map((f) => [`${f.kind}|${f.name}`, f.id as string | null]),
  )
  const existing = await tx<
    { id: string; kind: string; article: string | null; key: string; calculated: boolean }[]
  >`
    select i.id, i.kind, lower(i.article_no) as article, lower(i.short_text) || '|' || i.unit_id as key,
           exists (select 1 from catalog_component c where c.catalog_item_id = i.id) as calculated
    from catalog_item i where i.archived_at is null`
  const byArticle = new Map(
    existing.filter((e) => e.article).map((e) => [`${e.kind}|${e.article}`, e]),
  )
  const byKey = new Map(existing.map((e) => [`${e.kind}|${e.key}`, e]))
  const seen = new Set<string>()
  const newFolders: string[] = []
  const rows: CatalogImportRow[] = []
  for (const [index, line] of lines.entries()) {
    const get = (column: Column) => (line[columns.indexOf(column)] ?? '').trim()
    if (line.every((cell) => !cell.trim())) continue
    const name = get('Kurztext') || '–'
    const row = (action: CatalogImportRow['action'], message: string | null) =>
      rows.push({ line: index + 2, name, action, message })
    const kind = kindOf(get('Art'), input.kind)
    if (!kind) {
      row('error', `Unbekannte Art „${get('Art')}“ (Leistung oder Material).`)
      continue
    }
    const unit = unitOf(get('Einheit'))
    if (!unit) {
      row(
        'error',
        `Unbekannte Einheit „${get('Einheit')}“. Bitte unter Einstellungen › Einheiten anlegen.`,
      )
      continue
    }
    const cost = germanNumber(get('EK'))
    const markup = germanNumber(get('Zuschlag %'))
    const price = germanNumber(get('VK'))
    const pack = germanNumber(get('Gebindeinhalt'))
    const bad = (
      [
        ['EK', cost],
        ['Zuschlag %', markup],
        ['VK', price],
        ['Gebindeinhalt', pack],
      ] as const
    ).find(([, v]) => v === undefined)
    if (bad) {
      row('error', `${bad[0]}: „${get(bad[0])}“ ist keine Zahl.`)
      continue
    }
    const folderName = get('Ordner')
    const request: UpdateCatalogItemRequest = {
      shortText: get('Kurztext'),
      longText: get('Langtext') || null,
      unitId: unit.id,
      articleNo: get('Artikelnummer') || null,
      manufacturer: get('Hersteller') || null,
      ean: get('EAN') || null,
      ...(cost ? { costCents: Number(toCents(cost.mul(100))) } : {}),
      ...(markup ? { markupPercent: markup.toFixed(4) } : {}),
      ...(price ? { priceCents: Number(toCents(price.mul(100))) } : {}),
      packSize: pack ? pack.toString() : null,
    }
    const parsed = updateCatalogItemRequest.safeParse(request)
    if (!parsed.success) {
      const issue = parsed.error.issues[0]
      row('error', `${issue?.path.join('.') || 'Zeile'}: ${issue?.message ?? 'ungültig'}`)
      continue
    }
    const article = request.articleNo?.toLowerCase()
    const key = `${kind}|${article ? `a:${article}` : `k:${name.toLowerCase()}|${unit.id}`}`
    if (seen.has(key)) {
      row('skip', 'Steht weiter oben schon in der Datei.')
      continue
    }
    seen.add(key)
    const match = article
      ? byArticle.get(`${kind}|${article}`)
      : byKey.get(`${kind}|${name.toLowerCase()}|${unit.id}`)
    if (match && !input.updateExisting) {
      row(
        'skip',
        article
          ? `Artikelnummer ${request.articleNo} gibt es schon.`
          : 'Diesen Eintrag gibt es schon.',
      )
      continue
    }
    if (match?.calculated) {
      row('skip', 'Der Eintrag hat eine Kalkulation; Preise bitte im Eintrag ändern.')
      continue
    }
    let folderId: string | null = null
    if (folderName) {
      const folderKey = `${kind}|${folderName.toLowerCase()}`
      folderId = folders.get(folderKey) ?? null
      if (!folders.has(folderKey)) {
        newFolders.push(`${KIND_LABEL[kind]}: ${folderName}`)
        if (!input.dryRun) {
          const [created] = await tx<{ id: string }[]>`
            insert into catalog_folder (tenant_id, kind, name, sort)
            values (${auth.tenantId}, ${kind}, ${folderName},
                    (select coalesce(max(sort), 0) + 10 from catalog_folder where kind = ${kind} and parent_id is null))
            returning id`
          folderId = (created as { id: string }).id
        }
        folders.set(folderKey, folderId)
      }
    }
    if (!input.dryRun) {
      await saveItem(
        tx,
        auth,
        kind,
        { ...parsed.data, ...(folderName ? { folderId } : {}) },
        match?.id,
      )
    }
    row(match ? 'update' : 'create', null)
  }
  return {
    dryRun: input.dryRun,
    created: rows.filter((r) => r.action === 'create').length,
    updated: rows.filter((r) => r.action === 'update').length,
    skipped: rows.filter((r) => r.action === 'skip').length,
    errors: rows.filter((r) => r.action === 'error').length,
    newFolders,
    rows,
  }
}

export function registerCatalogCsvRoutes(app: FastifyInstance, services: Services) {
  app.get('/api/v1/catalog/export.csv', async (request, reply) => {
    const auth = requirePermission(request, 'catalog.read')
    const { kind } = parse(catalogExportQuery, request.query)
    const prices = auth.permissions.has('price.view')
    const rows = await inTenant(
      services,
      auth,
      (tx) => tx<Record<string, string | null>[]>`
        select i.kind, f.name as folder, i.article_no as article, i.manufacturer, i.ean,
               i.short_text as short, i.long_text as long, u.symbol as unit,
               i.cost_cents::text as cost, trim_scale(i.markup_percent)::text as markup,
               i.price_cents::text as price, trim_scale(i.pack_size)::text as pack
        from catalog_item i join unit u on u.id = i.unit_id
        left join catalog_folder f on f.id = i.folder_id
        where i.archived_at is null and (${kind ?? null}::text is null or i.kind = ${kind ?? null})
        order by i.kind desc, lower(f.name), lower(i.short_text), i.id`,
    )
    const body = csv(
      CATALOG_CSV_COLUMNS,
      rows.map((r) => [
        KIND_LABEL[r.kind as 'service' | 'material'],
        r.folder,
        r.article,
        r.manufacturer,
        r.ean,
        r.short,
        r.long,
        r.unit,
        // EK and markup only for roles with price.view (security audit run-1).
        prices ? germanAmount(r.cost ?? '0') : null,
        prices ? (r.markup ?? '0').replace('.', ',') : null,
        germanAmount(r.price ?? '0'),
        r.pack?.replace('.', ',') ?? null,
      ]),
    )
    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header(
        'content-disposition',
        `attachment; filename="Stammdaten_${todayIn(services.now())}.csv"`,
      )
      .send(`﻿${body}`)
  })

  app.post('/api/v1/catalog/import', async (request): Promise<CatalogImportResult> => {
    const auth = requirePermission(request, 'catalog.write')
    const input = parse(importCatalogCsvRequest, request.body)
    return inTenant(services, auth, (tx) => importCatalog(tx, auth, input))
  })
}
