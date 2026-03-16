import { describe, it, expect } from 'vitest';
import {
  buildAnchorBlocks,
  buildCollapsedAnchorBlocks,
  buildErrorBlocks,
  buildResultBlocks,
  buildResponseFooter,
  buildThreadHeaderText,
  buildStreamingBlocks,
  buildHomeTabBlocksV2,
} from '../../src/slack/block-builder.js';
import type { SessionMetadata } from '../../src/types.js';

const mockSession: SessionMetadata = {
  sessionId: 'a1b2c3d4-e5f6-5789-abcd-ef0123456789',
  threadTs: '1710567000.000100',
  dmChannelId: 'D123',
  projectPath: '/Users/user/dev/my-webapp',
  name: 'my-webapp: implement auth',
  model: 'opus',
  status: 'active',
  startTime: new Date('2026-03-16T14:30:00Z'),
  totalCost: 0.23,
  turnCount: 5,
  totalInputTokens: 45000,
  totalOutputTokens: 5000,
  lastActiveAt: new Date(),
  anchorCollapsed: false,
};

describe('buildAnchorBlocks', () => {
  it('should return blocks with header, section, context, model select, actions, hint', () => {
    const blocks = buildAnchorBlocks(mockSession);
    expect(blocks.length).toBeGreaterThanOrEqual(6);
    expect(blocks[0].type).toBe('header');
    expect(blocks[0].text.text).toContain('my-webapp: implement auth');
    expect(blocks[1].type).toBe('section');
    expect(blocks[1].text.text).toContain(':large_green_circle:');

    const modelBlock = blocks.find(
      (b: any) => b.type === 'section' && b.accessory?.action_id === 'set_model',
    );
    expect(modelBlock).toBeDefined();
    expect(modelBlock.accessory.initial_option.value).toBe('opus');

    const actionsBlock = blocks.find(
      (b: any) => b.type === 'actions' && b.block_id === 'session_controls',
    );
    expect(actionsBlock).toBeDefined();
    expect(actionsBlock.elements.length).toBe(2);
  });

  it('should show ended status for ended session', () => {
    const endedSession = { ...mockSession, status: 'ended' as const };
    const blocks = buildAnchorBlocks(endedSession);
    expect(blocks[1].text.text).toContain(':white_circle:');
  });
});

describe('buildCollapsedAnchorBlocks', () => {
  it('should return single section with expand button', () => {
    const blocks = buildCollapsedAnchorBlocks(mockSession);
    expect(blocks.length).toBe(1);
    expect(blocks[0].type).toBe('section');
    expect(blocks[0].accessory.action_id).toBe('toggle_anchor');
    expect(blocks[0].accessory.value).toBe('expand');
  });
});

describe('buildErrorBlocks', () => {
  it('should build error message with retry button', () => {
    const blocks = buildErrorBlocks({
      errorMessage: 'ENOENT: no such file or directory',
      sessionId: 'a1b2c3d4',
      exitCode: 1,
      durationSec: 3.2,
      originalPromptHash: 'prompt_hash_123',
    });
    expect(blocks.length).toBeGreaterThanOrEqual(3);
    expect(blocks[0].text.text).toContain(':x:');

    const actionsBlock = blocks.find((b: any) => b.type === 'actions');
    expect(actionsBlock).toBeDefined();
    const retryButton = actionsBlock.elements.find(
      (e: any) => e.action_id === 'retry_prompt',
    );
    expect(retryButton.value).toBe('prompt_hash_123');
  });
});

describe('buildResultBlocks', () => {
  it('should build result message blocks', () => {
    const blocks = buildResultBlocks({
      text: 'Authentication module implemented.',
      durationSec: 32,
      costUsd: 0.045,
      turnCount: 5,
      model: 'claude-sonnet-4-6',
    });
    expect(blocks.length).toBeGreaterThanOrEqual(2);
    expect(blocks[0].type).toBe('section');
    expect(blocks[0].text.text).toContain('Authentication');

    const contextBlock = blocks.find((b: any) => b.type === 'context');
    expect(contextBlock).toBeDefined();
  });
});

describe('buildResponseFooter', () => {
  it('formats cost, tokens, model, and duration', () => {
    const blocks = buildResponseFooter({
      inputTokens: 1200,
      outputTokens: 3400,
      costUsd: 0.042,
      model: 'sonnet',
      durationMs: 12300,
    });
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe('context');
    const text = (blocks[0] as any).elements[0].text;
    expect(text).toContain('1.2k');
    expect(text).toContain('3.4k');
    expect(text).toContain('$0.042');
    expect(text).toContain('sonnet');
    expect(text).toContain('12.3s');
  });

  it('handles zero cost', () => {
    const blocks = buildResponseFooter({
      inputTokens: 0, outputTokens: 0, costUsd: 0, model: 'haiku', durationMs: 500,
    });
    expect(blocks).toHaveLength(1);
  });
});

describe('buildThreadHeaderText', () => {
  it('includes project dir basename, model, session ID', () => {
    const text = buildThreadHeaderText({
      projectPath: '/Users/alice/dev/myapp',
      model: 'sonnet',
      sessionId: 'abc12345',
    });
    expect(text).toContain('myapp');
    expect(text).toContain('sonnet');
    expect(text).toContain('abc12345');
  });
});

describe('buildStreamingBlocks', () => {
  it('builds blocks for partial assistant text', () => {
    const blocks = buildStreamingBlocks({ text: 'Thinking about...', isComplete: false });
    expect(blocks.length).toBeGreaterThan(0);
    const textBlock = blocks.find((b: any) => b.type === 'section');
    expect(textBlock).toBeDefined();
  });

  it('does not show progress indicator when complete', () => {
    const blocks = buildStreamingBlocks({ text: 'Final answer', isComplete: true });
    const ctx = blocks.find((b: any) => b.type === 'context' && b.elements?.[0]?.text?.includes('応答中'));
    expect(ctx).toBeUndefined();
  });
});

describe('buildHomeTabBlocksV2 (phase2)', () => {
  const defaultParams = {
    model: 'sonnet',
    directoryId: 'myapp',
    directories: [
      { id: 'myapp', name: 'myapp', path: '/home/user/myapp' },
      { id: 'other', name: 'other', path: '/home/user/other' },
    ],
    activeSessions: [
      { cliSessionId: 's1', name: 'fix-auth-bug', lastActiveAt: '2026-03-16T10:00:00Z', model: 'sonnet', status: 'active' as const, threadTs: '123', channelId: 'C001' },
    ],
    endedSessions: [
      { cliSessionId: 's2', name: 'refactor-api', lastActiveAt: '2026-03-16T08:00:00Z', model: 'opus', status: 'ended' as const, threadTs: '456', channelId: 'C001' },
    ],
    page: 0,
    totalPages: 1,
  };

  it('includes header section', () => {
    const blocks = buildHomeTabBlocksV2(defaultParams);
    const header = blocks.find((b: any) => b.type === 'header');
    expect(header).toBeDefined();
  });

  it('includes model static_select', () => {
    const blocks = buildHomeTabBlocksV2(defaultParams);
    const modelSection = blocks.find((b: any) =>
      b.accessory?.action_id === 'home_set_default_model'
    );
    expect(modelSection).toBeDefined();
  });

  it('includes directory static_select', () => {
    const blocks = buildHomeTabBlocksV2(defaultParams);
    const dirSection = blocks.find((b: any) =>
      b.accessory?.action_id === 'home_set_directory'
    );
    expect(dirSection).toBeDefined();
  });

  it('includes usage guide section', () => {
    const blocks = buildHomeTabBlocksV2(defaultParams);
    const found = blocks.some((b: any) =>
      b.text?.text?.includes('Usage Guide') || b.text?.text?.includes('usage') || b.text?.text?.includes('Usage')
    );
    expect(found).toBe(true);
  });

  it('includes active session', () => {
    const blocks = buildHomeTabBlocksV2(defaultParams);
    const found = blocks.some((b: any) =>
      JSON.stringify(b).includes('fix-auth-bug')
    );
    expect(found).toBe(true);
  });

  it('stays within 100 block limit', () => {
    const blocks = buildHomeTabBlocksV2(defaultParams);
    expect(blocks.length).toBeLessThanOrEqual(100);
  });

  it('includes pagination when totalPages > 1', () => {
    const blocks = buildHomeTabBlocksV2({ ...defaultParams, totalPages: 3, page: 1 });
    const found = blocks.some((b: any) =>
      JSON.stringify(b).includes('session_page_next') || JSON.stringify(b).includes('session_page_prev')
    );
    expect(found).toBe(true);
  });
});
