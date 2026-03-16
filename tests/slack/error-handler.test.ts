import { describe, it, expect, vi } from 'vitest';
import { ErrorDisplayHandler } from '../../src/slack/error-handler.js';
import { ExecutionError, ProcessError, BridgeError } from '../../src/utils/errors.js';

describe('ErrorDisplayHandler', () => {
  function createMockClient() {
    return {
      chat: {
        postMessage: vi.fn().mockResolvedValue({ ok: true, ts: '2.000' }),
      },
    };
  }

  it('should post execution error with retry button', async () => {
    const client = createMockClient();
    const handler = new ErrorDisplayHandler(client as any);

    const err = new ExecutionError('CLI failed', {
      sessionId: 'abc-123',
      exitCode: 1,
      stderr: 'command not found',
    });

    await handler.displayError({
      error: err,
      channelId: 'D123',
      threadTs: '1.000',
      originalPromptHash: 'hash123',
    });

    expect(client.chat.postMessage).toHaveBeenCalledTimes(1);
    const callArgs = client.chat.postMessage.mock.calls[0][0];
    expect(callArgs.channel).toBe('D123');
    expect(callArgs.thread_ts).toBe('1.000');
    expect(callArgs.blocks.length).toBeGreaterThan(0);
  });

  it('should post process timeout error', async () => {
    const client = createMockClient();
    const handler = new ErrorDisplayHandler(client as any);

    const err = ProcessError.timeout('abc-123', 300000);

    await handler.displayError({
      error: err,
      channelId: 'D123',
      threadTs: '1.000',
    });

    expect(client.chat.postMessage).toHaveBeenCalledTimes(1);
  });

  it('should post generic bridge error', async () => {
    const client = createMockClient();
    const handler = new ErrorDisplayHandler(client as any);

    const err = new BridgeError('something broke', 'UNKNOWN_ERROR');

    await handler.displayError({
      error: err,
      channelId: 'D123',
      threadTs: '1.000',
    });

    expect(client.chat.postMessage).toHaveBeenCalledTimes(1);
  });
});
