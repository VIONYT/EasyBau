import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto'
import { isoCBOR } from '@simplewebauthn/server/helpers'

/**
 * Minimal software FIDO2 authenticator for tests (behaves like a USB security key, e.g. a
 * YubiKey): ES256 key pair, "none" attestation, signature counter, user verification flag.
 * Produces the JSON the browser API would return, so the real server verification runs.
 */
export class SoftAuthenticator {
  readonly credentialId = randomBytes(32)
  private readonly keys = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  private counter = 0
  private userHandle: string | undefined

  constructor(private readonly origin: string) {}

  private get rpIdHash(): Buffer {
    return createHash('sha256').update(new URL(this.origin).hostname).digest()
  }

  private clientData(type: 'webauthn.create' | 'webauthn.get', challenge: string): Buffer {
    return Buffer.from(JSON.stringify({ type, challenge, origin: this.origin, crossOrigin: false }))
  }

  private coseKey(): Uint8Array {
    const jwk = this.keys.publicKey.export({ format: 'jwk' })
    return isoCBOR.encode(
      new Map<number, number | Uint8Array>([
        [1, 2], // kty: EC2
        [3, -7], // alg: ES256
        [-1, 1], // crv: P-256
        [-2, Buffer.from(jwk.x as string, 'base64url')],
        [-3, Buffer.from(jwk.y as string, 'base64url')],
      ]),
    )
  }

  /** Response to navigator.credentials.create() for the given registration options. */
  register(options: { challenge: string; user: { id: string } }) {
    this.userHandle = options.user.id
    const flags = 0x01 | 0x04 | 0x40 // user present, user verified, attested credential data
    const idLength = Buffer.alloc(2)
    idLength.writeUInt16BE(this.credentialId.length)
    const authData = Buffer.concat([
      this.rpIdHash,
      Buffer.from([flags]),
      Buffer.alloc(4), // sign count 0
      Buffer.alloc(16), // AAGUID (none)
      idLength,
      this.credentialId,
      Buffer.from(this.coseKey()),
    ])
    const attestationObject = isoCBOR.encode(
      new Map<string, unknown>([
        ['fmt', 'none'],
        ['attStmt', new Map()],
        ['authData', new Uint8Array(authData)],
      ]) as never,
    )
    const id = this.credentialId.toString('base64url')
    return {
      id,
      rawId: id,
      type: 'public-key',
      response: {
        clientDataJSON: this.clientData('webauthn.create', options.challenge).toString('base64url'),
        attestationObject: Buffer.from(attestationObject).toString('base64url'),
        transports: ['usb'],
      },
      clientExtensionResults: {},
    }
  }

  /** Response to navigator.credentials.get(). */
  authenticate(options: { challenge: string }, { userVerified = true } = {}) {
    this.counter += 1
    const counter = Buffer.alloc(4)
    counter.writeUInt32BE(this.counter)
    const authData = Buffer.concat([
      this.rpIdHash,
      Buffer.from([0x01 | (userVerified ? 0x04 : 0)]),
      counter,
    ])
    const clientDataJSON = this.clientData('webauthn.get', options.challenge)
    const signature = sign(
      'sha256',
      Buffer.concat([authData, createHash('sha256').update(clientDataJSON).digest()]),
      this.keys.privateKey,
    )
    const id = this.credentialId.toString('base64url')
    return {
      id,
      rawId: id,
      type: 'public-key',
      response: {
        clientDataJSON: clientDataJSON.toString('base64url'),
        authenticatorData: authData.toString('base64url'),
        signature: signature.toString('base64url'),
        ...(this.userHandle ? { userHandle: this.userHandle } : {}),
      },
      clientExtensionResults: {},
    }
  }
}
