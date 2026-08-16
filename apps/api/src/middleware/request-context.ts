import { createMiddleware } from 'hono/factory';
import { randomUUID } from 'node:crypto';

import type { AppVariables } from '../lib/context.js';
import { logger } from '../lib/logger.js';

/**
 * Request id and access logging.
 *
 * The id is echoed in the response header and in every error body, so a user
 * reporting a failure hands over the one string that finds the exact stack in
 * the logs. An inbound `x-request-id` is honoured so a trace survives across a
 * proxy or a calling service.
 */
export const requestContext = createMiddleware<{ Variables: AppVariables }>(async (c, next) => {
  const requestId = c.req.header('x-request-id') ?? randomUUID();
  c.set('requestId', requestId);
  c.header('x-request-id', requestId);

  const startedAt = performance.now();

  await next();

  const durationMs = Math.round(performance.now() - startedAt);

  // 5xx is our fault and deserves the louder level; 4xx is the caller's.
  const level = c.res.status >= 500 ? 'error' : c.res.status >= 400 ? 'warn' : 'info';

  logger[level](
    {
      requestId,
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      durationMs,
    },
    `${c.req.method} ${c.req.path} ${c.res.status}`,
  );
});
