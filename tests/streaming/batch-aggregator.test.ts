// tests/streaming/batch-aggregator.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BatchAggregator } from '../../src/streaming/batch-aggregator.js';
import type { SlackAction } from '../../src/streaming/types.js';

function makeToolAction(toolUseId: string): SlackAction {
  return {
    type: 'postMessage',
    priority: 3,
    channel: 'C1',
    threadTs: 'T1',
    blocks: [{ type: 'section', text: { type: 'mrkdwn', text: `tool ${toolUseId}` } }],
    text: `tool ${toolUseId}`,
    metadata: { messageType: 'tool_use', toolUseId },
  };
}

describe('BatchAggregator', () => {
  let aggregator: BatchAggregator;
  let flushedBatches: SlackAction[][];

  beforeEach(() => {
    vi.useFakeTimers();
    flushedBatches = [];
    aggregator = new BatchAggregator({
      windowMs: 1500,
      maxWaitMs: 3000,
      onFlush: (batch) => { flushedBatches.push(batch); },
    });
  });

  it('passes through non-batchable actions immediately', () => {
    const action: SlackAction = {
      type: 'update',
      priority: 3,
      channel: 'C1',
      threadTs: 'T1',
      messageTs: 'M1',
      blocks: [],
      text: '',
      metadata: { messageType: 'tool_use' },
    };
    aggregator.submit(action);
    expect(flushedBatches).toHaveLength(1);
    expect(flushedBatches[0]).toHaveLength(1);
  });

  it('individual posting when cumulativeToolCount < 5', () => {
    aggregator.setCumulativeToolCount(2);
    aggregator.submit(makeToolAction('t1'));
    // Dynamic batch size = 1, should flush immediately
    expect(flushedBatches).toHaveLength(1);
    expect(flushedBatches[0]).toHaveLength(1);
  });

  it('batches tool_use postMessages within window when batch size > 1', () => {
    aggregator.setCumulativeToolCount(7); // batch size = 3
    aggregator.submit(makeToolAction('t1'));
    aggregator.submit(makeToolAction('t2'));
    expect(flushedBatches).toHaveLength(0); // still in window

    vi.advanceTimersByTime(1500);
    expect(flushedBatches).toHaveLength(1);
    expect(flushedBatches[0]).toHaveLength(2);
  });

  it('force flushes at maxWaitMs', () => {
    aggregator.setCumulativeToolCount(7);
    aggregator.submit(makeToolAction('t1'));
    vi.advanceTimersByTime(1400);
    aggregator.submit(makeToolAction('t2'));
    vi.advanceTimersByTime(1400);
    aggregator.submit(makeToolAction('t3'));

    // Total: 2800ms, not at 3000ms yet
    expect(flushedBatches).toHaveLength(0);

    vi.advanceTimersByTime(200); // 3000ms total
    expect(flushedBatches).toHaveLength(1);
    expect(flushedBatches[0]).toHaveLength(3);
  });

  it('flushes immediately when batch reaches dynamic size', () => {
    aggregator.setCumulativeToolCount(7); // batch size = 3
    aggregator.submit(makeToolAction('t1'));
    aggregator.submit(makeToolAction('t2'));
    aggregator.submit(makeToolAction('t3'));
    // Should flush immediately at 3
    expect(flushedBatches).toHaveLength(1);
    expect(flushedBatches[0]).toHaveLength(3);
  });

  it('dispose clears timers', () => {
    aggregator.setCumulativeToolCount(7);
    aggregator.submit(makeToolAction('t1'));
    aggregator.dispose();
    vi.advanceTimersByTime(5000);
    expect(flushedBatches).toHaveLength(0);
  });
});
