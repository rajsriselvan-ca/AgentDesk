import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/**
 * Load the monorepo's root `.env` into `process.env`.
 *
 * Scripts in this repo run from several different working directories —
 * `pnpm dev` from the root, `pnpm --filter @agentdesk/db migrate` from the
 * package — so resolving `.env` relative to `process.cwd()` silently finds
 * nothing about half the time. This walks upward for the workspace root
 * instead, which is stable regardless of where the command was invoked.
 *
 * Real environment variables always win: this only fills in what is unset, so
 * `DATABASE_URL=... pnpm db:migrate` overrides the file as you would expect.
 */

function findWorkspaceRoot(startDir: string): string | null {
  let dir = startDir;

  for (let depth = 0; depth < 12; depth += 1) {
    if (existsSync(resolve(dir, 'pnpm-workspace.yaml'))) return dir;

    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return null;
}

let loaded = false;

export function loadEnvFile(): void {
  if (loaded) return;
  loaded = true;

  const root = findWorkspaceRoot(process.cwd());
  if (!root) return;

  // NODE_ENV=test reads .env.test first so a test run cannot point at the
  // development database by accident.
  const candidates =
    process.env.NODE_ENV === 'test' ? ['.env.test', '.env'] : ['.env.local', '.env'];

  for (const name of candidates) {
    const path = resolve(root, name);
    if (!existsSync(path)) continue;

    try {
      // Node's own parser; does not override variables already in the
      // environment, which is the precedence we want.
      process.loadEnvFile(path);
    } catch {
      // A malformed .env should not be fatal here — env.ts validates what
      // actually matters and produces a far better message.
    }
  }
}
