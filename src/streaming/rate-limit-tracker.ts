// src/streaming/rate-limit-tracker.ts
import type { SlackApiMethod } from './types.js';

const WINDOW_MS = 60_000;

const LIMITS: Record<SlackApiMethod, number> = {
  postMessage: 20,
  update: 50,
  addReaction: 20,
  removeReaction: 20,
};

export class RateLimitTracker {
  private buckets: Map<SlackApiMethod, number[]> = new Map();
  private backoffs: Map<SlackApiMethod, number> = new Map();

  record(method: SlackApiMethod): void {
    const arr = this.buckets.get(method) || [];
    arr.push(Date.now());
    this.buckets.set(method, arr);
  }

  getUtilization(method: SlackApiMethod): number {
    this.prune(method);
    const count = (this.buckets.get(method) || []).length;
    return count / LIMITS[method];
  }

  getMaxUtilization(): number {
    let max = 0;
    for (const method of Object.keys(LIMITS) as SlackApiMethod[]) {
      max = Math.max(max, this.getUtilization(method));
    }
    return max;
  }

  canProceed(method: SlackApiMethod): boolean {
    const backoffUntil = this.backoffs.get(method) || 0;
    if (Date.now() < backoffUntil) return false;
    this.prune(method);
    const count = (this.buckets.get(method) || []).length;
    return count < LIMITS[method];
  }

  recordRateLimited(method: SlackApiMethod, retryAfterMs: number): void {
    this.backoffs.set(method, Date.now() + retryAfterMs);
  }

  private prune(method: SlackApiMethod): void {
    const arr = this.buckets.get(method);
    if (!arr) return;
    const cutoff = Date.now() - WINDOW_MS;
    const pruned = arr.filter(ts => ts > cutoff);
    this.buckets.set(method, pruned);
  }
}
