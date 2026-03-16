// src/streaming/priority-queue.ts
import type { SlackAction } from './types.js';

export class PriorityQueue {
  private queues: Map<number, SlackAction[]> = new Map([
    [1, []], [2, []], [3, []], [4, []], [5, []],
  ]);

  get size(): number {
    let total = 0;
    for (const q of this.queues.values()) total += q.length;
    return total;
  }

  enqueue(action: SlackAction): void {
    this.queues.get(action.priority)!.push(action);
  }

  dequeue(): SlackAction | null {
    for (let p = 1; p <= 5; p++) {
      const q = this.queues.get(p)!;
      if (q.length > 0) return q.shift()!;
    }
    return null;
  }

  discardBelow(maxPriority: number): number {
    let dropped = 0;
    for (let p = maxPriority + 1; p <= 5; p++) {
      const q = this.queues.get(p)!;
      dropped += q.length;
      this.queues.set(p, []);
    }
    return dropped;
  }
}
