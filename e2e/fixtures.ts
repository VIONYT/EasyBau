import { expect, type Page } from '@playwright/test'

/**
 * Own test data per E2E file (C.11): customers, projects and contract documents created through
 * the API, so a file does not depend on what another file left behind. Only the company setup
 * and the admin session (01-einrichtung) are shared. Names carry the file they belong to.
 */

type Json = Record<string, unknown>

async function call<T = Json>(
  page: Page,
  method: 'get' | 'post' | 'patch',
  path: string,
  data?: unknown,
  headers: Record<string, string> = {},
): Promise<{ body: T; etag: string | null }> {
  const res = await page.request.fetch(path, {
    method,
    headers,
    ...(data === undefined ? {} : { data }),
  })
  const text = await res.text()
  expect(res.ok(), `${method.toUpperCase()} ${path}: ${res.status()} ${text}`).toBeTruthy()
  return { body: (text ? JSON.parse(text) : null) as T, etag: res.headers().etag ?? null }
}

/**
 * A customer (organisation), by default with a complete address so invoices to it can be
 * finalized; `withAddress: false` leaves the address for the test to fill in.
 */
export async function createCustomer(
  page: Page,
  name: string,
  { withAddress = true } = {},
): Promise<string> {
  const { body } = await call<{ id: string }>(page, 'post', '/api/v1/contacts', {
    kind: 'organization',
    organizationName: name,
    ...(withAddress
      ? {
          addresses: [
            { kind: 'main', street: 'Am Prüfstand 7', postalCode: '30159', city: 'Hannover' },
          ],
        }
      : {}),
  })
  return body.id
}

/** A project of the customer, running from the start of the current month. */
export async function createProject(page: Page, name: string, customerId: string | null) {
  const start = new Date()
  start.setDate(1)
  const { body } = await call<{ id: string; number: string }>(page, 'post', '/api/v1/projects', {
    name,
    customerId,
    startDate: start.toISOString().slice(0, 10),
    site: { street: 'Am Prüfstand 7', postalCode: '30159', city: 'Hannover' },
  })
  return body
}

export interface ContractItem {
  shortText: string
  quantity: string
  unitPriceCents: number
  /** Minutes of labour per unit at 54 €/Std (gives Soll-Stunden). */
  laborMinutes?: number
}

/**
 * Finalized Auftragsbestätigung (Hauptauftrag) with priced positions; the positions with
 * `laborMinutes` get a labour calculation, so the project has Soll-Stunden.
 */
export async function createOrderConfirmation(
  page: Page,
  projectId: string,
  customerId: string,
  items: ContractItem[],
): Promise<{ id: string; number: string }> {
  const units = (await call<{ id: string; symbol: string }[]>(page, 'get', '/api/v1/units')).body
  const m2 = units.find((u) => u.symbol === 'm²')?.id as string
  const minutes = units.find((u) => u.symbol === 'min')?.id
  const doc = await call<{ id: string }>(page, 'post', `/api/v1/projects/${projectId}/documents`, {
    type: 'order_confirmation',
    subject: 'Hauptauftrag',
  })
  const id = doc.body.id
  for (const item of items) {
    const created = await call<{ items?: { id: string; shortText: string }[] }>(
      page,
      'post',
      `/api/v1/documents/${id}/items`,
      {
        positionType: 'item',
        shortText: item.shortText,
        quantity: item.quantity,
        unitId: m2,
        unitPriceCents: item.unitPriceCents,
      },
    )
    const itemId = created.body.items?.find((i) => i.shortText === item.shortText)?.id
    if (item.laborMinutes && itemId) {
      await call(page, 'post', `/api/v1/documents/${id}/items/${itemId}/calculation`, {
        lines: [
          {
            kind: 'labor',
            quantity: String(item.laborMinutes),
            unitId: minutes ?? null,
            unitCostCents: 5400,
          },
        ],
      })
    }
  }
  const current = await call(page, 'get', `/api/v1/documents/${id}`)
  await call(
    page,
    'patch',
    `/api/v1/documents/${id}`,
    { contactId: customerId },
    {
      'if-match': current.etag ?? '',
    },
  )
  const done = await call<{ number: string }>(page, 'post', `/api/v1/documents/${id}/finalize`, {
    acknowledgeWarnings: true,
  })
  return { id, number: done.body.number }
}

/** Bautagesbericht of the project with a text in „Besondere Vorkommnisse“. */
export async function createDiaryReport(
  page: Page,
  projectId: string,
  reportDate: string,
  incident: string,
): Promise<string> {
  const id = crypto.randomUUID()
  await call(page, 'post', `/api/v1/projects/${projectId}/reports`, {
    id,
    templateKey: 'daily_site_report',
    reportDate,
  })
  const current = await call(page, 'get', `/api/v1/reports/${id}`)
  await call(
    page,
    'patch',
    `/api/v1/reports/${id}`,
    { data: { incidents: { text: incident } } },
    {
      'if-match': current.etag ?? '',
    },
  )
  return id
}

/** Leistungsaufmaß of the project with one line (for PDFs and lists). */
export async function createMeasurementSheet(page: Page, projectId: string): Promise<string> {
  const id = crypto.randomUUID()
  await call(page, 'post', `/api/v1/projects/${projectId}/measurement-sheets`, {
    id,
    kind: 'performance',
  })
  await call(page, 'post', `/api/v1/measurement-sheets/${id}/lines`, {
    id: crypto.randomUUID(),
    description: 'Wand Nord',
    formula: '4,2*2,5',
  })
  return id
}

/** Company address and tax number (needed for invoices and the letter footer); idempotent. */
export async function setCompanyAddress(page: Page): Promise<void> {
  await call(page, 'patch', '/api/v1/settings/company', {
    street: 'Werkstraße 2',
    postalCode: '30169',
    city: 'Hannover',
    taxNumber: '25/123/45678',
    email: 'buero@muster-bau.example',
    phone: '0511 123456',
    iban: 'DE89370400440532013000',
  })
}
