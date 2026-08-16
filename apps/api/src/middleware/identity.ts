import { createMiddleware } from 'hono/factory';
import { UnauthenticatedError } from '@agentdesk/core';
import { findUserById } from '@agentdesk/db';

import type { AppVariables } from '../lib/context.js';

/**
 * Caller identity.
 *
 * Full authentication is outside the scope of this build, so the demo carries
 * the caller in an `x-user-id` header, validated against a seeded user. It is
 * deliberately *not* a hand-rolled JWT: a toy token that looks like security is
 * worse than an obvious stand-in, because the next person assumes it is real.
 *
 * This middleware occupies exactly the slot a session or token check would.
 * Replacing it means changing this file and nothing else — every downstream
 * handler already reads the caller through `getUser`, and every repository is
 * already scoped by user id.
 */
export const identity = createMiddleware<{ Variables: AppVariables }>(async (c, next) => {
  const headerValue = c.req.header('x-user-id');

  if (!headerValue) {
    throw new UnauthenticatedError(
      'Missing x-user-id header. Pick a demo user in the UI, or send the header directly — GET /api/users lists the seeded ids.',
    );
  }

  const user = await findUserById(headerValue);

  if (!user) {
    throw new UnauthenticatedError(
      'That user id does not match a seeded user. GET /api/users lists the valid ones.',
    );
  }

  c.set('user', user);
  await next();
});
