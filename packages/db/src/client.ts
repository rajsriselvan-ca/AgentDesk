import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import { getEnv } from '@agentdesk/core/env';

import * as schema from './schema.js';

/**
 * The database connection.
 *
 * One pool per process, created lazily so that importing this package (for its
 * types, or in a test that never touches Postgres) does not open sockets.
 */

let sql: postgres.Sql | null = null;
let database: ReturnType<typeof drizzle<typeof schema>> | null = null;

/**
 * Read through the validated environment rather than `process.env` directly,
 * so the `.env` file is loaded and the value is checked the same way here as
 * everywhere else — a standalone script gets the same behaviour as the server.
 */
function connectionString(): string {
  return getEnv().DATABASE_URL;
}

export function getSql(): postgres.Sql {
  sql ??= postgres(connectionString(), {
    max: Number(process.env.DB_POOL_MAX ?? 10),
    idle_timeout: 20,
    connect_timeout: 10,
    // Dates come back as `Date`; numerics stay strings so no precision is lost
    // on the way out of the database.
    onnotice: () => {},
  });
  return sql;
}

export function getDb() {
  database ??= drizzle(getSql(), { schema });
  return database;
}

/**
 * Proxy so callers can `import { db }` and still get lazy connection.
 * Without this, a module-level `export const db = getDb()` would connect at
 * import time and break tests that only need the types.
 */
export const db = new Proxy({} as ReturnType<typeof getDb>, {
  get(_target, prop, receiver) {
    return Reflect.get(getDb(), prop, receiver) as unknown;
  },
});

export type Database = ReturnType<typeof getDb>;

/** Transaction handle — what repository functions accept to join a caller's tx. */
export type DbExecutor = Database | Parameters<Parameters<Database['transaction']>[0]>[0];

export async function closeDb(): Promise<void> {
  if (sql) {
    await sql.end({ timeout: 5 });
    sql = null;
    database = null;
  }
}

/** Round-trip check used by /health. Returns latency in ms, or throws. */
export async function pingDb(): Promise<number> {
  const startedAt = performance.now();
  await getSql()`select 1`;
  return Math.round(performance.now() - startedAt);
}
