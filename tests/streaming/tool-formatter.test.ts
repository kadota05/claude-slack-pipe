// tests/streaming/tool-formatter.test.ts
import { describe, it, expect } from 'vitest';
import { buildToolRunningBlocks, buildToolCompletedBlocks, buildThinkingBlocks, getToolOneLiner, getToolResultSummary } from '../../src/streaming/tool-formatter.js';
import {
  buildThinkingLiveBlocks,
  buildToolGroupLiveBlocks,
  buildSubagentLiveBlocks,
} from '../../src/streaming/tool-formatter.js';
import {
  buildThinkingCollapsedBlocks,
  buildToolGroupCollapsedBlocks,
  buildSubagentCollapsedBlocks,
} from '../../src/streaming/tool-formatter.js';
import { buildBundleCollapsedBlocks } from '../../src/streaming/tool-formatter.js';

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
  it('returns blocks with wrench icon', () => {
    const blocks = buildToolRunningBlocks('Read', 'src/auth.ts');
    expect(blocks).toHaveLength(2);
    expect(blocks[0].text.text).toContain(':wrench:');
    expect(blocks[0].text.text).toContain('`Read`');
    expect(blocks[0].text.text).toContain('src/auth.ts');
    expect(blocks[1].elements[0].text).toContain('実行中');
  });
});

describe('buildToolCompletedBlocks', () => {
  it('returns blocks with checkmark icon', () => {
    const blocks = buildToolCompletedBlocks('Read', 'src/auth.ts — 247行', 800);
    expect(blocks[0].text.text).toContain('✓');
    expect(blocks[0].text.text).toContain('`Read`');
    expect(blocks[1].elements[0].text).toContain('0.8s');
  });

  it('returns blocks with x icon on error', () => {
    const blocks = buildToolCompletedBlocks('Bash', 'exit code 1', 1200, true);
    expect(blocks[0].text.text).toContain('✗');
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

describe('buildThinkingLiveBlocks', () => {
  it('builds context blocks with italic text', () => {
    const blocks = buildThinkingLiveBlocks(['考えています...']);
    expect(blocks.length).toBeGreaterThanOrEqual(1);
    for (const b of blocks) {
      expect(b.type).toBe('context');
    }
    const allText = JSON.stringify(blocks);
    expect(allText).toContain('thought_balloon');
    expect(allText).toContain('思考中');
  });

  it('includes all thinking texts for multiple thoughts', () => {
    const blocks = buildThinkingLiveBlocks(['First thought', 'Second thought']);
    const allText = JSON.stringify(blocks);
    expect(allText).toContain('First thought');
    expect(allText).toContain('Second thought');
  });

  it('truncates long thinking text', () => {
    const blocks = buildThinkingLiveBlocks(['a'.repeat(500)]);
    const textBlock = blocks.find(b => JSON.stringify(b).includes('aaa'));
    const textContent = JSON.stringify(textBlock);
    expect(textContent).toContain('...');
    expect(textContent.length).toBeLessThan(500);
  });
});

describe('buildToolGroupLiveBlocks', () => {
  it('builds context blocks for running tools', () => {
    const blocks = buildToolGroupLiveBlocks([
      { toolName: 'Read', oneLiner: 'src/auth.ts', status: 'running' },
    ]);
    for (const b of blocks) { expect(b.type).toBe('context'); }
    const allText = JSON.stringify(blocks);
    expect(allText).toContain('Read');
    expect(allText).toContain('src/auth.ts');
    expect(allText).toContain(':wrench:');
  });

  it('shows completed tools with checkmark', () => {
    const blocks = buildToolGroupLiveBlocks([
      { toolName: 'Read', oneLiner: 'src/auth.ts', status: 'completed', durationMs: 300 },
      { toolName: 'Bash', oneLiner: 'npm test', status: 'running' },
    ]);
    const allText = JSON.stringify(blocks);
    expect(allText).toContain('✓');
    expect(allText).toContain(':wrench:');
  });

  it('handles 10+ tools with single context block', () => {
    const tools = Array.from({ length: 12 }, (_, i) => ({
      toolName: 'Read', oneLiner: `file${i}.ts`, status: 'completed' as const, durationMs: 100,
    }));
    const blocks = buildToolGroupLiveBlocks(tools);
    for (const b of blocks) {
      if (b.type === 'context') {
        expect((b.elements as any[]).length).toBeLessThanOrEqual(10);
      }
    }
  });
});

describe('buildSubagentLiveBlocks', () => {
  it('builds context blocks for subagent', () => {
    const blocks = buildSubagentLiveBlocks('コード探索', [
      { toolName: 'Grep', oneLiner: 'handleAuth', status: 'completed' },
      { toolName: 'Read', oneLiner: 'src/auth.ts', status: 'running' },
    ]);
    for (const b of blocks) { expect(b.type).toBe('context'); }
    const allText = JSON.stringify(blocks);
    expect(allText).toContain('SubAgent');
    expect(allText).toContain('コード探索');
  });
});

describe('buildThinkingCollapsedBlocks', () => {
  it('builds collapsed thinking with detail button', () => {
    const blocks = buildThinkingCollapsedBlocks(2, 'group-123');
    const allText = JSON.stringify(blocks);
    expect(allText).toContain('思考完了');
    expect(allText).toContain('2回');
    expect(allText).toContain('view_group_detail:group-123');
    expect(allText).toContain('詳細を見る');
  });

  it('omits count when 1', () => {
    const blocks = buildThinkingCollapsedBlocks(1, 'group-1');
    const allText = JSON.stringify(blocks);
    expect(allText).toContain('思考完了');
    expect(allText).not.toContain('1回');
  });
});

describe('buildToolGroupCollapsedBlocks', () => {
  it('builds collapsed tool group with counts', () => {
    const blocks = buildToolGroupCollapsedBlocks(
      [{ toolName: 'Read', count: 2 }, { toolName: 'Bash', count: 1 }],
      1500, 'group-456',
    );
    const allText = JSON.stringify(blocks);
    expect(allText).toContain('Read × 2');
    expect(allText).toContain('Bash × 1');
    expect(allText).toContain('完了');
    expect(allText).toContain('1.5s');
    expect(allText).toContain('view_group_detail:group-456');
  });
});

describe('buildSubagentCollapsedBlocks', () => {
  it('builds collapsed subagent with description', () => {
    const blocks = buildSubagentCollapsedBlocks('コード探索', 5200, 'group-789');
    const allText = JSON.stringify(blocks);
    expect(allText).toContain('SubAgent');
    expect(allText).toContain('コード探索');
    expect(allText).toContain('完了');
    expect(allText).toContain('5.2s');
    expect(allText).toContain('view_group_detail:group-789');
  });
});

describe('buildBundleCollapsedBlocks', () => {
  it('shows only present categories', () => {
    const blocks = buildBundleCollapsedBlocks({
      thinkingCount: 2,
      toolCount: 3,
      toolDurationMs: 1000,
      subagentCount: 0,
      subagentDurationMs: 0,
      sessionId: 'sess-1',
      bundleIndex: 0,
    });
    expect(blocks).toHaveLength(2);
    const contextText = (blocks[0] as any).elements[0].text;
    expect(contextText).toContain('💭×2');
    expect(contextText).toContain('🔧×3');
    expect(contextText).not.toContain('🤖');
  });

  it('shows all three categories when present', () => {
    const blocks = buildBundleCollapsedBlocks({
      thinkingCount: 1,
      toolCount: 2,
      toolDurationMs: 500,
      subagentCount: 1,
      subagentDurationMs: 3000,
      sessionId: 'sess-1',
      bundleIndex: 1,
    });
    const contextText = (blocks[0] as any).elements[0].text;
    expect(contextText).toContain('💭×1');
    expect(contextText).toContain('🔧×2');
    expect(contextText).toContain('🤖×1');
  });

  it('includes view_bundle action_id with sessionId and bundleKey', () => {
    const blocks = buildBundleCollapsedBlocks({
      thinkingCount: 1,
      toolCount: 0,
      toolDurationMs: 0,
      subagentCount: 0,
      subagentDurationMs: 0,
      sessionId: 'abc-123',
      bundleIndex: 2,
      bundleKey: 'toolu_ABC',
    });
    const actionsBlock = blocks.find((b: any) => b.type === 'actions') as any;
    expect(actionsBlock.elements[0].action_id).toBe('view_bundle:abc-123:toolu_ABC');
  });
});
