import type { Tx } from '@opc/db'
import {
  addDays,
  type BaseRate,
  baseRateOn,
  type DunningLevel,
  dunningAmounts,
  germanDate,
  type LetterheadValues,
  nextDunningLevel,
} from '@opc/domain'
import {
  DUNNING_TITLE,
  type DunningLetterSnapshot,
  documentTitle,
  dunningLetter,
  fillDunningText,
  renderLetterPdf,
} from '@opc/pdf-templates'
import {
  type BaseInterestRate,
  baseInterestRateRequest,
  type CreateDunningRequest,
  createDunningRequest,
  DEFAULT_DUNNING_SETTINGS,
  type DocumentDetail,
  type DunningAmounts,
  type DunningNotice,
  type DunningOverview,
  type DunningSettings,
  dunningSettingsRequest,
  sendDunningRequest,
} from '@opc/schemas'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { openArtifact, storeArtifact } from '../artifacts.js'
import { type AuthContext, inTenant, requirePermission, type Services } from '../context.js'
import { HttpError, notFound, parse } from '../http.js'
import { liveIssuer, loadDocument } from './documents.js'
import { queueEmail } from './email.js'
import { contentDisposition, logoFor } from './pdf.js'
import { todayIn, todayOf } from './receivables.js'

const idParam = z.object({ id: z.uuid('Ungültige ID.') })

/** Mahnungen are Handelsbriefe: kept 6 years from the end of the year (§ 257 HGB, § 147 AO). */
const DUNNING_RETENTION_YEARS = 6

export async function dunningSettings(tx: Tx): Promise<DunningSettings> {
  const [row] = await tx<{ dunning: Partial<DunningSettings> | null }[]>`
    select settings -> 'dunning' as dunning from tenant where id = current_tenant_id()`
  const stored = row?.dunning ?? {}
  const d = DEFAULT_DUNNING_SETTINGS
  return {
    reminder: { ...d.reminder, ...(stored.reminder ?? {}) },
    first: { ...d.first, ...(stored.first ?? {}) },
    final: { ...d.final, ...(stored.final ?? {}) },
    flatFeeBusiness: stored.flatFeeBusiness ?? d.flatFeeBusiness,
  }
}

/** Basiszinssätze: shipped rows, a company's own row wins on the same date. */
async function baseRates(tx: Tx): Promise<BaseInterestRate[]> {
  const rows = await tx<BaseInterestRate[]>`
    select id, to_char(valid_from, 'YYYY-MM-DD') as "validFrom", rate_percent::text as "ratePercent",
           tenant_id is not null as own
    from base_interest_rate order by valid_from, tenant_id nulls first`
  const byDate = new Map<string, BaseInterestRate>()
  for (const row of rows) byDate.set(row.validFrom, row)
  return [...byDate.values()]
}

interface NoticeRow {
  id: string
  level: DunningLevel
  noticeDate: string
  dueDate: string
  fee: string
  flatFee: string
  interest: string
  rate: string
  interestFrom: string | null
  interestTo: string | null
  open: string
  earlier: string
  total: string
  business: boolean
  createdAt: string
  createdBy: string | null
  emailTo: string | null
  emailStatus: 'queued' | 'sending' | 'sent' | 'failed' | null
  emailSentAt: string | null
}

async function noticesOf(tx: Tx, invoiceId: string): Promise<DunningNotice[]> {
  const rows = await tx<NoticeRow[]>`
    select n.id, n.level, to_char(n.notice_date, 'YYYY-MM-DD') as "noticeDate",
           to_char(n.due_date, 'YYYY-MM-DD') as "dueDate", n.fee_cents::text as fee,
           n.flat_fee_cents::text as "flatFee", n.interest_cents::text as interest,
           round(n.interest_rate_percent, 2)::text as rate,
           to_char(n.interest_from, 'YYYY-MM-DD') as "interestFrom",
           to_char(n.interest_to, 'YYYY-MM-DD') as "interestTo",
           n.open_amount_cents::text as open, n.earlier_charges_cents::text as earlier,
           n.total_cents::text as total, n.business,
           to_char(n.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "createdAt",
           u.display_name as "createdBy",
           m.to_address as "emailTo", m.status as "emailStatus",
           to_char(m.sent_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "emailSentAt"
    from dunning_notice n
    left join app_user u on u.id = n.created_by
    left join lateral (
      select to_address, status, sent_at from email_message
      where dunning_notice_id = n.id order by created_at desc limit 1) m on true
    where n.invoice_id = ${invoiceId}
    order by n.created_at`
  return rows.map((r) => ({
    id: r.id,
    level: r.level,
    noticeDate: r.noticeDate,
    dueDate: r.dueDate,
    business: r.business,
    openCents: Number(r.open),
    feeCents: Number(r.fee),
    flatFeeCents: Number(r.flatFee),
    interestCents: Number(r.interest),
    interestRatePercent: r.rate,
    interestFrom: r.interestFrom,
    interestTo: r.interestTo,
    earlierChargesCents: Number(r.earlier),
    totalCents: Number(r.total),
    createdAt: r.createdAt,
    createdBy: r.createdBy,
    email:
      r.emailTo && r.emailStatus
        ? { to: r.emailTo, status: r.emailStatus, sentAt: r.emailSentAt }
        : null,
  }))
}

const LEVEL_IN_TEXT: Record<DunningLevel, string> = {
  reminder: 'der Zahlungserinnerung',
  first: 'der 1. Mahnung',
  final: 'der letzten Mahnung',
}

/** The next notice with the given (or configured) values, or the reason why there is none. */
async function planNext(
  tx: Tx,
  doc: DocumentDetail,
  notices: DunningNotice[],
  input: CreateDunningRequest,
  today: string,
): Promise<{ amounts: DunningAmounts | null; blocked: string | null }> {
  const none = (blocked: string) => ({ amounts: null, blocked })
  if (
    doc.type !== 'invoice' ||
    !doc.finalizedAt ||
    !doc.number ||
    doc.invoiceKind === 'cancellation' ||
    doc.status === 'cancelled' ||
    !doc.receivable
  ) {
    return none('Mahnungen gibt es nur zu festgeschriebenen, nicht stornierten Rechnungen.')
  }
  if (doc.receivable.openCents <= 0) return none('Die Rechnung ist vollständig bezahlt.')
  const level = nextDunningLevel(notices.map((n) => n.level))
  if (!level) return none('Die letzte Mahnung ist bereits erstellt.')
  const noticeDate = input.noticeDate ?? today
  if (noticeDate > today) return none('Das Datum der Mahnung liegt in der Zukunft.')
  const due = doc.dueDate ?? doc.documentDate
  if (noticeDate <= due) {
    return none(`Die Rechnung ist erst am ${germanDate(due)} fällig.`)
  }
  const previous = notices.at(-1)
  if (previous && noticeDate <= previous.dueDate) {
    return none(
      `Die Frist ${LEVEL_IN_TEXT[previous.level]} läuft noch bis zum ${germanDate(previous.dueDate)}.`,
    )
  }
  const settings = await dunningSettings(tx)
  const rule = settings[level]
  const reminder = notices.find((n) => n.level === 'reminder')
  const business = input.business ?? !doc.recipient?.private
  const interest = input.interest ?? rule.interest
  // Verzug begins at the latest when the deadline of the Zahlungserinnerung has passed.
  const interestFrom =
    input.interestFrom !== undefined
      ? input.interestFrom
      : reminder
        ? addDays(reminder.dueDate, 1)
        : null
  const rates: BaseRate[] = (await baseRates(tx)).map((r) => ({
    validFrom: r.validFrom,
    ratePercent: r.ratePercent,
  }))
  const days = input.days ?? rule.days
  let result: ReturnType<typeof dunningAmounts>
  try {
    if (interest && interestFrom) baseRateOn(interestFrom, rates)
    result = dunningAmounts({
      level,
      noticeDate,
      openCents: BigInt(doc.receivable.openCents),
      business,
      rule: { days, feeCents: BigInt(input.feeCents ?? rule.feeCents), interest },
      interestFrom: interestFrom ?? null,
      // Payments and deductions during the Verzug: interest on the higher amount until then.
      paymentsSinceInterestFrom: interestFrom
        ? [
            ...doc.receivable.payments.map((p) => ({ date: p.paidOn, amountCents: p.amountCents })),
            ...doc.receivable.adjustments.map((a) => ({
              date: todayIn(Date.parse(a.createdAt)),
              amountCents: a.amountCents,
            })),
          ]
            .filter((p) => p.date >= interestFrom)
            .map((p) => ({ date: p.date, amountCents: BigInt(p.amountCents) }))
        : [],
      baseRates: rates,
      flatFee: input.flatFee ?? settings.flatFeeBusiness,
      earlierChargesCents: notices.reduce(
        (sum, n) => sum + BigInt(n.feeCents) + BigInt(n.flatFeeCents),
        0n,
      ),
      flatFeeCharged: notices.some((n) => n.flatFeeCents > 0),
    })
  } catch (error) {
    throw new HttpError(
      409,
      `${(error as Error).message} Bitte unter Einstellungen › Mahnungen ergänzen.`,
    )
  }
  const totalCents = Number(result.totalCents)
  const amounts: DunningAmounts = {
    level,
    noticeDate,
    dueDate: result.dueDate,
    days,
    business,
    interest,
    openCents: doc.receivable.openCents,
    feeCents: Number(result.feeCents),
    flatFeeCents: Number(result.flatFeeCents),
    interestCents: Number(result.interestCents),
    interestRatePercent: result.interestRatePercent,
    interestFrom: result.interestFrom,
    interestTo: result.interestTo,
    segments: result.segments.map((seg) => ({
      ...seg,
      principalCents: Number(seg.principalCents),
    })),
    earlierChargesCents: Number(result.earlierChargesCents),
    totalCents,
    text: fillDunningText(input.text ?? rule.text, {
      number: doc.number,
      documentDate: doc.documentDate,
      dueDate: result.dueDate,
      totalCents,
    }),
  }
  return { amounts, blocked: null }
}

async function suggestedEmail(tx: Tx, doc: DocumentDetail): Promise<string | null> {
  if (!doc.contact) return doc.recipient?.einvoiceEmail ?? null
  const [row] = await tx<{ email: string | null }[]>`
    select coalesce(
      (select value from contact_channel where contact_id = ${doc.contact.id} and kind = 'email'
       order by is_primary desc, id limit 1),
      (select einvoice_email from contact where id = ${doc.contact.id})) as email`
  return row?.email ?? null
}

async function loadInvoice(tx: Tx, auth: AuthContext, id: string): Promise<DocumentDetail> {
  const doc = await loadDocument(tx, auth, id)
  if (!doc) throw notFound('Die Rechnung')
  return doc
}

const pdfName = (level: DunningLevel, number: string) =>
  `${DUNNING_TITLE[level].replace(/\s+/g, '_').replace(/\./g, '')}_${number}.pdf`

function mailText(
  level: DunningLevel,
  number: string,
  amounts: { totalCents: number; dueDate: string },
  company: string,
  message: string | null | undefined,
): string {
  const euro = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(
    amounts.totalCents / 100,
  )
  return (
    message ??
    `Sehr geehrte Damen und Herren,\n\nanbei erhalten Sie unsere ${DUNNING_TITLE[level]} zur Rechnung ${number}. Bitte überweisen Sie ${euro} bis zum ${germanDate(amounts.dueDate)}.\n\nMit freundlichen Grüßen\n${company}\n`
  )
}

/** Queues the archived PDF of a notice as e-mail attachment. */
async function queueNoticeEmail(
  tx: Tx,
  services: Services,
  auth: AuthContext,
  notice: { id: string; level: DunningLevel; totalCents: number; dueDate: string },
  number: string,
  mail: { to: string; message?: string | null | undefined },
): Promise<void> {
  if (!services.config.SMTP_ENABLED) {
    throw new HttpError(
      409,
      'Der E-Mail-Versand ist nicht eingerichtet (SMTP_HOST und SMTP_FROM in der .env). Bitte das PDF herunterladen und selbst versenden.',
    )
  }
  const [artifact] = await tx<{ id: string }[]>`
    select id from document_artifact where dunning_notice_id = ${notice.id}`
  if (!artifact) throw notFound('Das PDF der Mahnung')
  const [company] = await tx<
    { name: string }[]
  >`select name from tenant where id = current_tenant_id()`
  await queueEmail(tx, auth, {
    kind: 'dunning',
    to: mail.to,
    subject: `${DUNNING_TITLE[notice.level]} zur Rechnung ${number}${company?.name ? ` – ${company.name}` : ''}`,
    text: mailText(notice.level, number, notice, company?.name ?? '', mail.message),
    attachments: [{ artifactId: artifact.id, filename: pdfName(notice.level, number) }],
    dunningNoticeId: notice.id,
  })
}

export function registerDunningRoutes(app: FastifyInstance, services: Services) {
  app.get('/api/v1/documents/:id/dunning', async (request): Promise<DunningOverview> => {
    const auth = requirePermission(request, 'document.read')
    const { id } = parse(idParam, request.params)
    return inTenant(services, auth, async (tx) => {
      const doc = await loadInvoice(tx, auth, id)
      const notices = await noticesOf(tx, id)
      const { amounts, blocked } = await planNext(tx, doc, notices, {}, todayOf(tx))
      return {
        notices,
        next: amounts,
        blocked,
        emailEnabled: services.config.SMTP_ENABLED,
        suggestedEmail: await suggestedEmail(tx, doc),
      }
    })
  })

  // Preview with changed values (no side effects).
  app.post('/api/v1/documents/:id/dunning/preview', async (request) => {
    const auth = requirePermission(request, 'dunning.write')
    const { id } = parse(idParam, request.params)
    const input = parse(createDunningRequest, request.body)
    return inTenant(services, auth, async (tx) => {
      const doc = await loadInvoice(tx, auth, id)
      const { amounts, blocked } = await planNext(
        tx,
        doc,
        await noticesOf(tx, id),
        input,
        todayOf(tx),
      )
      if (!amounts) throw new HttpError(409, blocked as string)
      return amounts
    })
  })

  // Issues the next notice: amounts and letter are frozen, the PDF/A is archived, optionally mailed.
  app.post('/api/v1/documents/:id/dunning', async (request, reply) => {
    const auth = requirePermission(request, 'dunning.write')
    const { id } = parse(idParam, request.params)
    const input = parse(createDunningRequest, request.body)
    const notice = await inTenant(services, auth, async (tx) => {
      await tx`select id from document where id = ${id} for update`
      const doc = await loadInvoice(tx, auth, id)
      const notices = await noticesOf(tx, id)
      const { amounts, blocked } = await planNext(tx, doc, notices, input, todayOf(tx))
      if (!amounts) throw new HttpError(409, blocked as string)
      const issuer = await liveIssuer(tx)
      const { text, ...frozen } = amounts
      const snapshot: DunningLetterSnapshot = {
        issuer: {
          name: issuer.name,
          layout: issuer.letterhead,
          values: (issuer.values ?? {}) as LetterheadValues,
          iban: issuer.einvoice?.iban ?? issuer.values?.IBAN ?? null,
          bic: issuer.einvoice?.bic ?? issuer.values?.BIC ?? null,
        },
        recipient: doc.recipient ? [doc.recipient.name, ...doc.recipient.lines] : [],
        customerNumber: doc.recipient?.customerNumber ?? null,
        invoice: {
          number: doc.number as string,
          title: documentTitle(doc),
          documentDate: doc.documentDate,
          dueDate: doc.dueDate,
          subject: doc.subject,
          placeOfPerformance: doc.placeOfPerformance,
          grossCents: doc.totals.grossCents,
        },
        amounts: frozen,
        text,
        signer: auth.displayName,
      }
      const [row] = await tx<{ id: string }[]>`
        insert into dunning_notice (tenant_id, invoice_id, level, notice_date, due_date, fee_cents,
                                    interest_rate_percent, interest_cents, flat_fee_cents, open_amount_cents,
                                    letter_snapshot, sent_at, created_by, business, interest_from,
                                    interest_to, earlier_charges_cents, total_cents)
        values (${auth.tenantId}, ${id}, ${amounts.level}, ${amounts.noticeDate}::date, ${amounts.dueDate}::date,
                ${amounts.feeCents}, ${amounts.interestRatePercent}::numeric, ${amounts.interestCents},
                ${amounts.flatFeeCents}, ${amounts.openCents}, ${tx.json(snapshot as never)}, now(),
                ${auth.userId}, ${amounts.business}, ${amounts.interestFrom}::date, ${amounts.interestTo}::date,
                ${amounts.earlierChargesCents}, ${amounts.totalCents})
        returning id`
      const noticeId = (row as { id: string }).id
      const { logoPosition, ...letter } = dunningLetter(snapshot)
      const pdf = renderLetterPdf(
        { ...letter, logo: await logoFor(tx, services, logoPosition) },
        { createdAt: new Date(services.now()) },
      )
      await storeArtifact(tx, services, auth, id, {
        kind: 'dunning_pdf',
        data: pdf,
        mime: 'application/pdf',
        dunningNoticeId: noticeId,
        retentionFrom: amounts.noticeDate,
        retentionYears: DUNNING_RETENTION_YEARS,
      })
      if (input.email) {
        await queueNoticeEmail(
          tx,
          services,
          auth,
          { ...amounts, id: noticeId },
          doc.number as string,
          input.email,
        )
      }
      return (await noticesOf(tx, id)).find((n) => n.id === noticeId) as DunningNotice
    })
    return reply.status(201).send(notice)
  })

  app.post('/api/v1/dunning-notices/:id/email', async (request, reply) => {
    const auth = requirePermission(request, 'dunning.write')
    const { id } = parse(idParam, request.params)
    const input = parse(sendDunningRequest, request.body)
    await inTenant(services, auth, async (tx) => {
      const [notice] = await tx<
        { invoiceId: string; level: DunningLevel; total: string; dueDate: string; number: string }[]
      >`
        select n.invoice_id as "invoiceId", n.level, n.total_cents::text as total,
               to_char(n.due_date, 'YYYY-MM-DD') as "dueDate", d.number
        from dunning_notice n join document d on d.id = n.invoice_id where n.id = ${id}`
      if (!notice || !(await loadDocument(tx, auth, notice.invoiceId))) {
        throw notFound('Die Mahnung')
      }
      await queueNoticeEmail(
        tx,
        services,
        auth,
        { id, level: notice.level, totalCents: Number(notice.total), dueDate: notice.dueDate },
        notice.number,
        input,
      )
    })
    return reply.status(202).send({ queued: true })
  })

  app.get('/api/v1/dunning-notices/:id/pdf', async (request, reply) => {
    const auth = requirePermission(request, 'document.read')
    const { id } = parse(idParam, request.params)
    const file = await inTenant(services, auth, async (tx) => {
      const [row] = await tx<
        { invoiceId: string; key: string; level: DunningLevel; number: string }[]
      >`
        select n.invoice_id as "invoiceId", a.storage_key as key, n.level, d.number
        from dunning_notice n
        join document_artifact a on a.dunning_notice_id = n.id
        join document d on d.id = n.invoice_id
        where n.id = ${id}`
      // Project visibility via the invoice.
      if (!row || !(await loadDocument(tx, auth, row.invoiceId))) return null
      const data = await openArtifact(services, row.key)
      return data ? { data, filename: pdfName(row.level, row.number) } : null
    })
    if (!file) throw notFound('Das PDF der Mahnung')
    return reply
      .header('content-type', 'application/pdf')
      .header('content-disposition', contentDisposition(file.filename))
      .header('cache-control', 'private, no-store')
      .header('x-content-type-options', 'nosniff')
      .send(file.data)
  })

  // ---- Einstellungen › Mahnungen ----

  app.get('/api/v1/settings/dunning', async (request) => {
    const auth = requirePermission(request, 'settings.read')
    return inTenant(services, auth, dunningSettings)
  })

  app.put('/api/v1/settings/dunning', async (request) => {
    const auth = requirePermission(request, 'settings.write')
    const input = parse(dunningSettingsRequest, request.body)
    return inTenant(services, auth, async (tx) => {
      await tx`update tenant set settings = jsonb_set(settings, '{dunning}', ${tx.json(input as never)})
               where id = current_tenant_id()`
      return dunningSettings(tx)
    })
  })

  app.get('/api/v1/settings/base-interest-rates', async (request) => {
    const auth = requirePermission(request, 'settings.read')
    return inTenant(services, auth, async (tx) => (await baseRates(tx)).reverse())
  })

  app.post('/api/v1/settings/base-interest-rates', async (request, reply) => {
    const auth = requirePermission(request, 'settings.write')
    const input = parse(baseInterestRateRequest, request.body)
    const rates = await inTenant(services, auth, async (tx) => {
      const [exists] = await tx`
        select 1 from base_interest_rate where tenant_id = ${auth.tenantId} and valid_from = ${input.validFrom}::date`
      if (exists) {
        throw new HttpError(
          409,
          'Für dieses Datum ist bereits ein eigener Basiszinssatz eingetragen.',
          {
            validFrom: 'Datum bereits vorhanden.',
          },
        )
      }
      await tx`
        insert into base_interest_rate (tenant_id, valid_from, rate_percent, created_by)
        values (${auth.tenantId}, ${input.validFrom}::date, ${input.ratePercent}::numeric, ${auth.userId})`
      return (await baseRates(tx)).reverse()
    })
    return reply.status(201).send(rates)
  })

  app.delete('/api/v1/settings/base-interest-rates/:id', async (request) => {
    const auth = requirePermission(request, 'settings.write')
    const { id } = parse(idParam, request.params)
    return inTenant(services, auth, async (tx) => {
      const deleted =
        await tx`delete from base_interest_rate where id = ${id} and tenant_id = ${auth.tenantId}`
      if (!deleted.count) throw notFound('Der eigene Basiszinssatz')
      return (await baseRates(tx)).reverse()
    })
  })
}
