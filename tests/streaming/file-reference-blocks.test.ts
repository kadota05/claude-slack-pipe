import { describe, it, expect } from 'vitest';
import { buildFileReferenceBlocks } from '../../src/streaming/file-reference-blocks.js';

describe('buildFileReferenceBlocks', () => {
  it('builds section + button for each file path', () => {
    const blocks = buildFileReferenceBlocks(['src/index.ts', 'src/types.ts']);
    expect(blocks).toHaveLength(3); // divider + 2 sections
    expect(blocks[0].type).toBe('divider');
    expect(blocks[1].type).toBe('section');
    expect(blocks[1].accessory.type).toBe('button');
    expect(blocks[1].accessory.action_id).toBe('view_file_content');
    expect(blocks[1].accessory.value).toBe('src/index.ts');
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
