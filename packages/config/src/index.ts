import { readFileSync } from 'node:fs'
import { z } from 'zod'

/**
 * Central runtime configuration, read once from environment variables.
 * Every variable must be documented in `.env.example` (see CLAUDE.md).
 */
export const roles = ['all', 'api', 'worker'] as const
export type Role = (typeof roles)[number]

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('production'),
  APP_NAME: z.string().min(1).default('EasyBau'),
  APP_VERSION: z.string().default('0.0.0-dev'),
  APP_ROLE: z.enum(roles).default('all'),
  PROFILE: z.enum(['compact', 'standard']).default('compact'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  /** Apply pending database migrations on start (API roles only). */
  MIGRATE_ON_START: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  /** Master secret for field encryption (IBAN, TOTP secrets). At least 32 characters. */
  APP_SECRET: z
    .string()
    .min(32, 'APP_SECRET muss mindestens 32 Zeichen lang sein (z. B. openssl rand -hex 32).'),
  /** Optional fixed setup code; otherwise a random code is printed to the log on first start. */
  SETUP_TOKEN: z.string().min(8).optional(),
  /** Session lifetime in days (absolute) and idle timeout in hours. */
  SESSION_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(30),
  SESSION_IDLE_HOURS: z.coerce
    .number()
    .int()
    .min(1)
    .max(24 * 30)
    .default(24 * 7),
  /** Secure cookies (HTTPS only). Disable only for local development without TLS. */
  COOKIE_SECURE: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  /**
   * Public address, e.g. https://erp.meine-firma.de. Used for invitation links and as the
   * WebAuthn origin/RP-ID (security keys are bound to it). Falls back to the request host.
   */
  PUBLIC_URL: z
    .url({ protocol: /^https?$/ })
    .transform((v) => v.replace(/\/+$/, ''))
    .optional(),
  /** Admins must use a second factor (TOTP or security key) before they can work. */
  REQUIRE_ADMIN_MFA: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  /** Directory for uploaded files (project filing). In Docker a named volume (ADR 0004). */
  STORAGE_DIR: z.string().min(1).default('/data/files'),
  /**
   * E-mail via SMTP (optional, off by default). Without SMTP_HOST nothing is sent; invitation
   * links are shown in the app instead.
   */
  SMTP_HOST: z.string().min(1).optional(),
  SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(587),
  /** true: TLS from the start (port 465); false: STARTTLS (port 587). */
  SMTP_SECURE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  SMTP_USER: z.string().min(1).optional(),
  SMTP_PASSWORD: z.string().min(1).optional(),
  /** Sender, e.g. "Muster Bau GmbH <buero@muster-bau.de>". Required with SMTP_HOST. */
  SMTP_FROM: z.string().min(3).optional(),
  /**
   * Rechnungseingang per E-Mail (P2.4, optional, off by default): the app fetches attachments
   * from the IMAP mailbox each company enters under Einstellungen › Rechnungseingang. Off: no
   * connection to any mail server is ever made.
   */
  INCOMING_MAIL_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  /** How often the mailboxes are checked, in minutes. */
  INCOMING_MAIL_INTERVAL_MINUTES: z.coerce.number().int().min(1).max(1440).default(5),
  /**
   * KoSIT validator daemon (ADR 0007), e.g. http://kosit:8080 in the Docker stack. Every e-invoice
   * (ZUGFeRD/Factur-X CII, XRechnung UBL) must pass it before an invoice is finalized (rule 8).
   * Without it, invoices cannot be finalized.
   */
  KOSIT_URL: z
    .url({ protocol: /^https?$/ })
    .transform((v) => v.replace(/\/+$/, ''))
    .optional(),
  /** Timeout for one validation in milliseconds. */
  KOSIT_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120000).default(20000),
  /**
   * Revisionssicheres Belegarchiv (ADR 0008): S3 bucket with Object Lock. Default in the Docker
   * stack: the bundled RustFS (http://storage:9000, ADR 0009); any S3-compatible service with Object Lock
   * works. Without an endpoint the originals stay only in the "files" volume (no WORM).
   */
  ARCHIVE_S3_ENDPOINT: z
    .url({ protocol: /^https?$/ })
    .transform((v) => v.replace(/\/+$/, ''))
    .optional(),
  ARCHIVE_S3_REGION: z.string().min(1).default('us-east-1'),
  ARCHIVE_S3_BUCKET: z
    .string()
    .regex(
      /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/,
      'Ungültiger Bucket-Name (3–63 Zeichen, a–z, 0–9, Punkt, Bindestrich).',
    )
    .default('belegarchiv'),
  ARCHIVE_S3_ACCESS_KEY: z.string().min(1).optional(),
  ARCHIVE_S3_SECRET_KEY: z.string().min(1).optional(),
  /** Path-style URLs (endpoint/bucket/key): RustFS, MinIO and most providers. */
  ARCHIVE_S3_PATH_STYLE: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  /** Create the bucket with Object Lock on start (development); in the stack storage-setup creates it, external buckets are prepared by the operator. */
  ARCHIVE_S3_CREATE_BUCKET: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  /** COMPLIANCE: nobody can delete before the end of the retention period (GoBD); GOVERNANCE only for tests. */
  ARCHIVE_RETENTION_MODE: z.enum(['COMPLIANCE', 'GOVERNANCE']).default('COMPLIANCE'),
  /**
   * Previous archive while moving to another S3 (e.g. bundled RustFS → external provider): the
   * archive reconciliation copies originals from here when the working copy is missing. Optional,
   * only during the move; reading only.
   */
  ARCHIVE_PREVIOUS_S3_ENDPOINT: z
    .url({ protocol: /^https?$/ })
    .transform((v) => v.replace(/\/+$/, ''))
    .optional(),
  ARCHIVE_PREVIOUS_S3_REGION: z.string().min(1).default('us-east-1'),
  ARCHIVE_PREVIOUS_S3_BUCKET: z
    .string()
    .regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/, 'Ungültiger Bucket-Name.')
    .default('belegarchiv'),
  ARCHIVE_PREVIOUS_S3_ACCESS_KEY: z.string().min(1).optional(),
  ARCHIVE_PREVIOUS_S3_SECRET_KEY: z.string().min(1).optional(),
  ARCHIVE_PREVIOUS_S3_PATH_STYLE: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  /** Maximum size of one uploaded file in megabytes. */
  UPLOAD_MAX_MB: z.coerce.number().int().min(1).max(2048).default(50),
})

export type Config = z.infer<typeof envSchema>

/** True when e-mail can be sent (SMTP_HOST and SMTP_FROM configured). */
export const smtpEnabled = (config: Pick<Config, 'SMTP_HOST' | 'SMTP_FROM'>): boolean =>
  Boolean(config.SMTP_HOST && config.SMTP_FROM)

export class ConfigError extends Error {
  override name = 'ConfigError'
}

/** Parses and validates the environment. Throws a readable error listing every invalid variable. */
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = envSchema.safeParse(resolveFileSecrets(env))
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n')
    throw new ConfigError(`Invalid configuration:\n${details}`)
  }
  if (
    parsed.data.ARCHIVE_S3_ENDPOINT &&
    (!parsed.data.ARCHIVE_S3_ACCESS_KEY || !parsed.data.ARCHIVE_S3_SECRET_KEY)
  ) {
    throw new ConfigError(
      'Invalid configuration:\n  - ARCHIVE_S3_ACCESS_KEY/ARCHIVE_S3_SECRET_KEY: Zugangsdaten für das Belegarchiv fehlen',
    )
  }
  if (
    parsed.data.ARCHIVE_PREVIOUS_S3_ENDPOINT &&
    (!parsed.data.ARCHIVE_PREVIOUS_S3_ACCESS_KEY || !parsed.data.ARCHIVE_PREVIOUS_S3_SECRET_KEY)
  ) {
    throw new ConfigError(
      'Invalid configuration:\n  - ARCHIVE_PREVIOUS_S3_ACCESS_KEY/ARCHIVE_PREVIOUS_S3_SECRET_KEY: Zugangsdaten für das bisherige Belegarchiv fehlen',
    )
  }
  if (parsed.data.SMTP_HOST && !parsed.data.SMTP_FROM) {
    throw new ConfigError(
      'Invalid configuration:\n  - SMTP_FROM: Absender fehlt (erforderlich mit SMTP_HOST)',
    )
  }
  return parsed.data
}

/**
 * Docker secrets: `NAME_FILE=/run/secrets/x` provides the value of NAME from a file.
 * An explicitly set NAME wins over NAME_FILE.
 */
export function resolveFileSecrets(
  env: Record<string, string | undefined>,
  readFile: (path: string) => string = (path) => readFileSync(path, 'utf8'),
): Record<string, string | undefined> {
  // Empty values (e.g. `SETUP_TOKEN=` from compose defaults) count as "not set".
  const resolved = Object.fromEntries(Object.entries(env).filter(([, value]) => value !== ''))
  for (const [key, path] of Object.entries(env)) {
    if (!key.endsWith('_FILE') || !path) continue
    const name = key.slice(0, -'_FILE'.length)
    if (resolved[name] !== undefined) continue
    try {
      resolved[name] = readFile(path).trim()
    } catch {
      throw new ConfigError(
        `Invalid configuration:\n  - ${key}: Datei ${path} kann nicht gelesen werden`,
      )
    }
  }
  return resolved
}

/** True if the process should serve the HTTP API. */
export const runsApi = (role: Role): boolean => role === 'all' || role === 'api'
/** True if the process should consume background jobs. */
export const runsWorker = (role: Role): boolean => role === 'all' || role === 'worker'
