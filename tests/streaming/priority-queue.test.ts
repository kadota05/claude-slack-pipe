// tests/streaming/priority-queue.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { PriorityQueue } from '../../src/streaming/priority-queue.js';
import type { SlackAction } from '../../src/streaming/types.js';

function makeAction(priority: 1|2|3|4|5, type: string = 'postMessage'): SlackAction {
  return {
    type: type as any,
    priority,
    channel: 'C1',
    threadTs: 'T1',
    text: `p${priority}`,
    metadata: { messageType: 'tool_use' },
  };
}

describe('PriorityQueue', () => {
  let queue: PriorityQueue;

  beforeEach(() => {
    queue = new PriorityQueue();
  });

  it('dequeues highest priority first', () => {
    queue.enqueue(makeAction(3));
    queue.enqueue(makeAction(1));
    queue.enqueue(makeAction(5));
    expect(queue.dequeue()!.priority).toBe(1);
    expect(queue.dequeue()!.priority).toBe(3);
    expect(queue.dequeue()!.priority).toBe(5);
  });

  it('returns null when empty', () => {
    expect(queue.dequeue()).toBeNull();
  });

  it('maintains FIFO within same priority', () => {
    const a1 = makeAction(3); a1.text = 'first';
    const a2 = makeAction(3); a2.text = 'second';
    queue.enqueue(a1);
    queue.enqueue(a2);
    expect(queue.dequeue()!.text).toBe('first');
    expect(queue.dequeue()!.text).toBe('second');
  });

  it('discardBelow drops low priority items', () => {
    queue.enqueue(makeAction(1));
    queue.enqueue(makeAction(3));
    queue.enqueue(makeAction(4));
    queue.enqueue(makeAction(5));
    const dropped = queue.discardBelow(3);
    expect(dropped).toBe(2);
    expect(queue.dequeue()!.priority).toBe(1);
    expect(queue.dequeue()!.priority).toBe(3);
    expect(queue.dequeue()).toBeNull();
  });

  it('reports correct size', () => {
    queue.enqueue(makeAction(1));
    queue.enqueue(makeAction(2));
    expect(queue.size).toBe(2);
  });
});
