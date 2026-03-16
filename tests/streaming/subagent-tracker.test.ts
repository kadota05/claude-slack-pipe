// tests/streaming/subagent-tracker.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { SubagentTracker } from '../../src/streaming/subagent-tracker.js';

describe('SubagentTracker', () => {
  let tracker: SubagentTracker;

  beforeEach(() => {
    tracker = new SubagentTracker();
  });

  it('registers a subagent when Agent tool is used', () => {
    tracker.registerAgent('toolu_agent1', 'Explore codebase');
    expect(tracker.isSubagent('toolu_agent1')).toBe(true);
    expect(tracker.getAgentCount()).toBe(1);
  });

  it('isChildOf returns true for registered parent', () => {
    tracker.registerAgent('toolu_agent1', 'Explore');
    expect(tracker.isChildOf('toolu_agent1')).toBe(true);
    expect(tracker.isChildOf('toolu_unknown')).toBe(false);
  });

  it('tracks child tool steps within a subagent', () => {
    tracker.registerAgent('toolu_agent1', 'Explore');
    tracker.addStep('toolu_agent1', {
      toolName: 'Read',
      toolUseId: 'toolu_child1',
      oneLiner: 'src/auth.ts',
      status: 'running',
    });

    const steps = tracker.getSteps('toolu_agent1');
    expect(steps).toHaveLength(1);
    expect(steps[0].toolName).toBe('Read');
  });

  it('updates step status', () => {
    tracker.registerAgent('toolu_agent1', 'Explore');
    tracker.addStep('toolu_agent1', {
      toolName: 'Read',
      toolUseId: 'toolu_child1',
      oneLiner: 'src/auth.ts',
      status: 'running',
    });
    tracker.updateStepStatus('toolu_agent1', 'toolu_child1', 'completed');

    const steps = tracker.getSteps('toolu_agent1');
    expect(steps[0].status).toBe('completed');
  });

  it('returns last N steps for display (fold older)', () => {
    tracker.registerAgent('toolu_agent1', 'Explore');
    for (let i = 0; i < 8; i++) {
      tracker.addStep('toolu_agent1', {
        toolName: 'Read',
        toolUseId: `toolu_c${i}`,
        oneLiner: `file${i}.ts`,
        status: 'completed',
      });
    }

    const display = tracker.getDisplaySteps('toolu_agent1', 5);
    expect(display.visibleSteps).toHaveLength(5);
    expect(display.hiddenCount).toBe(3);
  });

  it('getDisplaySteps returns all when under limit', () => {
    tracker.registerAgent('toolu_agent1', 'Explore');
    tracker.addStep('toolu_agent1', {
      toolName: 'Read',
      toolUseId: 'toolu_c1',
      oneLiner: 'file.ts',
      status: 'completed',
    });

    const display = tracker.getDisplaySteps('toolu_agent1', 5);
    expect(display.visibleSteps).toHaveLength(1);
    expect(display.hiddenCount).toBe(0);
  });

  it('getAgentDescription returns the registered description', () => {
    tracker.registerAgent('toolu_agent1', 'Search for auth code');
    expect(tracker.getAgentDescription('toolu_agent1')).toBe('Search for auth code');
  });

  it('returns empty for unknown agent', () => {
    expect(tracker.getSteps('unknown')).toEqual([]);
    expect(tracker.getDisplaySteps('unknown', 5)).toEqual({ visibleSteps: [], hiddenCount: 0 });
  });
});
