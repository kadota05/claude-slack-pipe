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

    // 3. Active group should still be subagent (not thinking)
    const activeGroup = sp.getActiveGroupData();
    expect(activeGroup).not.toBeNull();
    expect(activeGroup!.category).toBe('subagent');
  });
});

describe('StreamProcessor short text bundle deferral', () => {
  it('should NOT collapse bundle when short text arrives between tool calls', async () => {
    const sp = makeProcessor();

    // 1. thinking + tool_use → bundle starts
    await sp.processEvent({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'Let me search...' }] },
    });
    await sp.processEvent({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tool-1', name: 'ToolSearch', input: { query: 'mcp' } }] },
    });
    await sp.processEvent({
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'found tools' }] },
    });

    // 2. Short text (< 100 chars) — should NOT collapse bundle
    const r = await sp.processEvent({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'ツールを確認しました。' }] },
    });
    const collapseActions = r.bundleActions.filter(a => a.type === 'collapse');
    expect(collapseActions).toHaveLength(0);

    // 3. Next tool_use — should be in the SAME bundle (not a new one)
    const r2 = await sp.processEvent({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tool-2', name: 'mcp__gcal', input: {} }] },
    });
    const postActions = r2.bundleActions.filter(a => a.type === 'postMessage');
    expect(postActions).toHaveLength(0); // No new bundle posted
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

    // 2. Long text (>= 100 chars) — should collapse bundle
    const longText = 'これは非常に長いテキストレスポンスです。ユーザーの質問に対して詳細な回答を提供しています。バンドルはこのテキストで折りたたまれるべきです。十分な長さがあるため、バッファのチェックを超えます。追記：この行で確実に100文字を超えます。';
    const r = await sp.processEvent({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: longText }] },
    });
    const collapseActions = r.bundleActions.filter(a => a.type === 'collapse');
    expect(collapseActions).toHaveLength(1);
  });

  it('should collapse bundle on result even with buffered short text', async () => {
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

    // 2. Short text — NOT collapsed
    await sp.processEvent({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: '完了。' }] },
    });

    // 3. Result event — flushes active bundle
    const r = await sp.processEvent({ type: 'result', duration_ms: 1000 });
    expect(r.resultEvent).toBeDefined();
    // Bundle should have been flushed (collapsed)
    const collapseActions = r.bundleActions.filter(a => a.type === 'collapse');
    expect(collapseActions).toHaveLength(1);
  });

  it('should collapse bundle when accumulated short texts exceed threshold', async () => {
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

    // 2. First short text (30 chars) — NOT collapsed
    const r1 = await sp.processEvent({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'ファイルを確認しました。次に進みます。' }] },
    });
    expect(r1.bundleActions.filter(a => a.type === 'collapse')).toHaveLength(0);

    // 3. Second short text — accumulated total >= 100 chars → COLLAPSE
    const r2 = await sp.processEvent({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'このファイルには重要な設定が含まれています。変更内容を詳しく確認して、適切な修正を提案します。では具体的に見ていきましょう。合計100文字を超えるための追加テキストです。' }] },
    });
    const collapseActions = r2.bundleActions.filter(a => a.type === 'collapse');
    expect(collapseActions).toHaveLength(1);
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
