import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { ValidationError, agentParamSchema } from '@agentdesk/core';
import { describeAgent, listAgents } from '@agentdesk/agents';

import type { AppVariables } from '../lib/context.js';
import { rateLimit } from '../middleware/rate-limit.js';

/**
 * Agent discovery.
 *
 * Both responses are generated from the agent registry — the same object the
 * runtime dispatches on, and the same Zod schemas the tools validate with. The
 * documentation therefore cannot drift from the implementation: adding a tool
 * changes this endpoint automatically, and removing one cannot leave a stale
 * entry behind.
 *
 * No identity middleware: the capability surface is not user-specific, and
 * making it public means a client can render the agent list before a user is
 * chosen.
 */
export const agentRoutes = new Hono<{ Variables: AppVariables }>()
  .get('/', rateLimit('read'), (c) => c.json({ agents: listAgents() }))

  .get(
    '/:type/capabilities',
    rateLimit('read'),
    zValidator('param', agentParamSchema, (result) => {
      if (!result.success) {
        throw new ValidationError(
          'Unknown agent type. Valid types are: support, order, billing, fallback.',
          result.error,
        );
      }
    }),
    (c) => c.json(describeAgent(c.req.valid('param').type)),
  );
