import { describe, it, expect } from 'vitest';
import { splitMessage, splitAtBoundaries } from '../../src/slack/response-builder.js';

describe('splitAtBoundaries', () => {
  it('should not split text under the limit', () => {
    const text = 'Short text.';
    const chunks = splitAtBoundaries(text, 3900);
    expect(chunks).toEqual(['Short text.']);
  });

  it('should split at paragraph boundaries', () => {
    const text = 'Paragraph one.\n\nParagraph two.\n\nParagraph three.';
    const chunks = splitAtBoundaries(text, 25);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join('\n\n')).toContain('Paragraph one');
    expect(chunks.join('\n\n')).toContain('Paragraph three');
  });

  it('should split at markdown headings', () => {
    const text = '## Section 1\nContent 1\n\n## Section 2\nContent 2';
    const chunks = splitAtBoundaries(text, 25);
    expect(chunks.length).toBeGreaterThan(1);
  });

  it('should not split inside code blocks', () => {
    const codeBlock = '```typescript\nconst x = 1;\nconst y = 2;\nconst z = 3;\n```';
    const text = `Before code.\n\n${codeBlock}\n\nAfter code.`;
    const chunks = splitAtBoundaries(text, 70);
    // Code block should remain intact in one chunk
    const blockChunk = chunks.find((c) => c.includes('```typescript'));
    expect(blockChunk).toBeDefined();
    expect(blockChunk).toContain('const z = 3;');
    expect(blockChunk).toContain('```');
  });

  it('should force split at line boundaries as last resort', () => {
    const longLine = 'a'.repeat(100);
    const text = `${longLine}\n${longLine}`;
    const chunks = splitAtBoundaries(text, 120);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
  });
});

describe('splitMessage', () => {
  it('should return single chunk for short messages', () => {
    const result = splitMessage('Hello world');
    expect(result.type).toBe('single');
    expect(result.chunks).toHaveLength(1);
  });

  it('should split long messages into multiple chunks', () => {
    const longText = Array.from({ length: 100 }, (_, i) =>
      `Paragraph ${i + 1}. `.repeat(10)
    ).join('\n\n');

    const result = splitMessage(longText);
    expect(result.chunks.length).toBeGreaterThan(1);
    expect(result.type).toBe('multi');
  });

  it('should recommend file upload for very long messages', () => {
    const veryLong = 'x'.repeat(40_000);
    const result = splitMessage(veryLong);
    expect(result.type).toBe('file_upload');
  });
});
