import { Hono } from 'hono';
import { listUsers } from '@agentdesk/db';

import type { AppVariables } from '../lib/context.js';
import { rateLimit } from '../middleware/rate-limit.js';

/**
 * Demo user directory.
 *
 * Exists only to back the user picker, since this build stands in for
 * authentication with an `x-user-id` header. It is the one endpoint that would
 * be deleted outright when real auth arrives — the seeded users would become
 * accounts, and the client would learn its identity from a session instead.
 */
export const userRoutes = new Hono<{ Variables: AppVariables }>().get(
  '/',
  rateLimit('read'),
  async (c) => c.json({ users: await listUsers() }),
);
