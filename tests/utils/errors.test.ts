import { describe, it, expect } from 'vitest';
import {
  BridgeError,
  AuthError,
  RateLimitError,
  SessionError,
  ProcessError,
  ExecutionError,
  SlackApiError,
} from '../../src/utils/errors.js';

describe('BridgeError', () => {
  it('should create error with code and context', () => {
    const err = new BridgeError('something failed', 'UNKNOWN_ERROR', {
      sessionId: 'abc',
    });
    expect(err.message).toBe('something failed');
    expect(err.code).toBe('UNKNOWN_ERROR');
    expect(err.context).toEqual({ sessionId: 'abc' });
    expect(err.name).toBe('BridgeError');
    expect(err).toBeInstanceOf(Error);
  });

  it('should serialize to JSON', () => {
    const err = new BridgeError('fail', 'UNKNOWN_ERROR', { key: 'val' });
    const json = err.toJSON();
    expect(json).toEqual({
      name: 'BridgeError',
      code: 'UNKNOWN_ERROR',
      message: 'fail',
      context: { key: 'val' },
    });
  });
});

describe('AuthError', () => {
  it('should create auth error with userId', () => {
    const err = new AuthError('not allowed', { userId: 'U123' });
    expect(err.code).toBe('AUTH_DENIED');
    expect(err.context).toEqual({ userId: 'U123' });
    expect(err.name).toBe('AuthError');
    expect(err).toBeInstanceOf(BridgeError);
  });
});

describe('RateLimitError', () => {
  it('should include retryAfterMs', () => {
    const err = new RateLimitError('too fast', { userId: 'U123' });
    expect(err.code).toBe('RATE_LIMITED');
    expect(err.name).toBe('RateLimitError');
    expect(err).toBeInstanceOf(BridgeError);
  });
});

describe('SessionError', () => {
  it('should create session not found error', () => {
    const err = SessionError.notFound('sess-123');
    expect(err.code).toBe('SESSION_NOT_FOUND');
    expect(err.context).toEqual({ sessionId: 'sess-123' });
    expect(err.name).toBe('SessionError');
  });

  it('should create session already ended error', () => {
    const err = SessionError.alreadyEnded('sess-123');
    expect(err.code).toBe('SESSION_ENDED');
    expect(err.name).toBe('SessionError');
  });
});

describe('ProcessError', () => {
  it('should create concurrency limit error', () => {
    const err = ProcessError.concurrencyLimit('U123', 1);
    expect(err.code).toBe('CONCURRENCY_LIMIT');
    expect(err.name).toBe('ProcessError');
    expect(err).toBeInstanceOf(BridgeError);
  });

  it('should create timeout error', () => {
    const err = ProcessError.timeout('sess-123', 300000);
    expect(err.code).toBe('PROCESS_TIMEOUT');
    expect(err.name).toBe('ProcessError');
  });
});

describe('ExecutionError', () => {
  it('should wrap execution failures', () => {
    const err = new ExecutionError('cli failed', {
      sessionId: 'abc',
      exitCode: 1,
      stderr: 'error output',
    });
    expect(err.code).toBe('EXECUTION_FAILED');
    expect(err.context.exitCode).toBe(1);
    expect(err.name).toBe('ExecutionError');
  });
});

describe('SlackApiError', () => {
  it('should wrap slack api errors', () => {
    const err = new SlackApiError('chat.update failed', {
      method: 'chat.update',
      slackError: 'not_authed',
    });
    expect(err.code).toBe('SLACK_API_ERROR');
    expect(err.name).toBe('SlackApiError');
  });
});
