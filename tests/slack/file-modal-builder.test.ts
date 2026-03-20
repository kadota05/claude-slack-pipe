import { describe, it, expect } from 'vitest';
import { buildFileContentModal, buildFileChunksModal, buildFileChunkModal } from '../../src/slack/modal-builder.js';

describe('buildFileContentModal', () => {
  it('builds modal with file content in code blocks', () => {
    const modal = buildFileContentModal('src/index.ts', 'console.log("hello")');
    expect(modal.type).toBe('modal');
    expect(modal.title.text).toContain('index.ts');
    const textBlocks = modal.blocks.filter((b: any) => b.type === 'section');
    expect(textBlocks.length).toBeGreaterThan(0);
    expect(textBlocks[0].text.text).toContain('```');
  });

  it('splits long content into multiple sections', () => {
    const longContent = 'x'.repeat(6000);
    const modal = buildFileContentModal('src/big.ts', longContent);
    const textBlocks = modal.blocks.filter((b: any) => b.type === 'section');
    expect(textBlocks.length).toBeGreaterThan(1);
  });
});

describe('buildFileChunksModal', () => {
  it('builds parent modal with chunk buttons', () => {
    const modal = buildFileChunksModal('src/index.ts', 642);
    expect(modal.type).toBe('modal');
    const actionsBlocks = modal.blocks.filter((b: any) => b.type === 'actions');
    expect(actionsBlocks.length).toBeGreaterThan(0);
    const buttons = actionsBlocks[0].elements;
    expect(buttons[0].value).toContain('src/index.ts');
  });

  it('splits buttons into multiple actions blocks when >25 chunks', () => {
    const modal = buildFileChunksModal('src/huge.ts', 3000);
    const actionsBlocks = modal.blocks.filter((b: any) => b.type === 'actions');
    expect(actionsBlocks.length).toBeGreaterThan(1);
  });
});

describe('buildFileChunkModal', () => {
  it('builds child modal with chunk content', () => {
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join('\n');
    const modal = buildFileChunkModal('src/index.ts', lines, 1, 50);
    expect(modal.type).toBe('modal');
    expect(modal.title.text).toContain('1-50');
  });
});
