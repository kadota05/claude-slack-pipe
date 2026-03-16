// tests/streaming/rate-limit-tracker.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { RateLimitTracker } from '../../src/streaming/rate-limit-tracker.js';

describe('RateLimitTracker', () => {
  let tracker: RateLimitTracker;

  beforeEach(() => {
    vi.useFakeTimers();
    tracker = new RateLimitTracker();
  });

  it('starts at 0% utilization', () => {
    expect(tracker.getUtilization('postMessage')).toBe(0);
  });

  it('tracks calls and calculates utilization', () => {
    for (let i = 0; i < 10; i++) {
      tracker.record('postMessage');
    }
    expect(tracker.getUtilization('postMessage')).toBe(0.5);
  });

  it('expires old entries after 60 seconds', () => {
    for (let i = 0; i < 10; i++) {
      tracker.record('postMessage');
    }
    expect(tracker.getUtilization('postMessage')).toBe(0.5);
    vi.advanceTimersByTime(61_000);
    expect(tracker.getUtilization('postMessage')).toBe(0);
  });

  it('canProceed returns false when at limit', () => {
    for (let i = 0; i < 20; i++) {
      tracker.record('postMessage');
    }
    expect(tracker.canProceed('postMessage')).toBe(false);
  });

  it('canProceed returns true when under limit', () => {
    for (let i = 0; i < 15; i++) {
      tracker.record('postMessage');
    }
    expect(tracker.canProceed('postMessage')).toBe(true);
  });

  it('getMaxUtilization returns highest across all methods', () => {
    for (let i = 0; i < 10; i++) tracker.record('postMessage');
    for (let i = 0; i < 40; i++) tracker.record('update');
    expect(tracker.getMaxUtilization()).toBe(0.8);
  });

  it('handles 429 backoff', () => {
    tracker.recordRateLimited('postMessage', 5000);
    expect(tracker.canProceed('postMessage')).toBe(false);
    vi.advanceTimersByTime(5001);
    expect(tracker.canProceed('postMessage')).toBe(true);
  });
});
