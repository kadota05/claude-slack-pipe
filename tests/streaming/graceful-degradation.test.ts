// tests/streaming/graceful-degradation.test.ts
import { describe, it, expect } from 'vitest';
import { GracefulDegradation } from '../../src/streaming/graceful-degradation.js';

describe('GracefulDegradation', () => {
  it('returns NORMAL at low utilization', () => {
    expect(GracefulDegradation.getLevel(0.3)).toBe('NORMAL');
    expect(GracefulDegradation.getLevel(0.59)).toBe('NORMAL');
  });

  it('returns CAUTION at 60-75%', () => {
    expect(GracefulDegradation.getLevel(0.65)).toBe('CAUTION');
  });

  it('returns THROTTLE at 75-85%', () => {
    expect(GracefulDegradation.getLevel(0.8)).toBe('THROTTLE');
  });

  it('returns CRITICAL at 85-95%', () => {
    expect(GracefulDegradation.getLevel(0.9)).toBe('CRITICAL');
  });

  it('returns EMERGENCY at 95%+', () => {
    expect(GracefulDegradation.getLevel(0.96)).toBe('EMERGENCY');
  });

  it('shouldExecute allows P1 in EMERGENCY', () => {
    expect(GracefulDegradation.shouldExecute('EMERGENCY', 1)).toBe(true);
  });

  it('shouldExecute blocks P3+ in EMERGENCY', () => {
    expect(GracefulDegradation.shouldExecute('EMERGENCY', 3)).toBe(false);
  });

  it('shouldExecute blocks P4+ in THROTTLE', () => {
    expect(GracefulDegradation.shouldExecute('THROTTLE', 4)).toBe(false);
    expect(GracefulDegradation.shouldExecute('THROTTLE', 3)).toBe(true);
  });

  it('shouldExecute allows all in NORMAL', () => {
    for (let p = 1; p <= 5; p++) {
      expect(GracefulDegradation.shouldExecute('NORMAL', p as any)).toBe(true);
    }
  });

  it('shouldExecute blocks P5 in CAUTION', () => {
    expect(GracefulDegradation.shouldExecute('CAUTION', 5)).toBe(false);
    expect(GracefulDegradation.shouldExecute('CAUTION', 4)).toBe(true);
  });
});
