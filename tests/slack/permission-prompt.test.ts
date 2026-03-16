// tests/slack/permission-prompt.test.ts
import { describe, it, expect } from 'vitest';
import { buildPermissionPromptBlocks, parsePermissionAction } from '../../src/slack/permission-prompt.js';

describe('buildPermissionPromptBlocks', () => {
  it('builds blocks with tool name and Approve/Deny buttons', () => {
    const blocks = buildPermissionPromptBlocks({
      toolName: 'Bash',
      toolInput: { command: 'rm -rf node_modules && npm install' },
      toolUseId: 'toolu_123',
    });
    expect(blocks.length).toBeGreaterThan(0);
    const actionBlock = blocks.find((b: any) => b.type === 'actions');
    expect(actionBlock).toBeDefined();
    const buttons = (actionBlock as any).elements;
    expect(buttons).toHaveLength(2);
  });

  it('includes tool name in the message', () => {
    const blocks = buildPermissionPromptBlocks({
      toolName: 'Edit',
      toolInput: { file_path: 'src/index.ts' },
      toolUseId: 'toolu_456',
    });
    const section = blocks.find((b: any) => b.type === 'section');
    expect((section as any).text.text).toContain('Edit');
  });

  it('truncates long input preview', () => {
    const longInput = { command: 'x'.repeat(300) };
    const blocks = buildPermissionPromptBlocks({
      toolName: 'Bash',
      toolInput: longInput,
      toolUseId: 'toolu_789',
    });
    const section = blocks.find((b: any) => b.type === 'section');
    expect((section as any).text.text.length).toBeLessThan(400);
  });
});

describe('parsePermissionAction', () => {
  it('parses approve action', () => {
    const result = parsePermissionAction('approve:toolu_123');
    expect(result).toEqual({ toolUseId: 'toolu_123', allowed: true });
  });

  it('parses deny action', () => {
    const result = parsePermissionAction('deny:toolu_123');
    expect(result).toEqual({ toolUseId: 'toolu_123', allowed: false });
  });
});
