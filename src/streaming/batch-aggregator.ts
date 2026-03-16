// src/streaming/batch-aggregator.ts
import type { SlackAction } from './types.js';

interface BatchAggregatorConfig {
  windowMs: number;     // 1500ms default
  maxWaitMs: number;    // 3000ms forced flush
  onFlush: (batch: SlackAction[]) => void;
}

export class BatchAggregator {
  private buffer: SlackAction[] = [];
  private windowTimer: ReturnType<typeof setTimeout> | null = null;
  private maxWaitTimer: ReturnType<typeof setTimeout> | null = null;
  private maxWaitStartTime: number | null = null;
  private cumulativeToolCount = 0;
  private readonly config: BatchAggregatorConfig;

  constructor(config: BatchAggregatorConfig) {
    this.config = config;
  }

  setCumulativeToolCount(count: number): void {
    this.cumulativeToolCount = count;
  }

  submit(action: SlackAction): void {
    if (!this.isBatchable(action)) {
      this.config.onFlush([action]);
      return;
    }

    this.buffer.push(action);

    // Individual posting when batch size is 1
    const batchSize = this.getDynamicBatchSize();
    if (batchSize === 1) {
      this.flush();
      return;
    }

    // Start max wait timer on first item
    if (this.buffer.length === 1) {
      this.maxWaitStartTime = Date.now();
      this.maxWaitTimer = setTimeout(() => this.flush(), this.config.maxWaitMs);
    }

    // Reset window timer on each new item
    if (this.windowTimer) clearTimeout(this.windowTimer);
    this.windowTimer = setTimeout(() => this.flush(), this.config.windowMs);

    // If buffer reaches dynamic batch size, flush immediately —
    // but only if there is still enough time remaining in the maxWait window.
    // When maxWait is nearly expired (remaining < windowMs), let maxWaitTimer
    // trigger the flush instead to avoid a premature partial flush.
    if (this.buffer.length >= batchSize) {
      const elapsed = this.maxWaitStartTime !== null ? Date.now() - this.maxWaitStartTime : 0;
      const remaining = this.config.maxWaitMs - elapsed;
      if (remaining >= this.config.windowMs) {
        this.flush();
      }
    }
  }

  dispose(): void {
    if (this.windowTimer) { clearTimeout(this.windowTimer); this.windowTimer = null; }
    if (this.maxWaitTimer) { clearTimeout(this.maxWaitTimer); this.maxWaitTimer = null; }
    this.buffer = [];
  }

  private flush(): void {
    if (this.windowTimer) { clearTimeout(this.windowTimer); this.windowTimer = null; }
    if (this.maxWaitTimer) { clearTimeout(this.maxWaitTimer); this.maxWaitTimer = null; }

    if (this.buffer.length === 0) return;

    const batch = this.buffer.splice(0);
    this.config.onFlush(batch);
  }

  private isBatchable(action: SlackAction): boolean {
    return action.type === 'postMessage' && action.metadata.messageType === 'tool_use';
  }

  private getDynamicBatchSize(): number {
    if (this.cumulativeToolCount < 5) return 1;
    if (this.cumulativeToolCount < 10) return 3;
    if (this.cumulativeToolCount < 20) return 5;
    return 8;
  }
}
