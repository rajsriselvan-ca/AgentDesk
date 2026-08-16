/**
 * The one error hierarchy the whole system throws.
 *
 * Services and repositories throw these; they are never returned. A single
 * `onError` handler on the Hono app turns them into responses, so no route
 * handler needs a try/catch just to produce a sensible status code.
 *
 * Anything that is *not* an AppError escaping into that handler is treated as
 * a bug: it becomes a 500, its message is withheld from the client, and the
 * stack is logged against the request id.
 */

export const ErrorCode = {
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  RATE_LIMITED: 'RATE_LIMITED',
  AGENT_FAILED: 'AGENT_FAILED',
  TOOL_FAILED: 'TOOL_FAILED',
  TOOL_TIMEOUT: 'TOOL_TIMEOUT',
  PROVIDER_UNAVAILABLE: 'PROVIDER_UNAVAILABLE',
  INTERNAL: 'INTERNAL',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

/** The exact JSON body every failed request returns. */
export interface ErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    details?: unknown;
    requestId: string;
  };
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: unknown;
  /** Whether the client may usefully retry the identical request. */
  readonly retryable: boolean;

  constructor(
    code: ErrorCode,
    status: number,
    message: string,
    options: { details?: unknown; retryable?: boolean; cause?: unknown } = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = new.target.name;
    this.code = code;
    this.status = status;
    this.details = options.details;
    this.retryable = options.retryable ?? false;
  }

  toBody(requestId: string): ErrorBody {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details !== undefined ? { details: this.details } : {}),
        requestId,
      },
    };
  }
}

export class ValidationError extends AppError {
  constructor(message = 'The request body or query is not valid.', details?: unknown) {
    super(ErrorCode.VALIDATION_FAILED, 400, message, { details });
  }
}

export class UnauthenticatedError extends AppError {
  constructor(message = 'No caller identity was supplied.') {
    super(ErrorCode.UNAUTHENTICATED, 401, message);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'You do not have access to this resource.') {
    super(ErrorCode.FORBIDDEN, 403, message);
  }
}

/**
 * Used for resources that exist but belong to someone else, as well as for
 * resources that genuinely do not exist. Answering 403 for the former would
 * confirm that a given id is real, which is an existence leak.
 */
export class NotFoundError extends AppError {
  constructor(resource = 'Resource', message?: string) {
    super(ErrorCode.NOT_FOUND, 404, message ?? `${resource} was not found.`);
  }
}

export class ConflictError extends AppError {
  constructor(message: string, details?: unknown) {
    super(ErrorCode.CONFLICT, 409, message, { details });
  }
}

export class RateLimitError extends AppError {
  readonly retryAfterSeconds: number;

  constructor(retryAfterSeconds: number, message?: string) {
    super(
      ErrorCode.RATE_LIMITED,
      429,
      message ?? `Too many requests. Try again in ${retryAfterSeconds} seconds.`,
      { retryable: true, details: { retryAfterSeconds } },
    );
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class ToolError extends AppError {
  constructor(toolName: string, message: string, cause?: unknown) {
    super(ErrorCode.TOOL_FAILED, 500, message, { details: { tool: toolName }, cause });
  }
}

export class ToolTimeoutError extends AppError {
  constructor(toolName: string, timeoutMs: number) {
    super(
      ErrorCode.TOOL_TIMEOUT,
      504,
      `The ${toolName} lookup took longer than ${timeoutMs}ms and was abandoned.`,
      { details: { tool: toolName, timeoutMs }, retryable: true },
    );
  }
}

export class AgentError extends AppError {
  constructor(message: string, cause?: unknown) {
    super(ErrorCode.AGENT_FAILED, 500, message, { retryable: true, cause });
  }
}

export class ProviderUnavailableError extends AppError {
  constructor(message = 'The model provider is unreachable right now.', cause?: unknown) {
    super(ErrorCode.PROVIDER_UNAVAILABLE, 503, message, { retryable: true, cause });
  }
}

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}

/**
 * Narrow an unknown thrown value to an AppError, wrapping anything unexpected.
 * The original message is deliberately dropped for non-AppErrors so internal
 * details never reach a client.
 */
export function toAppError(value: unknown): AppError {
  if (isAppError(value)) return value;
  return new AppError(ErrorCode.INTERNAL, 500, 'Something went wrong on our side.', {
    cause: value,
  });
}
