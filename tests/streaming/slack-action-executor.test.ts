// tests/streaming/slack-action-executor.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SlackActionExecutor } from '../../src/streaming/slack-action-executor.js';
import type { SlackAction } from '../../src/streaming/types.js';

function createMockClient() {
  return {
    chat: {
      postMessage: vi.fn().mockResolvedValue({ ok: true, ts: '1234.5678' }),
      update: vi.fn().mockResolvedValue({ ok: true, ts: '1234.5678' }),
    },
    reactions: {
      add: vi.fn().mockResolvedValue({ ok: true }),
      remove: vi.fn().mockResolvedValue({ ok: true }),
    },
  };
}

function makeAction(overrides: Partial<SlackAction> = {}): SlackAction {
  return {
    type: 'postMessage',
    priority: 3,
    channel: 'C123',
    threadTs: 'T123',
    blocks: [{ type: 'section', text: { type: 'mrkdwn', text: 'test' } }],
    text: 'test',
    metadata: { messageType: 'tool_use' },
    ...overrides,
  };
}

describe('SlackActionExecutor', () => {
  let executor: SlackActionExecutor;
  let client: ReturnType<typeof createMockClient>;

  beforeEach(() => {
    client = createMockClient();
    executor = new SlackActionExecutor(client as any);
  });

  it('executes postMessage action', async () => {
    const action = makeAction({ type: 'postMessage' });
    const result = await executor.execute(action);
    expect(result.ok).toBe(true);
    expect(result.ts).toBe('1234.5678');
    expect(client.chat.postMessage).toHaveBeenCalledWith({
      channel: 'C123',
      thread_ts: 'T123',
      blocks: action.blocks,
      text: 'test',
    });
  });

  it('executes update action', async () => {
    const action = makeAction({ type: 'update', messageTs: '1111.2222' });
    const result = await executor.execute(action);
    expect(result.ok).toBe(true);
    expect(client.chat.update).toHaveBeenCalledWith({
      channel: 'C123',
      ts: '1111.2222',
      blocks: action.blocks,
      text: 'test',
    });
  });

  it('executes addReaction action', async () => {
    const action = makeAction({
      type: 'addReaction',
      emoji: 'brain',
      targetTs: '1111.2222',
    });
    const result = await executor.execute(action);
    expect(result.ok).toBe(true);
    expect(client.reactions.add).toHaveBeenCalledWith({
      channel: 'C123',
      timestamp: '1111.2222',
      name: 'brain',
    });
  });

  it('handles API errors gracefully', async () => {
    client.chat.postMessage.mockRejectedValue(new Error('channel_not_found'));
    const action = makeAction();
    const result = await executor.execute(action);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('channel_not_found');
  });

  it('detects 429 and records rate limit', async () => {
    const error = new Error('ratelimited') as any;
    error.data = { headers: { 'retry-after': '5' } };
    error.code = 'slack_webapi_rate_limited';
    client.chat.postMessage.mockRejectedValue(error);

    const action = makeAction();
    const result = await executor.execute(action);
    expect(result.ok).toBe(false);
    expect(result.retryAfterMs).toBeGreaterThan(0);
  });
});
