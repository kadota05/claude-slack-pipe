import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RateLimiter } from '../../src/middleware/rate-limiter.js';

describe('RateLimiter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should allow requests under the limit', () => {
    const limiter = new RateLimiter({ maxRequests: 3, windowMs: 60_000 });
    const result = limiter.check('U1');
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(2);
  });

  it('should block requests over the limit', () => {
    const limiter = new RateLimiter({ maxRequests: 2, windowMs: 60_000 });
    limiter.check('U1');
    limiter.check('U1');
    const result = limiter.check('U1');
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
    expect(result.retryAfterMs).toBeGreaterThan(0);
  });

  it('should reset after the window expires', () => {
    const limiter = new RateLimiter({ maxRequests: 1, windowMs: 60_000 });
    limiter.check('U1');
    const blocked = limiter.check('U1');
    expect(blocked.allowed).toBe(false);

    vi.advanceTimersByTime(60_001);

    const result = limiter.check('U1');
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(0);
  });

  it('should track users independently', () => {
    const limiter = new RateLimiter({ maxRequests: 1, windowMs: 60_000 });
    const r1 = limiter.check('U1');
    const r2 = limiter.check('U2');
    expect(r1.allowed).toBe(true);
    expect(r2.allowed).toBe(true);

    const r1b = limiter.check('U1');
    expect(r1b.allowed).toBe(false);
  });
});
