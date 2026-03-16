// tests/bridge/message-queue.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MessageQueue } from '../../src/bridge/message-queue.js';

describe('MessageQueue', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('enqueues and dequeues FIFO', () => {
    const q = new MessageQueue(5);
    q.enqueue({ id: '1', prompt: 'a' });
    q.enqueue({ id: '2', prompt: 'b' });
    expect(q.dequeue()?.prompt).toBe('a');
    expect(q.dequeue()?.prompt).toBe('b');
  });

  it('reports size correctly', () => {
    const q = new MessageQueue(5);
    q.enqueue({ id: '1', prompt: 'a' });
    expect(q.size).toBe(1);
  });

  it('rejects when full', () => {
    const q = new MessageQueue(2);
    expect(q.enqueue({ id: '1', prompt: 'a' })).toBe(true);
    expect(q.enqueue({ id: '2', prompt: 'b' })).toBe(true);
    expect(q.enqueue({ id: '3', prompt: 'c' })).toBe(false);
  });

  it('expires entries after TTL', () => {
    const q = new MessageQueue(5, 5 * 60 * 1000);
    q.enqueue({ id: '1', prompt: 'a' });
    vi.advanceTimersByTime(6 * 60 * 1000);
    expect(q.dequeue()).toBeUndefined();
  });

  it('isEmpty returns correct value', () => {
    const q = new MessageQueue(5);
    expect(q.isEmpty).toBe(true);
    q.enqueue({ id: '1', prompt: 'a' });
    expect(q.isEmpty).toBe(false);
  });
});
