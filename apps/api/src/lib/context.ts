import type { Context } from 'hono';
import { UnauthenticatedError } from '@agentdesk/core';
import type { User } from '@agentdesk/db';

/**
 * Request-scoped values, and the only supported way to read them.
 *
 * `getUser` throws rather than returning null. A handler that reaches for the
 * caller's identity has already been past the auth middleware by definition, so
 * a missing user is a wiring bug — and failing loudly here is far better than
 * letting `undefined` flow into a repository call that then queries across all
 * users.
 */

export interface AppVariables {
  requestId: string;
  user?: User;
}

export type AppContext = Context<{ Variables: AppVariables }>;

export function getRequestId(c: AppContext): string {
  return c.get('requestId') ?? 'unknown';
}

export function getUser(c: AppContext): User {
  const user = c.get('user');
  if (!user) {
    throw new UnauthenticatedError(
      'This endpoint requires a caller identity but none was resolved.',
    );
  }
  return user;
}
