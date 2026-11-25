import type { LoginResponse } from '@easybau/schemas'
import {
  browserSupportsWebAuthn,
  startAuthentication,
  startRegistration,
} from '@simplewebauthn/browser'
import { ApiError, api } from './api'
import { t } from './i18n'

export const webauthnSupported = (): boolean => browserSupportsWebAuthn()

/** Browser/authenticator errors (cancelled, timeout, wrong key) become a readable message. */
async function ceremony<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (error) {
    if (error instanceof ApiError) throw error
    throw new ApiError(0, t('auth.keyCancelled'))
  }
}

/** Second factor after the password (pending login cookie is set by the server). */
export async function loginWithKeyAsSecondFactor(): Promise<LoginResponse> {
  const options = await api<Parameters<typeof startAuthentication>[0]['optionsJSON']>(
    'POST',
    '/api/v1/auth/login/webauthn/options',
  )
  const response = await ceremony(() => startAuthentication({ optionsJSON: options }))
  return api<LoginResponse>('POST', '/api/v1/auth/login/webauthn/verify', { response })
}

/** Passwordless login with a discoverable credential (passkey, YubiKey with PIN). */
export async function loginWithPasskey(): Promise<LoginResponse> {
  const options = await api<Parameters<typeof startAuthentication>[0]['optionsJSON']>(
    'POST',
    '/api/v1/auth/passkey/options',
  )
  const response = await ceremony(() => startAuthentication({ optionsJSON: options }))
  return api<LoginResponse>('POST', '/api/v1/auth/passkey/verify', { response })
}

export async function registerKey(name: string): Promise<void> {
  const options = await api<Parameters<typeof startRegistration>[0]['optionsJSON']>(
    'POST',
    '/api/v1/auth/webauthn/register/options',
  )
  const response = await ceremony(() => startRegistration({ optionsJSON: options }))
  await api('POST', '/api/v1/auth/webauthn/register/verify', { response, name })
}
