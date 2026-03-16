// tests/slack/modal-builder.test.ts
import { describe, it, expect } from 'vitest';
import { buildToolModal, buildThinkingModal, buildToolGroupModal } from '../../src/slack/modal-builder.js';

describe('buildToolModal', () => {
  it('builds modal for Read tool', () => {
    const modal = buildToolModal({
      toolId: 'toolu_001',
      toolName: 'Read',
      input: { file_path: '/src/auth.ts' },
      result: 'const x = 1;\nconst y = 2;',
      durationMs: 800,
      isError: false,
    });

    expect(modal.type).toBe('modal');
    expect(modal.title.text).toContain('Read');
    expect(modal.blocks.length).toBeGreaterThan(0);
  });

  it('truncates title to 24 chars', () => {
    const modal = buildToolModal({
      toolId: 'toolu_001',
      toolName: 'Read',
      input: { file_path: '/very/long/path/to/some/deeply/nested/file.ts' },
      result: 'content',
      durationMs: 100,
      isError: false,
    });

    expect(modal.title.text.length).toBeLessThanOrEqual(24);
  });

  it('splits large content into multiple sections', () => {
    const largeResult = 'x'.repeat(6000);
    const modal = buildToolModal({
      toolId: 'toolu_001',
      toolName: 'Bash',
      input: { command: 'cat big.txt' },
      result: largeResult,
      durationMs: 2000,
      isError: false,
    });

    const sections = modal.blocks.filter((b: any) => b.type === 'section');
    expect(sections.length).toBeGreaterThan(1);
  });

  it('shows error styling for error results', () => {
    const modal = buildToolModal({
      toolId: 'toolu_001',
      toolName: 'Bash',
      input: { command: 'exit 1' },
      result: 'command failed',
      durationMs: 100,
      isError: true,
    });

    const text = JSON.stringify(modal.blocks);
    expect(text).toContain(':x:');
  });

  it('formats Edit tool input correctly', () => {
    const modal = buildToolModal({
      toolId: 'toolu_001',
      toolName: 'Edit',
      input: { file_path: '/src/a.ts', old_string: 'foo', new_string: 'bar' },
      result: 'success',
      durationMs: 200,
      isError: false,
    });

    const text = JSON.stringify(modal.blocks);
    expect(text).toContain('/src/a.ts');
  });

  it('has close button', () => {
    const modal = buildToolModal({
      toolId: 'toolu_001',
      toolName: 'Read',
      input: { file_path: '/a.ts' },
      result: 'ok',
      durationMs: 100,
      isError: false,
    });

    expect(modal.close.text).toBeDefined();
  });
});

describe('buildThinkingModal', () => {
  it('displays all thinking texts with separators', () => {
    const modal = buildThinkingModal(['First thought', 'Second thought']);
    expect(modal.type).toBe('modal');
    const allText = JSON.stringify(modal.blocks);
    expect(allText).toContain('First thought');
    expect(allText).toContain('Second thought');
    expect(modal.blocks.some((b: any) => b.type === 'divider')).toBe(true);
  });

  it('truncates very long thinking text', () => {
    const modal = buildThinkingModal(['a'.repeat(5000)]);
    const allText = JSON.stringify(modal.blocks);
    expect(allText.length).toBeLessThan(10000);
  });
});

describe('buildToolGroupModal', () => {
  it('displays tool list with detail buttons', () => {
    const modal = buildToolGroupModal([
      { toolUseId: 'toolu_001', toolName: 'Read', oneLiner: 'src/auth.ts', durationMs: 300, isError: false },
      { toolUseId: 'toolu_002', toolName: 'Bash', oneLiner: 'npm test', durationMs: 1200, isError: false },
    ]);
    expect(modal.type).toBe('modal');
    const allText = JSON.stringify(modal.blocks);
    expect(allText).toContain('Read');
    expect(allText).toContain('Bash');
    expect(allText).toContain('view_tool_detail:toolu_001');
    expect(allText).toContain('view_tool_detail:toolu_002');
  });

  it('shows error icon for failed tools', () => {
    const modal = buildToolGroupModal([
      { toolUseId: 'toolu_001', toolName: 'Bash', oneLiner: 'exit 1', durationMs: 100, isError: true },
    ]);
    const allText = JSON.stringify(modal.blocks);
    expect(allText).toContain(':x:');
  });
});
