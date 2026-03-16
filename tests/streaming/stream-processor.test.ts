// tests/streaming/stream-processor.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { StreamProcessor } from '../../src/streaming/stream-processor.js';
import type { SlackAction } from '../../src/streaming/types.js';

describe('StreamProcessor', () => {
  let processor: StreamProcessor;
  let emittedActions: SlackAction[];

  beforeEach(() => {
    emittedActions = [];
    processor = new StreamProcessor({
      channel: 'C123',
      threadTs: 'T123',
    });
    processor.on('action', (action: SlackAction) => {
      emittedActions.push(action);
    });
  });

  describe('thinking events', () => {
    it('emits postMessage for first thinking', () => {
      processor.processEvent({
        type: 'assistant',
        message: {
          content: [{ type: 'thinking', thinking: 'Analyzing the code...' }],
          stop_reason: null,
        },
      });

      expect(emittedActions).toHaveLength(1);
      expect(emittedActions[0].type).toBe('postMessage');
      expect(emittedActions[0].metadata.messageType).toBe('thinking');
    });

    it('does NOT emit for second thinking', () => {
      processor.processEvent({
        type: 'assistant',
        message: {
          content: [{ type: 'thinking', thinking: 'First thought' }],
          stop_reason: null,
        },
      });

      processor.processEvent({
        type: 'assistant',
        message: {
          content: [{ type: 'thinking', thinking: 'Second thought' }],
          stop_reason: null,
        },
      });

      const thinkingActions = emittedActions.filter(a => a.metadata.messageType === 'thinking');
      expect(thinkingActions).toHaveLength(1);
    });
  });

  describe('tool_use events', () => {
    it('emits postMessage for tool_use', () => {
      processor.processEvent({
        type: 'assistant',
        message: {
          content: [{
            type: 'tool_use',
            id: 'toolu_001',
            name: 'Read',
            input: { file_path: '/src/auth.ts' },
          }],
          stop_reason: 'tool_use',
        },
      });

      expect(emittedActions).toHaveLength(1);
      expect(emittedActions[0].type).toBe('postMessage');
      expect(emittedActions[0].metadata.messageType).toBe('tool_use');
      expect(emittedActions[0].metadata.toolUseId).toBe('toolu_001');
      expect(emittedActions[0].metadata.toolName).toBe('Read');
    });
  });

  describe('tool_result events', () => {
    it('emits update for tool_result', () => {
      // First: tool_use
      processor.processEvent({
        type: 'assistant',
        message: {
          content: [{
            type: 'tool_use',
            id: 'toolu_001',
            name: 'Read',
            input: { file_path: '/src/auth.ts' },
          }],
          stop_reason: 'tool_use',
        },
      });

      // Register the message ts
      processor.registerMessageTs('toolu_001', 'MSG_TS_001');

      // tool_result
      processor.processEvent({
        type: 'user',
        message: {
          content: [{
            type: 'tool_result',
            tool_use_id: 'toolu_001',
            content: 'file contents here\nline2\nline3',
          }],
        },
      });

      const updateActions = emittedActions.filter(a => a.type === 'update');
      expect(updateActions).toHaveLength(1);
      expect(updateActions[0].messageTs).toBe('MSG_TS_001');
    });
  });

  describe('result events', () => {
    it('emits result event (not SlackAction) for result', () => {
      const resultEvents: any[] = [];
      processor.on('result', (event: any) => resultEvents.push(event));

      processor.processEvent({
        type: 'result',
        duration_ms: 5000,
        usage: { input_tokens: 1000, output_tokens: 500 },
        total_cost_usd: 0.05,
      });

      expect(resultEvents).toHaveLength(1);
      expect(resultEvents[0].duration_ms).toBe(5000);
      expect(emittedActions.filter(a => a.metadata.messageType === 'result')).toHaveLength(0);
    });
  });

  describe('mixed content blocks', () => {
    it('handles thinking + tool_use in same message', () => {
      processor.processEvent({
        type: 'assistant',
        message: {
          content: [
            { type: 'thinking', thinking: 'I need to read the file' },
            { type: 'tool_use', id: 'toolu_002', name: 'Read', input: { file_path: '/a.ts' } },
          ],
          stop_reason: 'tool_use',
        },
      });

      expect(emittedActions.length).toBeGreaterThanOrEqual(1);
      const toolActions = emittedActions.filter(a => a.metadata.messageType === 'tool_use');
      expect(toolActions).toHaveLength(1);
    });
  });

  describe('state tracking', () => {
    it('tracks cumulative tool count', () => {
      for (let i = 0; i < 3; i++) {
        processor.processEvent({
          type: 'assistant',
          message: {
            content: [{
              type: 'tool_use',
              id: `toolu_${i}`,
              name: 'Read',
              input: { file_path: `/file${i}.ts` },
            }],
            stop_reason: 'tool_use',
          },
        });
      }
      expect(processor.getState().cumulativeToolCount).toBe(3);
    });

    it('resets state correctly', () => {
      processor.processEvent({
        type: 'assistant',
        message: {
          content: [{ type: 'thinking', thinking: 'test' }],
          stop_reason: null,
        },
      });
      expect(processor.getState().thinkingCount).toBe(1);

      processor.reset();
      expect(processor.getState().thinkingCount).toBe(0);
      expect(processor.getState().cumulativeToolCount).toBe(0);
    });
  });

  describe('subagent handling', () => {
    it('registers Agent tool as subagent and emits subagent message', () => {
      processor.processEvent({
        type: 'assistant',
        parent_tool_use_id: null,
        message: {
          content: [{
            type: 'tool_use',
            id: 'toolu_agent1',
            name: 'Agent',
            input: { prompt: 'Search for auth code' },
          }],
          stop_reason: 'tool_use',
        },
      });

      const subagentActions = emittedActions.filter(a => a.metadata.messageType === 'subagent');
      expect(subagentActions).toHaveLength(1);
      expect(subagentActions[0].type).toBe('postMessage');
    });

    it('routes child tools to subagent update instead of individual message', () => {
      // Register agent
      processor.processEvent({
        type: 'assistant',
        parent_tool_use_id: null,
        message: {
          content: [{
            type: 'tool_use', id: 'toolu_agent1', name: 'Agent',
            input: { prompt: 'Explore' },
          }],
          stop_reason: 'tool_use',
        },
      });
      processor.registerMessageTs('toolu_agent1', 'AGENT_MSG_TS');

      // Child tool
      processor.processEvent({
        type: 'assistant',
        parent_tool_use_id: 'toolu_agent1',
        message: {
          content: [{
            type: 'tool_use', id: 'toolu_child1', name: 'Read',
            input: { file_path: '/src/a.ts' },
          }],
          stop_reason: 'tool_use',
        },
      });

      // Should emit update to subagent message, not new postMessage
      const updates = emittedActions.filter(a => a.type === 'update' && a.metadata.messageType === 'subagent');
      expect(updates.length).toBeGreaterThanOrEqual(1);
      expect(updates[0].messageTs).toBe('AGENT_MSG_TS');
    });

    it('routes child tool results to subagent update', () => {
      // Register agent
      processor.processEvent({
        type: 'assistant',
        parent_tool_use_id: null,
        message: {
          content: [{
            type: 'tool_use', id: 'toolu_agent2', name: 'Agent',
            input: { prompt: 'Analyze code' },
          }],
          stop_reason: 'tool_use',
        },
      });
      processor.registerMessageTs('toolu_agent2', 'AGENT_MSG_TS2');

      // Child tool
      processor.processEvent({
        type: 'assistant',
        parent_tool_use_id: 'toolu_agent2',
        message: {
          content: [{
            type: 'tool_use', id: 'toolu_child2', name: 'Grep',
            input: { pattern: 'auth' },
          }],
          stop_reason: 'tool_use',
        },
      });

      // Child tool result
      processor.processEvent({
        type: 'user',
        parent_tool_use_id: 'toolu_agent2',
        message: {
          content: [{
            type: 'tool_result',
            tool_use_id: 'toolu_child2',
            content: 'found 3 matches',
          }],
        },
      });

      const updates = emittedActions.filter(a => a.type === 'update' && a.metadata.messageType === 'subagent');
      // Should have at least 2 updates: one for child tool start, one for child tool result
      expect(updates.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('error detection in tool_result', () => {
    it('detects is_error flag', () => {
      processor.processEvent({
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', id: 'toolu_err', name: 'Bash', input: { command: 'exit 1' } }],
          stop_reason: 'tool_use',
        },
      });
      processor.registerMessageTs('toolu_err', 'MSG_ERR');

      processor.processEvent({
        type: 'user',
        message: {
          content: [{ type: 'tool_result', tool_use_id: 'toolu_err', content: 'Error: command failed', is_error: true }],
        },
      });

      const updates = emittedActions.filter(a => a.type === 'update');
      expect(updates).toHaveLength(1);
      // The update should show error icon (:x:)
      const blockText = JSON.stringify(updates[0].blocks);
      expect(blockText).toContain(':x:');
    });
  });
});
