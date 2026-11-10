import {
  type LoginResponse,
  renameCredentialRequest,
  webauthnRegisterRequest,
  webauthnResponse,
} from '@opc/schemas'
import {
  type AuthenticationResponseJSON,
  generateAuthenticationOptions,
  generateRegistrationOptions,
  type RegistrationResponseJSON,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { mfaSetupRequired, publicOrigin, requireAuth, type Services } from '../context.js'
import { HttpError, notFound, parse } from '../http.js'
import { deleteSessionsOfUser } from '../security/sessions.js'
import {
  audit,
  createChallenge,
  deleteChallenge,
  finishLogin,
  rateLimit,
  setChallengeValue,
  useChallenge,
} from './auth-common.js'

/**
 * WebAuthn / FIDO2: hardware security keys (e.g. YubiKey) and passkeys.
 *  - as second factor after the password (/auth/login/webauthn/*)
 *  - as passwordless login with a discoverable credential (/auth/passkey/*)
 * Credentials are bound to the RP ID (domain of PUBLIC_URL).
 */

interface StoredCredential {
  id: string
  userId: string
  credentialId: string
  publicKey: Buffer
  counter: string
  transports: string[]
}

const idParam = z.object({ id: z.uuid('Ungültige ID.') })
const KEY_FAILED = 'Der Sicherheitsschlüssel konnte nicht bestätigt werden. Bitte erneut versuchen.'

function relyingParty(services: Services, request: FastifyRequest) {
  const origin = publicOrigin(services, request)
  return { origin, rpID: new URL(origin).hostname, rpName: services.config.APP_NAME }
}

/** Stable, non-personal user handle for the authenticator: the 16 bytes of the user UUID. */
function userHandle(userId: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(Buffer.from(userId.replace(/-/g, ''), 'hex'))
}

async function credentialsOf(services: Services, userId: string) {
  return services.sql<{ credentialId: string; transports: string[] }[]>`
    select credential_id as "credentialId", transports from webauthn_credential where user_id = ${userId}`
}

async function verifyAssertion(
  services: Services,
  request: FastifyRequest,
  response: AuthenticationResponseJSON,
  expectedChallenge: string,
  expectedUserId: string | null,
): Promise<string> {
  const [credential] = await services.sql<StoredCredential[]>`
    select c.id, c.user_id as "userId", credential_id as "credentialId", public_key as "publicKey",
           counter, transports
    from webauthn_credential c join app_user u on u.id = c.user_id
    where credential_id = ${response.id} and u.is_active`
  if (!credential || (expectedUserId && credential.userId !== expectedUserId))
    throw new HttpError(401, KEY_FAILED)
  const { origin, rpID } = relyingParty(services, request)
  let result: Awaited<ReturnType<typeof verifyAuthenticationResponse>>
  try {
    result = await verifyAuthenticationResponse({
      response,
      expectedChallenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      credential: {
        id: credential.credentialId,
        publicKey: new Uint8Array(credential.publicKey),
        counter: Number(credential.counter),
        transports: credential.transports as never,
      },
      // Passkeys must verify the user (PIN/biometrics); as second factor presence is enough.
      requireUserVerification: expectedUserId === null,
    })
  } catch {
    throw new HttpError(401, KEY_FAILED)
  }
  if (!result.verified) throw new HttpError(401, KEY_FAILED)
  await services.sql`update webauthn_credential set counter = ${result.authenticationInfo.newCounter},
                     last_used_at = now() where id = ${credential.id}`
  return credential.userId
}

export function registerWebauthnRoutes(app: FastifyInstance, services: Services) {
  const { sql } = services

  // --- Registrierung eines Schlüssels (angemeldet) -------------------------------------------------

  app.post('/api/v1/auth/webauthn/register/options', async (request, reply) => {
    const auth = requireAuth(request)
    const { rpID, rpName } = relyingParty(services, request)
    const existing = await credentialsOf(services, auth.userId)
    const options = await generateRegistrationOptions({
      rpName,
      rpID,
      userName: auth.email,
      userDisplayName: auth.displayName,
      userID: userHandle(auth.userId),
      attestationType: 'none',
      excludeCredentials: existing.map((c) => ({ id: c.credentialId, transports: c.transports })),
      authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
    })
    await createChallenge(services, reply, {
      purpose: 'webauthn_register',
      userId: auth.userId,
      challenge: options.challenge,
    })
    return options
  })

  app.post('/api/v1/auth/webauthn/register/verify', async (request, reply) => {
    const auth = requireAuth(request)
    const input = parse(webauthnRegisterRequest, request.body)
    const challenge = await useChallenge(services, request, 'webauthn_register')
    if (challenge.userId !== auth.userId || !challenge.challenge)
      throw new HttpError(401, KEY_FAILED)
    const { origin, rpID } = relyingParty(services, request)
    let result: Awaited<ReturnType<typeof verifyRegistrationResponse>>
    try {
      result = await verifyRegistrationResponse({
        response: input.response as unknown as RegistrationResponseJSON,
        expectedChallenge: challenge.challenge,
        expectedOrigin: origin,
        expectedRPID: rpID,
        requireUserVerification: false,
      })
    } catch {
      throw new HttpError(400, KEY_FAILED)
    }
    if (!result.verified) throw new HttpError(400, KEY_FAILED)
    const info = result.registrationInfo
    await deleteChallenge(services, challenge.id)
    const [created] = await sql<{ id: string }[]>`
      insert into webauthn_credential (user_id, credential_id, public_key, counter, transports, device_type,
                                       backed_up, aaguid, name)
      values (${auth.userId}, ${info.credential.id}, ${Buffer.from(info.credential.publicKey)},
              ${info.credential.counter}, ${(info.credential.transports ?? []) as string[]},
              ${info.credentialDeviceType}, ${info.credentialBackedUp}, ${info.aaguid}, ${input.name})
      on conflict (credential_id) do nothing returning id`
    if (!created) throw new HttpError(409, 'Dieser Sicherheitsschlüssel ist bereits registriert.')
    // A new factor invalidates other sessions, like enabling TOTP.
    await sql`update user_session set mfa_verified = true where id = ${auth.sessionId}`
    await deleteSessionsOfUser(sql, auth.userId, auth.sessionId)
    await audit(services, auth.tenantId, auth.userId, 'webauthn_registered')
    return reply.status(201).send({ id: created.id })
  })

  app.patch('/api/v1/auth/webauthn/credentials/:id', async (request, reply) => {
    const auth = requireAuth(request)
    const { id } = parse(idParam, request.params)
    const { name } = parse(renameCredentialRequest, request.body)
    const updated =
      await sql`update webauthn_credential set name = ${name} where id = ${id} and user_id = ${auth.userId}`
    if (!updated.count) throw notFound('Der Sicherheitsschlüssel')
    return reply.status(204).send()
  })

  app.delete('/api/v1/auth/webauthn/credentials/:id', async (request, reply) => {
    const auth = requireAuth(request)
    const { id } = parse(idParam, request.params)
    if (mfaSetupRequired(services, { ...auth, webauthnCount: auth.webauthnCount - 1 })) {
      throw new HttpError(
        409,
        'Als Admin brauchen Sie mindestens einen zweiten Faktor. Richten Sie zuerst einen weiteren ein.',
      )
    }
    const deleted =
      await sql`delete from webauthn_credential where id = ${id} and user_id = ${auth.userId}`
    if (!deleted.count) throw notFound('Der Sicherheitsschlüssel')
    await audit(services, auth.tenantId, auth.userId, 'webauthn_removed')
    return reply.status(204).send()
  })

  // --- Zweiter Faktor nach dem Passwort ------------------------------------------------------------

  app.post('/api/v1/auth/login/webauthn/options', async (request) => {
    const challenge = await useChallenge(services, request, 'mfa_login')
    const credentials = await credentialsOf(services, challenge.userId as string)
    if (!credentials.length)
      throw new HttpError(400, 'Für diesen Zugang ist kein Sicherheitsschlüssel eingerichtet.')
    const options = await generateAuthenticationOptions({
      rpID: relyingParty(services, request).rpID,
      allowCredentials: credentials.map((c) => ({ id: c.credentialId, transports: c.transports })),
      userVerification: 'preferred',
    })
    await setChallengeValue(services, challenge.id, options.challenge)
    return options
  })

  app.post('/api/v1/auth/login/webauthn/verify', async (request, reply): Promise<LoginResponse> => {
    const { response } = parse(webauthnResponse, request.body)
    const challenge = await useChallenge(services, request, 'mfa_login')
    if (!challenge.challenge) throw new HttpError(400, 'Bitte zuerst den Schlüssel anfordern.')
    const userId = await verifyAssertion(
      services,
      request,
      response as unknown as AuthenticationResponseJSON,
      challenge.challenge,
      challenge.userId,
    )
    await deleteChallenge(services, challenge.id)
    return finishLogin(services, request, reply, {
      userId,
      requestedTenantId: challenge.requestedTenantId,
      mfaVerified: true,
      method: 'webauthn',
    })
  })

  // --- Anmeldung ohne Passwort (Passkey / YubiKey mit PIN) -----------------------------------------

  app.post('/api/v1/auth/passkey/options', async (request, reply) => {
    await rateLimit(services, `passkey:ip:${request.ip}`, 50)
    const options = await generateAuthenticationOptions({
      rpID: relyingParty(services, request).rpID,
      userVerification: 'required',
    })
    await createChallenge(services, reply, {
      purpose: 'passkey_login',
      challenge: options.challenge,
    })
    return options
  })

  app.post('/api/v1/auth/passkey/verify', async (request, reply): Promise<LoginResponse> => {
    const { response } = parse(webauthnResponse, request.body)
    const challenge = await useChallenge(services, request, 'passkey_login')
    const userId = await verifyAssertion(
      services,
      request,
      response as unknown as AuthenticationResponseJSON,
      challenge.challenge as string,
      null,
    )
    await deleteChallenge(services, challenge.id)
    return finishLogin(services, request, reply, { userId, mfaVerified: true, method: 'passkey' })
  })
}
