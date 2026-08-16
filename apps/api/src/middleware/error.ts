import type { ErrorHandler, NotFoundHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { ErrorCode, RateLimitError, isAppError, toAppError } from '@agentdesk/core';

import { getRequestId, type AppVariables } from '../lib/context.js';
import { logger } from '../lib/logger.js';

/**
 * The single place HTTP responses are produced for failures.
 *
 * Because everything throws typed `AppError`s, no route handler needs a
 * try/catch just to pick a status code, and no failure can accidentally return
 * 200 with an error-shaped body.
 *
 * Two rules that matter:
 *   Unexpected errors never leak their message. A thrown `TypeError` becomes a
 *   generic 500 for the client, and the real stack goes to the log keyed by
 *   request id, so support can still find it.
 *
 *   Every response carries that request id, so a user reporting "it failed"
 *   hands you the one string needed to find the exact stack.
 */
export const onError: ErrorHandler<{ Variables: AppVariables }> = (error, c) => {
  const requestId = getRequestId(c);

  // Hono raises these for malformed requests before our code runs.
  if (error instanceof HTTPException) {
    return c.json(
      {
        error: {
          code: error.status === 404 ? ErrorCode.NOT_FOUND : ErrorCode.VALIDATION_FAILED,
          message: error.message || 'The request could not be handled.',
          requestId,
        },
      },
      error.status,
    );
  }

  const appError = toAppError(error);

  if (isAppError(error)) {
    logger.warn(
      { requestId, code: appError.code, status: appError.status, path: c.req.path },
      appError.message,
    );
  } else {
    logger.error(
      { requestId, path: c.req.path, method: c.req.method, err: error },
      'Unhandled error escaped a route handler.',
    );
  }

  if (appError instanceof RateLimitError) {
    c.header('Retry-After', String(appError.retryAfterSeconds));
  }

  return c.json(appError.toBody(requestId), appError.status as 400);
};

export const onNotFound: NotFoundHandler<{ Variables: AppVariables }> = (c) =>
  c.json(
    {
      error: {
        code: ErrorCode.NOT_FOUND,
        message: `No route matches ${c.req.method} ${c.req.path}.`,
        requestId: getRequestId(c),
      },
    },
    404,
  );
