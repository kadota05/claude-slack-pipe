// tests/streaming/notification-text.test.ts
import { describe, it, expect } from 'vitest';
import { notifyText, DECORATION_ICONS } from '../../src/streaming/notification-text.js';

describe('DECORATION_ICONS', () => {
  it('defines decoration-only icons as plain text characters', () => {
    expect(DECORATION_ICONS.completed).toBe('✓');
    expect(DECORATION_ICONS.error).toBe('✗');
  });

  it('does not use reaction emojis in decorations', () => {
    const values = Object.values(DECORATION_ICONS);
    expect(values).not.toContain(':white_check_mark:');
    expect(values).not.toContain(':x:');
    expect(values).not.toContain(':hourglass_flowing_sand:');
  });
});

describe('notifyText.footer', () => {
  it('generates content-based footer text', () => {
    const result = notifyText.footer('opus', 1234, 3200);
    expect(result).toBe('opus | 1,234 tokens | 3.2s');
  });

  it('handles zero tokens', () => {
    const result = notifyText.footer('haiku', 0, 500);
    expect(result).toBe('haiku | 0 tokens | 0.5s');
  });
});

describe('notifyText.text', () => {
  it('returns first 100 chars of buffer', () => {
    const result = notifyText.text('a'.repeat(200));
    expect(result).toHaveLength(100);
  });

  it('returns full text if under 100 chars', () => {
    const result = notifyText.text('hello world');
    expect(result).toBe('hello world');
  });
});

describe('notifyText.update', () => {
  it('thinking returns content-based text', () => {
    expect(notifyText.update.thinking()).toBe('💭 思考中');
  });

  it('tools lists tool names', () => {
    const tools = [
      { toolName: 'Read', status: 'completed' },
      { toolName: 'Bash', status: 'running' },
      { toolName: 'Grep', status: 'running' },
    ];
    expect(notifyText.update.tools(tools as any)).toBe('🔧 Read, Bash, Grep');
  });

  it('collapsed generates summary', () => {
    const result = notifyText.update.collapsed({
      thinkingCount: 1,
      toolCount: 3,
      toolDurationMs: 2500,
      subagentCount: 0,
      subagentDurationMs: 0,
    });
    expect(result).toBe('💭×1  🔧×3 (2.5s)');
  });

  it('collapsed with subagents', () => {
    const result = notifyText.update.collapsed({
      thinkingCount: 0,
      toolCount: 2,
      toolDurationMs: 1000,
      subagentCount: 1,
      subagentDurationMs: 5000,
    });
    expect(result).toBe('🔧×2 (1.0s)  🤖×1 (5.0s)');
  });

  it('pending returns fallback text', () => {
    expect(notifyText.update.pending()).toBe('...');
  });
});
