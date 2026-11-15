import { describe, expect, it } from 'vitest'
import { MicrosoftTokenError, microsoftImapToken } from './incoming-mailbox.js'

const oauth = {
  tenantId: 'eingang.onmicrosoft.com',
  clientId: '6a7b8c9d-0e1f-4a2b-8c3d-abcdef012345',
  clientSecret: 'geheim',
}

describe('Microsoft 365 token (client credentials)', () => {
  it('requests a token for IMAP of Exchange Online', async () => {
    const calls: { url: string; init: RequestInit | undefined }[] = []
    const token = await microsoftImapToken(oauth, (async (url, init) => {
      calls.push({ url: String(url), init })
      return new Response(JSON.stringify({ access_token: 'eyJ0', token_type: 'Bearer' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof fetch)
    expect(token).toBe('eyJ0')
    expect(calls[0]?.url).toBe(
      'https://login.microsoftonline.com/eingang.onmicrosoft.com/oauth2/v2.0/token',
    )
    const body = new URLSearchParams(String(calls[0]?.init?.body))
    expect(Object.fromEntries(body)).toEqual({
      client_id: oauth.clientId,
      client_secret: 'geheim',
      scope: 'https://outlook.office365.com/.default',
      grant_type: 'client_credentials',
    })
  })

  it('fails with MicrosoftTokenError when Microsoft refuses the credentials', async () => {
    const refuse = (async () =>
      new Response(JSON.stringify({ error: 'invalid_client' }), { status: 401 })) as typeof fetch
    await expect(microsoftImapToken(oauth, refuse)).rejects.toBeInstanceOf(MicrosoftTokenError)
    const garbage = (async () => new Response('<html>', { status: 200 })) as typeof fetch
    await expect(microsoftImapToken(oauth, garbage)).rejects.toBeInstanceOf(MicrosoftTokenError)
  })
})
