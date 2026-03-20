import { describe, it, expect } from 'vitest';
import {
  buildErrorBlocks,
  buildResultBlocks,
  buildResponseFooter,
  buildThreadHeaderText,
  buildStreamingBlocks,
  buildHomeTabBlocks,
} from '../../src/slack/block-builder.js';

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
  it('formats tokens, ctx, model, and duration', () => {
    const blocks = buildResponseFooter({
      inputTokens: 1200,
      outputTokens: 3400,
      contextUsed: 55500,
      contextWindow: 1_000_000,
      model: 'sonnet',
      durationMs: 12300,
    });
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe('context');
    const text = (blocks[0] as any).elements[0].text;
    expect(text).toContain('in:1.2k');
    expect(text).toContain('out:3.4k');
    expect(text).toContain('ctx 55.5k/1M');
    expect(text).toContain('sonnet');
    expect(text).toContain('12.3s');
  });

  it('shows 200k context window for haiku', () => {
    const blocks = buildResponseFooter({
      inputTokens: 0, outputTokens: 0, contextUsed: 62000, contextWindow: 200_000, model: 'haiku', durationMs: 500,
    });
    const text = (blocks[0] as any).elements[0].text;
    expect(text).toContain('200k');
    expect(text).toContain('ctx 62.0k/200k(31.0%)');
  });
});

describe('buildThreadHeaderText', () => {
  it('includes Dir with code block and ID with code block, no model', () => {
    const text = buildThreadHeaderText({
      projectPath: '/Users/alice/dev/myapp',
      model: 'sonnet',
      sessionId: 'abc12345',
    });
    expect(text).toContain('Dir: `/Users/alice/dev/myapp`');
    expect(text).toContain('ID: `abc12345`');
    expect(text).not.toContain('sonnet');
    expect(text).toContain('*Session Started*');
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

describe('buildHomeTabBlocks', () => {
  const defaultParams = {
    model: 'sonnet',
    directoryId: 'myapp',
    directories: [
      { id: 'myapp', name: 'myapp', path: '/home/user/myapp' },
      { id: 'other', name: 'other', path: '/home/user/other' },
    ],
    recentSessions: [
      { timeAgo: '2h ago', firstPromptPreview: 'fix-auth-bug', projectPath: '/home/user/myapp' },
    ],
  };

  it('includes model selector as first block', () => {
    const blocks = buildHomeTabBlocks(defaultParams);
    const modelSection = blocks.find((b: any) =>
      b.accessory?.action_id === 'home_set_default_model'
    );
    expect(modelSection).toBeDefined();
  });

  it('includes model static_select', () => {
    const blocks = buildHomeTabBlocks(defaultParams);
    const modelSection = blocks.find((b: any) =>
      b.accessory?.action_id === 'home_set_default_model'
    );
    expect(modelSection).toBeDefined();
  });

  it('includes directory static_select', () => {
    const blocks = buildHomeTabBlocks(defaultParams);
    const dirSection = blocks.find((b: any) =>
      b.accessory?.action_id === 'home_set_directory'
    );
    expect(dirSection).toBeDefined();
  });


  it('includes recent session', () => {
    const blocks = buildHomeTabBlocks(defaultParams);
    const found = blocks.some((b: any) =>
      JSON.stringify(b).includes('fix-auth-bug')
    );
    expect(found).toBe(true);
  });

  it('stays within 100 block limit', () => {
    const blocks = buildHomeTabBlocks(defaultParams);
    expect(blocks.length).toBeLessThanOrEqual(100);
  });

  it('shows no recent sessions message when empty', () => {
    const blocks = buildHomeTabBlocks({ ...defaultParams, recentSessions: [] });
    const found = blocks.some((b: any) =>
      JSON.stringify(b).includes('No recent sessions')
    );
    expect(found).toBe(true);
  });

  it('sorts starred directories first with ★ prefix', () => {
    const blocks = buildHomeTabBlocks({
      ...defaultParams,
      directories: [
        { id: 'aaa', name: 'alpha', path: '/alpha' },
        { id: 'bbb', name: 'beta', path: '/beta' },
        { id: 'ccc', name: 'gamma', path: '/gamma' },
      ],
      directoryId: 'aaa',
      starredDirectoryIds: ['ccc'],
    });
    const dirSection = blocks.find((b: any) =>
      b.accessory?.action_id === 'home_set_directory'
    );
    const options = dirSection.accessory.options;
    expect(options[0].text.text).toBe('★ gamma');
    expect(options[0].value).toBe('ccc');
    expect(options[1].text.text).toBe('alpha');
    expect(options[2].text.text).toBe('beta');
  });

  it('shows ★ prefix on initial_option when starred', () => {
    const blocks = buildHomeTabBlocks({
      ...defaultParams,
      directories: [
        { id: 'aaa', name: 'alpha', path: '/alpha' },
      ],
      directoryId: 'aaa',
      starredDirectoryIds: ['aaa'],
    });
    const dirSection = blocks.find((b: any) =>
      b.accessory?.action_id === 'home_set_directory'
    );
    expect(dirSection.accessory.initial_option.text.text).toBe('★ alpha');
  });

  it('shows ★ toggle button when directory is selected', () => {
    const blocks = buildHomeTabBlocks({
      ...defaultParams,
      starredDirectoryIds: [],
    });
    const actionsBlock = blocks.find((b: any) =>
      b.type === 'actions' && b.elements?.some((e: any) => e.action_id === 'toggle_star_directory')
    );
    expect(actionsBlock).toBeDefined();
    expect(actionsBlock.elements[0].text.text).toContain('☆');
  });

  it('shows ★ on toggle button when directory is starred', () => {
    const blocks = buildHomeTabBlocks({
      ...defaultParams,
      starredDirectoryIds: ['myapp'],
    });
    const actionsBlock = blocks.find((b: any) =>
      b.type === 'actions' && b.elements?.some((e: any) => e.action_id === 'toggle_star_directory')
    );
    expect(actionsBlock.elements[0].text.text).toContain('★');
    expect(actionsBlock.elements[0].value).toBe('myapp');
  });

  it('hides ★ toggle button when no directory selected', () => {
    const blocks = buildHomeTabBlocks({
      ...defaultParams,
      directoryId: '',
      starredDirectoryIds: [],
    });
    const actionsBlock = blocks.find((b: any) =>
      b.type === 'actions' && b.elements?.some((e: any) => e.action_id === 'toggle_star_directory')
    );
    expect(actionsBlock).toBeUndefined();
  });
});
