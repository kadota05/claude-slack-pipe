// tests/streaming/tool-formatter.test.ts
import { describe, it, expect } from 'vitest';
import { buildToolRunningBlocks, buildToolCompletedBlocks, buildThinkingBlocks, getToolOneLiner, getToolResultSummary } from '../../src/streaming/tool-formatter.js';

describe('getToolOneLiner', () => {
  it('formats Read tool', () => {
    const result = getToolOneLiner('Read', { file_path: '/src/auth.ts' });
    expect(result).toBe('src/auth.ts');
  });

  it('formats Edit tool', () => {
    const result = getToolOneLiner('Edit', { file_path: '/src/auth.ts', old_string: 'foo' });
    expect(result).toBe('src/auth.ts');
  });

  it('formats Bash tool', () => {
    const result = getToolOneLiner('Bash', { command: 'npm test' });
    expect(result).toBe('npm test');
  });

  it('formats Bash tool with long command', () => {
    const result = getToolOneLiner('Bash', { command: 'a'.repeat(100) });
    expect(result.length).toBeLessThanOrEqual(63);
  });

  it('formats Grep tool', () => {
    const result = getToolOneLiner('Grep', { pattern: 'TODO', path: '/src' });
    expect(result).toBe('TODO in /src');
  });

  it('formats Glob tool', () => {
    const result = getToolOneLiner('Glob', { pattern: '**/*.ts' });
    expect(result).toBe('**/*.ts');
  });

  it('formats Write tool', () => {
    const result = getToolOneLiner('Write', { file_path: '/src/new.ts' });
    expect(result).toBe('src/new.ts');
  });

  it('formats Agent tool', () => {
    const result = getToolOneLiner('Agent', { prompt: 'Search for auth code' });
    expect(result).toBe('Search for auth code');
  });

  it('formats unknown tool', () => {
    const result = getToolOneLiner('UnknownTool', { foo: 'bar' });
    expect(result).toBe('UnknownTool');
  });
});

describe('buildToolRunningBlocks', () => {
  it('returns blocks with hourglass icon', () => {
    const blocks = buildToolRunningBlocks('Read', 'src/auth.ts');
    expect(blocks).toHaveLength(2);
    expect(blocks[0].text.text).toContain(':hourglass_flowing_sand:');
    expect(blocks[0].text.text).toContain('`Read`');
    expect(blocks[0].text.text).toContain('src/auth.ts');
    expect(blocks[1].elements[0].text).toContain('実行中');
  });
});

describe('buildToolCompletedBlocks', () => {
  it('returns blocks with checkmark icon', () => {
    const blocks = buildToolCompletedBlocks('Read', 'src/auth.ts — 247行', 800);
    expect(blocks[0].text.text).toContain(':white_check_mark:');
    expect(blocks[0].text.text).toContain('`Read`');
    expect(blocks[1].elements[0].text).toContain('0.8s');
  });

  it('returns blocks with x icon on error', () => {
    const blocks = buildToolCompletedBlocks('Bash', 'exit code 1', 1200, true);
    expect(blocks[0].text.text).toContain(':x:');
  });
});

describe('buildThinkingBlocks', () => {
  it('returns thinking blocks with snippet', () => {
    const blocks = buildThinkingBlocks('JWT validation strategy...');
    expect(blocks[0].elements[0].text).toContain(':thought_balloon:');
    expect(blocks[1].text.text).toContain('JWT validation');
  });

  it('truncates long thinking text', () => {
    const blocks = buildThinkingBlocks('a'.repeat(500));
    expect(blocks[1].text.text.length).toBeLessThan(300);
  });
});

describe('getToolResultSummary', () => {
  it('summarizes Read result by line count', () => {
    expect(getToolResultSummary('Read', 'line1\nline2\nline3', false)).toBe('3行');
  });

  it('summarizes Bash result with first line', () => {
    expect(getToolResultSummary('Bash', 'hello world\nmore', false)).toBe('hello world');
  });

  it('returns error text on error', () => {
    expect(getToolResultSummary('Bash', 'something failed', true)).toBe('something failed');
  });
});
