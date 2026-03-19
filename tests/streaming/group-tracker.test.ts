import { describe, it, expect, beforeEach } from 'vitest';
import { GroupTracker } from '../../src/streaming/group-tracker.js';

describe('GroupTracker with ActionBundle', () => {
  let tracker: GroupTracker;

  beforeEach(() => {
    tracker = new GroupTracker();
  });

  describe('bundle lifecycle', () => {
    it('creates bundle on first thinking event', () => {
      const actions = tracker.handleThinking('thought');
      expect(actions).toHaveLength(1);
      expect(actions[0].type).toBe('postMessage');
      expect(actions[0].bundleId).toMatch(/^bundle-/);
      expect(actions[0].bundleIndex).toBe(0);
    });

    it('creates bundle on first tool event', () => {
      const actions = tracker.handleToolUse('toolu_001', 'Read', { file_path: '/a.ts' });
      expect(actions).toHaveLength(1);
      expect(actions[0].type).toBe('postMessage');
      expect(actions[0].bundleId).toMatch(/^bundle-/);
    });

    it('reuses same bundle across category switches', () => {
      const a1 = tracker.handleThinking('thought');
      const bundleId = a1[0].bundleId;
      tracker.registerBundleMessageTs(bundleId, 'MSG_TS');

      const a2 = tracker.handleToolUse('toolu_001', 'Read', { file_path: '/a.ts' });
      expect(a2.every(a => a.bundleId === bundleId)).toBe(true);
      const hasPost = a2.some(a => a.type === 'postMessage');
      expect(hasPost).toBe(false);
    });

    it('collapses bundle on handleTextStart', () => {
      const a1 = tracker.handleThinking('thought');
      tracker.registerBundleMessageTs(a1[0].bundleId, 'MSG_TS');

      tracker.handleToolUse('toolu_001', 'Read', { file_path: '/a.ts' });
      tracker.handleToolResult('toolu_001', 'content', false);

      const collapseActions = tracker.handleTextStart('sess-1');
      const collapse = collapseActions.find(a => a.type === 'collapse');
      expect(collapse).toBeDefined();
      expect(collapse!.bundleIndex).toBe(0);
    });

    it('increments bundleIndex on each text arrival', () => {
      const a1 = tracker.handleThinking('thought1');
      tracker.registerBundleMessageTs(a1[0].bundleId, 'MSG_TS_1');
      tracker.handleTextStart('sess-1');

      const a2 = tracker.handleThinking('thought2');
      expect(a2[0].bundleIndex).toBe(1);
    });
  });

  describe('live display — category switches', () => {
    it('shows only active category blocks on update', () => {
      const a1 = tracker.handleThinking('thought');
      tracker.registerBundleMessageTs(a1[0].bundleId, 'MSG_TS');

      const a2 = tracker.handleToolUse('toolu_001', 'Read', { file_path: '/a.ts' });
      const update = a2.find(a => a.type === 'update');
      expect(update).toBeDefined();
      const blockTexts = JSON.stringify(update!.blocks);
      expect(blockTexts).toContain('Read');
      expect(blockTexts).not.toContain('思考中');
    });
  });

  describe('tool group within bundle', () => {
    it('keeps sequential tools in same active group', () => {
      const a1 = tracker.handleToolUse('toolu_001', 'Read', { file_path: '/a.ts' });
      const bundleId = a1[0].bundleId;
      tracker.registerBundleMessageTs(bundleId, 'MSG_TS');

      tracker.handleToolResult('toolu_001', 'content', false);
      const a2 = tracker.handleToolUse('toolu_002', 'Bash', { command: 'ls' });
      expect(a2.every(a => a.type !== 'postMessage')).toBe(true);
    });
  });

  describe('subagent within bundle', () => {
    it('switches to subagent active group without new message', () => {
      const a1 = tracker.handleToolUse('toolu_001', 'Read', { file_path: '/a.ts' });
      tracker.registerBundleMessageTs(a1[0].bundleId, 'MSG_TS');
      tracker.handleToolResult('toolu_001', 'ok', false);

      const a2 = tracker.handleSubagentStart('toolu_agent', 'コード探索');
      expect(a2.every(a => a.type !== 'postMessage')).toBe(true);
      const update = a2.find(a => a.type === 'update');
      expect(update).toBeDefined();
    });

    it('tracks subagent steps as updates within same bundle', () => {
      const a1 = tracker.handleSubagentStart('toolu_agent', 'コード探索');
      const bundleId = a1[0].bundleId;
      tracker.registerBundleMessageTs(bundleId, 'MSG_TS');

      const group = tracker.getActiveGroupData();
      if (group) group.lastUpdateTime = 0;

      const a2 = tracker.handleSubagentStep('toolu_agent', 'Read', 'toolu_child', 'src/a.ts');
      const update = a2.find(a => a.type === 'update');
      expect(update).toBeDefined();
      expect(update!.bundleId).toBe(bundleId);
    });

    it('subagent complete does NOT collapse bundle — keeps it open', () => {
      const a1 = tracker.handleSubagentStart('toolu_agent', 'コード探索');
      const bundleId = a1[0].bundleId;
      tracker.registerBundleMessageTs(bundleId, 'MSG_TS');

      const a2 = tracker.handleSubagentComplete('toolu_agent', 'done', 5000);
      const collapse = a2.find(a => a.type === 'collapse');
      expect(collapse).toBeUndefined();
    });

    it('subagent complete → next tool arrives → same bundle', () => {
      const a1 = tracker.handleSubagentStart('toolu_agent', 'コード探索');
      const bundleId = a1[0].bundleId;
      tracker.registerBundleMessageTs(bundleId, 'MSG_TS');

      tracker.handleSubagentComplete('toolu_agent', 'done', 5000);

      const a3 = tracker.handleToolUse('toolu_002', 'Grep', { pattern: 'foo' });
      expect(a3.every(a => a.bundleId === bundleId)).toBe(true);
      expect(a3.every(a => a.type !== 'postMessage')).toBe(true);
    });

    it('subagent step result updates within same bundle', () => {
      const a1 = tracker.handleSubagentStart('toolu_agent', 'コード探索');
      tracker.registerBundleMessageTs(a1[0].bundleId, 'MSG_TS');

      tracker.handleSubagentStep('toolu_agent', 'Read', 'toolu_child', 'src/a.ts');

      const group = tracker.getActiveGroupData();
      if (group) group.lastUpdateTime = 0;

      const a2 = tracker.handleSubagentStepResult('toolu_agent', 'toolu_child', false);
      const update = a2.find(a => a.type === 'update');
      if (update) {
        expect(update.bundleId).toBe(a1[0].bundleId);
      }
    });
  });

  describe('collapsed bundle summary', () => {
    it('aggregates counts across completed groups', () => {
      const a1 = tracker.handleThinking('thought');
      tracker.registerBundleMessageTs(a1[0].bundleId, 'MSG_TS');

      tracker.handleToolUse('toolu_001', 'Read', { file_path: '/a.ts' });
      tracker.handleToolResult('toolu_001', 'ok', false);

      const collapse = tracker.handleTextStart('sess-1');
      const collapseAction = collapse.find(a => a.type === 'collapse');
      expect(collapseAction).toBeDefined();
      const blockText = JSON.stringify(collapseAction!.blocks);
      expect(blockText).toContain('💭×1');
      expect(blockText).toContain('🔧×1');
    });
  });

  describe('flushActiveBundle', () => {
    it('collapses active bundle on stream end', () => {
      const a1 = tracker.handleToolUse('toolu_001', 'Read', { file_path: '/a.ts' });
      tracker.registerBundleMessageTs(a1[0].bundleId, 'MSG_TS');

      const actions = tracker.flushActiveBundle('sess-1');
      expect(actions).toHaveLength(1);
      expect(actions[0].type).toBe('collapse');
    });

    it('marks running tools as error on flush', () => {
      const a1 = tracker.handleToolUse('toolu_001', 'Read', { file_path: '/a.ts' });
      tracker.registerBundleMessageTs(a1[0].bundleId, 'MSG_TS');

      tracker.flushActiveBundle('sess-1');
    });

    it('returns empty when no active bundle', () => {
      const actions = tracker.flushActiveBundle('sess-1');
      expect(actions).toHaveLength(0);
    });
  });

  describe('registerBundleMessageTs', () => {
    it('registers messageTs for active bundle', () => {
      const a1 = tracker.handleThinking('thought');
      const bundleId = a1[0].bundleId;

      tracker.registerBundleMessageTs(bundleId, 'MSG_TS');

      const group = tracker.getActiveGroupData();
      if (group) group.lastUpdateTime = 0;

      const a2 = tracker.handleThinking('more thought');
      const update = a2.find(a => a.type === 'update');
      expect(update).toBeDefined();
      expect(update!.messageTs).toBe('MSG_TS');
    });
  });

  describe('parallel subagents', () => {
    it('tracks two subagents simultaneously in the same bundle', () => {
      const actionsA = tracker.handleSubagentStart('agent-A', 'Explore codebase');
      expect(actionsA.length).toBeGreaterThan(0);
      expect(actionsA[0].type).toBe('postMessage');

      const actionsB = tracker.handleSubagentStart('agent-B', 'Run tests');
      const stepA = tracker.handleSubagentStep('agent-A', 'Read', 'tool-1', 'src/index.ts');
      const stepB = tracker.handleSubagentStep('agent-B', 'Bash', 'tool-2', 'npm test');
      expect(stepA).toBeDefined();
      expect(stepB).toBeDefined();
    });

    it('completes subagents independently', () => {
      tracker.handleSubagentStart('agent-A', 'Explore');
      tracker.handleSubagentStart('agent-B', 'Test');
      tracker.handleSubagentComplete('agent-A', 'done', 0);
      const stepB = tracker.handleSubagentStep('agent-B', 'Bash', 'tool-3', 'npm test');
      expect(stepB).toBeDefined();
    });

    it('allows collapse only when all subagents are done', () => {
      const a1 = tracker.handleSubagentStart('agent-A', 'Explore');
      tracker.registerBundleMessageTs(a1[0].bundleId, 'MSG_TS');
      tracker.handleSubagentStart('agent-B', 'Test');

      tracker.handleSubagentComplete('agent-A', 'done', 0);
      const actions1 = tracker.handleTextStart('session-1');
      expect(actions1.find(a => a.type === 'collapse')).toBeUndefined();

      tracker.handleSubagentComplete('agent-B', 'done', 0);
      const actions2 = tracker.handleTextStart('session-1');
      expect(actions2.find(a => a.type === 'collapse')).toBeDefined();
    });
  });
});
