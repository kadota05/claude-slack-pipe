import { describe, it, expect } from 'vitest';
import { buildFileReferenceBlocks } from '../../src/streaming/file-reference-blocks.js';

describe('buildFileReferenceBlocks', () => {
  it('builds actions block with buttons for each file path', () => {
    const blocks = buildFileReferenceBlocks(['src/index.ts', 'src/types.ts']);
    expect(blocks).toHaveLength(2); // divider + 1 actions block
    expect(blocks[0].type).toBe('divider');
    expect(blocks[1].type).toBe('actions');
    const buttons = (blocks[1] as any).elements;
    expect(buttons).toHaveLength(2);
    expect(buttons[0].type).toBe('button');
    expect(buttons[0].action_id).toBe('view_file_content:0');
    expect(buttons[0].value).toBe('src/index.ts');
    expect(buttons[0].text.text).toContain('index.ts');
  });

  it('returns empty array for no file paths', () => {
    const blocks = buildFileReferenceBlocks([]);
    expect(blocks).toHaveLength(0);
  });

  it('respects max blocks limit', () => {
    const paths = Array.from({ length: 60 }, (_, i) => `src/file${i}.ts`);
    const blocks = buildFileReferenceBlocks(paths, 10);
    expect(blocks.length).toBeLessThanOrEqual(10);
  });
});
