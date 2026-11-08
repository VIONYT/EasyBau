import { z } from 'zod'
import { id, optionalText, text } from './common.js'

export type FileCategory = 'image' | 'pdf' | 'video' | 'office' | 'plan' | 'text' | 'archive'

export const folderRequest = z.object({ name: text(100) })
export type FolderRequest = z.infer<typeof folderRequest>

export interface FolderSummary {
  id: string
  name: string
  sort: number
  fileCount: number
}

export const fileListQuery = z.object({
  /** Folder id, or "none" for files without folder. Omitted: all files of the project. */
  folderId: z.union([id, z.literal('none')]).optional(),
})

/** Upload: the body is the raw file (application/octet-stream), metadata in the query string. */
export const uploadQuery = z.object({
  filename: z.string().trim().min(1, 'Dateiname fehlt.').max(500),
  folderId: id.optional(),
  caption: optionalText(500),
})

export const updateFileRequest = z
  .object({
    filename: text(200),
    folderId: id.nullable(),
    caption: optionalText(500),
  })
  .partial()
export type UpdateFileRequest = z.infer<typeof updateFileRequest>

export interface FileSummary {
  id: string
  projectId: string
  folderId: string | null
  filename: string
  mimeType: string
  category: FileCategory
  /** Can be shown in the browser (images, PDF, video). */
  inline: boolean
  sizeBytes: number
  caption: string | null
  isEvidence: boolean
  uploadedBy: { id: string; displayName: string } | null
  createdAt: string
  /** Uploader or project editor, and the file is not evidence. */
  canDelete: boolean
}
