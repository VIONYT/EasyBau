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
] as const

export type EditablePositionType = (typeof EDITABLE_POSITION_TYPES)[number]
export const PRICED_POSITION_TYPES: readonly EditablePositionType[] = [
  'item',
  'alternative',
  'optional',
  'lump_sum',
]
