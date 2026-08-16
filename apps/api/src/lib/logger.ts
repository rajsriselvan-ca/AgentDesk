import pino from 'pino';
import { getEnv } from '@agentdesk/core/env';

const env = getEnv();

/**
 * Structured logging.
 *
 * Pretty-printed in development because a human is reading it; raw JSON
 * everywhere else because a log aggregator is. Request-scoped children carry
 * the request id so a 500 in the response can be traced to its stack.
 */
export const logger = pino({
  level: env.LOG_LEVEL,
  redact: {
    paths: ['req.headers.authorization', 'req.headers["x-user-id"]', '*.apiKey', '*.password'],
    remove: true,
  },
  ...(env.NODE_ENV === 'development'
    ? {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
        },
      }
    : {}),
});

export type Logger = typeof logger;
