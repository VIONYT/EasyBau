import { Readable } from 'node:stream'
import type { Tx } from '@easybau/db'
import {
  CalculationError,
  type CostLineInput,
  calculateItem,
  type DatanormArticle,
  type DatanormArticleExtra,
  type DatanormDiscount,
  DatanormError,
  type DatanormPrice,
  type DatanormText,
  Decimal,
  decodeBytes,
  detectEncoding,
  isConvertible,
  LineSplitter,
  parseDatanormLine,
  rateForTimeUnit,
  roundTo,
  toCents,
  toDecimal,
  unitCostCents,
} from '@easybau/domain'
import {
  type CatalogFolder,
  type CatalogItem,
  catalogFolderRequest,
  catalogListQuery,
  createCatalogItemRequest,
  type ImportResult,
  importCatalogQuery,
  insertFromCatalogRequest,
  type SupplierArticle,
  type SupplierCatalog,
  saveToCatalogRequest,
  supplierArticleQuery,
  takeOverArticleRequest,
  type UpdateCatalogItemRequest,
  updateCatalogItemRequest,
  updateSupplierCatalogRequest,
} from '@easybau/schemas'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { type AuthContext, inTenant, requirePermission, type Services } from '../context.js'
import { HttpError, notFound, parse } from '../http.js'
import {
  checkQuantityDecimals,
  loadDocument,
  lockDraft,
  recalculate,
  sendDocument,
  unitSnapshot,
} from './documents.js'

const idParam = z.object({ id: z.uuid('Ungültige ID.') })

const ISO = (tx: Tx, column: string) =>
  tx`to_char(${tx.unsafe(column)} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`

const invalid = (errors: Record<string, string>) =>
  new HttpError(400, 'Die Eingaben sind unvollständig oder ungültig.', errors)

// ---- Stammdaten: prices ------------------------------------------------------------------------

interface ComponentRow {
  kind: CostLineInput['kind']
  description: string | null
  quantity: string
  unitId: string | null
  unitSymbol: string | null
  unitCostCents: number | string
  markupPercent: string | null
  wageGroupId?: string | null
}

async function surcharges(tx: Tx): Promise<Map<string, string>> {
  const rows = await tx<{ kind: string; percent: string }[]>`
    select cost_kind as kind, trim_scale(percent)::text as percent from surcharge`
  return new Map(rows.map((r) => [r.kind, r.percent]))
}

function costLine(c: ComponentRow, defaults: Map<string, string>): CostLineInput {
  const timeUnit = c.unitSymbol && isConvertible(c.unitSymbol, 'Std')
  return {
    kind: c.kind,
    quantity: c.quantity,
    ...(c.unitSymbol ? { unit: c.unitSymbol } : {}),
    unitCostCents:
      c.kind === 'labor' && timeUnit
        ? rateForTimeUnit(c.unitCostCents, c.unitSymbol as string)
        : c.unitCostCents,
    markupPercent: c.markupPercent ?? defaults.get(c.kind) ?? '0',
  }
}

/**
 * EK, Zuschlag and VK of a Stammdaten entry:
 *  - with Bestandteile (Leistungen): from the Kalkulation for one unit,
 *  - otherwise VK as entered, or EK × (1 + Zuschlag).
 */
function pricesOf(
  input: {
    costCents: number
    markupPercent: string
    priceCents: number | null
    calcMode: 'unit_price' | 'total_price'
  },
  components: ComponentRow[],
  defaults: Map<string, string>,
): { costCents: bigint; markupPercent: string; priceCents: bigint; laborHours: string | null } {
  try {
    if (components.length) {
      const calc = calculateItem({
        quantity: 1,
        calcMode: input.calcMode,
        costLines: components.map((c) => costLine(c, defaults)),
      })
      const markup =
        calc.costCents > 0n
          ? roundTo(
              new Decimal(calc.unitPriceCents.toString())
                .div(calc.costCents.toString())
                .minus(1)
                .mul(100),
              4,
            )
          : '0'
      return {
        costCents: calc.costCents,
        markupPercent: markup,
        priceCents: calc.unitPriceCents,
        laborHours: roundTo(calc.laborHours, 2),
      }
    }
    const cost = BigInt(input.costCents)
    if (input.priceCents !== null) {
      const markup =
        cost > 0n
          ? roundTo(new Decimal(input.priceCents).div(cost.toString()).minus(1).mul(100), 4)
          : input.markupPercent
      return {
        costCents: cost,
        markupPercent: markup,
        priceCents: BigInt(input.priceCents),
        laborHours: null,
      }
    }
    const price = toCents(
      new Decimal(cost.toString()).mul(toDecimal(input.markupPercent).div(100).plus(1)),
    )
    return {
      costCents: cost,
      markupPercent: input.markupPercent,
      priceCents: price,
      laborHours: null,
    }
  } catch (error) {
    if (error instanceof CalculationError) throw new HttpError(400, error.message)
    throw error
  }
}

export async function loadItem(tx: Tx, id: string): Promise<CatalogItem | null> {
  const [row] = await tx<
    (Omit<CatalogItem, 'components' | 'laborHours'> & { calcModeRaw: string })[]
  >`
    select i.id, i.kind, i.folder_id as "folderId", i.article_no as "articleNo", i.manufacturer, i.ean,
           i.short_text as "shortText", i.long_text as "longText",
           json_build_object('id', u.id, 'symbol', u.symbol, 'decimals', u.decimals) as unit,
           i.cost_cents::float8 as "costCents", trim_scale(i.markup_percent)::text as "markupPercent",
           i.price_cents::float8 as "priceCents", trim_scale(i.pack_size)::text as "packSize",
           i.calc_mode as "calcMode", i.source, i.supplier_name as "supplierName",
           ${ISO(tx, 'i.updated_at')} as "updatedAt"
    from catalog_item i join unit u on u.id = i.unit_id
    where i.id = ${id} and i.archived_at is null`
  if (!row) return null
  const components = await tx<(ComponentRow & { id: string; unitDecimals: number | null })[]>`
    select c.id, c.cost_kind as kind, c.description, trim_scale(c.quantity)::text as quantity,
           c.unit_id as "unitId", u.symbol as "unitSymbol", u.decimals as "unitDecimals",
           c.unit_cost_cents::float8 as "unitCostCents", trim_scale(c.markup_percent)::text as "markupPercent",
           c.wage_group_id as "wageGroupId"
    from catalog_component c left join unit u on u.id = c.unit_id
    where c.catalog_item_id = ${id} order by c.sort, c.id`
  const { calcModeRaw: _, ...item } = row as typeof row & { calcModeRaw?: string }
  const prices = components.length
    ? pricesOf({ ...item, priceCents: null }, components, await surcharges(tx))
    : null
  return {
    ...item,
    components: components.map((c) => ({
      id: c.id,
      kind: c.kind,
      description: c.description,
      quantity: c.quantity,
      unit: c.unitId
        ? { id: c.unitId, symbol: c.unitSymbol ?? '', decimals: c.unitDecimals ?? 2 }
        : null,
      unitCostCents: Number(c.unitCostCents),
      markupPercent: c.markupPercent,
      wageGroupId: c.wageGroupId ?? null,
    })),
    laborHours: prices?.laborHours ?? null,
  }
}

async function unitSymbols(
  tx: Tx,
  ids: (string | null | undefined)[],
): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter((v): v is string => !!v))]
  if (!wanted.length) return new Map()
  const rows = await tx<{ id: string; symbol: string }[]>`
    select id, symbol from unit where id in ${tx(wanted)} and is_active`
  if (rows.length !== wanted.length) throw invalid({ unitId: 'Unbekannte Einheit.' })
  return new Map(rows.map((r) => [r.id, r.symbol]))
}

export async function saveItem(
  tx: Tx,
  auth: AuthContext,
  kind: 'service' | 'material',
  input: UpdateCatalogItemRequest,
  existingId?: string,
): Promise<string> {
  const defaults = await surcharges(tx)
  const current = existingId
    ? ((await loadItem(tx, existingId)) ??
      (() => {
        throw notFound('Der Eintrag')
      })())
    : null
  if (input.folderId) {
    const found =
      await tx`select 1 from catalog_folder where id = ${input.folderId} and kind = ${kind}`
    if (!found.length) throw invalid({ folderId: 'Unbekannter Ordner.' })
  }
  const components: ComponentRow[] | undefined = input.components
    ? await (async () => {
        const symbols = await unitSymbols(tx, input.components?.map((c) => c.unitId) ?? [])
        return (input.components ?? []).map((c) => ({
          kind: c.kind,
          description: c.description ?? null,
          quantity: c.quantity,
          unitId: c.unitId ?? null,
          unitSymbol: c.unitId ? (symbols.get(c.unitId) ?? null) : null,
          unitCostCents: c.unitCostCents,
          markupPercent: c.markupPercent ?? null,
          wageGroupId: c.kind === 'labor' ? (c.wageGroupId ?? null) : null,
        }))
      })()
    : undefined
  await unitSymbols(tx, [input.unitId])
  const effectiveComponents =
    components ??
    current?.components.map((c) => ({
      kind: c.kind,
      description: c.description,
      quantity: c.quantity,
      unitId: c.unit?.id ?? null,
      unitSymbol: c.unit?.symbol ?? null,
      unitCostCents: c.unitCostCents,
      markupPercent: c.markupPercent,
    })) ??
    []
  const markupDefault = defaults.get(kind === 'material' ? 'material' : 'other') ?? '0'
  const prices = pricesOf(
    {
      costCents: input.costCents ?? current?.costCents ?? 0,
      markupPercent: input.markupPercent ?? current?.markupPercent ?? markupDefault,
      priceCents:
        input.priceCents ??
        (input.costCents !== undefined || input.markupPercent
          ? null
          : (current?.priceCents ?? null)),
      calcMode: input.calcMode ?? current?.calcMode ?? 'unit_price',
    },
    effectiveComponents,
    defaults,
  )
  const columns: Record<string, unknown> = {
    cost_cents: prices.costCents.toString(),
    markup_percent: prices.markupPercent,
    price_cents: prices.priceCents.toString(),
  }
  const map: [keyof UpdateCatalogItemRequest, string][] = [
    ['folderId', 'folder_id'],
    ['shortText', 'short_text'],
    ['longText', 'long_text'],
    ['unitId', 'unit_id'],
    ['articleNo', 'article_no'],
    ['manufacturer', 'manufacturer'],
    ['ean', 'ean'],
    ['packSize', 'pack_size'],
    ['calcMode', 'calc_mode'],
  ]
  for (const [key, column] of map) if (input[key] !== undefined) columns[column] = input[key]
  let id = existingId
  if (id) {
    await tx`update catalog_item set ${tx(columns)} where id = ${id}`
  } else {
    if (!columns.folder_id) {
      const [folder] = await tx<{ id: string }[]>`
        select id from catalog_folder where kind = ${kind} and parent_id is null order by sort, name limit 1`
      columns.folder_id = folder?.id ?? null
    }
    const [row] = await tx<{ id: string }[]>`
      insert into catalog_item ${tx({ ...columns, tenant_id: auth.tenantId, kind })} returning id`
    id = (row as { id: string }).id
  }
  if (components) {
    const groups = [...new Set(components.map((c) => c.wageGroupId).filter(Boolean))] as string[]
    if (groups.length) {
      const found = await tx`select id from wage_group where id in ${tx(groups)}`
      if (found.length !== groups.length) throw invalid({ components: 'Unbekannte Lohngruppe.' })
    }
    await tx`delete from catalog_component where catalog_item_id = ${id}`
    for (const [index, c] of components.entries()) {
      await tx`
        insert into catalog_component ${tx({
          tenant_id: auth.tenantId,
          catalog_item_id: id,
          sort: (index + 1) * 10,
          cost_kind: c.kind,
          description: c.description,
          quantity: c.quantity,
          unit_id: c.unitId,
          unit_cost_cents: String(c.unitCostCents),
          markup_percent: c.markupPercent,
          wage_group_id: c.wageGroupId ?? null,
        })}`
    }
  }
  return id as string
}

// ---- Supplier catalogs -------------------------------------------------------------------------

async function loadCatalog(tx: Tx, id: string): Promise<SupplierCatalog | null> {
  const [row] = await tx<SupplierCatalog[]>`
    select c.id, c.name, c.supplier, c.version, trim_scale(c.discount_percent)::text as "discountPercent",
           c.article_count as "articleCount", ${ISO(tx, 'c.imported_at')} as "importedAt",
           coalesce((select json_agg(json_build_object('discountGroup', d.discount_group,
                                                       'percent', trim_scale(d.percent)::text)
                                     order by d.discount_group)
                     from supplier_discount d where d.catalog_id = c.id), '[]'::json) as discounts
    from supplier_catalog c where c.id = ${id}`
  return row ?? null
}

/** Einkaufspreis of one unit after discount (group discount wins over the catalog discount). */
const ARTICLE_COLUMNS = (tx: Tx) => tx`
  a.id, a.catalog_id as "catalogId", c.name as "catalogName", a.article_no as "articleNo",
  a.short_text as "shortText", a.long_text as "longText", a.unit_raw as "unitRaw",
  case when u.id is null then null else json_build_object('id', u.id, 'symbol', u.symbol, 'decimals', u.decimals) end as unit,
  a.price_kind as "priceKind", trim_scale(a.price_cents)::text as "priceCents", a.price_unit as "priceUnit",
  a.discount_group as "discountGroup", a.ean,
  coalesce(d.percent, c.discount_percent)::text as "discountPercent"`

const fromArticles = (tx: Tx) => tx`
  supplier_article a
  join supplier_catalog c on c.id = a.catalog_id
  left join unit u on u.id = a.unit_id
  left join supplier_discount d on d.catalog_id = a.catalog_id and d.discount_group = a.discount_group`

function toArticle(row: SupplierArticle & { discountPercent: string }): SupplierArticle {
  const { discountPercent, ...article } = row
  return {
    ...article,
    unitCostCents: roundTo(unitCostCents(article, discountPercent), 4)
      .replace(/0+$/, '')
      .replace(/\.$/, ''),
  }
}

interface ImportBatch {
  articles: DatanormArticle[]
  extras: DatanormArticleExtra[]
  texts: DatanormText[]
  prices: DatanormPrice[]
}

async function flush(
  tx: Tx,
  tenantId: string,
  catalogId: string,
  units: Map<string, string>,
  batch: ImportBatch,
) {
  const upserts = batch.articles.filter((a) => a.action !== 'delete')
  // The last record of an article in the batch wins.
  const byNo = new Map(upserts.map((a) => [a.articleNo, a]))
  if (byNo.size) {
    const rows = [...byNo.values()].map((a) => ({
      tenant_id: tenantId,
      catalog_id: catalogId,
      article_no: a.articleNo,
      short_text: a.shortText.slice(0, 500),
      long_text_key: a.longTextKey,
      unit_raw: a.unitRaw || null,
      unit_id: a.unitSymbol ? (units.get(a.unitSymbol) ?? null) : null,
      price_kind: a.priceKind,
      price_cents: a.priceCents,
      price_unit: a.priceUnit,
      discount_group: a.discountGroup,
      product_group: a.productGroup,
    }))
    await tx`
      insert into supplier_article ${tx(rows)}
      on conflict (catalog_id, article_no) do update set
        short_text = excluded.short_text, long_text_key = excluded.long_text_key, unit_raw = excluded.unit_raw,
        unit_id = excluded.unit_id, price_kind = excluded.price_kind, price_cents = excluded.price_cents,
        price_unit = excluded.price_unit, discount_group = excluded.discount_group,
        product_group = excluded.product_group, updated_at = now()`
  }
  const deletes = batch.articles.filter((a) => a.action === 'delete').map((a) => a.articleNo)
  if (deletes.length) {
    await tx`delete from supplier_article where catalog_id = ${catalogId} and article_no = any(${deletes}::text[])`
  }
  const extras = batch.extras.filter((e) => e.action !== 'delete')
  if (extras.length) {
    await tx`
      update supplier_article a set matchcode = v.matchcode, ean = v.ean
      from unnest(${extras.map((e) => e.articleNo)}::text[], ${extras.map((e) => e.matchcode ?? '')}::text[],
                  ${extras.map((e) => e.ean ?? '')}::text[]) as v(article_no, matchcode, ean)
      where a.catalog_id = ${catalogId} and a.article_no = v.article_no`
  }
  if (batch.texts.length) {
    const unique = new Map(batch.texts.map((t) => [`${t.key}\u0000${t.line}`, t]))
    await tx`
      insert into supplier_text ${tx(
        [...unique.values()].map((t) => ({
          tenant_id: tenantId,
          catalog_id: catalogId,
          text_key: t.key,
          line_no: t.line,
          text: t.text,
        })),
      )}
      on conflict (catalog_id, text_key, line_no) do update set text = excluded.text`
  }
  if (batch.prices.length) {
    await tx`
      update supplier_article a set price_kind = v.kind, price_cents = v.cents::numeric, updated_at = now()
      from unnest(${batch.prices.map((p) => p.articleNo)}::text[], ${batch.prices.map((p) => p.priceKind)}::text[],
                  ${batch.prices.map((p) => p.priceCents)}::text[]) as v(article_no, kind, cents)
      where a.catalog_id = ${catalogId} and a.article_no = v.article_no`
  }
  batch.articles = []
  batch.extras = []
  batch.texts = []
  batch.prices = []
}

const BATCH = 500

// ---- Routes ------------------------------------------------------------------------------------

export function registerCatalogRoutes(app: FastifyInstance, services: Services) {
  // Folders
  app.get('/api/v1/catalog/folders', async (request): Promise<CatalogFolder[]> => {
    const auth = requirePermission(request, 'catalog.read')
    return inTenant(
      services,
      auth,
      (tx) => tx<CatalogFolder[]>`
        select f.id, f.kind, f.name, f.parent_id as "parentId",
               (select count(*)::int from catalog_item i where i.folder_id = f.id and i.archived_at is null) as "itemCount"
        from catalog_folder f order by f.kind, f.sort, lower(f.name)`,
    )
  })

  app.post('/api/v1/catalog/folders', async (request, reply) => {
    const auth = requirePermission(request, 'catalog.write')
    const input = parse(catalogFolderRequest, request.body)
    const folder = await inTenant(services, auth, async (tx) => {
      const [row] = await tx<CatalogFolder[]>`
        insert into catalog_folder (tenant_id, kind, name, parent_id, sort)
        values (${auth.tenantId}, ${input.kind}, ${input.name}, ${input.parentId ?? null},
                (select coalesce(max(sort), 0) + 10 from catalog_folder where kind = ${input.kind}))
        returning id, kind, name, parent_id as "parentId", 0 as "itemCount"`.catch(
        (error: { code?: string }) => {
          if (error.code === '23505')
            throw invalid({ name: 'Einen Ordner mit diesem Namen gibt es bereits.' })
          if (error.code === '23503') throw invalid({ parentId: 'Unbekannter Ordner.' })
          throw error
        },
      )
      return row
    })
    return reply.status(201).send(folder)
  })

  app.delete('/api/v1/catalog/folders/:id', async (request, reply) => {
    const auth = requirePermission(request, 'catalog.write')
    const { id } = parse(idParam, request.params)
    await inTenant(services, auth, async (tx) => {
      const [used] = await tx<{ n: number }[]>`
        select count(*)::int as n from catalog_item where folder_id = ${id} and archived_at is null`
      if (used?.n) throw new HttpError(409, 'Der Ordner enthält noch Einträge.')
      const deleted = await tx`delete from catalog_folder where id = ${id}`
      if (!deleted.count) throw notFound('Der Ordner')
    })
    return reply.status(204).send()
  })

  // Items (Leistungen, Materialien)
  app.get('/api/v1/catalog/items', async (request) => {
    const auth = requirePermission(request, 'catalog.read')
    const query = parse(catalogListQuery, request.query)
    const search = query.q ? `%${query.q.toLowerCase().replace(/[%_\\]/g, '\\$&')}%` : null
    return inTenant(services, auth, async (tx) => {
      const rows = await tx<{ id: string }[]>`
        select i.id from catalog_item i
        where i.kind = ${query.kind} and i.archived_at is null
          and (${query.folderId ?? null}::uuid is null or i.folder_id = ${query.folderId ?? null})
          and (${search}::text is null or lower(i.short_text) like ${search}
               or lower(coalesce(i.article_no, '')) like ${search} or lower(coalesce(i.long_text, '')) like ${search})
        order by lower(i.short_text), i.id
        limit ${query.limit} offset ${query.offset}`
      const items: CatalogItem[] = []
      for (const row of rows) items.push((await loadItem(tx, row.id)) as CatalogItem)
      return items
    })
  })

  app.get('/api/v1/catalog/items/:id', async (request) => {
    const auth = requirePermission(request, 'catalog.read')
    const { id } = parse(idParam, request.params)
    const item = await inTenant(services, auth, (tx) => loadItem(tx, id))
    if (!item) throw notFound('Der Eintrag')
    return item
  })

  app.post('/api/v1/catalog/items', async (request, reply) => {
    const auth = requirePermission(request, 'catalog.write')
    const input = parse(createCatalogItemRequest, request.body)
    const item = await inTenant(services, auth, async (tx) =>
      loadItem(tx, await saveItem(tx, auth, input.kind, input)),
    )
    return reply.status(201).send(item)
  })

  app.patch('/api/v1/catalog/items/:id', async (request) => {
    const auth = requirePermission(request, 'catalog.write')
    const { id } = parse(idParam, request.params)
    const input = parse(updateCatalogItemRequest, request.body)
    return inTenant(services, auth, async (tx) => {
      const [current] = await tx<{ kind: 'service' | 'material' }[]>`
        select kind from catalog_item where id = ${id} and archived_at is null for update`
      if (!current) throw notFound('Der Eintrag')
      return loadItem(tx, await saveItem(tx, auth, current.kind, input, id))
    })
  })

  app.delete('/api/v1/catalog/items/:id', async (request, reply) => {
    const auth = requirePermission(request, 'catalog.write')
    const { id } = parse(idParam, request.params)
    await inTenant(services, auth, async (tx) => {
      // Positions keep their copied texts and prices; the link is cleared (ON DELETE SET NULL).
      const deleted = await tx`delete from catalog_item where id = ${id}`
      if (!deleted.count) throw notFound('Der Eintrag')
    })
    return reply.status(204).send()
  })

  // ---- Supplier catalogs (DATANORM) ----

  app.get('/api/v1/supplier-catalogs', async (request): Promise<SupplierCatalog[]> => {
    const auth = requirePermission(request, 'catalog.read')
    return inTenant(services, auth, async (tx) => {
      const ids = await tx<{ id: string }[]>`select id from supplier_catalog order by lower(name)`
      const result: SupplierCatalog[] = []
      for (const { id } of ids) result.push((await loadCatalog(tx, id)) as SupplierCatalog)
      return result
    })
  })

  /** Import a DATANORM file (raw body, streamed): new catalog or update of an existing one. */
  app.post('/api/v1/supplier-catalogs/import', async (request, reply) => {
    const auth = requirePermission(request, 'catalog.write')
    const body = request.body
    const drain = () => {
      if (body instanceof Readable) body.resume()
    }
    try {
      const query = parse(importCatalogQuery, request.query)
      if (!(body instanceof Readable)) {
        throw new HttpError(415, 'Bitte die DATANORM-Datei als application/octet-stream senden.')
      }
      const maxBytes = services.config.UPLOAD_MAX_MB * 1024 * 1024
      if (Number(request.headers['content-length'] ?? 0) > maxBytes) {
        throw new HttpError(
          413,
          `Die Datei ist zu groß (höchstens ${services.config.UPLOAD_MAX_MB} MB).`,
        )
      }
      const baseName = query.filename.replace(/\.[^.]+$/, '')
      const result = await inTenant(services, auth, async (tx): Promise<ImportResult> => {
        let catalogId = query.catalogId
        if (catalogId) {
          const found = await tx`select 1 from supplier_catalog where id = ${catalogId} for update`
          if (!found.length) throw notFound('Der Katalog')
        } else {
          const name = query.name ?? baseName
          const [created] = await tx<{ id: string }[]>`
            insert into supplier_catalog (tenant_id, name, created_by)
            values (${auth.tenantId}, ${name.slice(0, 200)}, ${auth.userId}) returning id`
          catalogId = (created as { id: string }).id
        }
        const units = new Map(
          (
            await tx<{ symbol: string; id: string }[]>`select symbol, id from unit where is_active`
          ).map((u) => [u.symbol, u.id]),
        )
        const stats = {
          lines: 0,
          articles: 0,
          deleted: 0,
          prices: 0,
          texts: 0,
          skipped: 0,
          encoding: '',
          unknownUnits: [] as string[],
          discounts: 0,
          discountsWithoutValue: 0,
        }
        // Discount groups of a *.RAB file; applied after the articles (last record per group wins).
        const discounts = new Map<string, DatanormDiscount>()
        const unknown = new Set<string>()
        let header: { supplier: string | null; version: string; currency: string } | null = null
        const batch: ImportBatch = { articles: [], extras: [], texts: [], prices: [] }
        const splitter = new LineSplitter()
        let decoder: ((chunk: Buffer, last: boolean) => string) | null = null
        let size = 0

        const handle = async (lines: { text: string; line: number }[]) => {
          for (const { text, line } of lines) {
            const record = parseDatanormLine(text, line)
            stats.lines = line
            if (!record) continue
            switch (record.type) {
              case 'header':
                header = record.header
                break
              case 'article':
                batch.articles.push(record.article)
                if (record.article.action === 'delete') stats.deleted += 1
                else stats.articles += 1
                if (record.article.unitRaw && !record.article.unitSymbol)
                  unknown.add(record.article.unitRaw)
                break
              case 'extra':
                batch.extras.push(record.extra)
                break
              case 'text':
                batch.texts.push(...record.texts)
                stats.texts += record.texts.length
                break
              case 'price':
                batch.prices.push(...record.prices)
                stats.prices += record.prices.length
                break
              case 'discount':
                discounts.set(record.discount.discountGroup, record.discount)
                break
              default:
                stats.skipped += 1
            }
            if (
              batch.articles.length +
                batch.extras.length +
                batch.texts.length +
                batch.prices.length >=
              BATCH
            ) {
              await flush(tx, auth.tenantId, catalogId as string, units, batch)
            }
          }
        }

        for await (const chunk of body as AsyncIterable<Buffer>) {
          size += chunk.length
          if (size > maxBytes) {
            throw new HttpError(
              413,
              `Die Datei ist zu groß (höchstens ${services.config.UPLOAD_MAX_MB} MB).`,
            )
          }
          if (!decoder) {
            const encoding = detectEncoding(chunk)
            stats.encoding = encoding
            if (encoding === 'utf-8') {
              const utf8 = new TextDecoder('utf-8')
              decoder = (bytes, last) => utf8.decode(bytes, { stream: !last })
            } else {
              decoder = (bytes) => decodeBytes(bytes, encoding)
            }
          }
          await handle(splitter.push(decoder(chunk, false)))
        }
        if (decoder) await handle(splitter.push(decoder(Buffer.alloc(0), true)))
        await handle(splitter.end())
        if (!stats.lines) throw new HttpError(400, 'Die Datei ist leer.')
        await flush(tx, auth.tenantId, catalogId as string, units, batch)

        // Long texts: join the T records into the articles.
        await tx`
          update supplier_article a set long_text = t.text
          from (select text_key, string_agg(text, E'\n' order by line_no) as text
                from supplier_text where catalog_id = ${catalogId} group by text_key) t
          where a.catalog_id = ${catalogId} and a.long_text_key = t.text_key`
        await tx`delete from supplier_text where catalog_id = ${catalogId}`
        for (const d of discounts.values()) {
          if (d.action === 'delete') {
            await tx`delete from supplier_discount
                     where catalog_id = ${catalogId} and discount_group = ${d.discountGroup}`
            continue
          }
          // 0 % or no value usually means "your own conditions": keep what the firm entered.
          if (d.kind !== 'percent' || !d.percent || Number(d.percent) === 0) {
            stats.discountsWithoutValue += 1
            continue
          }
          await tx`
            insert into supplier_discount (tenant_id, catalog_id, discount_group, percent)
            values (${auth.tenantId}, ${catalogId}, ${d.discountGroup}, ${d.percent})
            on conflict (catalog_id, discount_group) do update set percent = excluded.percent`
          stats.discounts += 1
        }
        const h = header as { supplier: string | null; version: string; currency: string } | null
        // Files are often just called DATANORM.001: then the supplier from the header names it.
        if (!query.catalogId && !query.name && h?.supplier && /^datanorm$/i.test(baseName)) {
          await tx`update supplier_catalog set name = ${h.supplier.slice(0, 200)}
                   where id = ${catalogId}`
        }
        await tx`
          update supplier_catalog set
            article_count = (select count(*)::int from supplier_article where catalog_id = ${catalogId}),
            imported_at = now(),
            supplier = coalesce(${h?.supplier ?? null}, supplier),
            version = coalesce(${h?.version || null}, version),
            currency = coalesce(${h?.currency ?? null}, currency)
          where id = ${catalogId}`
        stats.unknownUnits = [...unknown].slice(0, 20)
        if (!query.catalogId && stats.articles === 0) {
          throw new HttpError(
            400,
            discounts.size || stats.skipped
              ? 'Die Datei enthält keine Artikel. Rabatt- und Warengruppendateien (z. B. *.RAB, *.WRG) bitte in einen vorhandenen Katalog importieren.'
              : 'Die Datei enthält keine Artikel.',
          )
        }
        return { catalog: (await loadCatalog(tx, catalogId as string)) as SupplierCatalog, stats }
      })
      return reply.status(201).send(result)
    } catch (error) {
      drain()
      if (error instanceof DatanormError) throw new HttpError(400, `DATANORM: ${error.message}`)
      throw error
    }
  })

  app.patch('/api/v1/supplier-catalogs/:id', async (request) => {
    const auth = requirePermission(request, 'catalog.write')
    const { id } = parse(idParam, request.params)
    const input = parse(updateSupplierCatalogRequest, request.body)
    return inTenant(services, auth, async (tx) => {
      const columns: Record<string, unknown> = {}
      if (input.name !== undefined) columns.name = input.name
      if (input.discountPercent !== undefined) columns.discount_percent = input.discountPercent
      if (Object.keys(columns).length) {
        const updated = await tx`update supplier_catalog set ${tx(columns)} where id = ${id}`
        if (!updated.count) throw notFound('Der Katalog')
      }
      if (input.discounts) {
        await tx`delete from supplier_discount where catalog_id = ${id}`
        for (const d of input.discounts) {
          await tx`insert into supplier_discount (tenant_id, catalog_id, discount_group, percent)
                   values (${auth.tenantId}, ${id}, ${d.discountGroup}, ${d.percent})`
        }
      }
      const catalog = await loadCatalog(tx, id)
      if (!catalog) throw notFound('Der Katalog')
      return catalog
    })
  })

  app.delete('/api/v1/supplier-catalogs/:id', async (request, reply) => {
    const auth = requirePermission(request, 'catalog.write')
    const { id } = parse(idParam, request.params)
    await inTenant(services, auth, async (tx) => {
      const deleted = await tx`delete from supplier_catalog where id = ${id}`
      if (!deleted.count) throw notFound('Der Katalog')
    })
    return reply.status(204).send()
  })

  app.get('/api/v1/supplier-articles', async (request): Promise<SupplierArticle[]> => {
    const auth = requirePermission(request, 'catalog.read')
    const query = parse(supplierArticleQuery, request.query)
    const rows = await inTenant(services, auth, (tx) => {
      const like = `%${query.q.toLowerCase().replace(/[%_\\]/g, '\\$&')}%`
      return tx<(SupplierArticle & { discountPercent: string })[]>`
        select ${ARTICLE_COLUMNS(tx)} from ${fromArticles(tx)}
        where (${query.catalogId ?? null}::uuid is null or a.catalog_id = ${query.catalogId ?? null})
          and (a.search @@ plainto_tsquery('german', ${query.q})
               or a.article_no = ${query.q} or a.ean = ${query.q} or lower(a.short_text) like ${like})
        order by (a.article_no = ${query.q}) desc, ts_rank(a.search, plainto_tsquery('german', ${query.q})) desc,
                 a.short_text
        limit ${query.limit}`
    })
    return rows.map(toArticle)
  })

  /** „In Stammdaten übernehmen“: material with EK after discount and the company markup. */
  app.post('/api/v1/catalog/items/from-supplier', async (request, reply) => {
    const auth = requirePermission(request, 'catalog.write')
    const input = parse(takeOverArticleRequest, request.body)
    const item = await inTenant(services, auth, async (tx) => {
      const [row] = await tx<
        (SupplierArticle & { discountPercent: string; supplier: string | null })[]
      >`
        select ${ARTICLE_COLUMNS(tx)}, coalesce(c.supplier, c.name) as supplier
        from ${fromArticles(tx)} where a.id = ${input.supplierArticleId}`
      if (!row) throw notFound('Der Artikel')
      const article = toArticle(row)
      const unitId = input.unitId ?? article.unit?.id
      if (!unitId) {
        throw invalid({
          unitId: `Die Einheit „${article.unitRaw ?? ''}“ ist unbekannt. Bitte eine Einheit wählen.`,
        })
      }
      const id = await saveItem(tx, auth, 'material', {
        folderId: input.folderId ?? null,
        shortText: article.shortText,
        longText: article.longText,
        unitId,
        articleNo: article.articleNo,
        ean: article.ean,
        costCents: Number(toCents(toDecimal(article.unitCostCents))),
        ...(input.markupPercent ? { markupPercent: input.markupPercent } : {}),
      })
      await tx`update catalog_item set source = 'datanorm', supplier_name = ${row.supplier},
                 supplier_article_id = ${article.id} where id = ${id}`
      return loadItem(tx, id)
    })
    return reply.status(201).send(item)
  })

  /**
   * „In Stammdaten speichern“ (P2.12): a position with its Kalkulation becomes a new Leistung;
   * without Kalkulation the EP is the Verkaufspreis. A draft position is linked to the new entry.
   */
  app.post('/api/v1/documents/:id/items/:itemId/to-catalog', async (request, reply) => {
    const auth = requirePermission(request, 'catalog.write')
    if (!auth.permissions.has('document.read')) {
      throw new HttpError(403, 'Für diese Aktion fehlt die Berechtigung.')
    }
    const { id, itemId } = parse(
      z.object({ id: z.uuid('Ungültige ID.'), itemId: z.uuid('Ungültige ID.') }),
      request.params,
    )
    const input = parse(saveToCatalogRequest, request.body ?? {})
    const created = await inTenant(services, auth, async (tx) => {
      const doc = await loadDocument(tx, auth, id)
      if (!doc) throw notFound('Das Dokument')
      const item = doc.items.find((i) => i.id === itemId)
      if (!item) throw notFound('Die Position')
      if (!['item', 'alternative', 'optional', 'lump_sum'].includes(item.positionType)) {
        throw invalid({ itemId: 'Nur Positionen mit Menge und Preis lassen sich speichern.' })
      }
      if (!item.unit || !item.shortText) throw invalid({ itemId: 'Kurztext oder Einheit fehlt.' })
      // Dublettenprüfung: same Kurztext and Einheit in the Leistungen (unless confirmed).
      if (!input.allowDuplicate) {
        const [same] = await tx<{ id: string; folder: string | null }[]>`
          select i.id, f.name as folder from catalog_item i left join catalog_folder f on f.id = i.folder_id
          where i.kind = 'service' and i.archived_at is null and i.unit_id = ${item.unit.id}
            and lower(i.short_text) = lower(${item.shortText}) limit 1`
        if (same) {
          throw new HttpError(
            409,
            `Eine Leistung „${item.shortText}“ mit dieser Einheit gibt es schon${same.folder ? ` (Ordner „${same.folder}“)` : ''}.`,
            { duplicateId: same.id },
          )
        }
      }
      const calculated = item.costLines.length > 0
      const catalogId = await saveItem(tx, auth, 'service', {
        folderId: input.folderId ?? null,
        shortText: item.shortText,
        longText: item.longText,
        unitId: item.unit.id,
        calcMode: item.calcMode ?? 'unit_price',
        ...(calculated
          ? {
              components: item.costLines.map((l) => ({
                kind: l.kind,
                description: l.description,
                quantity: l.quantity,
                unitId: l.unit?.id ?? null,
                unitCostCents: l.unitCostCents,
                markupPercent: l.markupPercent,
                wageGroupId: l.wageGroupId,
              })),
            }
          : { priceCents: item.unitPriceCents ?? 0 }),
      })
      if (doc.status === 'draft') {
        await tx`update document_item set catalog_item_id = ${catalogId} where id = ${itemId}`
      }
      return loadItem(tx, catalogId)
    })
    return reply.status(201).send(created)
  })

  /** Position from Stammdaten or a catalog article, with its Kalkulation (Kostenzeilen). */
  app.post('/api/v1/documents/:id/items/from-catalog', async (request, reply) => {
    const auth = requirePermission(request, 'document.write')
    const { id } = parse(idParam, request.params)
    const input = parse(insertFromCatalogRequest, request.body)
    const doc = await inTenant(services, auth, async (tx) => {
      await lockDraft(tx, auth, id)
      if (input.parentId) {
        const [parent] = await tx<{ type: string }[]>`
          select position_type as type from document_item where id = ${input.parentId} and document_id = ${id}`
        if (parent?.type !== 'title') throw invalid({ parentId: 'Unbekannter Titel.' })
      }
      const defaults = await surcharges(tx)
      let source: {
        shortText: string
        longText: string | null
        unitId: string
        catalogItemId: string | null
        unitPriceCents: bigint
        calcMode: 'unit_price' | 'total_price'
        lines: ComponentRow[]
      }
      if (input.catalogItemId) {
        const item = await loadItem(tx, input.catalogItemId)
        if (!item) throw notFound('Der Eintrag')
        source = {
          shortText: item.shortText,
          longText: item.longText,
          unitId: item.unit.id,
          catalogItemId: item.id,
          unitPriceCents: BigInt(item.priceCents),
          calcMode: item.calcMode,
          lines: item.components.length
            ? item.components.map((c) => ({
                kind: c.kind,
                description: c.description,
                quantity: c.quantity,
                unitId: c.unit?.id ?? null,
                unitSymbol: c.unit?.symbol ?? null,
                unitCostCents: c.unitCostCents,
                markupPercent: c.markupPercent,
                wageGroupId: c.wageGroupId,
              }))
            : item.costCents > 0
              ? [
                  {
                    kind: item.kind === 'material' ? 'material' : 'other',
                    description: item.articleNo ? `Art.-Nr. ${item.articleNo}` : null,
                    quantity: '1',
                    unitId: null,
                    unitSymbol: null,
                    unitCostCents: item.costCents,
                    markupPercent: item.markupPercent,
                  },
                ]
              : [],
        }
      } else {
        const [row] = await tx<(SupplierArticle & { discountPercent: string })[]>`
          select ${ARTICLE_COLUMNS(tx)} from ${fromArticles(tx)} where a.id = ${input.supplierArticleId as string}`
        if (!row) throw notFound('Der Artikel')
        const article = toArticle(row)
        if (!article.unit) {
          throw invalid({
            supplierArticleId: `Die Einheit „${article.unitRaw ?? ''}“ ist unbekannt. Bitte den Artikel zuerst in die Stammdaten übernehmen.`,
          })
        }
        source = {
          shortText: article.shortText,
          longText: article.longText,
          unitId: article.unit.id,
          catalogItemId: null,
          unitPriceCents: 0n,
          calcMode: 'unit_price',
          lines: [
            {
              kind: 'material',
              description: `${article.catalogName} ${article.articleNo}`,
              quantity: '1',
              unitId: null,
              unitSymbol: null,
              unitCostCents: Number(toCents(toDecimal(article.unitCostCents))),
              markupPercent: defaults.get('material') ?? '0',
            },
          ],
        }
      }
      const unit = await unitSnapshot(tx, source.unitId)
      const quantity = input.quantity ?? '1'
      checkQuantityDecimals(quantity, unit)
      const [rate] = await tx<{ percent: string }[]>`
        select trim_scale(percent)::text as percent from tax_rate where is_default limit 1`
      const [{ sort } = { sort: 10 }] = await tx<{ sort: number }[]>`
        select (coalesce(max(sort), 0) + 10)::int as sort from document_item
        where document_id = ${id} and parent_id is not distinct from ${input.parentId ?? null}::uuid`
      const [created] = await tx<{ id: string }[]>`
        insert into document_item ${tx({
          tenant_id: auth.tenantId,
          document_id: id,
          parent_id: input.parentId ?? null,
          sort,
          position_type: 'item',
          short_text: source.shortText,
          long_text: source.longText,
          quantity,
          unit_id: source.unitId,
          unit_symbol: unit.symbol,
          unit_unece_code: unit.unece,
          unit_price_cents: source.unitPriceCents.toString(),
          tax_rate_percent: rate?.percent ?? '19',
          calc_mode: source.calcMode,
          catalog_item_id: source.catalogItemId,
        })} returning id`
      const itemId = (created as { id: string }).id
      for (const [index, line] of source.lines.entries()) {
        await tx`
          insert into item_calc_component ${tx({
            tenant_id: auth.tenantId,
            document_id: id,
            document_item_id: itemId,
            sort: (index + 1) * 10,
            cost_kind: line.kind,
            description: line.description,
            quantity: line.quantity,
            unit_id: line.unitId,
            unit_cost_cents: String(line.unitCostCents),
            markup_percent: line.markupPercent ?? defaults.get(line.kind) ?? '0',
            wage_group_id: line.wageGroupId ?? null,
          })}`
      }
      await recalculate(tx, id)
      return loadDocument(tx, auth, id)
    })
    return sendDocument(reply, doc, 201)
  })
}
