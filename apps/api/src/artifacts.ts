import { Readable } from 'node:stream'
import type { Tx } from '@easybau/db'
import type { DocumentArchive, EinvoiceFormat, EinvoiceSummary } from '@easybau/schemas'
import { type AuthContext, type Services, servicesOf } from './context.js'
import { HttpError } from './http.js'

const MAX_ARTIFACT_BYTES = 50 * 1024 * 1024

export type ArtifactKind =
  | 'pdf'
  | 'zugferd_pdf'
  | 'zugferd_xml'
  | 'xrechnung_xml'
  | 'validation_report'
  | 'dunning_pdf'

/**
 * Archives an original of a finalized document (insert-only, SHA-256, locked for the retention
 * period from the end of the calendar year of the document: invoices and credit notes the
 * company's retention_years (default 10, § 147 AO), other documents 6 years (Handelsbriefe)). The file is
 * committed to the store inside the transaction; a rollback leaves at most an unreferenced file.
 */
export async function storeArtifact(
  tx: Tx,
  services: Services,
  auth: AuthContext,
  documentId: string,
  artifact: {
    kind: ArtifactKind
    data: Buffer
    mime: string
    format?: string | null
    validated?: boolean
    validatedAt?: string | null
    sourceArtifactId?: string | null
    /** Mahnung: the notice the PDF belongs to. */
    dunningNoticeId?: string | null
    /** Start of the retention period (default: the document date, never before finalisation) and its length in years. */
    retentionFrom?: string
    retentionYears?: number
  },
): Promise<string> {
  const pending = await services.storage.receive(Readable.from([artifact.data]), {
    maxBytes: MAX_ARTIFACT_BYTES,
  })
  try {
    const [ids] = await tx<{ id: string }[]>`select uuid_v7() as id`
    const artifactId = (ids as { id: string }).id
    const key = `${auth.tenantId}/documents/${documentId}/${artifactId}`
    const validatedAt =
      artifact.validatedAt ?? (artifact.validated ? new Date().toISOString() : null)
    await tx`
      insert into document_artifact (id, tenant_id, document_id, kind, storage_key, sha256, size_bytes,
                                     mime_type, format, validated_at, source_artifact_id, dunning_notice_id,
                                     locked_until)
      select ${artifactId}, tenant_id, id, ${artifact.kind}, ${key}, ${pending.sha256}, ${pending.sizeBytes},
             ${artifact.mime}, ${artifact.format ?? null}, ${validatedAt}::timestamptz,
             ${artifact.sourceArtifactId ?? null}, ${artifact.dunningNoticeId ?? null},
             (date_trunc('year', greatest(
                 coalesce(${artifact.retentionFrom ?? null}::date, document_date),
                 (coalesce(finalized_at, now()) at time zone 'Europe/Berlin')::date))
               + make_interval(years => 1 + coalesce(${artifact.retentionYears ?? null}::int,
                   case when type in ('invoice', 'credit_note')
                        then (select retention_years from tenant t where t.id = document.tenant_id)
                        else 6 end)) - interval '1 day')::date
      from document where id = ${documentId}`
    await pending.commit(key)
    return artifactId
  } finally {
    await pending.discard()
  }
}

/**
 * Archives a received invoice unchanged as original of the incoming invoice (P1.11), the moment it
 * arrives. Retention: 10 years from the end of the year of receipt (§ 147 AO; the receipt is never
 * earlier than the invoice date, so the period is never too short).
 */
export async function storeIncomingOriginal(
  tx: Tx,
  services: Services,
  auth: Pick<AuthContext, 'tenantId'>,
  incomingInvoiceId: string,
  original: { data: Buffer; mime: string },
): Promise<string> {
  const pending = await services.storage.receive(Readable.from([original.data]), {
    maxBytes: Math.max(MAX_ARTIFACT_BYTES, original.data.length),
  })
  try {
    const [ids] = await tx<{ id: string }[]>`select uuid_v7() as id`
    const artifactId = (ids as { id: string }).id
    const key = `${auth.tenantId}/incoming/${incomingInvoiceId}/${artifactId}`
    await tx`
      insert into document_artifact (id, tenant_id, incoming_invoice_id, kind, storage_key, sha256,
                                     size_bytes, mime_type, locked_until)
      select ${artifactId}, tenant_id, id, 'incoming_original', ${key}, ${pending.sha256},
             ${pending.sizeBytes}, ${original.mime},
             (date_trunc('year', (received_at at time zone 'Europe/Berlin')::date)
               + make_interval(years => 1 + (select retention_years from tenant t
                                              where t.id = incoming_invoice.tenant_id))
               - interval '1 day')::date
      from incoming_invoice where id = ${incomingInvoiceId}`
    await pending.commit(key)
    return artifactId
  } finally {
    await pending.discard()
  }
}

/**
 * Originals of a document anonymised after its retention period (C.12, migration 0047) are gone:
 * no download, no new rendering, no e-mail.
 */
export async function assertNotPurged(tx: Tx, documentId: string): Promise<void> {
  const [row] = await tx<{ purged: boolean }[]>`
    select purged_at is not null as purged from document where id = ${documentId}`
  if (row?.purged) {
    throw new HttpError(
      410,
      'Der Beleg wurde nach Ablauf der Aufbewahrungsfrist anonymisiert; die Originale sind gelöscht.',
    )
  }
}

/**
 * Opens an archived original: the working copy in the files volume, or – if that is gone (e.g.
 * after restoring only the database) – the WORM copy from the archive (ADR 0008).
 */
export async function openArtifact(services: Services, key: string): Promise<Readable | null> {
  if ((await services.storage.size(key)) !== null) return services.storage.read(key)
  const archived = services.archive ? await services.archive.get(key) : null
  return archived ? Readable.from([archived]) : null
}

/** Reads a stored artifact completely (XML, report). */
export async function readArtifact(services: Services, key: string): Promise<Buffer> {
  const stream = await openArtifact(services, key)
  if (!stream) throw new Error(`artifact ${key} is missing in the files volume and the archive`)
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks)
}

/** Archive state of a finalized document's originals (for the detail view). */
export async function archiveSummary(tx: Tx, documentId: string): Promise<DocumentArchive | null> {
  const [row] = await tx<
    { total: number; archived: number; retainUntil: string | null; archivedAt: string | null }[]
  >`
    select count(*)::int as total, count(r.artifact_id)::int as archived,
           to_char(min(a.locked_until), 'YYYY-MM-DD') as "retainUntil",
           to_char(max(r.archived_at) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "archivedAt"
    from document_artifact a left join artifact_archive r on r.artifact_id = a.id
    where a.document_id = ${documentId}`
  if (!row?.total) return null
  return {
    enabled: Boolean(servicesOf(tx)?.archive),
    files: row.total,
    archived: row.archived,
    retainUntil: row.retainUntil,
    archivedAt: row.archived === row.total ? row.archivedAt : null,
  }
}

/** Validated e-invoice XML files of a finalized invoice (ZUGFeRD first). */
export async function einvoiceSummary(tx: Tx, documentId: string): Promise<EinvoiceSummary | null> {
  const rows = await tx<
    { id: string; format: EinvoiceFormat; validatedAt: string; sizeBytes: string; sha256: string }[]
  >`
    select id, format, to_char(validated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "validatedAt",
           size_bytes::text as "sizeBytes", encode(sha256, 'hex') as sha256
    from document_artifact
    where document_id = ${documentId} and kind in ('zugferd_xml', 'xrechnung_xml')
    order by kind = 'zugferd_xml' desc, format, created_at`
  if (!rows.length) return null
  return {
    files: rows.map((r) => ({
      format: r.format,
      validatedAt: r.validatedAt,
      sizeBytes: Number(r.sizeBytes),
      sha256: r.sha256,
    })),
  }
}
