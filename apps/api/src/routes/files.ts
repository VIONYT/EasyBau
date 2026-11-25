import { Readable } from 'node:stream'
import type { Tx } from '@easybau/db'
import {
  type FileSummary,
  type FolderSummary,
  fileListQuery,
  folderRequest,
  updateFileRequest,
  uploadQuery,
} from '@easybau/schemas'
import {
  detectFileType,
  extensionOf,
  sanitizeFilename,
  TooLargeError,
  typeOfMime,
} from '@easybau/storage'
import type { FastifyInstance, FastifyRequest } from 'fastify'
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
import { HttpError, notFound, parse } from '../http.js'

const projectParam = z.object({ id: z.uuid('Ungültige ID.') })
const folderParam = z.object({ id: z.uuid('Ungültige ID.'), folderId: z.uuid('Ungültige ID.') })
const fileParam = z.object({ id: z.uuid('Ungültige ID.') })
const contentQuery = z.object({ download: z.enum(['1', 'true']).optional() })

const TS = (tx: Tx, column: string) =>
  tx`to_char(${tx.unsafe(column)} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`

interface FileRow extends Omit<FileSummary, 'category' | 'inline' | 'canDelete'> {
  uploadedById: string | null
  storageKey: string
}

function fileColumns(tx: Tx) {
  return tx`
    f.id, f.project_id as "projectId", f.folder_id as "folderId", f.filename, f.mime_type as "mimeType",
    f.size_bytes::float8 as "sizeBytes", f.caption, f.is_evidence as "isEvidence", f.storage_key as "storageKey",
    f.uploaded_by as "uploadedById", ${TS(tx, 'f.created_at')} as "createdAt",
    case when u.id is null then null else json_build_object('id', u.id, 'displayName', u.display_name) end as "uploadedBy"`
}

/** Uploader or project editor may change and delete; evidence never (DB guard as last line). */
function canModify(auth: AuthContext, row: Pick<FileRow, 'uploadedById' | 'isEvidence'>) {
  return (
    !row.isEvidence && (row.uploadedById === auth.userId || auth.permissions.has('project.write'))
  )
}

function toSummary(auth: AuthContext, row: FileRow): FileSummary {
  const { storageKey: _, uploadedById: __, ...rest } = row
  const type = typeOfMime(row.mimeType)
  return { ...rest, category: type.category, inline: type.inline, canDelete: canModify(auth, row) }
}

/** Read-only roles (Steuerberatung) can look at files, but not add or change any. */
function requireWriter(auth: AuthContext) {
  if (auth.access === 'readonly') {
    throw new HttpError(403, 'Mit Ihrer Rolle können Sie keine Dateien hochladen oder ändern.')
  }
}

async function loadFile(tx: Tx, auth: AuthContext, id: string): Promise<FileRow | null> {
  const [row] = await tx<FileRow[]>`
    select ${fileColumns(tx)}
    from file f
    join project p on p.id = f.project_id
    left join app_user u on u.id = f.uploaded_by
    where f.id = ${id} and ${projectVisibility(tx, auth)}`
  return row ?? null
}

async function checkFolder(tx: Tx, projectId: string, folderId: string | null | undefined) {
  if (!folderId) return
  const found =
    await tx`select 1 from project_folder where id = ${folderId} and project_id = ${projectId}`
  if (!found.length) {
    throw new HttpError(400, 'Die Eingaben sind unvollständig oder ungültig.', {
      folderId: 'Unbekannter Ordner.',
    })
  }
}

function uniqueFolderName(error: unknown): never {
  if ((error as { code?: string }).code === '23505') {
    throw new HttpError(409, 'Einen Ordner mit diesem Namen gibt es bereits.', {
      name: 'Name bereits vergeben.',
    })
  }
  throw error
}

/** RFC 6266: ASCII fallback plus UTF-8 name, so umlauts survive. */
export function contentDisposition(kind: 'inline' | 'attachment', filename: string) {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`
}

/**
 * Stores an uploaded file (raw bytes, streamed) in the project's Ablage: size and type checked
 * (extension + content), row and object written together. `onStored` runs in the same transaction
 * (e.g. to attach the file as a report photo); if it fails, the file is not kept.
 */
export async function storeUploadedFile(
  services: Services,
  auth: AuthContext,
  request: FastifyRequest,
  projectId: string,
  options: {
    filename: string
    folderId: string | null
    caption: string | null
    imageOnly?: boolean
    onStored?: (tx: Tx, fileId: string) => Promise<void>
  },
): Promise<string> {
  const body = request.body
  const drain = () => {
    if (body instanceof Readable) body.resume()
  }
  let pending: Awaited<ReturnType<typeof services.storage.receive>> | undefined
  let committedKey: string | undefined
  try {
    requireWriter(auth)
    if (!(body instanceof Readable)) {
      throw new HttpError(415, 'Bitte die Datei als application/octet-stream senden.')
    }
    const maxBytes = services.config.UPLOAD_MAX_MB * 1024 * 1024
    const tooLarge = () =>
      new HttpError(413, `Die Datei ist zu groß (höchstens ${services.config.UPLOAD_MAX_MB} MB).`)
    if (Number(request.headers['content-length'] ?? 0) > maxBytes) throw tooLarge()
    await inTenant(services, auth, async (tx) => {
      await requireVisibleProject(tx, auth, projectId)
      await checkFolder(tx, projectId, options.folderId)
    })

    try {
      pending = await services.storage.receive(body, { maxBytes })
    } catch (error) {
      if (error instanceof TooLargeError) throw tooLarge()
      throw error
    }
    if (pending.sizeBytes === 0) throw new HttpError(400, 'Die Datei ist leer.')
    const filename = sanitizeFilename(options.filename)
    const type = detectFileType(filename, pending.head)
    if (!type) {
      throw new HttpError(
        415,
        'Dieser Dateityp ist nicht erlaubt oder der Inhalt passt nicht zur Dateiendung. ' +
          'Erlaubt sind z. B. PDF, Fotos (JPG, PNG, HEIC), Videos, Office-Dateien, Pläne (DWG, DXF) und GAEB.',
      )
    }
    if (options.imageOnly && type.category !== 'image') {
      throw new HttpError(415, 'Bitte ein Foto (JPG, PNG, HEIC …) hochladen.')
    }
    const upload = pending
    return await inTenant(services, auth, async (tx) => {
      await requireVisibleProject(tx, auth, projectId)
      const [ids] = await tx<{ id: string }[]>`select uuid_v7() as id`
      const fileId = (ids as { id: string }).id
      const key = `${auth.tenantId}/files/${fileId}`
      await tx`
        insert into file (id, tenant_id, project_id, folder_id, filename, mime_type, size_bytes,
                          sha256, storage_key, caption, uploaded_by)
        values (${fileId}, ${auth.tenantId}, ${projectId}, ${options.folderId}, ${filename}, ${type.mime},
                ${upload.sizeBytes}, ${upload.sha256}, ${key}, ${options.caption}, ${auth.userId})`
      if (options.onStored) await options.onStored(tx, fileId)
      // Move the object into place last: if the transaction fails afterwards it is removed again.
      await upload.commit(key)
      committedKey = key
      return fileId
    })
  } catch (error) {
    drain()
    await pending?.discard()
    if (committedKey) await services.storage.delete(committedKey).catch(() => undefined)
    throw error
  }
}

export function registerFileRoutes(app: FastifyInstance, services: Services) {
  // Uploads arrive as raw bytes and are streamed straight into the object store (no buffering).
  app.addContentTypeParser('application/octet-stream', (_request, payload, done) =>
    done(null, payload),
  )

  // ---- Folders --------------------------------------------------------------------------------

  app.get('/api/v1/projects/:id/folders', async (request): Promise<FolderSummary[]> => {
    const auth = requireAuth(request)
    const { id } = parse(projectParam, request.params)
    return inTenant(services, auth, async (tx) => {
      await requireVisibleProject(tx, auth, id)
      return tx<FolderSummary[]>`
        select d.id, d.name, d.sort,
               (select count(*)::int from file f where f.folder_id = d.id) as "fileCount"
        from project_folder d where d.project_id = ${id}
        order by d.sort, lower(d.name)`
    })
  })

  app.post('/api/v1/projects/:id/folders', async (request, reply) => {
    const auth = requirePermission(request, 'project.write')
    const { id } = parse(projectParam, request.params)
    const input = parse(folderRequest, request.body)
    const folder = await inTenant(services, auth, async (tx) => {
      await requireVisibleProject(tx, auth, id)
      const [row] = await tx<FolderSummary[]>`
        insert into project_folder (tenant_id, project_id, name, sort, created_by)
        values (${auth.tenantId}, ${id}, ${input.name},
                (select coalesce(max(sort), 0) + 10 from project_folder where project_id = ${id}),
                ${auth.userId})
        returning id, name, sort, 0 as "fileCount"`.catch(uniqueFolderName)
      return row
    })
    return reply.status(201).send(folder)
  })

  app.patch('/api/v1/projects/:id/folders/:folderId', async (request) => {
    const auth = requirePermission(request, 'project.write')
    const { id, folderId } = parse(folderParam, request.params)
    const input = parse(folderRequest, request.body)
    return inTenant(services, auth, async (tx) => {
      await requireVisibleProject(tx, auth, id)
      const [row] = await tx<FolderSummary[]>`
        update project_folder d set name = ${input.name}
        where d.id = ${folderId} and d.project_id = ${id}
        returning d.id, d.name, d.sort,
                  (select count(*)::int from file f where f.folder_id = d.id) as "fileCount"`.catch(
        uniqueFolderName,
      )
      if (!row) throw notFound('Der Ordner')
      return row
    })
  })

  app.delete('/api/v1/projects/:id/folders/:folderId', async (request, reply) => {
    const auth = requirePermission(request, 'project.write')
    const { id, folderId } = parse(folderParam, request.params)
    await inTenant(services, auth, async (tx) => {
      await requireVisibleProject(tx, auth, id)
      const [{ n } = { n: 0 }] = await tx<{ n: number }[]>`
        select count(*)::int as n from file where folder_id = ${folderId}`
      if (n > 0) {
        throw new HttpError(
          409,
          'Der Ordner enthält noch Dateien. Bitte zuerst verschieben oder löschen.',
        )
      }
      const deleted =
        await tx`delete from project_folder where id = ${folderId} and project_id = ${id}`
      if (!deleted.count) throw notFound('Der Ordner')
    })
    return reply.status(204).send()
  })

  // ---- Files ----------------------------------------------------------------------------------

  app.get('/api/v1/projects/:id/files', async (request): Promise<FileSummary[]> => {
    const auth = requireAuth(request)
    const { id } = parse(projectParam, request.params)
    const query = parse(fileListQuery, request.query)
    const rows = await inTenant(services, auth, async (tx) => {
      await requireVisibleProject(tx, auth, id)
      const folder =
        query.folderId === undefined
          ? tx`true`
          : query.folderId === 'none'
            ? tx`f.folder_id is null`
            : tx`f.folder_id = ${query.folderId}`
      return tx<FileRow[]>`
        select ${fileColumns(tx)}
        from file f left join app_user u on u.id = f.uploaded_by
        where f.project_id = ${id} and ${folder}
        order by f.created_at desc, f.id desc
        limit 1000`
    })
    return rows.map((row) => toSummary(auth, row))
  })

  app.post('/api/v1/projects/:id/files', async (request, reply) => {
    const auth = requireAuth(request)
    const { id } = parse(projectParam, request.params)
    const query = parse(uploadQuery, request.query)
    const fileId = await storeUploadedFile(services, auth, request, id, {
      filename: query.filename,
      folderId: query.folderId ?? null,
      caption: query.caption ?? null,
    })
    const row = await inTenant(services, auth, (tx) => loadFile(tx, auth, fileId))
    return reply.status(201).send(toSummary(auth, row as FileRow))
  })

  app.get('/api/v1/files/:id', async (request) => {
    const auth = requireAuth(request)
    const { id } = parse(fileParam, request.params)
    const row = await inTenant(services, auth, (tx) => loadFile(tx, auth, id))
    if (!row) throw notFound('Die Datei')
    return toSummary(auth, row)
  })

  app.get('/api/v1/files/:id/content', async (request, reply) => {
    const auth = requireAuth(request)
    const { id } = parse(fileParam, request.params)
    const { download } = parse(contentQuery, request.query)
    const row = await inTenant(services, auth, (tx) => loadFile(tx, auth, id))
    if (!row) throw notFound('Die Datei')
    const size = await services.storage.size(row.storageKey)
    if (size === null) {
      request.log.error({ fileId: row.id }, 'stored object missing')
      throw new HttpError(500, 'Die Datei ist im Speicher nicht vorhanden.')
    }
    const type = typeOfMime(row.mimeType)
    const inline = type.inline && !download
    return reply
      .header('content-type', row.mimeType)
      .header('content-length', String(size))
      .header(
        'content-disposition',
        contentDisposition(inline ? 'inline' : 'attachment', row.filename),
      )
      .header('x-content-type-options', 'nosniff')
      .header(
        'content-security-policy',
        type.category === 'pdf'
          ? "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; frame-ancestors 'self'"
          : "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; sandbox",
      )
      .header('cache-control', 'private, max-age=3600')
      .send(services.storage.read(row.storageKey))
  })

  app.patch('/api/v1/files/:id', async (request) => {
    const auth = requireAuth(request)
    requireWriter(auth)
    const { id } = parse(fileParam, request.params)
    const input = parse(updateFileRequest, request.body)
    const row = await inTenant(services, auth, async (tx) => {
      const current = await loadFile(tx, auth, id)
      if (!current) throw notFound('Die Datei')
      if (!canModify(auth, current)) {
        throw new HttpError(403, 'Diese Datei dürfen Sie nicht ändern.')
      }
      const columns: Record<string, unknown> = {}
      if (input.filename !== undefined) {
        // The extension stays, because the content was checked against it.
        const ext = extensionOf(current.filename)
        let name = sanitizeFilename(input.filename)
        if (extensionOf(name) !== ext) name = `${name}.${ext}`
        columns.filename = name
      }
      if (input.folderId !== undefined) {
        await checkFolder(tx, current.projectId, input.folderId)
        columns.folder_id = input.folderId
      }
      if (input.caption !== undefined) columns.caption = input.caption
      if (Object.keys(columns).length) await tx`update file set ${tx(columns)} where id = ${id}`
      return loadFile(tx, auth, id)
    })
    return toSummary(auth, row as FileRow)
  })

  app.delete('/api/v1/files/:id', async (request, reply) => {
    const auth = requireAuth(request)
    requireWriter(auth)
    const { id } = parse(fileParam, request.params)
    const key = await inTenant(services, auth, async (tx) => {
      const current = await loadFile(tx, auth, id)
      if (!current) throw notFound('Die Datei')
      if (current.isEvidence) {
        throw new HttpError(
          409,
          'Diese Datei ist Nachweis in einem unterschriebenen Bericht oder einer Rechnung und kann nicht gelöscht werden.',
        )
      }
      if (!canModify(auth, current))
        throw new HttpError(403, 'Diese Datei dürfen Sie nicht löschen.')
      await tx`delete from file where id = ${id}`.catch((error: { code?: string }) => {
        if (error.code === '23503') {
          throw new HttpError(
            409,
            'Diese Datei wird als Bild in einem Dokument verwendet und kann nicht gelöscht werden.',
          )
        }
        throw error
      })
      return current.storageKey
    })
    // Only after the deletion is committed (an orphaned object is harmless, a missing one is not).
    await services.storage
      .delete(key)
      .catch((err: unknown) =>
        request.log.warn({ err, fileId: id }, 'could not delete stored object'),
      )
    return reply.status(204).send()
  })
}
