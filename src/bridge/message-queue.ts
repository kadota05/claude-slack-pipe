// src/bridge/message-queue.ts
export interface QueuedMessage {
  id: string;
  prompt: string;
  enqueuedAt?: number;
}

export class MessageQueue {
  private queue: QueuedMessage[] = [];
  private readonly maxSize: number;
  private readonly ttlMs: number | null;

  constructor(maxSize: number, ttlMs: number | null = null) {
    this.maxSize = maxSize;
    this.ttlMs = ttlMs;
  }

  enqueue(msg: QueuedMessage): boolean {
    this.purgeExpired();
    if (this.queue.length >= this.maxSize) return false;
    msg.enqueuedAt = Date.now();
    this.queue.push(msg);
    return true;
  }

  dequeue(): QueuedMessage | undefined {
    this.purgeExpired();
    return this.queue.shift();
  }

  get size(): number {
    this.purgeExpired();
    return this.queue.length;
  }

  get isEmpty(): boolean {
    return this.size === 0;
  }

  private purgeExpired(): void {
    if (!this.ttlMs) return;
    const now = Date.now();
    this.queue = this.queue.filter((m) => now - (m.enqueuedAt ?? 0) < this.ttlMs!);
  }
}
