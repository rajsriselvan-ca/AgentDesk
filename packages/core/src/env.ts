import { z } from 'zod';
import { loadEnvFile } from './load-env.js';

/**
 * Server-only environment parsing.
 *
 * Imported via the `@agentdesk/core/env` subpath so that the browser bundle
 * never pulls `process.env` in through the package root.
 *
 * Parsing happens once, eagerly, and a bad value stops the process at boot
 * with a readable list of what is wrong — far better than a `undefined` that
 * surfaces as a confusing failure three layers deep at request time.
 */

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  DATABASE_URL: z
    .string()
    .min(1, 'DATABASE_URL is required. Copy .env.example to .env and set it.'),

  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  CORS_ORIGIN: z.string().default('http://localhost:5173'),

  AI_PROVIDER: z.enum(['mock', 'anthropic']).default('mock'),
  ANTHROPIC_API_KEY: z.string().optional(),
  AGENT_MODEL: z.string().default('claude-opus-5'),
  COMPACTION_MODEL: z.string().default('claude-haiku-4-5'),

  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  RATE_LIMIT_READ_MAX: z.coerce.number().int().positive().default(120),
  RATE_LIMIT_CHAT_MAX: z.coerce.number().int().positive().default(15),

  CONTEXT_TOKEN_BUDGET: z.coerce.number().int().positive().default(6000),
  CONTEXT_RECENT_MESSAGES: z.coerce.number().int().positive().default(10),

  AGENT_MAX_STEPS: z.coerce.number().int().positive().max(20).default(6),
  TOOL_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
});

export type Env = z.infer<typeof envSchema>;

function parseEnv(source: NodeJS.ProcessEnv): Env {
  const result = envSchema.safeParse(source);

  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Environment is not valid:\n${problems}\n`);
  }

  // A key is only meaningful for the anthropic provider; catching this at boot
  // beats discovering it on the first user message.
  if (result.data.AI_PROVIDER === 'anthropic' && !result.data.ANTHROPIC_API_KEY) {
    throw new Error(
      'AI_PROVIDER=anthropic requires ANTHROPIC_API_KEY to be set.\n' +
        'Either export a key, or set AI_PROVIDER=mock to run without one.\n',
    );
  }

  return result.data;
}

let cached: Env | null = null;

/**
 * Parsed environment. Throws on first call if anything is invalid.
 *
 * The `.env` file is loaded here rather than by each entry point, because ESM
 * hoists every `import` above the module body: a `loadEnvFile()` call at the
 * top of `server.ts` runs *after* the modules it imports have already been
 * evaluated, so any of them reading env at module scope would see nothing.
 * Loading from inside this function removes that ordering trap entirely.
 */
export function getEnv(): Env {
  if (!cached) {
    loadEnvFile();
    cached = parseEnv(process.env);
  }
  return cached;
}

/** Test seam: swap the environment without touching `process.env`. */
export function setEnvForTesting(overrides: Partial<Env>): void {
  cached = { ...getEnv(), ...overrides };
}

export function resetEnvCache(): void {
  cached = null;
}
