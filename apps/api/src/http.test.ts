import { describe, expect, it } from 'vitest'
import { checkIfMatch, etagOf, normalizeEtag } from './http.js'

describe('ETag / If-Match behind the proxy', () => {
  const updatedAt = new Date('2026-11-08T10:00:00.123Z')
  const tag = etagOf(updatedAt)

  it('accepts the tag as sent, weak and with the compression suffix of the proxy', () => {
    expect(normalizeEtag(`W/${tag}`)).toBe(tag)
    expect(normalizeEtag(tag.replace(/"$/, '-zstd"'))).toBe(tag)
    expect(normalizeEtag(tag.replace(/"$/, '-gzip"'))).toBe(tag)
    for (const header of [tag, `W/${tag}`, tag.replace(/"$/, '-zstd"'), undefined]) {
      expect(() => checkIfMatch(header, updatedAt)).not.toThrow()
    }
  })

  it('rejects a tag of an older version', () => {
    expect(() => checkIfMatch('"alt"', updatedAt)).toThrow(/inzwischen geändert/)
    expect(() => checkIfMatch(etagOf(new Date(0)).replace(/"$/, '-zstd"'), updatedAt)).toThrow()
  })
})
