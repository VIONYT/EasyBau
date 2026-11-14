// Plain constants without zod, importable by the web app without bundling the validators.

/** File extensions accepted by the upload (the server also checks the content). */
export const UPLOAD_EXTENSIONS = [
  'pdf',
  'jpg',
  'jpeg',
  'png',
  'gif',
  'webp',
  'heic',
  'heif',
  'mp4',
  'm4v',
  'mov',
  'docx',
  'xlsx',
  'pptx',
  'odt',
  'ods',
  'zip',
  'dwg',
  'dxf',
  'txt',
  'csv',
  'xml',
  'x31',
  'x81',
  'x82',
  'x83',
  'x84',
  'x85',
  'x86',
] as const

export const DOCUMENT_TYPES = [
  'quote',
  'cost_estimate',
  'order_confirmation',
  'change_order',
  'delivery_note',
  'invoice',
  'credit_note',
] as const

/** Invoice kinds that can be created directly (cancellations come from „Stornieren“). */
export const CREATABLE_INVOICE_KINDS = ['standard', 'partial', 'progress', 'final'] as const

export const CHANGE_ORDER_BASES = [
  'changed_work',
  'additional_work',
  'quantity_variance',
  'bgb_650b',
  'other',
] as const

export const TAX_MODES = [
  'standard',
  'reverse_charge_13b',
  'small_business',
  'intra_eu',
  'export',
] as const

export const EDITABLE_POSITION_TYPES = [
  'title',
  'item',
  'alternative',
  'optional',
  'lump_sum',
  'text',
  'image',
] as const

export type EditablePositionType = (typeof EDITABLE_POSITION_TYPES)[number]
export const PRICED_POSITION_TYPES: readonly EditablePositionType[] = [
  'item',
  'alternative',
  'optional',
  'lump_sum',
]

/** Angebotsaufmaß (before the quote) and Leistungsaufmaß (work done, basis for invoices). */
export const MEASUREMENT_KINDS = ['survey', 'performance'] as const

/** Weather conditions in the daily site report (Bautagesbericht). */
export const WEATHER_CONDITIONS = [
  'sunny',
  'partly_cloudy',
  'overcast',
  'rain',
  'heavy_rain',
  'snow',
  'frost',
  'storm',
  'fog',
] as const

/** Section types of report templates this version can fill in. */
export const SUPPORTED_SECTION_TYPES = [
  'header',
  'weather',
  'staff',
  'services',
  'materials',
  'equipment',
  'text',
  'photos',
  'signatures',
  'yes_no',
  'deadline',
] as const

export const SIGNER_ROLES = ['contractor', 'client', 'other'] as const

/** Kostenarten der Kalkulation: Lohn, Material, Gerät, Fremdleistung, Sonstiges. */
export const COST_KINDS = ['labor', 'material', 'equipment', 'subcontract', 'other'] as const

/** Stammdaten: Leistungen (service) and Materialien (material). */
export const CATALOG_KINDS = ['service', 'material'] as const

/** Eingangsrechnungen (P1.11). */
export const INCOMING_STATUSES = ['review', 'confirmed', 'discarded', 'cancelled'] as const
export const INCOMING_SOURCES = [
  'pdf',
  'image',
  'zugferd',
  'xrechnung_cii',
  'xrechnung_ubl',
] as const
/** Kostenart of an allocation (same keys as the calculation's cost kinds). */
export const COST_TYPES = ['material', 'labor', 'equipment', 'subcontract', 'other'] as const
/** Received invoices: PDF (also ZUGFeRD), XRechnung XML, photos/scans. */
export const INCOMING_UPLOAD_EXTENSIONS = ['pdf', 'xml', 'jpg', 'jpeg', 'png'] as const

/** Bundesländer (ISO 3166-2:DE suffix); they select the statutory holidays. */
export const FEDERAL_STATES = [
  'BW',
  'BY',
  'BE',
  'BB',
  'HB',
  'HH',
  'HE',
  'MV',
  'NI',
  'NW',
  'RP',
  'SL',
  'SN',
  'ST',
  'SH',
  'TH',
] as const
export type FederalStateCode = (typeof FEDERAL_STATES)[number]

/** Placeholders of the Dateinamen-Muster (packages/domain file-names.ts). */
export const FILE_NAME_PLACEHOLDERS = [
  'Typ',
  'Nummer',
  'Kunde',
  'Projekt',
  'Datum',
  'Jahr',
] as const
