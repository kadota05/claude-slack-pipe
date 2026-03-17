// tests/bridge/history-poster.test.ts
import { describe, it, expect } from 'vitest';
import { parseTurnsFromJsonl, formatTurnForSlack } from '../../src/bridge/history-poster.js';

describe('parseTurnsFromJsonl', () => {
  it('extracts user and assistant turns', () => {
    const lines = [
      JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: 'Hello' }] } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Hi there' }] } }),
    ].join('\n');

    const turns = parseTurnsFromJsonl(lines);
    expect(turns).toHaveLength(1);
    expect(turns[0].userText).toBe('Hello');
    expect(turns[0].assistantText).toBe('Hi there');
  });

  it('limits to 15 most recent turns', () => {
    const lines: string[] = [];
    for (let i = 0; i < 20; i++) {
      lines.push(JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: `Q${i}` }] } }));
      lines.push(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: `A${i}` }] } }));
    }
    const turns = parseTurnsFromJsonl(lines.join('\n'));
    expect(turns).toHaveLength(15);
    expect(turns[0].userText).toBe('Q5');
  });

  it('summarizes tool use as one-liner', () => {
    const lines = [
      JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: 'Read file' }] } }),
      JSON.stringify({ type: 'assistant', message: { content: [
        { type: 'tool_use', name: 'Read', input: { file_path: 'src/index.ts' } },
        { type: 'text', text: 'Here is the file' },
      ] } }),
    ].join('\n');

    const turns = parseTurnsFromJsonl(lines);
    expect(turns[0].assistantText).toContain('Read');
    expect(turns[0].assistantText).toContain('src/index.ts');
  });

  it('skips malformed JSON lines', () => {
    const lines = [
      'not json',
      JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: 'Hello' }] } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Hi' }] } }),
    ].join('\n');
    const turns = parseTurnsFromJsonl(lines);
    expect(turns).toHaveLength(1);
  });

  it('returns empty array for empty input', () => {
    expect(parseTurnsFromJsonl('')).toHaveLength(0);
  });
});

describe('formatTurnForSlack', () => {
  it('bundles user and assistant into single message', () => {
    const text = formatTurnForSlack({
      userText: 'Fix the bug',
      assistantText: 'I fixed auth.ts',
      turnIndex: 0,
    });
    expect(text).toContain('Fix the bug');
    expect(text).toContain('I fixed auth.ts');
  });
});
