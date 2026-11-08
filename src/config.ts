import 'dotenv/config';
import { z } from 'zod';

const ConfigSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  DATABASE_URL: z
    .string()
    .url()
    .refine((value) => ['postgres:', 'postgresql:'].includes(new URL(value).protocol), {
      message: 'DATABASE_URL must use the postgres protocol',
    }),
  WEBHOOK_SECRET: z.string().min(16),
  OUTBOX_POLL_INTERVAL_MS: z.coerce.number().int().min(50).max(60_000).default(300),
  OUTBOX_LEASE_MS: z.coerce.number().int().min(1_000).max(300_000).default(30_000),
  FAKE_PROVIDER_OUTCOME: z
    .enum(['success', 'declined', 'timeout-after-charge', 'timeout-before-charge'])
    .default('success'),
}).superRefine((config, context) => {
  if (config.NODE_ENV === 'production') {
    context.addIssue({
      code: 'custom',
      path: ['NODE_ENV'],
      message: 'This challenge server uses a simulated payment provider and cannot run in production',
    });
  }
});

const DatabaseUrlSchema = z
  .string()
  .url()
  .refine((value) => ['postgres:', 'postgresql:'].includes(new URL(value).protocol), {
    message: 'DATABASE_URL must use the postgres protocol',
  });

export type AppConfig = z.infer<typeof ConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = ConfigSchema.safeParse(env);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || 'environment'}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid configuration: ${detail}`);
  }
  return parsed.data;
}

export function loadDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const parsed = DatabaseUrlSchema.safeParse(env.DATABASE_URL);
  if (!parsed.success) {
    throw new Error('Invalid configuration: DATABASE_URL must be a valid URL');
  }
  return parsed.data;
}
