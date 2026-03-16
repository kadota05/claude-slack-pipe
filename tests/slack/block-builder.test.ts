import { describe, it, expect } from 'vitest';
import {
  buildAnchorBlocks,
  buildCollapsedAnchorBlocks,
  buildErrorBlocks,
  buildResultBlocks,
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
