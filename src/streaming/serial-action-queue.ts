// src/streaming/serial-action-queue.ts
import { logger } from '../utils/logger.js';

type ErrorHandler = (error: Error) => void;

export class SerialActionQueue {
  private queue: Array<() => Promise<void>> = [];
  private processing = false;
  private drainResolvers: Array<() => void> = [];
  private errorHandler: ErrorHandler | null = null;

  onError(handler: ErrorHandler): void {
    this.errorHandler = handler;
  }

  enqueue(task: () => Promise<void>): void {
    this.queue.push(task);
    if (!this.processing) {
      this.processNext();
    }
  }

  async drain(): Promise<void> {
    if (this.queue.length === 0 && !this.processing) return;
    return new Promise<void>((resolve) => {
      this.drainResolvers.push(resolve);
    });
  }

  private async processNext(): Promise<void> {
    if (this.queue.length === 0) {
      this.processing = false;
      for (const resolve of this.drainResolvers) resolve();
      this.drainResolvers = [];
      return;
    }

    this.processing = true;
    const task = this.queue.shift()!;

    try {
      await task();
    } catch (err) {
      logger.error('SerialActionQueue task error', { error: (err as Error).message });
      if (this.errorHandler) {
        this.errorHandler(err as Error);
      }
    }

    await this.processNext();
  }
}
