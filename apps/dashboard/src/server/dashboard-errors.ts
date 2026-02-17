export type DashboardIntegrationErrorCode =
  | 'not_found'
  | 'invalid_request'
  | 'auth_required'
  | 'conflict'
  | 'internal_error';

export class DashboardIntegrationError extends Error {
  readonly code: DashboardIntegrationErrorCode;
  readonly status: number;
  readonly details?: Record<string, unknown>;

  constructor(
    code: DashboardIntegrationErrorCode,
    message: string,
    options: {
      status: number;
      details?: Record<string, unknown>;
      cause?: unknown;
    },
  ) {
    super(message, { cause: options.cause });
    this.name = 'DashboardIntegrationError';
    this.code = code;
    this.status = options.status;
    this.details = options.details;
  }
}

type ErrorWithCode = {
  code?: unknown;
  message?: unknown;
};

function hasCode(error: unknown): error is ErrorWithCode {
  return typeof error === 'object' && error !== null && 'code' in error;
}

function hasMessage(error: unknown): error is ErrorWithCode {
  return typeof error === 'object' && error !== null && 'message' in error;
}

function readMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (hasMessage(error) && typeof error.message === 'string') {
    return error.message;
  }

  return String(error);
}

function isJsonParseError(error: unknown, normalizedMessage: string): boolean {
  return error instanceof SyntaxError && normalizedMessage.includes('json');
}

export function toDashboardIntegrationError(
  error: unknown,
  fallbackMessage = 'Dashboard integration request failed.',
): DashboardIntegrationError {
  if (error instanceof DashboardIntegrationError) {
    return error;
  }

  const message = readMessage(error);
  const normalizedMessage = message.toLowerCase();

  if (hasCode(error) && error.code === 'WORKFLOW_TREE_NOT_FOUND') {
    return new DashboardIntegrationError('not_found', message, {
      status: 404,
      cause: error,
    });
  }

  if (
    normalizedMessage.includes('authentication is required') ||
    (normalizedMessage.includes('auth') && normalizedMessage.includes('required'))
  ) {
    return new DashboardIntegrationError('auth_required', message, {
      status: 401,
      cause: error,
    });
  }

  if (normalizedMessage.includes('was not found') || normalizedMessage.includes('not found')) {
    return new DashboardIntegrationError('not_found', message, {
      status: 404,
      cause: error,
    });
  }

  if (isJsonParseError(error, normalizedMessage)) {
    return new DashboardIntegrationError('invalid_request', message, {
      status: 400,
      cause: error,
    });
  }

  if (
    normalizedMessage.includes('invalid') ||
    normalizedMessage.includes('missing') ||
    normalizedMessage.includes('cannot be empty')
  ) {
    return new DashboardIntegrationError('invalid_request', message, {
      status: 400,
      cause: error,
    });
  }

  if (normalizedMessage.includes('already exists') || normalizedMessage.includes('precondition failed')) {
    return new DashboardIntegrationError('conflict', message, {
      status: 409,
      cause: error,
    });
  }

  return new DashboardIntegrationError('internal_error', fallbackMessage, {
    status: 500,
    details: {
      cause: message,
    },
    cause: error,
  });
}
