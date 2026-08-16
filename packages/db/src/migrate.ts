import { loadEnvFile } from '@agentdesk/core/load-env';

loadEnvFile();

import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { closeDb, getDb } from './client.js';

const here = dirname(fileURLToPath(import.meta.url));

async function main(): Promise<void> {
  const target = process.env.DATABASE_URL ?? '(unset)';
  console.log(`Applying migrations to ${redact(target)}`);

  await migrate(getDb(), { migrationsFolder: resolve(here, '../migrations') });

  console.log('Migrations applied.');
  await closeDb();
}

function redact(url: string): string {
  return url.replace(/:\/\/([^:]+):([^@]+)@/, '://$1:***@');
}

main().catch(async (error: unknown) => {
  console.error('Migration failed.');
  console.error(error);
  await closeDb().catch(() => {});
  process.exit(1);
});
