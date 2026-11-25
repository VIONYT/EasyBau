import type { Tx } from '@opc/db'
import { erasureAction } from '@opc/domain'
import { type ContactPrivacy, type EraseContactResult, eraseContactRequest } from '@opc/schemas'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { inTenant, requirePermission, type Services } from '../context.js'
import { HttpError, notFound, parse } from '../http.js'
import { todayOf } from './receivables.js'

const idParam = z.object({ id: z.uuid('Ungültige ID.') })

const ISO = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`

async function privacyOf(tx: Tx, id: string): Promise<ContactPrivacy> {
  const [row] = await tx<(Omit<ContactPrivacy, 'action' | 'usage'> & ContactPrivacy['usage'])[]>`
    select to_char(contact_retention_end(c.id), 'YYYY-MM-DD') as "retentionEnd",
           to_char(c.blocked_at at time zone 'UTC', ${tx.unsafe(ISO)}) as "blockedAt",
           to_char(c.blocked_until, 'YYYY-MM-DD') as "blockedUntil",
           to_char(c.erased_at at time zone 'UTC', ${tx.unsafe(ISO)}) as "erasedAt",
           (select count(*)::int from project p where p.customer_id = c.id) as projects,
           (select count(*)::int from document d
             where d.contact_id = c.id or d.contact_person_id = c.id) as documents,
           (select count(*)::int from document d
             where (d.contact_id = c.id or d.contact_person_id = c.id) and d.status <> 'draft')
             as "finalizedDocuments",
           (select count(*)::int from incoming_invoice i where i.contact_id = c.id) as "incomingInvoices",
           (select count(*)::int from file f join project p on p.id = f.project_id
             where p.customer_id = c.id) as files,
           (select count(*)::int from report r join project p on p.id = r.project_id
             where p.customer_id = c.id) as reports
    from contact c where c.id = ${id}`
  if (!row) throw notFound('Der Kontakt')
  const { projects, documents, finalizedDocuments, incomingInvoices, files, reports, ...rest } = row
  return {
    ...rest,
    action: erasureAction(rest.retentionEnd, todayOf(tx)).action,
    usage: { projects, documents, finalizedDocuments, incomingInvoices, files, reports },
  }
}

/** Fixed parts of the Auskunft (Art. 15 Abs. 1 lit. a–h DSGVO); the firm adapts them if needed. */
const REPORT_NOTES = {
  Zwecke:
    'Anbahnung und Abwicklung von Aufträgen (Angebote, Aufträge, Leistungserbringung, Abrechnung, Mahnwesen) sowie Erfüllung gesetzlicher Aufbewahrungspflichten.',
  Rechtsgrundlagen:
    'Art. 6 Abs. 1 lit. b DSGVO (Vertrag und vorvertragliche Maßnahmen), Art. 6 Abs. 1 lit. c DSGVO i. V. m. § 147 AO und § 257 HGB (Aufbewahrungspflichten).',
  Empfänger:
    'Steuerberatung (Buchhaltungsexport), Finanzverwaltung im Rahmen einer Außenprüfung, Rechnungsempfänger-Plattformen bei E-Rechnungen; E-Mails über den eigenen E-Mail-Server der Firma.',
  Speicherdauer:
    'Bis zum Ende der gesetzlichen Aufbewahrungsfrist der Belege, in denen Sie genannt sind (siehe „Aufbewahrung bis“), sonst bis zur Erledigung des Zwecks.',
  Rechte:
    'Berichtigung (Art. 16), Löschung (Art. 17), Einschränkung der Verarbeitung (Art. 18), Datenübertragbarkeit (Art. 20), Widerspruch (Art. 21), Beschwerde bei einer Datenschutz-Aufsichtsbehörde (Art. 77).',
  Herkunft: 'Von Ihnen selbst bzw. von Ihrem Auftraggeber angegeben.',
}

export function registerPrivacyRoutes(app: FastifyInstance, services: Services) {
  app.get('/api/v1/contacts/:id/privacy', async (request): Promise<ContactPrivacy> => {
    const auth = requirePermission(request, 'contacts.read')
    const { id } = parse(idParam, request.params)
    return inTenant(services, auth, (tx) => privacyOf(tx, id))
  })

  // Löschen (Art. 17): erase now, or block until the retention period ends (Art. 18).
  app.post('/api/v1/contacts/:id/erase', async (request): Promise<EraseContactResult> => {
    const auth = requirePermission(request, 'contacts.write')
    const { id } = parse(idParam, request.params)
    parse(eraseContactRequest, request.body)
    return inTenant(services, auth, async (tx) => {
      await tx`select 1 from contact where id = ${id} for update`
      const privacy = await privacyOf(tx, id)
      if (privacy.erasedAt) throw new HttpError(409, 'Der Kontakt ist bereits gelöscht.')
      const decision = erasureAction(privacy.retentionEnd, todayOf(tx))
      if (decision.action === 'erase') {
        await tx`select erase_contact(${id})`
        await tx`insert into audit_event (tenant_id, actor_user_id, action, entity, entity_id, hash)
                 values (${auth.tenantId}, ${auth.userId}, 'privacy_erase', 'contact', ${id}, ''::bytea)`
        return { result: 'erased', blockedUntil: null }
      }
      await tx`
        update contact set blocked_at = coalesce(blocked_at, now()), blocked_until = ${decision.until},
                           archived_at = coalesce(archived_at, now())
        where id = ${id}`
      await tx`insert into audit_event (tenant_id, actor_user_id, action, entity, entity_id, hash)
               values (${auth.tenantId}, ${auth.userId}, 'privacy_block', 'contact', ${id}, ''::bytea)`
      return { result: 'blocked', blockedUntil: decision.until }
    })
  })

  // Auskunft (Art. 15) and Datenübertragbarkeit (Art. 20): everything stored about the contact.
  app.get('/api/v1/contacts/:id/privacy-report', async (request, reply) => {
    const auth = requirePermission(request, 'contacts.write')
    requirePermission(request, 'document.read')
    const { id } = parse(idParam, request.params)
    const report = await inTenant(services, auth, async (tx) => {
      const [contact] = await tx<Record<string, unknown>[]>`
        select number as "Kundennummer", kind as "Art", organization_name as "Firma",
               salutation as "Anrede", title as "Titel", first_name as "Vorname",
               last_name as "Nachname", website as "Website", description as "Notiz",
               vat_id as "USt-IdNr.", buyer_reference as "Leitweg-ID",
               einvoice_email as "E-Mail für E-Rechnungen", creditor_number as "Kreditorennummer",
               to_char(created_at at time zone 'Europe/Berlin', 'YYYY-MM-DD') as "Angelegt am",
               to_char(archived_at at time zone 'Europe/Berlin', 'YYYY-MM-DD') as "Archiviert am",
               to_char(blocked_until, 'YYYY-MM-DD') as "Gesperrt bis",
               to_char(erased_at at time zone 'Europe/Berlin', 'YYYY-MM-DD') as "Gelöscht am"
        from contact where id = ${id}`
      if (!contact) throw notFound('Der Kontakt')
      const privacy = await privacyOf(tx, id)
      const [company] = await tx<{ name: string; address: string | null; email: string | null }[]>`
        select name, nullif(concat_ws(', ', street, concat_ws(' ', postal_code, city)), '') as address,
               email from tenant where id = current_tenant_id()`
      const addresses = await tx`
        select kind as "Art", recipient_block as "Empfänger", street as "Straße",
               street_extra as "Zusatz", postal_code as "PLZ", city as "Ort", country_code as "Land"
        from contact_address where contact_id = ${id} order by kind`
      const channels = await tx`
        select kind as "Art", value as "Wert", label as "Bezeichnung"
        from contact_channel where contact_id = ${id} order by kind, value`
      const links = await tx`
        select other.display_name as "Name", l.role as "Rolle"
        from contact_link l
        join contact other on other.id = case when l.person_id = ${id} then l.organization_id else l.person_id end
        where l.person_id = ${id} or l.organization_id = ${id}`
      const projects = await tx`
        select number as "Nummer", name as "Name",
               nullif(concat_ws(', ', site_street, concat_ws(' ', site_postal_code, site_city)), '') as "Baustelle"
        from project where customer_id = ${id} order by created_at`
      const documents = await tx`
        select d.type as "Art", d.number as "Nummer", to_char(d.document_date, 'YYYY-MM-DD') as "Datum",
               d.status as "Status", d.subject as "Betreff",
               to_char(a.locked_until, 'YYYY-MM-DD') as "Aufbewahrung bis"
        from document d
        left join lateral (select max(locked_until) as locked_until from document_artifact
                           where document_id = d.id) a on true
        where d.contact_id = ${id} or d.contact_person_id = ${id}
        order by d.document_date, d.number`
      const incoming = await tx`
        select i.invoice_number as "Rechnungsnummer", to_char(i.invoice_date, 'YYYY-MM-DD') as "Datum",
               i.status as "Status", i.supplier_name as "Lieferant"
        from incoming_invoice i where i.contact_id = ${id} order by i.invoice_date`
      const emails = await tx`
        select m.to_address as "An", m.subject as "Betreff", m.status as "Status",
               to_char(coalesce(m.sent_at, m.created_at) at time zone 'Europe/Berlin', 'YYYY-MM-DD HH24:MI') as "Zeit"
        from email_message m
        where m.document_id in (select d.id from document d where d.contact_id = ${id})
           or lower(m.to_address) in (select lower(value) from contact_channel
                                      where contact_id = ${id} and kind = 'email')
        order by m.created_at`
      await tx`insert into audit_event (tenant_id, actor_user_id, action, entity, entity_id, hash)
               values (${auth.tenantId}, ${auth.userId}, 'privacy_report', 'contact', ${id}, ''::bytea)`
      return {
        'Auskunft nach Art. 15 DSGVO': {
          Verantwortlicher: company,
          'Erstellt am': todayOf(tx),
          'Aufbewahrung bis': privacy.retentionEnd,
        },
        Stammdaten: contact,
        Anschriften: addresses,
        Kommunikation: channels,
        'Verknüpfte Kontakte': links,
        Projekte: projects,
        Dokumente: documents,
        Eingangsrechnungen: incoming,
        'E-Mails': emails,
        Hinweise: REPORT_NOTES,
      }
    })
    const date = report['Auskunft nach Art. 15 DSGVO']['Erstellt am']
    return reply
      .header('content-type', 'application/json; charset=utf-8')
      .header('content-disposition', `attachment; filename="Auskunft_DSGVO_${date}.json"`)
      .header('cache-control', 'no-store')
      .send(JSON.stringify(report, null, 2))
  })
}
