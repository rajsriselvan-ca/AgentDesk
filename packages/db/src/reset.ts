import { loadEnvFile } from '@agentdesk/core/load-env';

loadEnvFile();

import { closeDb, getSql } from './client.js';

/**
 * Drop everything.
 *
 * Chained by `pnpm db:reset` into migrate + seed. Refuses to run against a
 * database that does not look local unless FORCE_RESET is set, because
 * "reset the dev database" and "reset production" are one exported variable
 * apart.
 */

const url = process.env.DATABASE_URL ?? '';
const looksLocal = /@(localhost|127\.0\.0\.1|::1|host\.docker\.internal)[:/]/.test(url);

if (!looksLocal && process.env.FORCE_RESET !== 'true') {
  console.error(
    `Refusing to reset a non-local database.\n  ${url.replace(/:\/\/([^:]+):([^@]+)@/, '://$1:***@')}\n\n` +
      'Set FORCE_RESET=true if you genuinely mean it.',
  );
  process.exit(1);
}

const sql = getSql();

await sql`drop schema if exists public cascade`;
await sql`create schema public`;

// Drizzle records applied migrations in its own `drizzle` schema. Dropping only
// `public` leaves that ledger intact, so the next `migrate` decides everything
// is already applied, creates nothing, and `seed` then fails on tables that do
// not exist. Both have to go.
await sql`drop schema if exists drizzle cascade`;

console.log('Schema dropped and recreated. Run migrations next.');

await closeDb();
