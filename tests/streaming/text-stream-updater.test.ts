// tests/streaming/text-stream-updater.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TextStreamUpdater } from '../../src/streaming/text-stream-updater.js';
import type { SlackAction } from '../../src/streaming/types.js';

describe('TextStreamUpdater', () => {
  let updater: TextStreamUpdater;
  let emittedActions: SlackAction[];

  beforeEach(() => {
    vi.useFakeTimers();
    emittedActions = [];
    updater = new TextStreamUpdater({
      channel: 'C1',
      threadTs: 'T1',
      onAction: (action) => emittedActions.push(action),
      getUpdateUtilization: () => 0.3,
    });
  });

  it('emits postMessage on first text', () => {
    updater.appendText('Hello');
    expect(emittedActions).toHaveLength(1);
    expect(emittedActions[0].type).toBe('postMessage');
    expect(emittedActions[0].metadata.messageType).toBe('text');
  });

  it('does not emit update until interval', () => {
    updater.appendText('Hello');
    updater.setMessageTs('MSG1');
    updater.appendText(' world');
    // No interval elapsed → no update yet (only initial postMessage)
    expect(emittedActions).toHaveLength(1);
  });

  it('emits update after interval', () => {
    updater.appendText('Hello');
    updater.setMessageTs('MSG1');
    updater.appendText(' world');

    vi.advanceTimersByTime(2000);
    const updates = emittedActions.filter(a => a.type === 'update');
    expect(updates.length).toBeGreaterThanOrEqual(1);
  });

  it('finalize emits final update and removes indicator', () => {
    updater.appendText('Hello');
    updater.setMessageTs('MSG1');
    updater.finalize();

    const updates = emittedActions.filter(a => a.type === 'update');
    expect(updates.length).toBeGreaterThanOrEqual(1);
    // Final update should not have streaming indicator
    const lastUpdate = updates[updates.length - 1];
    const blocksJson = JSON.stringify(lastUpdate.blocks);
    expect(blocksJson).not.toContain('入力中');
  });

  it('getAccumulatedText returns full text', () => {
    updater.appendText('Hello');
    updater.appendText(' world');
    expect(updater.getAccumulatedText()).toBe('Hello world');
  });

  it('dispose stops timers', () => {
    updater.appendText('Hello');
    updater.setMessageTs('MSG1');
    updater.appendText(' more');
    updater.dispose();

    vi.advanceTimersByTime(10000);
    // Only the initial postMessage, no updates after dispose
    expect(emittedActions).toHaveLength(1);
  });

  it('uses dynamic interval based on utilization', () => {
    // High utilization = longer interval
    const highUtilUpdater = new TextStreamUpdater({
      channel: 'C1',
      threadTs: 'T1',
      onAction: (action) => emittedActions.push(action),
      getUpdateUtilization: () => 0.85, // High utilization
    });

    highUtilUpdater.appendText('Hello');
    highUtilUpdater.setMessageTs('MSG1');
    highUtilUpdater.appendText(' world');

    // At 0.85 utilization, interval should be 5000ms
    vi.advanceTimersByTime(3000);
    const updatesAt3s = emittedActions.filter(a => a.type === 'update');
    expect(updatesAt3s).toHaveLength(0); // Not yet at 5s

    vi.advanceTimersByTime(2500);
    const updatesAt5s = emittedActions.filter(a => a.type === 'update');
    expect(updatesAt5s.length).toBeGreaterThanOrEqual(1);

    highUtilUpdater.dispose();
  });
});
