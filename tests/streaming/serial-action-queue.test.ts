// tests/streaming/serial-action-queue.test.ts
import { describe, it, expect, vi } from 'vitest';
import { SerialActionQueue } from '../../src/streaming/serial-action-queue.js';

describe('SerialActionQueue', () => {
  it('executes tasks in order', async () => {
    const queue = new SerialActionQueue();
    const order: number[] = [];

    queue.enqueue(async () => {
      await new Promise(r => setTimeout(r, 50));
      order.push(1);
    });
    queue.enqueue(async () => {
      await new Promise(r => setTimeout(r, 10));
      order.push(2);
    });
    queue.enqueue(async () => {
      order.push(3);
    });

    await queue.drain();
    expect(order).toEqual([1, 2, 3]);
  });

  it('continues processing after task error', async () => {
    const queue = new SerialActionQueue();
    const order: number[] = [];
    const errorHandler = vi.fn();

    queue.onError(errorHandler);

    queue.enqueue(async () => { order.push(1); });
    queue.enqueue(async () => { throw new Error('task failed'); });
    queue.enqueue(async () => { order.push(3); });

    await queue.drain();
    expect(order).toEqual([1, 3]);
    expect(errorHandler).toHaveBeenCalledOnce();
  });

  it('handles concurrent enqueue correctly', async () => {
    const queue = new SerialActionQueue();
    const order: number[] = [];

    for (let i = 0; i < 10; i++) {
      queue.enqueue(async () => {
        await new Promise(r => setTimeout(r, 5));
        order.push(i);
      });
    }

    await queue.drain();
    expect(order).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('drain resolves immediately when empty', async () => {
    const queue = new SerialActionQueue();
    await queue.drain(); // should not hang
  });
});
