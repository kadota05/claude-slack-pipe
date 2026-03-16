// tests/slack/modal-builder.test.ts
import { describe, it, expect } from 'vitest';
import { buildToolModal, buildThinkingModal, buildToolGroupModal, buildSubagentModal, buildBundleDetailModal } from '../../src/slack/modal-builder.js';
import type { BundleEntry } from '../../src/streaming/session-jsonl-reader.js';

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

  it('does not include a header block in body', () => {
    const modal = buildToolModal({
      toolId: 'toolu_001',
      toolName: 'Read',
      input: { file_path: '/a.ts' },
      result: 'ok',
      durationMs: 100,
      isError: false,
    });

    expect(modal.blocks.filter((b: any) => b.type === 'header')).toHaveLength(0);
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

  it('does not include a header block in body', () => {
    const modal = buildThinkingModal(['some thought']);
    expect(modal.blocks.filter((b: any) => b.type === 'header')).toHaveLength(0);
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

  it('does not include a header block in body', () => {
    const modal = buildToolGroupModal([
      { toolUseId: 'toolu_001', toolName: 'Read', oneLiner: 'a.ts', durationMs: 100, isError: false },
    ]);
    expect(modal.blocks.filter((b: any) => b.type === 'header')).toHaveLength(0);
  });
});

describe('buildBundleDetailModal', () => {
  it('renders thinking entry as button', () => {
    const entries: BundleEntry[] = [
      { type: 'thinking', texts: ['Let me analyze the file structure...'] },
    ];
    const modal = buildBundleDetailModal(entries, 'sess-1', 0);
    expect(modal.type).toBe('modal');
    const actionsBlocks = modal.blocks.filter((b: any) => b.type === 'actions');
    expect(actionsBlocks.length).toBeGreaterThan(0);
    const buttons = actionsBlocks.flatMap((b: any) => b.elements);
    expect(buttons[0].action_id).toBe('view_thinking_detail:sess-1:0:0');
    expect(buttons[0].text.text).toContain('💭');
  });

  it('renders tool entry as button with action_id', () => {
    const entries: BundleEntry[] = [
      { type: 'tool', toolUseId: 'toolu_001', toolName: 'Read', oneLiner: 'src/auth.ts', durationMs: 200 },
    ];
    const modal = buildBundleDetailModal(entries, 'sess-1', 0);
    const actionsBlocks = modal.blocks.filter((b: any) => b.type === 'actions');
    const buttons = actionsBlocks.flatMap((b: any) => b.elements);
    expect(buttons[0].action_id).toBe('view_tool_detail:sess-1:toolu_001');
    expect(buttons[0].text.text).toContain('🔧');
    expect(buttons[0].text.text).toContain('Read');
  });

  it('renders subagent entry as button with action_id', () => {
    const entries: BundleEntry[] = [
      { type: 'subagent', toolUseId: 'toolu_agent', description: 'コード探索', agentId: 'abc', durationMs: 3000 },
    ];
    const modal = buildBundleDetailModal(entries, 'sess-1', 0);
    const actionsBlocks = modal.blocks.filter((b: any) => b.type === 'actions');
    const buttons = actionsBlocks.flatMap((b: any) => b.elements);
    expect(buttons[0].action_id).toBe('view_subagent_detail:sess-1:toolu_agent');
    expect(buttons[0].text.text).toContain('🤖');
  });

  it('truncates button text to 75 chars max', () => {
    const entries: BundleEntry[] = [
      { type: 'tool', toolUseId: 'toolu_001', toolName: 'Read', oneLiner: 'a'.repeat(100), durationMs: 200 },
    ];
    const modal = buildBundleDetailModal(entries, 'sess-1', 0);
    const actionsBlocks = modal.blocks.filter((b: any) => b.type === 'actions');
    const buttons = actionsBlocks.flatMap((b: any) => b.elements);
    expect(buttons[0].text.text.length).toBeLessThanOrEqual(75);
  });

  it('assigns correct thinkingIndex for multiple thinking entries', () => {
    const entries: BundleEntry[] = [
      { type: 'thinking', texts: ['first'] },
      { type: 'tool', toolUseId: 'toolu_001', toolName: 'Read', oneLiner: 'a.ts', durationMs: 100 },
      { type: 'thinking', texts: ['second'] },
    ];
    const modal = buildBundleDetailModal(entries, 'sess-1', 2);
    const actionsBlocks = modal.blocks.filter((b: any) => b.type === 'actions');
    const buttons = actionsBlocks.flatMap((b: any) => b.elements);
    expect(buttons[0].action_id).toBe('view_thinking_detail:sess-1:2:0');
    expect(buttons[1].action_id).toBe('view_tool_detail:sess-1:toolu_001');
    expect(buttons[2].action_id).toBe('view_thinking_detail:sess-1:2:1');
  });

  it('does not include header block', () => {
    const entries: BundleEntry[] = [
      { type: 'thinking', texts: ['hmm'] },
    ];
    const modal = buildBundleDetailModal(entries, 'sess-1', 0);
    const headerBlocks = modal.blocks.filter((b: any) => b.type === 'header');
    expect(headerBlocks).toHaveLength(0);
  });
});

describe('buildSubagentModal', () => {
  it('displays conversation flow from JSONL', () => {
    const flow = {
      agentType: 'general-purpose',
      systemPromptSummary: 'You are a search agent...',
      steps: [
        { type: 'text' as const, text: 'I will search.' },
        { type: 'tool_use' as const, toolName: 'Grep', toolUseId: 'toolu_001', oneLiner: 'auth' },
        { type: 'tool_result' as const, toolUseId: 'toolu_001', resultSummary: '5 matches', isError: false },
      ],
      finalResult: 'Found auth in 5 files.',
      totalDurationMs: 5000,
    };

    const modal = buildSubagentModal('コード探索', flow);
    expect(modal.type).toBe('modal');
    const allText = JSON.stringify(modal.blocks);
    expect(allText).toContain('search agent');
    expect(allText).toContain('Grep');
    expect(allText).toContain('Found auth');
  });

  it('displays fallback when flow is null', () => {
    const modal = buildSubagentModal('コード探索', null);
    const allText = JSON.stringify(modal.blocks);
    expect(allText).toContain('取得できませんでした');
  });

  it('does not include a header block in body', () => {
    const modal = buildSubagentModal('コード探索', null);
    expect(modal.blocks.filter((b: any) => b.type === 'header')).toHaveLength(0);
  });
});
