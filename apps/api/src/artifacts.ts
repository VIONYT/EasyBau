import { Readable } from 'node:stream'
import type { Tx } from '@opc/db'
import type { AuthContext, Services } from './context.js'

const MAX_ARTIFACT_BYTES = 50 * 1024 * 1024

export type ArtifactKind =
  | 'pdf'
  | 'zugferd_pdf'
  | 'zugferd_xml'
  | 'xrechnung_xml'
  | 'validation_report'

/**
 * Archives an original of a finalized document (insert-only, SHA-256, locked for the retention
 * period: 10 years from the end of the calendar year of the document, § 147 AO). The file is
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
                                     mime_type, format, validated_at, source_artifact_id, locked_until)
      select ${artifactId}, tenant_id, id, ${artifact.kind}, ${key}, ${pending.sha256}, ${pending.sizeBytes},
             ${artifact.mime}, ${artifact.format ?? null}, ${validatedAt}::timestamptz,
             ${artifact.sourceArtifactId ?? null},
             (date_trunc('year', document_date) + interval '11 years' - interval '1 day')::date
      from document where id = ${documentId}`
    await pending.commit(key)
    return artifactId
  } finally {
    await pending.discard()
  }
}

/** Reads a stored artifact completely (XML, report). */
export async function readArtifact(services: Services, key: string): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of services.storage.read(key)) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks)
}
