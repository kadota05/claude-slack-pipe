export type ErrorCode =
  | 'UNKNOWN_ERROR'
  | 'AUTH_DENIED'
  | 'RATE_LIMITED'
  | 'SESSION_NOT_FOUND'
  | 'SESSION_ENDED'
  | 'CONCURRENCY_LIMIT'
  | 'PROCESS_TIMEOUT'
  | 'EXECUTION_FAILED'
  | 'SLACK_API_ERROR'
  | 'INVALID_COMMAND'
  | 'PROJECT_NOT_FOUND';

export class BridgeError extends Error {
  constructor(
    message: string,
    public readonly code: ErrorCode,
    public readonly context: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'BridgeError';
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      context: this.context,
    };
  }
}

export class AuthError extends BridgeError {
  constructor(message: string, context: Record<string, unknown> = {}) {
    super(message, 'AUTH_DENIED', context);
    this.name = 'AuthError';
  }
}

export class RateLimitError extends BridgeError {
  constructor(message: string, context: Record<string, unknown> = {}) {
    super(message, 'RATE_LIMITED', context);
    this.name = 'RateLimitError';
  }
}

export class SessionError extends BridgeError {
  constructor(
    message: string,
    code: ErrorCode,
    context: Record<string, unknown> = {},
  ) {
    super(message, code, context);
    this.name = 'SessionError';
  }

  static notFound(sessionId: string): SessionError {
    return new SessionError(
      `Session not found: ${sessionId}`,
      'SESSION_NOT_FOUND',
      { sessionId },
    );
  }

  static alreadyEnded(sessionId: string): SessionError {
    return new SessionError(
      `Session already ended: ${sessionId}`,
      'SESSION_ENDED',
      { sessionId },
    );
  }
}

export class ProcessError extends BridgeError {
  constructor(
    message: string,
    code: ErrorCode,
    context: Record<string, unknown> = {},
  ) {
    super(message, code, context);
    this.name = 'ProcessError';
  }

  static concurrencyLimit(userId: string, limit: number): ProcessError {
    return new ProcessError(
      `Concurrency limit reached for user ${userId} (max: ${limit})`,
      'CONCURRENCY_LIMIT',
      { userId, limit },
    );
  }

  static timeout(sessionId: string, timeoutMs: number): ProcessError {
    return new ProcessError(
      `Process timed out after ${timeoutMs}ms for session ${sessionId}`,
      'PROCESS_TIMEOUT',
      { sessionId, timeoutMs },
    );
  }
}

export class ExecutionError extends BridgeError {
  constructor(
    message: string,
    context: Record<string, unknown> & {
      sessionId: string;
      exitCode?: number | null;
      stderr?: string;
    },
  ) {
    super(message, 'EXECUTION_FAILED', context);
    this.name = 'ExecutionError';
  }
}

export class SlackApiError extends BridgeError {
  constructor(
    message: string,
    context: Record<string, unknown> & {
      method: string;
      slackError?: string;
    },
  ) {
    super(message, 'SLACK_API_ERROR', context);
    this.name = 'SlackApiError';
  }
}
