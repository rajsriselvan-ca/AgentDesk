import { serve } from '@hono/node-server';
import { getEnv } from '@agentdesk/core/env';

import app from './app.js';
import { logger } from './lib/logger.js';
import { closeDb } from '@agentdesk/db';

/**
 * Process entry point.
 *
 * Everything that can fail at boot — environment parsing, database
 * reachability — fails here, loudly, before the port is bound. A server that
 * accepts connections it cannot serve is worse than one that refused to start.
 */

const env = getEnv();

const server = serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  logger.info(
    {
      port: info.port,
      env: env.NODE_ENV,
      provider: env.AI_PROVIDER,
    },
    `AgentDesk API listening on http://localhost:${info.port}`,
  );

  if (env.AI_PROVIDER === 'mock') {
    logger.info(
      'Running with the deterministic mock model. Set AI_PROVIDER=anthropic and ANTHROPIC_API_KEY for real agent responses.',
    );
  }
});

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  logger.info({ signal }, 'Shutting down.');

  // Stop accepting new work, let in-flight streams finish, then release the
  // pool. A forced exit after the grace period stops a stuck stream from
  // hanging the process forever.
  const forced = setTimeout(() => {
    logger.warn('Graceful shutdown timed out; exiting.');
    process.exit(1);
  }, 10_000);
  forced.unref();

  server.close(() => {
    void closeDb().then(() => {
      logger.info('Shutdown complete.');
      process.exit(0);
    });
  });
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'Unhandled promise rejection.');
});
