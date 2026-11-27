import { describe, expect, it } from 'vitest'
import { MASK, maskSecrets } from './mask.js'

describe('maskSecrets', () => {
  it('masks nested secrets but keeps proof hashes and other values', () => {
    const settings = {
      incomingMail: { host: 'imap.example.test', passwordEnc: 'abc', clientSecretEnc: null },
      iban_enc: 'x',
      list: [{ googleKeyEnc: 'k', user: 'u' }],
      prev_hash: 'h',
      content_hash: 'c',
    }
    expect(maskSecrets(settings)).toEqual({
      incomingMail: { host: 'imap.example.test', passwordEnc: MASK, clientSecretEnc: null },
      iban_enc: MASK,
      list: [{ googleKeyEnc: MASK, user: 'u' }],
      prev_hash: 'h',
      content_hash: 'c',
    })
    expect(maskSecrets('text')).toBe('text')
    expect(maskSecrets(null)).toBeNull()
  })
})
