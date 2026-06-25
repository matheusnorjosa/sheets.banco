import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().url(),
  GOOGLE_CLIENT_ID: z.string().min(1),
  GOOGLE_CLIENT_SECRET: z.string().min(1),
  GOOGLE_REDIRECT_URI: z.string().url().default('http://localhost:3000/auth/google/callback'),
  JWT_SECRET: z.string().min(16),
  PORT: z.coerce.number().default(3000),
  HOST: z.string().default('0.0.0.0'),
  FRONTEND_URL: z.string().default('http://localhost:3001'),
  /**
   * Comma-separated allowlist of origins for the global CORS plugin. If unset,
   * falls back to `FRONTEND_URL` only. Use `*` only in development.
   */
  ALLOWED_ORIGINS: z.string().optional(),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  /**
   * Maximum request body size in bytes. Default 1 MiB matches Fastify's previous
   * hardcoded value; bump (e.g. 25 MiB) when importing large CSVs.
   */
  BODY_LIMIT: z.coerce.number().int().positive().default(1_048_576),
  /**
   * Master key for the at-rest secret cipher (AES-256-GCM) used by
   * `lib/secret-cipher.ts`. 64 hex chars (32 bytes). Required in production
   * once the encrypted-column migration starts; optional in dev/test so the
   * unit suite that doesn't touch encrypted fields keeps running without it.
   * Generate: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
   */
  SECRETS_ENC_KEY: z.string().regex(/^[0-9a-f]{64}$/i, 'must be 64 hex chars').optional(),
}).superRefine((env, ctx) => {
  if (env.NODE_ENV === 'production') {
    if (env.JWT_SECRET.length < 32) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['JWT_SECRET'],
        message: 'must be at least 32 chars in production',
      });
    }
    if (!env.ALLOWED_ORIGINS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ALLOWED_ORIGINS'],
        message: 'must be set in production (comma-separated list)',
      });
    }
    // SECRETS_ENC_KEY is mandatory in prod since the Phase B encryption
    // landed: every hmacSecret / WebhookSubscription.secret create/rotate
    // path calls encrypt(), which throws without the key. Boot also calls
    // eagerLoadCipherKey() — but failing here in env validation gives a
    // clearer message.
    if (!env.SECRETS_ENC_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['SECRETS_ENC_KEY'],
        message: 'must be set in production (64 hex chars; generate via node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))")',
      });
    }
  }
});

export type Env = z.infer<typeof envSchema>;

function loadEnv(): Env {
  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    console.error('❌ Invalid environment variables:');
    for (const issue of result.error.issues) {
      console.error(`  ${issue.path.join('.')}: ${issue.message}`);
    }
    process.exit(1);
  }

  return result.data;
}

export const env = loadEnv();
