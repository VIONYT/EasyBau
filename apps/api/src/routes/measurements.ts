import type { Tx } from '@opc/db'
import {
  FormulaError,
  type FormulaVariables,
  measurementLineQuantity,
  quantityVariance,
  sumQuantities,
} from '@opc/domain'
import {
  type CreateLineRequest,
  createLineRequest,
  createSheetRequest,
  type ItemQuantitySummary,
  locationRequest,
  type MeasurableItem,
  type MeasurementKind,
  type MeasurementLine,
  type MeasurementLocation,
  type MeasurementSheetDetail,
  type MeasurementSheetSummary,
  signSheetRequest,
  updateLineRequest,
  updateLocationRequest,
  updateSheetRequest,
} from '@opc/schemas'
import type { FastifyInstance, FastifyReply } from 'fastify'
import { z } from 'zod'
import {
  type AuthContext,
  inTenant,
  projectVisibility,
  requireAuth,
  requirePermission,
  requireVisibleProject,
  type Services,
} from '../context.js'
import { checkIfMatch, etagOf, HttpError, notFound, parse } from '../http.js'
import { loadDocument, lockDraft, recalculate, sendDocument } from './documents.js'

const projectParam = z.object({ id: z.uuid('Ungültige ID.') })
const sheetParam = z.object({ id: z.uuid('Ungültige ID.') })
const locationParam = z.object({ id: z.uuid('Ungültige ID.'), locationId: z.uuid('Ungültige ID.') })
const lineParam = z.object({ id: z.uuid('Ungültige ID.'), lineId: z.uuid('Ungültige ID.') })
const itemsQuery = z.object({ kind: z.enum(['survey', 'performance']).default('survey') })

const ISO = (tx: Tx, column: string) =>
  tx`to_char(${tx.unsafe(column)} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`

const invalid = (errors: Record<string, string>) =>
  new HttpError(400, 'Die Eingaben sind unvollständig oder ungültig.', errors)

const SIGNED_MESSAGE =
  'Das Aufmaß ist unterschrieben (gemeinsames Aufmaß) und kann nicht mehr geändert werden. Korrekturen bitte in einem neuen Aufmaßblatt.'

function summaryColumns(tx: Tx) {
  return tx`
    s.id, s.project_id as "projectId", s.kind, s.title, to_char(s.measured_on, 'YYYY-MM-DD') as "measuredOn",
    s.status, (select count(*)::int from measurement_line l where l.sheet_id = s.id) as "lineCount",
    case when u.id is null then null else json_build_object('id', u.id, 'displayName', u.display_name) end as "createdBy",
    ${ISO(tx, 's.updated_at')} as "updatedAt"`
}

/** Loads a sheet of a visible project; optionally locked for changes (draft only). */
async function sheetOf(
  tx: Tx,
  auth: AuthContext,
  id: string,
  options: { forUpdate?: boolean } = {},
) {
  const [sheet] = await tx<
    { id: string; projectId: string; kind: MeasurementKind; status: string; updatedAt: Date }[]
  >`
    select s.id, s.project_id as "projectId", s.kind, s.status, s.updated_at as "updatedAt"
    from measurement_sheet s join project p on p.id = s.project_id
    where s.id = ${id} and ${projectVisibility(tx, auth)}
    ${options.forUpdate ? tx`for update of s` : tx``}`
  if (!sheet) throw notFound('Das Aufmaßblatt')
  if (options.forUpdate && sheet.status === 'signed') throw new HttpError(409, SIGNED_MESSAGE)
  return sheet
}

// ---- Rooms and variables ------------------------------------------------------------------------

interface LocationRow {
  id: string
  parentId: string | null
  name: string
  variables: Record<string, string>
  sort: number
}

async function loadLocations(tx: Tx, sheetId: string): Promise<LocationRow[]> {
  return tx<LocationRow[]>`
    select id, parent_id as "parentId", name, variables, sort
    from measurement_location where sheet_id = ${sheetId}`
}

/** Tree order with path „Haus A › EG › Bad“. */
function locationTree(rows: LocationRow[]): MeasurementLocation[] {
  const children = new Map<string | null, LocationRow[]>()
  for (const row of rows) {
    const list = children.get(row.parentId) ?? []
    list.push(row)
    children.set(row.parentId, list)
  }
  const result: MeasurementLocation[] = []
  const walk = (parentId: string | null, path: string, level: number) => {
    const list = (children.get(parentId) ?? []).sort(
      (a, b) => a.sort - b.sort || a.name.localeCompare(b.name, 'de'),
    )
    for (const row of list) {
      const full = path ? `${path} › ${row.name}` : row.name
      result.push({
        id: row.id,
        parentId: row.parentId,
        name: row.name,
        variables: row.variables,
        path: full,
        level,
      })
      walk(row.id, full, level + 1)
    }
  }
  walk(null, '', 0)
  return result
}

/** Variables of a room including those of its parents (the room's own values win). */
function variablesOf(rows: LocationRow[], locationId: string | null): FormulaVariables {
  const byId = new Map(rows.map((r) => [r.id, r]))
  const chain: LocationRow[] = []
  let current = locationId ? byId.get(locationId) : undefined
  while (current && chain.length < 20) {
    chain.unshift(current)
    current = current.parentId ? byId.get(current.parentId) : undefined
  }
  return Object.assign({}, ...chain.map((r) => r.variables))
}

function quantityOf(
  input: { formula: string; variables: Record<string, string>; isDeduction: boolean },
  locationVariables: FormulaVariables,
  decimals: number,
): string {
  try {
    return measurementLineQuantity({
      formula: input.formula,
      locationVariables,
      variables: input.variables,
      isDeduction: input.isDeduction,
      decimals,
    })
  } catch (error) {
    if (error instanceof FormulaError) {
      const where = error.position === undefined ? '' : ` (Zeichen ${error.position + 1})`
      throw invalid({ formula: `${error.message}${where}` })
    }
    throw error
  }
}

/**
 * Recomputes every line of the sheet (rule 11: the server always calculates itself),
 * e.g. after room dimensions changed. A line that no longer computes rejects the change.
 */
async function recalculateSheet(tx: Tx, sheetId: string) {
  const locations = await loadLocations(tx, sheetId)
  const lines = await tx<
    {
      id: string
      locationId: string | null
      formula: string
      variables: Record<string, string>
      isDeduction: boolean
      resultQty: string
      description: string | null
      decimals: number
    }[]
  >`
    select l.id, l.location_id as "locationId", l.formula, l.variables, l.is_deduction as "isDeduction",
           l.result_qty::text as "resultQty", l.description, coalesce(u.decimals, 2)::int as decimals
    from measurement_line l left join unit u on u.id = l.unit_id where l.sheet_id = ${sheetId}`
  for (const line of lines) {
    let quantity: string
    try {
      quantity = quantityOf(line, variablesOf(locations, line.locationId), line.decimals)
    } catch (error) {
      if (error instanceof HttpError) {
        throw new HttpError(
          400,
          `Die Zeile „${line.description ?? line.formula}“ lässt sich damit nicht mehr berechnen: ${
            error.errors?.formula ?? error.message
          }`,
        )
      }
      throw error
    }
    if (Number(quantity) !== Number(line.resultQty)) {
      await tx`update measurement_line set result_qty = ${quantity} where id = ${line.id}`
    }
  }
}

// ---- LV positions -------------------------------------------------------------------------------

async function measurableItems(
  tx: Tx,
  projectId: string,
  kind: MeasurementKind,
  onlyIds?: string[],
): Promise<MeasurableItem[]> {
  return tx<MeasurableItem[]>`
    select i.id, i.oz, i.short_text as "shortText", trim_scale(i.quantity)::text as quantity,
           case when i.unit_id is null then null
                else json_build_object('id', i.unit_id, 'symbol', i.unit_symbol,
                                       'decimals', (select u.decimals from unit u where u.id = i.unit_id)) end as unit,
           json_build_object('id', d.id, 'type', d.type, 'invoiceKind', d.invoice_kind, 'progressNo', d.progress_no,
                             'number', d.number, 'status', d.status, 'changeOrderNumber', co.number) as document,
           coalesce((select trim_scale(sum(l.result_qty)) from measurement_line l
                     join measurement_sheet s on s.id = l.sheet_id
                     where l.document_item_id = i.id and s.kind = ${kind}), 0)::text as "measuredQuantity"
    from document_item i
    join document d on d.id = i.document_id
    left join change_order_meta co on co.document_id = d.id
    where d.project_id = ${projectId}
      and i.position_type in ('item', 'alternative', 'optional', 'lump_sum')
      and ${
        onlyIds
          ? tx`i.id in ${tx(onlyIds.length ? onlyIds : ['00000000-0000-0000-0000-000000000000'])}`
          : tx`d.type in ('quote', 'cost_estimate', 'order_confirmation', 'change_order')
               and d.status <> 'cancelled'`
      }
    order by array_position(array['quote','cost_estimate','order_confirmation','change_order',
                                  'delivery_note','invoice','credit_note'], d.type),
             d.created_at, d.id,
             string_to_array(coalesce(i.oz, '0'), '.')::int[], i.sort`
}

async function checkItem(tx: Tx, projectId: string, itemId: string | null | undefined) {
  if (!itemId) return null
  const [item] = await tx<{ unitId: string | null; type: string; decimals: number | null }[]>`
    select i.unit_id as "unitId", i.position_type as type,
           (select u.decimals from unit u where u.id = i.unit_id)::int as decimals
    from document_item i join document d on d.id = i.document_id
    where i.id = ${itemId} and d.project_id = ${projectId}`
  if (!item || !['item', 'alternative', 'optional', 'lump_sum'].includes(item.type)) {
    throw invalid({ documentItemId: 'Diese LV-Position gehört nicht zu diesem Projekt.' })
  }
  return item
}

async function checkUnit(tx: Tx, unitId: string | null | undefined): Promise<number | null> {
  if (!unitId) return null
  const [unit] = await tx<
    { decimals: number }[]
  >`select decimals from unit where id = ${unitId} and is_active`
  if (!unit) throw invalid({ unitId: 'Unbekannte Einheit.' })
  return unit.decimals
}

/** Lines without unit are rounded to two decimals. */
const DEFAULT_DECIMALS = 2

async function checkLocation(tx: Tx, sheetId: string, locationId: string | null | undefined) {
  if (!locationId) return
  const found =
    await tx`select 1 from measurement_location where id = ${locationId} and sheet_id = ${sheetId}`
  if (!found.length) throw invalid({ locationId: 'Unbekannter Raum.' })
}

// ---- Loading the sheet --------------------------------------------------------------------------

async function loadSheet(
  tx: Tx,
  auth: AuthContext,
  id: string,
): Promise<(MeasurementSheetDetail & { etag: string }) | null> {
  const [row] = await tx<
    (Omit<MeasurementSheetDetail, 'locations' | 'lines' | 'items' | 'unassigned'> & {
      updatedRaw: Date
    })[]
  >`
    select ${summaryColumns(tx)}, s.updated_at as "updatedRaw",
           json_build_object('id', p.id, 'number', p.number, 'name', p.name) as project,
           ${ISO(tx, 's.signed_at')} as "signedAt", s.signed_by_contractor as "signedByContractor",
           s.signed_by_client as "signedByClient"
    from measurement_sheet s
    join project p on p.id = s.project_id
    left join app_user u on u.id = s.created_by
    where s.id = ${id} and ${projectVisibility(tx, auth)}`
  if (!row) return null
  const { updatedRaw, ...sheet } = row
  const locations = locationTree(await loadLocations(tx, id))
  const order = new Map(locations.map((l, i) => [l.id, i]))
  const lines = (
    await tx<(MeasurementLine & { sort: number })[]>`
      select l.id, l.location_id as "locationId", l.document_item_id as "documentItemId", l.description,
             l.formula, l.variables, trim_scale(l.result_qty)::text as "resultQty", l.is_deduction as "isDeduction",
             case when un.id is null then null
                  else json_build_object('id', un.id, 'symbol', un.symbol, 'decimals', un.decimals) end as unit,
             (l.locked_by_invoice_id is not null or ${sheet.status === 'signed'}) as locked,
             ${ISO(tx, 'l.created_at')} as "createdAt", l.sort
      from measurement_line l left join unit un on un.id = l.unit_id
      where l.sheet_id = ${id}
      order by l.sort, l.id`
  ).sort(
    (a, b) =>
      (a.locationId ? (order.get(a.locationId) ?? 0) + 1 : 0) -
      (b.locationId ? (order.get(b.locationId) ?? 0) + 1 : 0),
  )
  const itemIds = [...new Set(lines.map((l) => l.documentItemId).filter((v): v is string => !!v))]
  const items = await measurableItems(tx, sheet.projectId, sheet.kind, itemIds)
  const summaries: ItemQuantitySummary[] = items.map((item) => ({
    item,
    sheetQuantity: trim(
      sumQuantities(lines.filter((l) => l.documentItemId === item.id).map((l) => l.resultQty)),
    ),
    variance: (() => {
      const v = quantityVariance(item.quantity, item.measuredQuantity)
      return { ...v, difference: trim(v.difference) }
    })(),
  }))
  const unassignedByUnit = new Map<
    string,
    { unit: string | null; decimals: number; quantities: string[] }
  >()
  for (const line of lines.filter((l) => !l.documentItemId)) {
    const key = line.unit?.symbol ?? ''
    const entry = unassignedByUnit.get(key) ?? {
      unit: line.unit?.symbol ?? null,
      decimals: line.unit?.decimals ?? DEFAULT_DECIMALS,
      quantities: [],
    }
    entry.quantities.push(line.resultQty)
    unassignedByUnit.set(key, entry)
  }
  return {
    ...sheet,
    locations,
    lines: lines.map(({ sort: _, ...line }) => line),
    items: summaries,
    unassigned: [...unassignedByUnit.values()].map((e) => ({
      unit: e.unit,
      decimals: e.decimals,
      quantity: trim(sumQuantities(e.quantities)),
      count: e.quantities.length,
    })),
    etag: etagOf(updatedRaw),
  }
}

/** "12.5000" → "12.5" (same format as the database's trim_scale). */
function trim(value: string): string {
  return value.includes('.') ? value.replace(/0+$/, '').replace(/\.$/, '') : value
}

function sendSheet(
  reply: FastifyReply,
  sheet: (MeasurementSheetDetail & { etag: string }) | null,
  status = 200,
) {
  if (!sheet) throw notFound('Das Aufmaßblatt')
  const { etag, ...body } = sheet
  return reply.status(status).header('etag', etag).send(body)
}

const touch = (tx: Tx, sheetId: string) =>
  tx`update measurement_sheet set updated_at = now() where id = ${sheetId}`

const KIND_TITLE: Record<MeasurementKind, string> = {
  survey: 'Angebotsaufmaß',
  performance: 'Leistungsaufmaß',
}

// ---- Routes -------------------------------------------------------------------------------------

export function registerMeasurementRoutes(app: FastifyInstance, services: Services) {
  app.get(
    '/api/v1/projects/:id/measurement-sheets',
    async (request): Promise<MeasurementSheetSummary[]> => {
      const auth = requireAuth(request)
      const { id } = parse(projectParam, request.params)
      return inTenant(services, auth, async (tx) => {
        await requireVisibleProject(tx, auth, id)
        return tx<MeasurementSheetSummary[]>`
          select ${summaryColumns(tx)}
          from measurement_sheet s left join app_user u on u.id = s.created_by
          where s.project_id = ${id} and not s.is_inline
          order by s.measured_on desc, s.created_at desc`
      })
    },
  )

  app.post('/api/v1/projects/:id/measurement-sheets', async (request, reply) => {
    const auth = requirePermission(request, 'measurement.write')
    const { id } = parse(projectParam, request.params)
    const input = parse(createSheetRequest, request.body)
    const sheet = await inTenant(services, auth, async (tx) => {
      const project = await requireVisibleProject(tx, auth, id)
      if (project.archived) {
        throw new HttpError(409, 'Das Projekt ist archiviert. Bitte zuerst wiederherstellen.')
      }
      const [count] = await tx<{ n: number }[]>`
        select count(*)::int + 1 as n from measurement_sheet where project_id = ${id} and kind = ${input.kind}`
      const [created] = await tx<{ id: string }[]>`
        insert into measurement_sheet ${tx({
          tenant_id: auth.tenantId,
          project_id: id,
          kind: input.kind,
          title: input.title ?? `${KIND_TITLE[input.kind]} ${count?.n ?? 1}`,
          ...(input.measuredOn ? { measured_on: input.measuredOn } : {}),
          created_by: auth.userId,
        })} returning id`
      return loadSheet(tx, auth, (created as { id: string }).id)
    })
    reply.header('location', `/api/v1/measurement-sheets/${sheet?.id}`)
    return sendSheet(reply, sheet, 201)
  })

  app.get('/api/v1/projects/:id/measurable-items', async (request): Promise<MeasurableItem[]> => {
    const auth = requireAuth(request)
    const { id } = parse(projectParam, request.params)
    const { kind } = parse(itemsQuery, request.query)
    return inTenant(services, auth, async (tx) => {
      await requireVisibleProject(tx, auth, id)
      return measurableItems(tx, id, kind)
    })
  })

  app.get('/api/v1/measurement-sheets/:id', async (request, reply) => {
    const auth = requireAuth(request)
    const { id } = parse(sheetParam, request.params)
    return sendSheet(reply, await inTenant(services, auth, (tx) => loadSheet(tx, auth, id)))
  })

  app.patch('/api/v1/measurement-sheets/:id', async (request, reply) => {
    const auth = requirePermission(request, 'measurement.write')
    const { id } = parse(sheetParam, request.params)
    const input = parse(updateSheetRequest, request.body)
    const sheet = await inTenant(services, auth, async (tx) => {
      const current = await sheetOf(tx, auth, id, { forUpdate: true })
      checkIfMatch(request.headers['if-match'], current.updatedAt)
      const columns: Record<string, unknown> = {}
      if (input.title !== undefined) columns.title = input.title
      if (input.measuredOn !== undefined) columns.measured_on = input.measuredOn
      if (input.kind !== undefined) columns.kind = input.kind
      if (Object.keys(columns).length)
        await tx`update measurement_sheet set ${tx(columns)} where id = ${id}`
      return loadSheet(tx, auth, id)
    })
    return sendSheet(reply, sheet)
  })

  app.delete('/api/v1/measurement-sheets/:id', async (request, reply) => {
    const auth = requirePermission(request, 'measurement.write')
    const { id } = parse(sheetParam, request.params)
    await inTenant(services, auth, async (tx) => {
      await sheetOf(tx, auth, id, { forUpdate: true })
      const [locked] = await tx<{ n: number }[]>`
        select count(*)::int as n from measurement_line where sheet_id = ${id} and locked_by_invoice_id is not null`
      if (locked?.n) {
        throw new HttpError(
          409,
          'Zeilen dieses Aufmaßes wurden bereits abgerechnet. Es kann nicht gelöscht werden.',
        )
      }
      await tx`delete from measurement_sheet where id = ${id}`
    })
    return reply.status(204).send()
  })

  // Gemeinsames Aufmaß: both sides confirm; afterwards the sheet is locked (DB trigger).
  app.post('/api/v1/measurement-sheets/:id/sign', async (request, reply) => {
    const auth = requirePermission(request, 'measurement.write')
    const { id } = parse(sheetParam, request.params)
    const input = parse(signSheetRequest, request.body)
    const sheet = await inTenant(services, auth, async (tx) => {
      await sheetOf(tx, auth, id, { forUpdate: true })
      const [count] = await tx<
        { n: number }[]
      >`select count(*)::int as n from measurement_line where sheet_id = ${id}`
      if (!count?.n) throw new HttpError(409, 'Ein leeres Aufmaß kann nicht abgeschlossen werden.')
      await tx`
        update measurement_sheet set status = 'signed', signed_at = now(),
               signed_by_contractor = ${input.contractorName}, signed_by_client = ${input.clientName}
        where id = ${id}`
      return loadSheet(tx, auth, id)
    })
    return sendSheet(reply, sheet)
  })

  // ---- Rooms ----

  app.post('/api/v1/measurement-sheets/:id/locations', async (request, reply) => {
    const auth = requirePermission(request, 'measurement.write')
    const { id } = parse(sheetParam, request.params)
    const input = parse(locationRequest, request.body)
    const sheet = await inTenant(services, auth, async (tx) => {
      await sheetOf(tx, auth, id, { forUpdate: true })
      if (input.parentId) {
        await checkLocation(tx, id, input.parentId).catch(() => {
          throw invalid({ parentId: 'Unbekannter übergeordneter Bereich.' })
        })
      }
      await tx`
        insert into measurement_location (tenant_id, sheet_id, parent_id, name, variables, sort)
        values (${auth.tenantId}, ${id}, ${input.parentId ?? null}, ${input.name}, ${tx.json(input.variables)},
                (select coalesce(max(sort), 0) + 10 from measurement_location where sheet_id = ${id}))`
      await touch(tx, id)
      return loadSheet(tx, auth, id)
    })
    return sendSheet(reply, sheet, 201)
  })

  app.patch('/api/v1/measurement-sheets/:id/locations/:locationId', async (request, reply) => {
    const auth = requirePermission(request, 'measurement.write')
    const { id, locationId } = parse(locationParam, request.params)
    const input = parse(updateLocationRequest, request.body)
    const sheet = await inTenant(services, auth, async (tx) => {
      await sheetOf(tx, auth, id, { forUpdate: true })
      await checkLocation(tx, id, locationId).catch(() => {
        throw notFound('Der Raum')
      })
      const columns: Record<string, unknown> = {}
      if (input.name !== undefined) columns.name = input.name
      if (input.variables !== undefined) columns.variables = tx.json(input.variables)
      if (Object.keys(columns).length) {
        await tx`update measurement_location set ${tx(columns)} where id = ${locationId}`
      }
      if (input.variables !== undefined) await recalculateSheet(tx, id)
      await touch(tx, id)
      return loadSheet(tx, auth, id)
    })
    return sendSheet(reply, sheet)
  })

  app.delete('/api/v1/measurement-sheets/:id/locations/:locationId', async (request, reply) => {
    const auth = requirePermission(request, 'measurement.write')
    const { id, locationId } = parse(locationParam, request.params)
    const sheet = await inTenant(services, auth, async (tx) => {
      await sheetOf(tx, auth, id, { forUpdate: true })
      const [used] = await tx<{ n: number }[]>`
        with recursive sub as (
          select id from measurement_location where id = ${locationId} and sheet_id = ${id}
          union all
          select l.id from measurement_location l join sub on l.parent_id = sub.id
        )
        select count(*)::int as n from measurement_line where location_id in (select id from sub)`
      if (used?.n) {
        throw new HttpError(
          409,
          'In diesem Bereich gibt es noch Aufmaßzeilen. Bitte zuerst löschen oder verschieben.',
        )
      }
      const deleted =
        await tx`delete from measurement_location where id = ${locationId} and sheet_id = ${id}`
      if (!deleted.count) throw notFound('Der Raum')
      await touch(tx, id)
      return loadSheet(tx, auth, id)
    })
    return sendSheet(reply, sheet)
  })

  // ---- Lines ----

  app.post('/api/v1/measurement-sheets/:id/lines', async (request, reply) => {
    const auth = requirePermission(request, 'measurement.write')
    const { id } = parse(sheetParam, request.params)
    const input: CreateLineRequest = parse(createLineRequest, request.body)
    const sheet = await inTenant(services, auth, async (tx) => {
      const current = await sheetOf(tx, auth, id, { forUpdate: true })
      await checkLocation(tx, id, input.locationId)
      const item = await checkItem(tx, current.projectId, input.documentItemId)
      const unitDecimals = await checkUnit(tx, input.unitId)
      // The unit of an assigned LV position wins (quantities must add up in its unit).
      const decimals = (item?.unitId ? item.decimals : unitDecimals) ?? DEFAULT_DECIMALS
      const locations = await loadLocations(tx, id)
      const resultQty = quantityOf(
        {
          formula: input.formula,
          variables: input.variables ?? {},
          isDeduction: input.isDeduction ?? false,
        },
        variablesOf(locations, input.locationId ?? null),
        decimals,
      )
      const [{ sort } = { sort: 10 }] = await tx<{ sort: number }[]>`
        select (coalesce(max(sort), 0) + 10)::int as sort from measurement_line where sheet_id = ${id}`
      await tx`
        insert into measurement_line ${tx({
          tenant_id: auth.tenantId,
          sheet_id: id,
          sort,
          location_id: input.locationId ?? null,
          document_item_id: input.documentItemId ?? null,
          description: input.description ?? null,
          formula: input.formula,
          variables: tx.json(input.variables ?? {}) as never,
          result_qty: resultQty,
          // The unit of an assigned LV position wins (quantities must add up in its unit).
          unit_id: item?.unitId ?? input.unitId ?? null,
          is_deduction: input.isDeduction ?? false,
          created_by: auth.userId,
        })}`
      await touch(tx, id)
      return loadSheet(tx, auth, id)
    })
    return sendSheet(reply, sheet, 201)
  })

  app.patch('/api/v1/measurement-sheets/:id/lines/:lineId', async (request, reply) => {
    const auth = requirePermission(request, 'measurement.write')
    const { id, lineId } = parse(lineParam, request.params)
    const input = parse(updateLineRequest, request.body)
    const sheet = await inTenant(services, auth, async (tx) => {
      const current = await sheetOf(tx, auth, id, { forUpdate: true })
      const [line] = await tx<
        {
          formula: string
          variables: Record<string, string>
          isDeduction: boolean
          locationId: string | null
          documentItemId: string | null
          unitId: string | null
          locked: boolean
        }[]
      >`
        select formula, variables, is_deduction as "isDeduction", location_id as "locationId",
               document_item_id as "documentItemId", unit_id as "unitId",
               (locked_by_invoice_id is not null) as locked
        from measurement_line where id = ${lineId} and sheet_id = ${id}`
      if (!line) throw notFound('Die Aufmaßzeile')
      if (line.locked) {
        throw new HttpError(
          409,
          'Diese Zeile wurde in einer festgeschriebenen Rechnung abgerechnet. Bitte eine Korrekturzeile anlegen.',
        )
      }
      if (input.locationId !== undefined) await checkLocation(tx, id, input.locationId)
      const item =
        input.documentItemId !== undefined
          ? await checkItem(tx, current.projectId, input.documentItemId)
          : undefined
      if (input.unitId !== undefined) await checkUnit(tx, input.unitId)
      const next = {
        formula: input.formula ?? line.formula,
        variables: input.variables ?? line.variables,
        isDeduction: input.isDeduction ?? line.isDeduction,
        locationId: input.locationId === undefined ? line.locationId : input.locationId,
      }
      // Unit: an assigned LV position dictates it; otherwise the chosen unit.
      const itemId = input.documentItemId === undefined ? line.documentItemId : input.documentItemId
      const unitId = itemId
        ? input.documentItemId === undefined
          ? line.unitId
          : (item?.unitId ?? null)
        : input.unitId === undefined
          ? line.unitId
          : input.unitId
      const decimals = (await checkUnit(tx, unitId)) ?? DEFAULT_DECIMALS
      const resultQty = quantityOf(
        next,
        variablesOf(await loadLocations(tx, id), next.locationId),
        decimals,
      )
      const columns: Record<string, unknown> = {
        formula: next.formula,
        variables: tx.json(next.variables),
        is_deduction: next.isDeduction,
        location_id: next.locationId,
        document_item_id: itemId,
        unit_id: unitId,
        result_qty: resultQty,
      }
      if (input.description !== undefined) columns.description = input.description
      await tx`update measurement_line set ${tx(columns)} where id = ${lineId}`
      await touch(tx, id)
      return loadSheet(tx, auth, id)
    })
    return sendSheet(reply, sheet)
  })

  app.delete('/api/v1/measurement-sheets/:id/lines/:lineId', async (request, reply) => {
    const auth = requirePermission(request, 'measurement.write')
    const { id, lineId } = parse(lineParam, request.params)
    const sheet = await inTenant(services, auth, async (tx) => {
      await sheetOf(tx, auth, id, { forUpdate: true })
      const [line] = await tx<{ locked: boolean }[]>`
        select (locked_by_invoice_id is not null) as locked from measurement_line where id = ${lineId} and sheet_id = ${id}`
      if (!line) throw notFound('Die Aufmaßzeile')
      if (line.locked) {
        throw new HttpError(
          409,
          'Diese Zeile wurde bereits abgerechnet und kann nicht gelöscht werden.',
        )
      }
      await tx`delete from measurement_line where id = ${lineId}`
      await touch(tx, id)
      return loadSheet(tx, auth, id)
    })
    return sendSheet(reply, sheet)
  })

  // ---- Quantities into the document (Mengenfluss, DESIGN.md §4.3) ----

  app.post('/api/v1/documents/:id/apply-measurements', async (request, reply) => {
    const auth = requirePermission(request, 'document.write')
    const { id } = parse(sheetParam, request.params)
    const doc = await inTenant(services, auth, async (tx) => {
      await lockDraft(tx, auth, id)
      const sums = await tx<{ itemId: string; quantity: string }[]>`
        select l.document_item_id as "itemId",
               trim_scale(round(sum(l.result_qty), coalesce(max(u.decimals), 2)))::text as quantity
        from measurement_line l
        join document_item i on i.id = l.document_item_id
        left join unit u on u.id = i.unit_id
        where i.document_id = ${id} and i.position_type in ('item', 'alternative', 'optional', 'lump_sum')
        group by l.document_item_id`
      if (!sums.length) {
        throw new HttpError(409, 'Keiner Position dieses Dokuments sind Aufmaßzeilen zugeordnet.')
      }
      for (const sum of sums) {
        await tx`update document_item set quantity = ${sum.quantity}, quantity_from_measurement = true
                 where id = ${sum.itemId}`
      }
      await recalculate(tx, id)
      return loadDocument(tx, auth, id)
    })
    return sendDocument(reply, doc)
  })
}
