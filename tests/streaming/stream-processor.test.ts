// tests/streaming/stream-processor.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { StreamProcessor } from '../../src/streaming/stream-processor.js';

describe('StreamProcessor', () => {
  let processor: StreamProcessor;

  beforeEach(() => {
    processor = new StreamProcessor({ channel: 'C123', threadTs: 'T123' });
  });

  describe('thinking events', () => {
    it('returns postMessage group action for first thinking', () => {
      const result = processor.processEvent({
        type: 'assistant',
        message: {
          content: [{ type: 'thinking', thinking: 'Analyzing...' }],
          stop_reason: null,
        },
      });

      expect(result.groupActions).toHaveLength(1);
      expect(result.groupActions[0].type).toBe('postMessage');
      expect(result.groupActions[0].category).toBe('thinking');
      expect(result.textAction).toBeUndefined();
      expect(result.resultEvent).toBeUndefined();
    });
  });

  describe('tool_use events', () => {
    it('collapses thinking and starts tool group', () => {
      const think = processor.processEvent({
        type: 'assistant',
        message: {
          content: [{ type: 'thinking', thinking: 'Need to read file' }],
          stop_reason: null,
        },
      });
      processor.registerGroupMessageTs(think.groupActions[0].groupId, 'THINK_TS');

      const tool = processor.processEvent({
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', id: 'toolu_001', name: 'Read', input: { file_path: '/a.ts' } }],
          stop_reason: 'tool_use',
        },
      });

      const collapse = tool.groupActions.find(a => a.type === 'collapse');
      const post = tool.groupActions.find(a => a.type === 'postMessage');
      expect(collapse).toBeDefined();
      expect(post).toBeDefined();
      expect(post!.category).toBe('tool');
    });
  });

  describe('tool_result events', () => {
    it('collapses tool group when all tools complete', () => {
      const toolAction = processor.processEvent({
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', id: 'toolu_001', name: 'Read', input: { file_path: '/a.ts' } }],
          stop_reason: 'tool_use',
        },
      });
      processor.registerGroupMessageTs(toolAction.groupActions[0].groupId, 'TOOL_TS');

      const result = processor.processEvent({
        type: 'user',
        message: {
          content: [{ type: 'tool_result', tool_use_id: 'toolu_001', content: 'file contents' }],
        },
      });

      const collapse = result.groupActions.find(a => a.type === 'collapse');
      expect(collapse).toBeDefined();
    });
  });

  describe('text events', () => {
    it('returns text action for text content', () => {
      const result = processor.processEvent({
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'Hello world' }],
          stop_reason: 'end_turn',
        },
      });

      expect(result.textAction).toBeDefined();
      expect(result.textAction!.type).toBe('postMessage');
      expect(result.textAction!.metadata.messageType).toBe('text');
    });

    it('returns update action for subsequent text', () => {
      const first = processor.processEvent({
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'Hello' }],
          stop_reason: null,
        },
      });
      processor.registerTextMessageTs('TEXT_TS');

      const second = processor.processEvent({
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: ' world' }],
          stop_reason: 'end_turn',
        },
      });

      expect(second.textAction).toBeDefined();
      expect(second.textAction!.type).toBe('update');
    });
  });

  describe('result events', () => {
    it('returns resultEvent and flushes active group', () => {
      const toolAction = processor.processEvent({
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', id: 'toolu_001', name: 'Read', input: { file_path: '/a.ts' } }],
          stop_reason: 'tool_use',
        },
      });
      processor.registerGroupMessageTs(toolAction.groupActions[0].groupId, 'TOOL_TS');

      const result = processor.processEvent({
        type: 'result',
        duration_ms: 5000,
        usage: { input_tokens: 1000, output_tokens: 500 },
      });

      expect(result.resultEvent).toBeDefined();
      expect(result.groupActions.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('subagent events', () => {
    it('handles Agent tool as subagent', () => {
      const result = processor.processEvent({
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', id: 'toolu_agent', name: 'Agent', input: { prompt: 'Search code', description: 'コード探索' } }],
          stop_reason: 'tool_use',
        },
      });

      expect(result.groupActions).toHaveLength(1);
      expect(result.groupActions[0].category).toBe('subagent');
    });

    it('tracks child tools via parent_tool_use_id', () => {
      const agentResult = processor.processEvent({
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', id: 'toolu_agent', name: 'Agent', input: { description: 'Search' } }],
          stop_reason: 'tool_use',
        },
      });
      processor.registerGroupMessageTs(agentResult.groupActions[0].groupId, 'AGENT_TS');

      const childResult = processor.processEvent({
        type: 'assistant',
        parent_tool_use_id: 'toolu_agent',
        message: {
          content: [{ type: 'tool_use', id: 'toolu_child', name: 'Grep', input: { pattern: 'auth' } }],
          stop_reason: 'tool_use',
        },
      });

      // Should not create a new tool group (no postMessage with category 'tool')
      const toolGroupPost = childResult.groupActions.find(a => a.type === 'postMessage' && a.category === 'tool');
      expect(toolGroupPost).toBeUndefined();
    });
  });

  describe('mixed event sequences', () => {
    it('handles thinking → tool → thinking → tool → text', () => {
      const t1 = processor.processEvent({
        type: 'assistant',
        message: { content: [{ type: 'thinking', thinking: 'Think 1' }], stop_reason: null },
      });
      processor.registerGroupMessageTs(t1.groupActions[0].groupId, 'T1_TS');

      const tool1 = processor.processEvent({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/a.ts' } }], stop_reason: 'tool_use' },
      });
      const tool1PostAction = tool1.groupActions.find(a => a.type === 'postMessage');
      processor.registerGroupMessageTs(tool1PostAction!.groupId, 'TOOL1_TS');

      processor.processEvent({
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }] },
      });

      const t2 = processor.processEvent({
        type: 'assistant',
        message: { content: [{ type: 'thinking', thinking: 'Think 2' }], stop_reason: null },
      });
      const t2Post = t2.groupActions.find(a => a.type === 'postMessage');
      processor.registerGroupMessageTs(t2Post!.groupId, 'T2_TS');

      const text = processor.processEvent({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Answer' }], stop_reason: 'end_turn' },
      });

      const collapse = text.groupActions.find(a => a.type === 'collapse');
      expect(collapse).toBeDefined();
      expect(text.textAction).toBeDefined();
    });
  });
});
