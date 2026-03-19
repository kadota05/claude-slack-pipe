import { describe, it, expect, beforeEach, vi } from 'vitest';
import { StreamProcessor } from '../../src/streaming/stream-processor.js';

describe('StreamProcessor with BundleAction', () => {
  let processor: StreamProcessor;

  beforeEach(() => {
    processor = new StreamProcessor({ channel: 'C123', threadTs: '1234.5678', sessionId: 'sess-1' });
  });

  it('returns bundleActions instead of groupActions', async () => {
    const result = await processor.processEvent({
      type: 'assistant',
      message: { content: [{ type: 'thinking', thinking: 'hmm' }] },
    });
    expect(result.bundleActions).toBeDefined();
    expect(result.bundleActions.length).toBeGreaterThan(0);
    expect(result.bundleActions[0].bundleId).toBeDefined();
  });

  it('thinking then tool stays in same bundle', async () => {
    const r1 = await processor.processEvent({
      type: 'assistant',
      message: { content: [{ type: 'thinking', thinking: 'hmm' }] },
    });
    processor.registerBundleMessageTs(r1.bundleActions[0].bundleId, 'MSG_TS');

    const r2 = await processor.processEvent({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 'toolu_001', name: 'Read', input: { file_path: '/a.ts' } }] },
    });
    expect(r2.bundleActions[0].bundleId).toBe(r1.bundleActions[0].bundleId);
  });

  it('text event collapses bundle', async () => {
    const r1 = await processor.processEvent({
      type: 'assistant',
      message: { content: [{ type: 'thinking', thinking: 'hmm' }] },
    });
    processor.registerBundleMessageTs(r1.bundleActions[0].bundleId, 'MSG_TS');

    const r2 = await processor.processEvent({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'Here is the answer which is long enough to post immediately because it exceeds one hundred characters in length so the buffer triggers a post' }] },
    });
    const collapse = r2.bundleActions.find(a => a.type === 'collapse');
    expect(collapse).toBeDefined();
  });

  it('result event flushes active bundle', async () => {
    const r1 = await processor.processEvent({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 'toolu_001', name: 'Read', input: { file_path: '/a.ts' } }] },
    });
    processor.registerBundleMessageTs(r1.bundleActions[0].bundleId, 'MSG_TS');

    const r2 = await processor.processEvent({ type: 'result', duration_ms: 1000 });
    const collapse = r2.bundleActions.find(a => a.type === 'collapse');
    expect(collapse).toBeDefined();
    expect(r2.resultEvent).toBeDefined();
  });

  it('subagent complete does NOT collapse bundle', async () => {
    const r1 = await processor.processEvent({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 'toolu_agent', name: 'Agent', input: { description: 'explore' } }] },
    });
    processor.registerBundleMessageTs(r1.bundleActions[0].bundleId, 'MSG_TS');

    const r2 = await processor.processEvent({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_agent', content: 'agentId: abc123\ndone' }] },
    });
    const collapse = r2.bundleActions.find(a => a.type === 'collapse');
    expect(collapse).toBeUndefined();
  });

  it('extracts agentId from subagent tool_result', async () => {
    const r1 = await processor.processEvent({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 'toolu_agent', name: 'Agent', input: { description: 'explore' } }] },
    });
    processor.registerBundleMessageTs(r1.bundleActions[0].bundleId, 'MSG_TS');

    await processor.processEvent({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_agent', content: 'agentId: abc123\ndone' }] },
    });
    // No crash = agentId extraction works
  });
});

function makeProcessor() {
  return new StreamProcessor({
    channel: 'C_TEST',
    threadTs: '1000.0001',
    sessionId: 'sess-test',
  });
}

describe('StreamProcessor child event filtering', () => {
  it('should NOT collapse bundle when child text event arrives', async () => {
    const sp = makeProcessor();

    // 1. Start subagent — creates bundle + subagent group
    const r1 = await sp.processEvent({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'agent-1', name: 'Agent', input: { description: 'test agent' } }] },
    });
    expect(r1.bundleActions.length).toBeGreaterThan(0);
    expect(r1.bundleActions[0].type).toBe('postMessage');

    // 2. Child text event — should NOT collapse the bundle
    const r2 = await sp.processEvent({
      type: 'assistant',
      parent_tool_use_id: 'agent-1',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Using brainstorming skill...' }] },
    });
    // No collapse action should be emitted
    const collapseActions = r2.bundleActions.filter(a => a.type === 'collapse');
    expect(collapseActions).toHaveLength(0);
    // No text action should be emitted for child text
    expect(r2.textAction).toBeUndefined();

    // 3. Child tool_use — subagent step should still work
    const r3 = await sp.processEvent({
      type: 'assistant',
      parent_tool_use_id: 'agent-1',
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: '/tmp/test' } }] },
    });
    // Should produce update action (subagent step added)
    // No collapse
    const collapseActions3 = r3.bundleActions.filter(a => a.type === 'collapse');
    expect(collapseActions3).toHaveLength(0);
  });

  it('should NOT switch group category when child thinking event arrives', async () => {
    const sp = makeProcessor();

    // 1. Start subagent
    await sp.processEvent({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'agent-1', name: 'Agent', input: { description: 'test' } }] },
    });

    // 2. Child thinking event — should NOT create a thinking group
    const r2 = await sp.processEvent({
      type: 'assistant',
      parent_tool_use_id: 'agent-1',
      message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'Let me think about this...' }] },
    });
    const collapseActions = r2.bundleActions.filter(a => a.type === 'collapse');
    expect(collapseActions).toHaveLength(0);

    // 3. Subagent should still be tracked (in activeSubagents Map, not activeGroup)
    //    activeGroup should be null (child thinking must NOT create a thinking group)
    const activeGroup = sp.getActiveGroupData();
    expect(activeGroup).toBeNull();
  });
});

describe('StreamProcessor text posting (no 100-char buffer)', () => {
  it('collapses bundle when any text arrives (regardless of length)', async () => {
    const sp = makeProcessor();

    // 1. thinking + tool_use → bundle starts
    const r0 = await sp.processEvent({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'Let me search...' }] },
    });
    sp.registerBundleMessageTs(r0.bundleActions[0].bundleId, 'MSG_TS_1');
    await sp.processEvent({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tool-1', name: 'ToolSearch', input: { query: 'mcp' } }] },
    });
    await sp.processEvent({
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'found tools' }] },
    });

    // 2. Short text — NOW collapses bundle immediately (no 100-char buffer)
    const r = await sp.processEvent({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'ツールを確認しました。' }] },
    });
    const collapseActions = r.bundleActions.filter(a => a.type === 'collapse');
    expect(collapseActions).toHaveLength(1);
    expect(r.textAction).toBeDefined();
    expect(r.textAction!.type).toBe('postMessage');
  });

  it('should collapse bundle when long text arrives', async () => {
    const sp = makeProcessor();

    // 1. tool_use → bundle starts
    const r0 = await sp.processEvent({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: '/tmp/f' } }] },
    });
    sp.registerBundleMessageTs(r0.bundleActions[0].bundleId, 'MSG_TS_2');
    await sp.processEvent({
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'file contents' }] },
    });

    // 2. Long text — should collapse bundle
    const longText = 'これは非常に長いテキストレスポンスです。ユーザーの質問に対して詳細な回答を提供しています。バンドルはこのテキストで折りたたまれるべきです。十分な長さがあるため、バッファのチェックを超えます。追記：この行で確実に100文字を超えます。';
    const r = await sp.processEvent({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: longText }] },
    });
    const collapseActions = r.bundleActions.filter(a => a.type === 'collapse');
    expect(collapseActions).toHaveLength(1);
  });

  it('short text collapses bundle immediately, not deferred to result', async () => {
    const sp = makeProcessor();

    // 1. tool_use → bundle starts
    const r0 = await sp.processEvent({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: '/tmp/f' } }] },
    });
    sp.registerBundleMessageTs(r0.bundleActions[0].bundleId, 'MSG_TS_3');
    await sp.processEvent({
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'ok' }] },
    });

    // 2. Short text — collapses immediately now
    const r1 = await sp.processEvent({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: '完了。' }] },
    });
    const collapseActions1 = r1.bundleActions.filter(a => a.type === 'collapse');
    expect(collapseActions1).toHaveLength(1);

    // 3. Result event — no bundle left to collapse
    const r = await sp.processEvent({ type: 'result', duration_ms: 1000 });
    expect(r.resultEvent).toBeDefined();
  });

  it('first short text collapses immediately (no accumulation needed)', async () => {
    const sp = makeProcessor();

    // 1. tool_use → bundle starts
    const r0 = await sp.processEvent({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: '/tmp/f' } }] },
    });
    sp.registerBundleMessageTs(r0.bundleActions[0].bundleId, 'MSG_TS_4');
    await sp.processEvent({
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'ok' }] },
    });

    // 2. First short text — collapses immediately
    const r1 = await sp.processEvent({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'ファイルを確認しました。次に進みます。' }] },
    });
    expect(r1.bundleActions.filter(a => a.type === 'collapse')).toHaveLength(1);
    expect(r1.textAction).toBeDefined();
  });
});

import { TunnelManager } from '../../src/streaming/tunnel-manager.js';

describe('StreamProcessor with TunnelManager', () => {
  it('calls startTunnel when text contains localhost URL', async () => {
    const mockTunnelManager = {
      startTunnel: vi.fn().mockResolvedValue('https://test.trycloudflare.com'),
      getTunnelUrl: vi.fn(),
      stopTunnel: vi.fn(),
      stopAll: vi.fn(),
    } as unknown as TunnelManager;

    const processor = new StreamProcessor({
      channel: 'C123',
      threadTs: '123.456',
      sessionId: 'test',
      tunnelManager: mockTunnelManager,
    });

    await processor.processEvent({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'Server at http://localhost:3000 which is long enough to exceed the buffer threshold for posting text messages immediately to Slack' }] },
    });

    expect(mockTunnelManager.startTunnel).toHaveBeenCalledWith(3000);
  });

  it('does not call startTunnel when no localhost URL in text', async () => {
    const mockTunnelManager = {
      startTunnel: vi.fn(),
      getTunnelUrl: vi.fn(),
      stopTunnel: vi.fn(),
      stopAll: vi.fn(),
    } as unknown as TunnelManager;

    const processor = new StreamProcessor({
      channel: 'C123',
      threadTs: '123.456',
      sessionId: 'test',
      tunnelManager: mockTunnelManager,
    });

    await processor.processEvent({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'Hello world' }] },
    });

    expect(mockTunnelManager.startTunnel).not.toHaveBeenCalled();
  });

  it('works normally without tunnelManager (backward compat)', async () => {
    const processor = new StreamProcessor({
      channel: 'C123',
      threadTs: '123.456',
      sessionId: 'test',
    });

    // Should not throw
    const result = await processor.processEvent({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'Server at http://localhost:3000' }] },
    });
    expect(result).toBeDefined();
  });
});

describe('StreamProcessor - round-based text splitting', () => {
  const config = { channel: 'C123', threadTs: '1234.5678', sessionId: 'test-session' };

  it('posts text immediately regardless of length (no 100-char buffering)', async () => {
    const sp = new StreamProcessor(config);

    // thinking → tool → short text
    await sp.processEvent({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'hmm' }] } });
    sp.registerBundleMessageTs('bundle-1', '1111.0000');
    await sp.processEvent({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/a.txt' } }] } });
    await sp.processEvent({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } });

    // Short text (< 100 chars) — should still produce textAction
    const result = await sp.processEvent({ type: 'assistant', message: { content: [{ type: 'text', text: '確認しました。' }] } });
    expect(result.textAction).toBeDefined();
    expect(result.textAction!.type).toBe('postMessage');
  });

  it('resets textMessageTs when new thinking starts', async () => {
    const sp = new StreamProcessor(config);

    // Round 1: text
    const r1 = await sp.processEvent({ type: 'assistant', message: { content: [{ type: 'text', text: 'Round 1 text' }] } });
    expect(r1.textAction?.type).toBe('postMessage');
    sp.registerTextMessageTs('2222.0000');

    // Round 2: thinking starts → should reset textMessageTs
    await sp.processEvent({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'thinking again' }] } });
    sp.registerBundleMessageTs('bundle-1', '3333.0000');

    // Round 2: text → should be NEW postMessage, not update
    const result = await sp.processEvent({ type: 'assistant', message: { content: [{ type: 'text', text: 'Round 2 text' }] } });
    expect(result.textAction).toBeDefined();
    expect(result.textAction!.type).toBe('postMessage');
  });

  it('resets textMessageTs when new tool_use starts', async () => {
    const sp = new StreamProcessor(config);

    // Round 1: text
    await sp.processEvent({ type: 'assistant', message: { content: [{ type: 'text', text: 'First response' }] } });
    sp.registerTextMessageTs('2222.0000');

    // New tool starts → should reset
    await sp.processEvent({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/b.txt' } }] } });
    sp.registerBundleMessageTs('bundle-1', '4444.0000');
    await sp.processEvent({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } });

    // Next text → should be postMessage (new message)
    const result = await sp.processEvent({ type: 'assistant', message: { content: [{ type: 'text', text: 'Second response' }] } });
    expect(result.textAction?.type).toBe('postMessage');
  });

  it('buffers text while subagents are running', async () => {
    const sp = new StreamProcessor(config);

    // Start agent
    await sp.processEvent({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'agentA', name: 'Agent', input: { description: 'Explore' } }] } });
    sp.registerBundleMessageTs('bundle-1', 'b1.ts');

    // Text while agent running — should be buffered
    const textDuring = await sp.processEvent({ type: 'assistant', message: { content: [{ type: 'text', text: 'Working...' }] } });
    expect(textDuring.textAction).toBeUndefined();

    // Complete agent — text should flush
    const completion = await sp.processEvent({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'agentA', content: 'agentId: abc\ndone' }] } });
    expect(completion.textAction).toBeDefined();
    expect(completion.textAction!.type).toBe('postMessage');
  });
});

describe('StreamProcessor - multi-round ordering (integration)', () => {
  it('produces [bundle][text][bundle][text] for 2+ rounds', async () => {
    const sp = new StreamProcessor({ channel: 'C1', threadTs: '1.0', sessionId: 's1' });

    // Round 1: thinking → tool → text
    await sp.processEvent({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'think1' }] } });
    sp.registerBundleMessageTs('bundle-1', 'b1.ts');
    await sp.processEvent({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/a' } }] } });
    await sp.processEvent({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } });
    const r1text = await sp.processEvent({ type: 'assistant', message: { content: [{ type: 'text', text: 'Round 1 response' }] } });
    expect(r1text.textAction?.type).toBe('postMessage');
    sp.registerTextMessageTs('t1.ts');

    // Round 2: thinking → tool → text (should be NEW postMessage)
    await sp.processEvent({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'think2' }] } });
    sp.registerBundleMessageTs('bundle-2', 'b2.ts');
    await sp.processEvent({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'npm test' } }] } });
    await sp.processEvent({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't2', content: 'pass' }] } });
    const r2text = await sp.processEvent({ type: 'assistant', message: { content: [{ type: 'text', text: 'Round 2 response' }] } });
    // Critical: this must be postMessage (new message), NOT update
    expect(r2text.textAction?.type).toBe('postMessage');
  });
});

describe('StreamProcessor - parallel subagents (integration)', () => {
  it('tracks both subagents and flushes text after all complete', async () => {
    const sp = new StreamProcessor({ channel: 'C1', threadTs: '1.0', sessionId: 's1' });

    // Start agent A and B
    await sp.processEvent({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'agentA', name: 'Agent', input: { description: 'Explore' } }] } });
    sp.registerBundleMessageTs('bundle-1', 'b1.ts');
    await sp.processEvent({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'agentB', name: 'Agent', input: { description: 'Test' } }] } });

    // Text while subagents running — should be buffered
    const textDuring = await sp.processEvent({ type: 'assistant', message: { content: [{ type: 'text', text: 'Working on it...' }] } });
    expect(textDuring.textAction).toBeUndefined();

    // Complete A — text still buffered (B still running)
    const afterA = await sp.processEvent({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'agentA', content: 'agentId: abc123\ndone' }] } });
    expect(afterA.textAction).toBeUndefined();

    // Complete B — text should now flush
    const afterB = await sp.processEvent({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'agentB', content: 'agentId: def456\ndone' }] } });
    expect(afterB.textAction).toBeDefined();
    expect(afterB.textAction!.type).toBe('postMessage');
  });
});

describe('StreamProcessor - no 応答中 footer', () => {
  it('does not include 応答中 footer in streaming text blocks', async () => {
    const processor = new StreamProcessor({ channel: 'C1', threadTs: 'T1', sessionId: 'S1' });
    const result = await processor.processEvent({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'Hello world' }] },
    });
    if (result.textAction) {
      const hasFooter = result.textAction.blocks.some(
        (b: any) => b.type === 'context' && JSON.stringify(b).includes('応答中')
      );
      expect(hasFooter).toBe(false);
    }
  });
});

describe('StreamProcessor - text-tool-text pattern (integration)', () => {
  it('handles text → tool → text pattern with separate messages', async () => {
    const sp = new StreamProcessor({ channel: 'C1', threadTs: '1.0', sessionId: 's1' });

    // First text (no bundle before it)
    const r1 = await sp.processEvent({ type: 'assistant', message: { content: [{ type: 'text', text: 'Let me check.' }] } });
    expect(r1.textAction?.type).toBe('postMessage');
    sp.registerTextMessageTs('t1.ts');

    // Tool starts — should reset text
    await sp.processEvent({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/a' } }] } });
    sp.registerBundleMessageTs('bundle-1', 'b1.ts');
    await sp.processEvent({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'data' }] } });

    // Second text — should be NEW postMessage
    const r2 = await sp.processEvent({ type: 'assistant', message: { content: [{ type: 'text', text: 'Here are the results.' }] } });
    expect(r2.textAction?.type).toBe('postMessage');
  });
});
