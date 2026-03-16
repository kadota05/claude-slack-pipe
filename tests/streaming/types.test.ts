import { describe, it, expect } from 'vitest';
import type { CompletedGroup, BundleAction } from '../../src/streaming/types.js';

describe('ActionBundle types', () => {
  it('CompletedGroup accepts thinking category', () => {
    const cg: CompletedGroup = { category: 'thinking', thinkingTexts: ['hello'] };
    expect(cg.category).toBe('thinking');
  });

  it('CompletedGroup accepts tool category', () => {
    const cg: CompletedGroup = {
      category: 'tool',
      tools: [{ toolUseId: 'x', toolName: 'Read', input: {}, oneLiner: 'a.ts', status: 'completed', startTime: 0, durationMs: 100 }],
      totalDuration: 100,
    };
    expect(cg.tools).toHaveLength(1);
  });

  it('BundleAction has bundleId instead of groupId', () => {
    const action: BundleAction = {
      type: 'postMessage',
      bundleId: 'bundle-1',
      bundleIndex: 0,
      blocks: [],
      text: 'test',
    };
    expect(action.bundleId).toBe('bundle-1');
  });
});
