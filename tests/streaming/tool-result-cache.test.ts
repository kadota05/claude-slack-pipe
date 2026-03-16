// tests/streaming/tool-result-cache.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ToolResultCache } from '../../src/streaming/tool-result-cache.js';

describe('ToolResultCache', () => {
  let cache: ToolResultCache;

  beforeEach(() => {
    vi.useFakeTimers();
    cache = new ToolResultCache({ ttlMs: 30 * 60 * 1000, maxSizeBytes: 1024 * 1024 });
  });

  it('stores and retrieves tool data', () => {
    cache.set('toolu_001', {
      toolId: 'toolu_001',
      toolName: 'Read',
      input: { file_path: '/a.ts' },
      result: 'file contents',
      durationMs: 500,
      isError: false,
    });

    const data = cache.get('toolu_001');
    expect(data).toBeDefined();
    expect(data!.toolName).toBe('Read');
  });

  it('returns undefined for missing key', () => {
    expect(cache.get('nonexistent')).toBeUndefined();
  });

  it('expires entries after TTL', () => {
    cache.set('toolu_001', {
      toolId: 'toolu_001',
      toolName: 'Read',
      input: {},
      result: 'x',
      durationMs: 100,
      isError: false,
    });

    vi.advanceTimersByTime(31 * 60 * 1000);
    expect(cache.get('toolu_001')).toBeUndefined();
  });

  it('evicts LRU when size exceeded', () => {
    const bigResult = 'x'.repeat(600 * 1024);
    cache.set('toolu_001', {
      toolId: 'toolu_001', toolName: 'Read', input: {}, result: bigResult, durationMs: 100, isError: false,
    });
    cache.set('toolu_002', {
      toolId: 'toolu_002', toolName: 'Read', input: {}, result: bigResult, durationMs: 100, isError: false,
    });

    // toolu_001 should be evicted (total > 1MB)
    expect(cache.get('toolu_001')).toBeUndefined();
    expect(cache.get('toolu_002')).toBeDefined();
  });

  it('reports size correctly', () => {
    cache.set('toolu_001', {
      toolId: 'toolu_001', toolName: 'Read', input: {}, result: 'hello', durationMs: 100, isError: false,
    });
    expect(cache.size).toBe(1);
  });

  it('clear removes all entries', () => {
    cache.set('toolu_001', {
      toolId: 'toolu_001', toolName: 'Read', input: {}, result: 'hello', durationMs: 100, isError: false,
    });
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.get('toolu_001')).toBeUndefined();
  });
});
