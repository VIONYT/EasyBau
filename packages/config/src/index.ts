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
})

export type Config = z.infer<typeof envSchema>

export class ConfigError extends Error {
  override name = 'ConfigError'
}

/** Parses and validates the environment. Throws a readable error listing every invalid variable. */
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = envSchema.safeParse(env)
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n')
    throw new ConfigError(`Invalid configuration:\n${details}`)
  }
  return parsed.data
}

/** True if the process should serve the HTTP API. */
export const runsApi = (role: Role): boolean => role === 'all' || role === 'api'
/** True if the process should consume background jobs. */
export const runsWorker = (role: Role): boolean => role === 'all' || role === 'worker'
