import type { Tx } from '@opc/db'
import { hourlyRateCents } from '@opc/domain'
import {
  type Company,
  companyRequest,
  type DatevSettings,
  datevSettingsRequest,
  filingTemplateRequest,
  type NumberSequence,
  numberSequenceRequest,
  type PaymentTerm,
  paymentTermRequest,
  type Surcharges,
  settingsIdParam,
  surchargesRequest,
  type TaxRateSummary,
  type TextTemplate,
  taxRateRequest,
  textTemplateRequest,
  type UnitSetting,
  unitRequest,
  type WageGroup,
  type WorkingDay,
  wageGroupRequest,
  workingHoursRequest,
} from '@opc/schemas'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { inTenant, requirePermission, type Services } from '../context.js'
import { HttpError, notFound, parse } from '../http.js'

const kindParam = z.object({
  kind: z.enum([
    'contact',
    'project',
    'quote',
    'cost_estimate',
    'order_confirmation',
    'delivery_note',
    'invoice',
    'credit_note',
  ]),
})

const invalid = (errors: Record<string, string>) =>
  new HttpError(400, 'Die Eingaben sind unvollständig oder ungültig.', errors)

const conflict = (field: string, message: string) => (error: { code?: string }) => {
  if (error.code === '23505') throw invalid({ [field]: message })
  throw error
}

/** Defaults of the DATEV Standardkontenrahmen (Erlöse, Bank). */
export const DATEV_DEFAULTS = {
  SKR03: {
    standard19: '8400',
    reduced7: '8300',
    reverseCharge: '8337',
    exempt: '8120',
    bank: '1200',
  },
  SKR04: {
    standard19: '4400',
    reduced7: '4300',
    reverseCharge: '4337',
    exempt: '4120',
    bank: '1800',
  },
} as const

export const DEFAULT_DATEV: DatevSettings = {
  consultantNumber: null,
  clientNumber: null,
  chart: 'SKR03',
  fiscalYearStartMonth: 1,
  accountLength: 4,
  revenueAccounts: {},
  bankAccount: null,
}

export async function datevSettings(tx: Tx): Promise<DatevSettings> {
  const [row] = await tx<{ datev: Partial<DatevSettings> | null }[]>`
    select settings -> 'datev' as datev from tenant where id = current_tenant_id()`
  return { ...DEFAULT_DATEV, ...(row?.datev ?? {}) }
}

function preview(seq: Omit<NumberSequence, 'preview'>, year: number): string {
  return `${seq.prefix}${seq.includeYear ? `${year}-` : ''}${String(seq.nextValue).padStart(seq.minLength, '0')}`
}

const companyColumns: Record<keyof Omit<Company, 'iban'>, string> = {
  name: 'name',
  legalForm: 'legal_form',
  trade: 'trade',
  street: 'street',
  postalCode: 'postal_code',
  city: 'city',
  countryCode: 'country_code',
  federalState: 'federal_state',
  email: 'email',
  phone: 'phone',
  website: 'website',
  vatId: 'vat_id',
  taxNumber: 'tax_number',
  registerCourt: 'register_court',
  registerNumber: 'register_number',
  managerTitle: 'manager_title',
  managerName: 'manager_name',
  bankName: 'bank_name',
  bic: 'bic',
}

export function registerSettingsRoutes(app: FastifyInstance, services: Services) {
  // ---- Firma ----

  const loadCompany = async (tx: Tx): Promise<Company> => {
    const select = Object.entries(companyColumns).map(
      ([key, column]) => tx`${tx(column)} as ${tx(key)}`,
    )
    const [row] = await tx<(Omit<Company, 'iban'> & { ibanEnc: Buffer | null })[]>`
      select ${select.reduce((acc, part) => tx`${acc}, ${part}`)}, iban_enc as "ibanEnc"
      from tenant where id = current_tenant_id()`
    if (!row) throw notFound('Die Firma')
    const { ibanEnc, ...company } = row
    return { ...company, iban: ibanEnc ? services.cipher.decrypt(ibanEnc) : null }
  }

  app.get('/api/v1/settings/company', async (request) => {
    const auth = requirePermission(request, 'settings.read')
    return inTenant(services, auth, loadCompany)
  })

  app.patch('/api/v1/settings/company', async (request) => {
    const auth = requirePermission(request, 'tenant.manage')
    const input = parse(companyRequest, request.body)
    return inTenant(services, auth, async (tx) => {
      const columns: Record<string, unknown> = {}
      for (const [key, column] of Object.entries(companyColumns)) {
        const value = input[key as keyof typeof input]
        if (value !== undefined) columns[column] = value
      }
      if (input.iban !== undefined) {
        // Bank details are encrypted at rest (AES-256-GCM, APP_SECRET).
        columns.iban_enc = input.iban ? services.cipher.encrypt(input.iban) : null
      }
      if (Object.keys(columns).length) {
        await tx`update tenant set ${tx(columns)} where id = current_tenant_id()`
      }
      return loadCompany(tx)
    })
  })

  // ---- Nummernkreise ----

  app.get('/api/v1/settings/number-sequences', async (request): Promise<NumberSequence[]> => {
    const auth = requirePermission(request, 'settings.read')
    return inTenant(services, auth, async (tx) => {
      const rows = await tx<Omit<NumberSequence, 'preview'>[]>`
        select kind, prefix, next_value::int as "nextValue", min_length as "minLength",
               include_year as "includeYear", reset_yearly as "resetYearly"
        from number_sequence
        order by array_position(array['contact','project','quote','cost_estimate','order_confirmation',
                                      'delivery_note','invoice','credit_note'], kind)`
      const year = new Date().getFullYear()
      return rows.map((r) => ({ ...r, preview: preview(r, year) }))
    })
  })

  app.patch('/api/v1/settings/number-sequences/:kind', async (request) => {
    const auth = requirePermission(request, 'settings.write')
    const { kind } = parse(kindParam, request.params)
    const input = parse(numberSequenceRequest, request.body)
    return inTenant(services, auth, async (tx) => {
      const columns: Record<string, unknown> = {}
      if (input.prefix !== undefined) columns.prefix = input.prefix
      if (input.nextValue !== undefined) columns.next_value = input.nextValue
      if (input.minLength !== undefined) columns.min_length = input.minLength
      if (input.includeYear !== undefined) columns.include_year = input.includeYear
      if (input.resetYearly !== undefined) columns.reset_yearly = input.resetYearly
      if (Object.keys(columns).length) {
        await tx`update number_sequence set ${tx(columns)} where kind = ${kind}`.catch(
          (error: { message?: string }) => {
            if (String(error.message).includes('must not be decreased')) {
              throw invalid({
                nextValue:
                  'Rechnungs- und Gutschriftnummern dürfen nicht zurückgesetzt werden (lückenlose Nummerierung).',
              })
            }
            throw error
          },
        )
      }
      const [row] = await tx<Omit<NumberSequence, 'preview'>[]>`
        select kind, prefix, next_value::int as "nextValue", min_length as "minLength",
               include_year as "includeYear", reset_yearly as "resetYearly"
        from number_sequence where kind = ${kind}`
      if (!row) throw notFound('Der Nummernkreis')
      return { ...row, preview: preview(row, new Date().getFullYear()) }
    })
  })

  // ---- Zahlungsziele ----

  const termColumns = (tx: Tx) => tx`
    id, name, due_days as "dueDays", trim_scale(cash_discount_percent)::text as "cashDiscountPercent",
    cash_discount_days as "cashDiscountDays", is_default as "isDefault"`

  app.get('/api/v1/settings/payment-terms', async (request): Promise<PaymentTerm[]> => {
    const auth = requirePermission(request, 'settings.read')
    return inTenant(
      services,
      auth,
      (tx) =>
        tx<PaymentTerm[]>`select ${termColumns(tx)} from payment_term order by due_days, name`,
    )
  })

  const saveTerm = async (
    tx: Tx,
    tenantId: string,
    input: z.infer<typeof paymentTermRequest>,
    id?: string,
  ) => {
    const columns: Record<string, unknown> = {}
    if (input.name !== undefined) columns.name = input.name
    if (input.dueDays !== undefined) columns.due_days = input.dueDays
    if (input.cashDiscountPercent !== undefined)
      columns.cash_discount_percent = input.cashDiscountPercent
    if (input.cashDiscountDays !== undefined) columns.cash_discount_days = input.cashDiscountDays
    if (input.isDefault) await tx`update payment_term set is_default = false where is_default`
    if (input.isDefault !== undefined) columns.is_default = input.isDefault
    if (id) {
      if (Object.keys(columns).length) {
        const updated = await tx`update payment_term set ${tx(columns)} where id = ${id}`
        if (!updated.count) throw notFound('Das Zahlungsziel')
      }
      return id
    }
    if (!input.name || input.dueDays === undefined) throw invalid({ name: 'Name und Tage fehlen.' })
    const [row] = await tx<{ id: string }[]>`
      insert into payment_term ${tx({ ...columns, tenant_id: tenantId })} returning id`
    return (row as { id: string }).id
  }

  app.post('/api/v1/settings/payment-terms', async (request, reply) => {
    const auth = requirePermission(request, 'settings.write')
    const input = parse(paymentTermRequest, request.body)
    const term = await inTenant(services, auth, async (tx) => {
      const id = await saveTerm(tx, auth.tenantId, input)
      return (
        await tx<PaymentTerm[]>`select ${termColumns(tx)} from payment_term where id = ${id}`
      )[0]
    })
    return reply.status(201).send(term)
  })

  app.patch('/api/v1/settings/payment-terms/:id', async (request) => {
    const auth = requirePermission(request, 'settings.write')
    const { id } = parse(settingsIdParam, request.params)
    const input = parse(paymentTermRequest, request.body)
    return inTenant(services, auth, async (tx) => {
      await saveTerm(tx, auth.tenantId, input, id)
      return (
        await tx<PaymentTerm[]>`select ${termColumns(tx)} from payment_term where id = ${id}`
      )[0]
    })
  })

  app.delete('/api/v1/settings/payment-terms/:id', async (request, reply) => {
    const auth = requirePermission(request, 'settings.write')
    const { id } = parse(settingsIdParam, request.params)
    await inTenant(services, auth, async (tx) => {
      const [term] = await tx<
        { isDefault: boolean }[]
      >`select is_default as "isDefault" from payment_term where id = ${id}`
      if (!term) throw notFound('Das Zahlungsziel')
      if (term.isDefault)
        throw new HttpError(409, 'Das Standard-Zahlungsziel kann nicht gelöscht werden.')
      await tx`update contact set payment_term_id = null where payment_term_id = ${id}`
      await tx`delete from payment_term where id = ${id}`
    })
    return reply.status(204).send()
  })

  // ---- Steuersätze ----

  app.post('/api/v1/settings/tax-rates', async (request, reply) => {
    const auth = requirePermission(request, 'settings.write')
    const input = parse(taxRateRequest, request.body)
    if (!input.name || input.percent === undefined || !input.categoryCode) {
      throw invalid({ name: 'Name, Satz und Kategorie fehlen.' })
    }
    const rate = await inTenant(services, auth, async (tx) => {
      if (input.isDefault) await tx`update tax_rate set is_default = false where is_default`
      const [row] = await tx<TaxRateSummary[]>`
        insert into tax_rate (tenant_id, name, percent, category_code, is_default)
        values (${auth.tenantId}, ${input.name as string}, ${input.percent as string}, ${input.categoryCode as string},
                ${input.isDefault ?? false})
        returning id, name, trim_scale(percent)::text as percent, category_code as "categoryCode", is_default as "isDefault"`
      return row
    })
    return reply.status(201).send(rate)
  })

  app.patch('/api/v1/settings/tax-rates/:id', async (request) => {
    const auth = requirePermission(request, 'settings.write')
    const { id } = parse(settingsIdParam, request.params)
    const input = parse(taxRateRequest, request.body)
    return inTenant(services, auth, async (tx) => {
      const columns: Record<string, unknown> = {}
      if (input.name !== undefined) columns.name = input.name
      if (input.validTo !== undefined) columns.valid_to = input.validTo
      if (input.isDefault) await tx`update tax_rate set is_default = false where is_default`
      if (input.isDefault !== undefined) columns.is_default = input.isDefault
      // Percent and category are fixed: existing documents refer to them.
      if (input.percent !== undefined || input.categoryCode !== undefined) {
        throw invalid({
          percent: 'Satz und Kategorie sind fest. Bitte einen neuen Steuersatz anlegen.',
        })
      }
      if (Object.keys(columns).length) {
        const updated = await tx`update tax_rate set ${tx(columns)} where id = ${id}`
        if (!updated.count) throw notFound('Der Steuersatz')
      }
      const [row] = await tx<TaxRateSummary[]>`
        select id, name, trim_scale(percent)::text as percent, category_code as "categoryCode", is_default as "isDefault"
        from tax_rate where id = ${id}`
      return row
    })
  })

  // ---- Zuschläge ----

  app.get('/api/v1/settings/surcharges', async (request): Promise<Surcharges> => {
    const auth = requirePermission(request, 'settings.read')
    const rows = await inTenant(
      services,
      auth,
      (tx) => tx<{ kind: string; percent: string }[]>`
        select cost_kind as kind, trim_scale(percent)::text as percent from surcharge`,
    )
    return Object.fromEntries(rows.map((r) => [r.kind, r.percent])) as Surcharges
  })

  app.patch('/api/v1/settings/surcharges', async (request) => {
    const auth = requirePermission(request, 'settings.write')
    const input = parse(surchargesRequest, request.body)
    return inTenant(services, auth, async (tx) => {
      // Not retroactive: existing Stammdaten and documents keep their markups (DESIGN.md §4.2).
      for (const [kind, percent] of Object.entries(input)) {
        await tx`
          insert into surcharge (tenant_id, cost_kind, percent) values (${auth.tenantId}, ${kind}, ${percent})
          on conflict (tenant_id, cost_kind) do update set percent = excluded.percent`
      }
      const rows = await tx<{ kind: string; percent: string }[]>`
        select cost_kind as kind, trim_scale(percent)::text as percent from surcharge`
      return Object.fromEntries(rows.map((r) => [r.kind, r.percent]))
    })
  })

  // ---- Lohngruppen ----

  const wageColumns = (tx: Tx) => tx`
    id, name, cost_per_hour_cents::float8 as "costPerHourCents", trim_scale(markup_percent)::text as "markupPercent",
    hourly_rate_cents::float8 as "hourlyRateCents", is_active as "isActive"`

  app.get('/api/v1/settings/wage-groups', async (request): Promise<WageGroup[]> => {
    const auth = requirePermission(request, 'settings.read')
    return inTenant(
      services,
      auth,
      (tx) => tx<WageGroup[]>`select ${wageColumns(tx)} from wage_group order by sort, name`,
    )
  })

  const saveWageGroup = async (
    tx: Tx,
    tenantId: string,
    input: z.infer<typeof wageGroupRequest>,
    id?: string,
  ): Promise<WageGroup> => {
    const [current] = id
      ? await tx<{ cost: string; markup: string }[]>`
          select cost_per_hour_cents::text as cost, markup_percent::text as markup from wage_group where id = ${id}`
      : []
    if (id && !current) throw notFound('Die Lohngruppe')
    const cost = input.costPerHourCents ?? Number(current?.cost ?? 0)
    const markup = input.markupPercent ?? current?.markup ?? '0'
    const columns: Record<string, unknown> = {
      cost_per_hour_cents: cost,
      markup_percent: markup,
      hourly_rate_cents: hourlyRateCents(cost, markup).toString(),
    }
    if (input.name !== undefined) columns.name = input.name
    if (input.isActive !== undefined) columns.is_active = input.isActive
    const onDuplicate = conflict('name', 'Eine Lohngruppe mit diesem Namen gibt es bereits.')
    let wageId = id
    if (id) {
      await tx`update wage_group set ${tx(columns)} where id = ${id}`.catch(onDuplicate)
    } else {
      if (!input.name) throw invalid({ name: 'Name fehlt.' })
      const [row] = await tx<{ id: string }[]>`
        insert into wage_group ${tx({ ...columns, tenant_id: tenantId })} returning id`.catch(
        onDuplicate,
      )
      wageId = (row as { id: string }).id
    }
    return (
      await tx<
        WageGroup[]
      >`select ${wageColumns(tx)} from wage_group where id = ${wageId as string}`
    )[0] as WageGroup
  }

  app.post('/api/v1/settings/wage-groups', async (request, reply) => {
    const auth = requirePermission(request, 'settings.write')
    const input = parse(wageGroupRequest, request.body)
    return reply
      .status(201)
      .send(await inTenant(services, auth, (tx) => saveWageGroup(tx, auth.tenantId, input)))
  })

  app.patch('/api/v1/settings/wage-groups/:id', async (request) => {
    const auth = requirePermission(request, 'settings.write')
    const { id } = parse(settingsIdParam, request.params)
    const input = parse(wageGroupRequest, request.body)
    return inTenant(services, auth, (tx) => saveWageGroup(tx, auth.tenantId, input, id))
  })

  // ---- Einheiten ----

  const unitColumns = (tx: Tx) => tx`
    id, symbol, name, dimension, unece_code as "uneceCode", decimals, is_system as "isSystem", is_active as "isActive"`

  app.get('/api/v1/settings/units', async (request): Promise<UnitSetting[]> => {
    const auth = requirePermission(request, 'settings.read')
    return inTenant(
      services,
      auth,
      (tx) =>
        tx<UnitSetting[]>`select ${unitColumns(tx)} from unit order by is_system desc, symbol`,
    )
  })

  app.post('/api/v1/settings/units', async (request, reply) => {
    const auth = requirePermission(request, 'settings.write')
    const input = parse(unitRequest, request.body)
    if (!input.symbol || !input.name || !input.dimension || !input.uneceCode) {
      throw invalid({
        symbol: 'Kürzel, Bezeichnung, Art und UN/ECE-Code sind Pflicht (E-Rechnung).',
      })
    }
    const unit = await inTenant(services, auth, async (tx) => {
      const [row] = await tx<UnitSetting[]>`
        insert into unit (tenant_id, symbol, name, dimension, unece_code, decimals)
        values (${auth.tenantId}, ${input.symbol as string}, ${input.name as string}, ${input.dimension as string},
                ${input.uneceCode as string}, ${input.decimals ?? 2})
        returning ${unitColumns(tx)}`.catch(conflict('symbol', 'Diese Einheit gibt es bereits.'))
      return row
    })
    return reply.status(201).send(unit)
  })

  app.patch('/api/v1/settings/units/:id', async (request) => {
    const auth = requirePermission(request, 'settings.write')
    const { id } = parse(settingsIdParam, request.params)
    const input = parse(unitRequest, request.body)
    return inTenant(services, auth, async (tx) => {
      const [current] = await tx<
        { isSystem: boolean }[]
      >`select is_system as "isSystem" from unit where id = ${id}`
      if (!current) throw notFound('Die Einheit')
      if (
        current.isSystem &&
        (input.symbol !== undefined ||
          input.uneceCode !== undefined ||
          input.dimension !== undefined)
      ) {
        throw invalid({ symbol: 'Kürzel, Art und UN/ECE-Code von Systemeinheiten sind fest.' })
      }
      const columns: Record<string, unknown> = {}
      if (input.symbol !== undefined) columns.symbol = input.symbol
      if (input.name !== undefined) columns.name = input.name
      if (input.dimension !== undefined) columns.dimension = input.dimension
      if (input.uneceCode !== undefined) columns.unece_code = input.uneceCode
      if (input.decimals !== undefined) columns.decimals = input.decimals
      if (input.isActive !== undefined) columns.is_active = input.isActive
      if (Object.keys(columns).length) {
        await tx`update unit set ${tx(columns)} where id = ${id}`.catch(
          conflict('symbol', 'Diese Einheit gibt es bereits.'),
        )
      }
      return (await tx<UnitSetting[]>`select ${unitColumns(tx)} from unit where id = ${id}`)[0]
    })
  })

  // ---- Arbeitszeiten ----

  app.get('/api/v1/settings/working-hours', async (request): Promise<WorkingDay[]> => {
    const auth = requirePermission(request, 'settings.read')
    return inTenant(services, auth, async (tx) => {
      const rows = await tx<WorkingDay[]>`
        select weekday, to_char(start_time, 'HH24:MI') as "startTime", to_char(end_time, 'HH24:MI') as "endTime",
               break_minutes as "breakMinutes"
        from working_hours`
      return Array.from(
        { length: 7 },
        (_, i) =>
          rows.find((r) => r.weekday === i + 1) ?? {
            weekday: i + 1,
            startTime: null,
            endTime: null,
            breakMinutes: 0,
          },
      )
    })
  })

  app.put('/api/v1/settings/working-hours', async (request) => {
    const auth = requirePermission(request, 'settings.write')
    const days = parse(workingHoursRequest, request.body)
    for (const day of days) {
      if (
        (day.startTime === null) !== (day.endTime === null) ||
        (day.startTime && day.endTime && day.endTime <= day.startTime)
      ) {
        throw invalid({ [`${day.weekday}`]: 'Beginn muss vor dem Ende liegen.' })
      }
    }
    return inTenant(services, auth, async (tx) => {
      await tx`delete from working_hours`
      for (const day of days.filter((d) => d.startTime && d.endTime)) {
        await tx`
          insert into working_hours (tenant_id, weekday, start_time, end_time, break_minutes)
          values (${auth.tenantId}, ${day.weekday}, ${day.startTime}, ${day.endTime}, ${day.breakMinutes})`
      }
      return days
    })
  })

  // ---- Textvorlagen ----

  const textColumns = (tx: Tx) => tx`
    id, document_type as "documentType", placement, name, body, is_default as "isDefault"`

  app.get('/api/v1/settings/text-templates', async (request): Promise<TextTemplate[]> => {
    const auth = requirePermission(request, 'settings.read')
    return inTenant(
      services,
      auth,
      (tx) =>
        tx<
          TextTemplate[]
        >`select ${textColumns(tx)} from text_template order by document_type, placement, name`,
    )
  })

  const saveText = async (
    tx: Tx,
    tenantId: string,
    input: z.infer<typeof textTemplateRequest>,
    id?: string,
  ) => {
    const [current] = id
      ? await tx<{ documentType: string; placement: string }[]>`
          select document_type as "documentType", placement from text_template where id = ${id}`
      : []
    if (id && !current) throw notFound('Die Textvorlage')
    const type = input.documentType ?? current?.documentType
    const placement = input.placement ?? current?.placement
    if (!type || !placement) throw invalid({ documentType: 'Dokumentart und Stelle fehlen.' })
    // Only one default per document type and placement.
    if (input.isDefault) {
      await tx`update text_template set is_default = false
               where document_type = ${type} and placement = ${placement} and is_default`
    }
    const columns: Record<string, unknown> = {}
    if (input.documentType !== undefined) columns.document_type = input.documentType
    if (input.placement !== undefined) columns.placement = input.placement
    if (input.name !== undefined) columns.name = input.name
    if (input.body !== undefined) columns.body = input.body
    if (input.isDefault !== undefined) columns.is_default = input.isDefault
    if (id) {
      if (Object.keys(columns).length)
        await tx`update text_template set ${tx(columns)} where id = ${id}`
      return id
    }
    if (!input.name || !input.body) throw invalid({ body: 'Name und Text fehlen.' })
    const [row] = await tx<
      { id: string }[]
    >`insert into text_template ${tx({ ...columns, tenant_id: tenantId })} returning id`
    return (row as { id: string }).id
  }

  app.post('/api/v1/settings/text-templates', async (request, reply) => {
    const auth = requirePermission(request, 'settings.write')
    const input = parse(textTemplateRequest, request.body)
    const template = await inTenant(services, auth, async (tx) => {
      const id = await saveText(tx, auth.tenantId, input)
      return (
        await tx<TextTemplate[]>`select ${textColumns(tx)} from text_template where id = ${id}`
      )[0]
    })
    return reply.status(201).send(template)
  })

  app.patch('/api/v1/settings/text-templates/:id', async (request) => {
    const auth = requirePermission(request, 'settings.write')
    const { id } = parse(settingsIdParam, request.params)
    const input = parse(textTemplateRequest, request.body)
    return inTenant(services, auth, async (tx) => {
      await saveText(tx, auth.tenantId, input, id)
      return (
        await tx<TextTemplate[]>`select ${textColumns(tx)} from text_template where id = ${id}`
      )[0]
    })
  })

  app.delete('/api/v1/settings/text-templates/:id', async (request, reply) => {
    const auth = requirePermission(request, 'settings.write')
    const { id } = parse(settingsIdParam, request.params)
    await inTenant(services, auth, async (tx) => {
      const deleted = await tx`delete from text_template where id = ${id}`
      if (!deleted.count) throw notFound('Die Textvorlage')
    })
    return reply.status(204).send()
  })

  // ---- Ablage-Ordnerstruktur ----

  app.get('/api/v1/settings/filing-template', async (request) => {
    const auth = requirePermission(request, 'settings.read')
    const rows = await inTenant(
      services,
      auth,
      (tx) => tx<{ name: string }[]>`select name from filing_template order by sort, name`,
    )
    return { folders: rows.map((r) => r.name) }
  })

  app.put('/api/v1/settings/filing-template', async (request) => {
    const auth = requirePermission(request, 'settings.write')
    const { folders } = parse(filingTemplateRequest, request.body)
    const unique = [...new Map(folders.map((f) => [f.toLowerCase(), f])).values()]
    return inTenant(services, auth, async (tx) => {
      // Applies to new projects; existing projects keep their folders.
      await tx`delete from filing_template`
      for (const [index, name] of unique.entries()) {
        await tx`insert into filing_template (tenant_id, name, sort) values (${auth.tenantId}, ${name}, ${(index + 1) * 10})`
      }
      return { folders: unique }
    })
  })

  // ---- DATEV ----

  app.get('/api/v1/settings/datev', async (request) => {
    const auth = requirePermission(request, 'settings.read')
    return inTenant(services, auth, datevSettings)
  })

  app.put('/api/v1/settings/datev', async (request) => {
    const auth = requirePermission(request, 'settings.write')
    const input = parse(datevSettingsRequest, request.body)
    return inTenant(services, auth, async (tx) => {
      await tx`update tenant set settings = jsonb_set(settings, '{datev}', ${tx.json(input as never)})
               where id = current_tenant_id()`
      return datevSettings(tx)
    })
  })
}
