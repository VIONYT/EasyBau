import { createVerify, generateKeyPairSync } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { HttpError } from '../http.js'
import {
  GoogleTokenError,
  googleImapToken,
  MicrosoftTokenError,
  microsoftImapToken,
  parseGoogleServiceAccountKey,
} from './incoming-mailbox.js'

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

describe('Google Workspace token (service account, domain-wide delegation)', () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  const keyFile = JSON.stringify({
    type: 'service_account',
    project_id: 'rechnungen',
    private_key_id: 'abc',
    private_key: pem,
    client_email: 'eingang@rechnungen.iam.gserviceaccount.com',
  })

  it('reads only e-mail and key from the JSON key file and refuses other files', () => {
    expect(parseGoogleServiceAccountKey(keyFile)).toEqual({
      clientEmail: 'eingang@rechnungen.iam.gserviceaccount.com',
      privateKey: pem,
    })
    for (const bad of [
      'kein json',
      JSON.stringify({ type: 'authorized_user', client_email: 'a@b', private_key: pem }),
      JSON.stringify({ type: 'service_account', client_email: 'a@b', private_key: 'x' }),
    ]) {
      expect(() => parseGoogleServiceAccountKey(bad)).toThrow(HttpError)
    }
  })

  it('signs a JWT for the mailbox user and exchanges it for a token', async () => {
    const account = parseGoogleServiceAccountKey(keyFile)
    let assertion = ''
    const token = await googleImapToken(
      account,
      'rechnungen@firma.example',
      Date.parse('2026-11-15T10:00:00Z'),
      (async (url, init) => {
        expect(String(url)).toBe('https://oauth2.googleapis.com/token')
        const body = new URLSearchParams(String(init?.body))
        expect(body.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer')
        assertion = body.get('assertion') ?? ''
        return new Response(JSON.stringify({ access_token: 'ya29.x' }), { status: 200 })
      }) as typeof fetch,
    )
    expect(token).toBe('ya29.x')
    const [header, claims, signature] = assertion.split('.')
    expect(JSON.parse(Buffer.from(header as string, 'base64url').toString())).toEqual({
      alg: 'RS256',
      typ: 'JWT',
    })
    expect(JSON.parse(Buffer.from(claims as string, 'base64url').toString())).toEqual({
      iss: 'eingang@rechnungen.iam.gserviceaccount.com',
      sub: 'rechnungen@firma.example',
      scope: 'https://mail.google.com/',
      aud: 'https://oauth2.googleapis.com/token',
      iat: 1_794_736_800,
      exp: 1_794_740_400,
    })
    expect(
      createVerify('RSA-SHA256')
        .update(`${header}.${claims}`)
        .verify(publicKey, Buffer.from(signature as string, 'base64url')),
    ).toBe(true)
    const refuse = (async () =>
      new Response(JSON.stringify({ error: 'unauthorized_client' }), {
        status: 401,
      })) as typeof fetch
    await expect(googleImapToken(account, 'x@y', Date.now(), refuse)).rejects.toBeInstanceOf(
      GoogleTokenError,
    )
  })
})
