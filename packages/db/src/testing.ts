import { execSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadEnvFile } from '@agentdesk/core/load-env';

/**
 * Test database setup, shared by every package's vitest `globalSetup`.
 *
 * Tests run against a separate database and are destructive — they truncate and
 * re-seed. Pointing them at the development database by accident would wipe
 * whatever you were looking at, so this refuses to run unless the target is
 * clearly a test database.
 */

const here = dirname(fileURLToPath(import.meta.url));

export function prepareTestDatabase(): void {
  loadEnvFile();

  const url = process.env.TEST_DATABASE_URL;

  if (!url) {
    throw new Error(
      'TEST_DATABASE_URL is not set. Add it to .env — see .env.example.\n' +
        'It must point at a database you are happy to have truncated.',
    );
  }

  if (!/test/i.test(url)) {
    throw new Error(
      `Refusing to run tests against "${redact(url)}".\n` +
        'The TEST_DATABASE_URL must contain "test" so a mistyped value cannot ' +
        'destroy a real database.',
    );
  }

  // Every module below reads DATABASE_URL, so redirect it for the whole run
  // rather than threading a separate connection through the code under test.
  process.env.DATABASE_URL = url;
  process.env.NODE_ENV = 'test';
  process.env.AI_PROVIDER ??= 'mock';

  const packageRoot = resolve(here, '..');
  const run = (script: string) =>
    execSync(`node --import tsx ${resolve(packageRoot, 'src', script)}`, {
      cwd: packageRoot,
      stdio: 'pipe',
      env: { ...process.env, DATABASE_URL: url },
    });

  run('migrate.ts');
  run('seed.ts');
}

function redact(url: string): string {
  return url.replace(/:\/\/([^:]+):([^@]+)@/, '://$1:***@');
}
