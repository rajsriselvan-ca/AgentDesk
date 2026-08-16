import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { getEnv } from '@agentdesk/core/env';

import type { AppVariables } from './lib/context.js';
import { onError, onNotFound } from './middleware/error.js';
import { requestContext } from './middleware/request-context.js';
import { agentRoutes } from './routes/agents.routes.js';
import { chatRoutes } from './routes/chat.routes.js';
import { userRoutes } from './routes/users.routes.js';
import { getHealth } from './services/health.service.js';

/**
 * The application.
 *
 * Exported separately from the server so tests can drive it with
 * `app.request(...)` — no port, no sockets, no teardown. The exported
 * `AppType` is what gives the browser its typed client; see
 * apps/web/src/lib/rpc-guard.ts for the guard that keeps it honest.
 */

const env = getEnv();

const app = new Hono<{ Variables: AppVariables }>()
  .use('*', requestContext)
  .use(
    '*',
    cors({
      origin: env.CORS_ORIGIN.split(',').map((value) => value.trim()),
      allowHeaders: ['Content-Type', 'x-user-id', 'x-request-id'],
      exposeHeaders: ['x-request-id', 'RateLimit-Limit', 'RateLimit-Remaining', 'Retry-After'],
      credentials: true,
    }),
  )

  // Outside /api and without identity, so an orchestrator can probe it.
  .get('/health', async (c) => {
    const health = await getHealth();
    // 503 when the database is gone, so a load balancer takes this instance
    // out rather than sending it traffic it cannot serve.
    return c.json(health, health.status === 'ok' ? 200 : 503);
  })

  .route('/api/chat', chatRoutes)
  .route('/api/agents', agentRoutes)
  .route('/api/users', userRoutes);

app.onError(onError);
app.notFound(onNotFound);

export type AppType = typeof app;
export default app;
