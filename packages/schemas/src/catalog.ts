import { z } from 'zod'
import { id, optionalText, text } from './common.js'
import { CATALOG_KINDS, COST_KINDS } from './constants.js'
import { type CostKind, decimalText, type UnitRef } from './documents.js'

export type CatalogKind = (typeof CATALOG_KINDS)[number]

const cents = z.number().int('Betrag in Cent (ganze Zahl) erwartet.').min(0).max(100_000_000_000)
const percent = decimalText('Zuschlag', 4, 4)

export const catalogFolderRequest = z.object({
  kind: z.enum(CATALOG_KINDS),
  name: text(100),
  parentId: id.nullish(),
})

export interface CatalogFolder {
  id: string
  kind: CatalogKind
  name: string
  parentId: string | null
  itemCount: number
}

const componentInput = z.object({
  kind: z.enum(COST_KINDS),
  description: optionalText(300),
  quantity: decimalText('Menge', 10, 4),
  unitId: id.nullish(),
  /** Cost per unit; labor in min/Std: hourly rate (Stundensatz). */
  unitCostCents: cents,
  markupPercent: percent.nullish(),
})

const itemFields = {
  folderId: id.nullish(),
  shortText: text(500),
  longText: optionalText(20_000),
  unitId: id,
  articleNo: optionalText(100),
  manufacturer: optionalText(200),
  ean: optionalText(20),
  /** Einkaufspreis (EK) per unit; materials. */
  costCents: cents.optional(),
  /** Zuschlag in percent; omitted: company default for the cost kind. */
  markupPercent: percent.nullish(),
  /** Verkaufspreis (VK) set directly; otherwise EK × (1 + Zuschlag) or from the Kalkulation. */
  priceCents: cents.nullish(),
  packSize: decimalText('Gebindeinhalt', 10, 4).nullish(),
  calcMode: z.enum(['unit_price', 'total_price']).default('unit_price'),
  /** Leistungen: Bestandteile (Lohn, Material, …) like the Kalkulation of a position. */
  components: z.array(componentInput).max(50).optional(),
}

export const createCatalogItemRequest = z.object({ kind: z.enum(CATALOG_KINDS), ...itemFields })
export type CreateCatalogItemRequest = z.infer<typeof createCatalogItemRequest>
export const updateCatalogItemRequest = z.object(itemFields).partial()
export type UpdateCatalogItemRequest = z.infer<typeof updateCatalogItemRequest>

export const catalogListQuery = z.object({
  kind: z.enum(CATALOG_KINDS),
  folderId: id.optional(),
  q: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
})

export interface CatalogComponent {
  id: string
  kind: CostKind
  description: string | null
  quantity: string
  unit: UnitRef | null
  unitCostCents: number
  markupPercent: string | null
}

export interface CatalogItem {
  id: string
  kind: CatalogKind
  folderId: string | null
  articleNo: string | null
  manufacturer: string | null
  ean: string | null
  shortText: string
  longText: string | null
  unit: UnitRef
  costCents: number
  markupPercent: string
  priceCents: number
  packSize: string | null
  calcMode: 'unit_price' | 'total_price'
  source: 'manual' | 'import' | 'datanorm'
  supplierName: string | null
  components: CatalogComponent[]
  /** Planned labor hours per unit (Leistungen with Kalkulation). */
  laborHours: string | null
  updatedAt: string
}

// ---- Supplier catalogs (DATANORM) ------------------------------------------------------------------

export const importCatalogQuery = z.object({
  filename: z.string().trim().min(1).max(500),
  /** Name for a new catalog; ignored when updating. */
  name: optionalText(200),
  /** Update an existing catalog (DATANORM update files with N/A/L records). */
  catalogId: id.optional(),
})

export const updateSupplierCatalogRequest = z
  .object({
    name: text(200),
    discountPercent: decimalText('Rabatt', 2, 4),
    discounts: z
      .array(z.object({ discountGroup: text(50), percent: decimalText('Rabatt', 2, 4) }))
      .max(500),
  })
  .partial()

export interface SupplierCatalog {
  id: string
  name: string
  supplier: string | null
  version: string | null
  discountPercent: string
  discounts: { discountGroup: string; percent: string }[]
  articleCount: number
  importedAt: string | null
}

export interface ImportResult {
  catalog: SupplierCatalog
  stats: {
    lines: number
    articles: number
    deleted: number
    prices: number
    texts: number
    skipped: number
    encoding: string
    /** Units of the file without a matching system unit (first 20). */
    unknownUnits: string[]
  }
}

export const supplierArticleQuery = z.object({
  q: z.string().trim().min(2, 'Bitte mindestens 2 Zeichen eingeben.').max(200),
  catalogId: id.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
})

export interface SupplierArticle {
  id: string
  catalogId: string
  catalogName: string
  articleNo: string
  shortText: string
  longText: string | null
  unitRaw: string | null
  unit: UnitRef | null
  priceKind: 'list' | 'net'
  /** Price as listed for `priceUnit` units (cents, may contain fractions). */
  priceCents: string
  priceUnit: number
  /** Einkaufspreis for one unit after discount (cents, 4 decimals). */
  unitCostCents: string
  discountGroup: string | null
  ean: string | null
}

export const takeOverArticleRequest = z.object({
  supplierArticleId: id,
  folderId: id.nullish(),
  markupPercent: percent.nullish(),
  /** Required when the article's unit has no matching system unit. */
  unitId: id.nullish(),
})

/** Position from Stammdaten or a supplier article, with its Kalkulation. */
export const insertFromCatalogRequest = z
  .object({
    catalogItemId: id.optional(),
    supplierArticleId: id.optional(),
    parentId: id.nullish(),
    quantity: decimalText('Menge', 14, 3).optional(),
  })
  .refine(
    (v) => Boolean(v.catalogItemId) !== Boolean(v.supplierArticleId),
    'Bitte genau einen Eintrag aus Stammdaten oder Katalog wählen.',
  )

// ---- Stammdaten als CSV (P2.12) -------------------------------------------------------------------

/** Columns of the Stammdaten CSV (export and import, German headers). */
export const CATALOG_CSV_COLUMNS = [
  'Art',
  'Ordner',
  'Artikelnummer',
  'Hersteller',
  'EAN',
  'Kurztext',
  'Langtext',
  'Einheit',
  'EK',
  'Zuschlag %',
  'VK',
  'Gebindeinhalt',
] as const

export const catalogExportQuery = z.object({ kind: z.enum(CATALOG_KINDS).optional() })

export const importCatalogCsvRequest = z.object({
  csv: z
    .string()
    .min(1, 'Die Datei ist leer.')
    .max(10_000_000, 'Die Datei ist zu groß (max. 10 MB).'),
  dryRun: z.boolean().default(true),
  /** Kind for rows without „Art“. */
  kind: z.enum(CATALOG_KINDS).default('material'),
  /** Same Artikelnummer (or Kurztext + Einheit): update texts and prices instead of skipping. */
  updateExisting: z.boolean().default(false),
})

export interface CatalogImportRow {
  /** Line in the file (header = 1). */
  line: number
  name: string
  action: 'create' | 'update' | 'skip' | 'error'
  message: string | null
}

export interface CatalogImportResult {
  dryRun: boolean
  created: number
  updated: number
  skipped: number
  errors: number
  /** Folders that are (or would be) created. */
  newFolders: string[]
  rows: CatalogImportRow[]
}
