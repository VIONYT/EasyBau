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
  APP_NAME: z.string().min(1).default('OpenPlancraft'),
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
  /** Maximum size of one uploaded file in megabytes. */
  UPLOAD_MAX_MB: z.coerce.number().int().min(1).max(2048).default(50),
})

export type Config = z.infer<typeof envSchema>

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
