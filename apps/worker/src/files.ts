import type { ObjectStore } from '@easybau/storage'

/** Date of a `date` column (postgres.js returns Date or string). */
export const isoDate = (value: Date | string) =>
  typeof value === 'string' ? value.slice(0, 10) : value.toISOString().slice(0, 10)

/** A whole working copy from the files volume. */
export async function readAll(files: ObjectStore, key: string): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of files.read(key)) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks)
}
