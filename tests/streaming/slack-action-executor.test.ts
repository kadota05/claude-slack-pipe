// tests/streaming/slack-action-executor.test.ts
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { SlackActionExecutor } from '../../src/streaming/slack-action-executor.js';
import type { SlackAction } from '../../src/streaming/types.js';

function createMockClient() {
  return {
    token: 'xoxb-test-token',
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

// Mock fetch for postMessage/update (which now use fetch directly)
const mockFetch = vi.fn();

describe('SlackActionExecutor', () => {
  let executor: SlackActionExecutor;
  let client: ReturnType<typeof createMockClient>;
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    client = createMockClient();
    executor = new SlackActionExecutor(client as any);
    originalFetch = global.fetch;
    global.fetch = mockFetch;
    mockFetch.mockReset();
    mockFetch.mockResolvedValue({
      json: () => Promise.resolve({ ok: true, ts: '1234.5678' }),
      headers: new Headers(),
    });
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('executes postMessage action via JSON fetch', async () => {
    const action = makeAction({ type: 'postMessage' });
    const result = await executor.execute(action);
    expect(result.ok).toBe(true);
    expect(result.ts).toBe('1234.5678');
    expect(mockFetch).toHaveBeenCalledWith(
      'https://slack.com/api/chat.postMessage',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Content-Type': 'application/json; charset=utf-8',
        }),
      })
    );
    // Verify JSON body contains correct fields
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.channel).toBe('C123');
    expect(body.thread_ts).toBe('T123');
    expect(body.blocks).toEqual(action.blocks);
  });

  it('executes update action via JSON fetch', async () => {
    const action = makeAction({ type: 'update', messageTs: '1111.2222' });
    const result = await executor.execute(action);
    expect(result.ok).toBe(true);
    expect(mockFetch).toHaveBeenCalledWith(
      'https://slack.com/api/chat.update',
      expect.any(Object)
    );
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.channel).toBe('C123');
    expect(body.ts).toBe('1111.2222');
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
    mockFetch.mockResolvedValue({
      json: () => Promise.resolve({ ok: false, error: 'channel_not_found' }),
      headers: new Headers(),
    });
    const action = makeAction();
    const result = await executor.execute(action);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('channel_not_found');
  });

  it('detects 429 and records rate limit', async () => {
    mockFetch.mockResolvedValue({
      json: () => Promise.resolve({ ok: false, error: 'ratelimited' }),
      headers: new Headers({ 'retry-after': '5' }),
    });
    const action = makeAction();
    const result = await executor.execute(action);
    expect(result.ok).toBe(false);
    expect(result.retryAfterMs).toBeGreaterThan(0);
  });

  it('skips low priority actions when rate limit is high', async () => {
    // Fill up rate limit to trigger degradation
    for (let i = 0; i < 19; i++) {
      executor.rateLimiter.record('postMessage');
    }
    // 19/20 = 95% → EMERGENCY → only P1 allowed

    const action = makeAction({ priority: 3 });
    const result = await executor.execute(action);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('degraded_skip');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('allows P1 actions even at high rate limit', async () => {
    for (let i = 0; i < 19; i++) {
      executor.rateLimiter.record('postMessage');
    }

    const action = makeAction({ priority: 1 });
    const result = await executor.execute(action);
    expect(result.ok).toBe(true);
  });
});
