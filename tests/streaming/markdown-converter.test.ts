// tests/streaming/markdown-converter.test.ts
import { describe, it, expect } from 'vitest';
import { convertMarkdownToMrkdwn } from '../../src/streaming/markdown-converter.js';

describe('convertMarkdownToMrkdwn', () => {
  // Headers
  it('converts h1-h6 to bold', () => {
    expect(convertMarkdownToMrkdwn('# Title')).toBe('*Title*');
    expect(convertMarkdownToMrkdwn('## Subtitle')).toBe('*Subtitle*');
    expect(convertMarkdownToMrkdwn('### Deep')).toBe('*Deep*');
  });

  // Bold / Italic
  it('converts **bold** to *bold*', () => {
    expect(convertMarkdownToMrkdwn('**hello**')).toBe('*hello*');
  });

  it('converts *italic* to _italic_', () => {
    expect(convertMarkdownToMrkdwn('*hello*')).toBe('_hello_');
  });

  it('converts ***bolditalic*** to *_bolditalic_*', () => {
    expect(convertMarkdownToMrkdwn('***hello***')).toBe('*_hello_*');
  });

  // Strikethrough
  it('converts ~~text~~ to ~text~', () => {
    expect(convertMarkdownToMrkdwn('~~deleted~~')).toBe('~deleted~');
  });

  // Code blocks
  it('preserves code blocks and strips language', () => {
    const input = '```typescript\nconst x = 1;\n```';
    const expected = '```\nconst x = 1;\n```';
    expect(convertMarkdownToMrkdwn(input)).toBe(expected);
  });

  it('does not transform content inside code blocks', () => {
    const input = '```\n**not bold** *not italic*\n```';
    expect(convertMarkdownToMrkdwn(input)).toBe(input);
  });

  // Inline code
  it('preserves inline code', () => {
    expect(convertMarkdownToMrkdwn('Use `npm install`')).toBe('Use `npm install`');
  });

  it('does not transform inside inline code', () => {
    expect(convertMarkdownToMrkdwn('`**bold**`')).toBe('`**bold**`');
  });

  // Lists
  it('converts unordered list markers to bullets', () => {
    expect(convertMarkdownToMrkdwn('- item 1\n- item 2')).toBe('• item 1\n• item 2');
  });

  it('converts nested lists with indentation', () => {
    expect(convertMarkdownToMrkdwn('- parent\n  - child')).toBe('• parent\n  • child');
  });

  it('converts task lists', () => {
    expect(convertMarkdownToMrkdwn('- [ ] todo\n- [x] done')).toBe('☐ todo\n☑ done');
  });

  // Links
  it('converts [text](url) to <url|text>', () => {
    expect(convertMarkdownToMrkdwn('[Google](https://google.com)')).toBe('<https://google.com|Google>');
  });

  // Images
  it('converts ![alt](url) to link', () => {
    expect(convertMarkdownToMrkdwn('![screenshot](https://img.png)')).toBe('<https://img.png|screenshot>');
  });

  // Horizontal rule
  it('converts --- to visual divider', () => {
    expect(convertMarkdownToMrkdwn('---')).toBe('───────────────');
  });

  // Blockquote
  it('preserves blockquotes', () => {
    expect(convertMarkdownToMrkdwn('> quoted text')).toBe('> quoted text');
  });

  // Tables
  it('converts tables to ASCII table in code block', () => {
    const input = '| A | B |\n|---|---|\n| 1 | 2 |';
    const result = convertMarkdownToMrkdwn(input);
    expect(result).toContain('```');
    expect(result).toContain('A');
    expect(result).toContain('B');
  });

  // HTML
  it('strips HTML tags', () => {
    expect(convertMarkdownToMrkdwn('hello<br>world')).toBe('hello\nworld');
  });

  // Escape chars
  it('removes escape backslashes', () => {
    expect(convertMarkdownToMrkdwn('\\*not italic\\*')).toBe('*not italic*');
  });

  // Incomplete markdown safety
  it('leaves incomplete bold untouched', () => {
    expect(convertMarkdownToMrkdwn('**incomplete')).toBe('**incomplete');
  });

  it('leaves unclosed code block as text', () => {
    const input = '```\nunclosed';
    expect(convertMarkdownToMrkdwn(input)).toBe(input);
  });

  // Combined
  it('handles real Claude response', () => {
    const input = '## Approach\n- **Structure**: 4 categories\n- **Benefit**: comprehensive\n\n| Cat | Count |\n|-----|-------|\n| A   | 20    |';
    const result = convertMarkdownToMrkdwn(input);
    expect(result).toContain('*Approach*');
    expect(result).toContain('• *Structure*');
    expect(result).toContain('```');
  });
});
