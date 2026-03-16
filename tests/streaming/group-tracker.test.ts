import { describe, it, expect, beforeEach } from 'vitest';
import { GroupTracker } from '../../src/streaming/group-tracker.js';

describe('GroupTracker', () => {
  let tracker: GroupTracker;

  beforeEach(() => {
    tracker = new GroupTracker();
  });

  describe('thinking groups', () => {
    it('creates a new group on first thinking', () => {
      const actions = tracker.handleThinking('First thought');
      expect(actions).toHaveLength(1);
      expect(actions[0].type).toBe('postMessage');
      expect(actions[0].category).toBe('thinking');
    });

    it('updates existing group on subsequent thinking', () => {
      const first = tracker.handleThinking('First thought');
      const groupId = first[0].groupId;
      tracker.registerMessageTs(groupId, 'MSG_TS_1');

      const second = tracker.handleThinking('Second thought');
      expect(second.length).toBeGreaterThanOrEqual(1);
      const updateAction = second.find(a => a.type === 'update');
      expect(updateAction).toBeDefined();
      expect(updateAction!.groupId).toBe(groupId);
    });

    it('collapses thinking group when tool arrives', () => {
      const first = tracker.handleThinking('Thinking...');
      const groupId = first[0].groupId;
      tracker.registerMessageTs(groupId, 'MSG_TS_1');

      const actions = tracker.handleToolUse('toolu_001', 'Read', { file_path: '/a.ts' });
      const collapseAction = actions.find(a => a.type === 'collapse');
      const postAction = actions.find(a => a.type === 'postMessage');
      expect(collapseAction).toBeDefined();
      expect(collapseAction!.groupId).toBe(groupId);
      expect(postAction).toBeDefined();
      expect(postAction!.category).toBe('tool');
    });

    it('collapses thinking group when text arrives', () => {
      const first = tracker.handleThinking('Thinking...');
      const groupId = first[0].groupId;
      tracker.registerMessageTs(groupId, 'MSG_TS_1');

      const actions = tracker.handleTextStart();
      const collapseAction = actions.find(a => a.type === 'collapse');
      expect(collapseAction).toBeDefined();
      expect(collapseAction!.groupId).toBe(groupId);
    });
  });

  describe('tool groups', () => {
    it('creates new tool group on first tool_use', () => {
      const actions = tracker.handleToolUse('toolu_001', 'Read', { file_path: '/a.ts' });
      expect(actions).toHaveLength(1);
      expect(actions[0].type).toBe('postMessage');
      expect(actions[0].category).toBe('tool');
    });

    it('updates group on subsequent tool_use', () => {
      const first = tracker.handleToolUse('toolu_001', 'Read', { file_path: '/a.ts' });
      tracker.registerMessageTs(first[0].groupId, 'MSG_TS');

      const group = tracker.getGroupData(first[0].groupId)!;
      group.lastUpdateTime = 0;

      const second = tracker.handleToolUse('toolu_002', 'Read', { file_path: '/b.ts' });
      const updateAction = second.find(a => a.type === 'update');
      expect(updateAction).toBeDefined();
    });

    it('collapses tool group when all tools complete', () => {
      const first = tracker.handleToolUse('toolu_001', 'Read', { file_path: '/a.ts' });
      tracker.registerMessageTs(first[0].groupId, 'MSG_TS');

      const result = tracker.handleToolResult('toolu_001', 'file content', false);
      const collapseAction = result.find(a => a.type === 'collapse');
      expect(collapseAction).toBeDefined();
    });

    it('does NOT collapse when some tools still running', () => {
      const first = tracker.handleToolUse('toolu_001', 'Read', { file_path: '/a.ts' });
      tracker.registerMessageTs(first[0].groupId, 'MSG_TS');
      tracker.handleToolUse('toolu_002', 'Read', { file_path: '/b.ts' });

      const result = tracker.handleToolResult('toolu_001', 'content', false);
      const collapseAction = result.find(a => a.type === 'collapse');
      expect(collapseAction).toBeUndefined();
    });
  });

  describe('subagent groups', () => {
    it('creates new subagent group', () => {
      const actions = tracker.handleSubagentStart('toolu_agent', 'コード探索');
      expect(actions).toHaveLength(1);
      expect(actions[0].type).toBe('postMessage');
      expect(actions[0].category).toBe('subagent');
    });

    it('collapses subagent group on complete', () => {
      const first = tracker.handleSubagentStart('toolu_agent', 'コード探索');
      tracker.registerMessageTs(first[0].groupId, 'MSG_TS');

      const complete = tracker.handleSubagentComplete('toolu_agent', 'done', 5000);
      const collapseAction = complete.find(a => a.type === 'collapse');
      expect(collapseAction).toBeDefined();
    });
  });

  describe('flushActiveGroup', () => {
    it('collapses active group', () => {
      const first = tracker.handleToolUse('toolu_001', 'Read', { file_path: '/a.ts' });
      tracker.registerMessageTs(first[0].groupId, 'MSG_TS');

      const actions = tracker.flushActiveGroup();
      expect(actions).toHaveLength(1);
      expect(actions[0].type).toBe('collapse');
    });

    it('marks running tools as error on flush', () => {
      const first = tracker.handleToolUse('toolu_001', 'Read', { file_path: '/a.ts' });
      const groupId = first[0].groupId;
      tracker.registerMessageTs(groupId, 'MSG_TS');

      tracker.flushActiveGroup();

      const group = tracker.getGroupData(groupId)!;
      expect(group.tools[0].status).toBe('error');
    });

    it('returns empty when no active group', () => {
      const actions = tracker.flushActiveGroup();
      expect(actions).toHaveLength(0);
    });
  });

  describe('group data retrieval', () => {
    it('returns active group data', () => {
      const first = tracker.handleThinking('Thinking...');
      const data = tracker.getGroupData(first[0].groupId);
      expect(data).toBeDefined();
      expect(data!.thinkingTexts).toEqual(['Thinking...']);
    });

    it('returns completed group data', () => {
      const first = tracker.handleThinking('Thinking...');
      const groupId = first[0].groupId;
      tracker.registerMessageTs(groupId, 'MSG_TS');
      tracker.handleTextStart();

      const data = tracker.getGroupData(groupId);
      expect(data).toBeDefined();
      expect(data!.thinkingTexts).toEqual(['Thinking...']);
    });
  });
});
