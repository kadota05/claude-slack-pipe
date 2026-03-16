import { describe, it, expect } from 'vitest';
import { parseCommand } from '../../src/slack/command-parser.js';

describe('parseCommand', () => {
  it('should parse bridge commands', () => {
    expect(parseCommand('cc /status')).toEqual({
      type: 'bridge_command',
      command: 'status',
      args: undefined,
      rawText: 'cc /status',
    });

    expect(parseCommand('cc /end')).toEqual({
      type: 'bridge_command',
      command: 'end',
      args: undefined,
      rawText: 'cc /end',
    });

    expect(parseCommand('cc /help')).toEqual({
      type: 'bridge_command',
      command: 'help',
      args: undefined,
      rawText: 'cc /help',
    });
  });

  it('should parse bridge commands with args', () => {
    expect(parseCommand('cc /model opus')).toEqual({
      type: 'bridge_command',
      command: 'model',
      args: 'opus',
      rawText: 'cc /model opus',
    });

    expect(parseCommand('cc /rename my new session name')).toEqual({
      type: 'bridge_command',
      command: 'rename',
      args: 'my new session name',
      rawText: 'cc /rename my new session name',
    });
  });

  it('should parse cc /panel as bridge command', () => {
    expect(parseCommand('cc /panel')).toEqual({
      type: 'bridge_command',
      command: 'panel',
      args: undefined,
      rawText: 'cc /panel',
    });
  });

  it('should parse Claude Code forwarded commands', () => {
    expect(parseCommand('cc /commit')).toEqual({
      type: 'claude_command',
      command: 'commit',
      args: undefined,
      rawText: 'cc /commit',
    });

    expect(parseCommand('cc /review-pr 123')).toEqual({
      type: 'claude_command',
      command: 'review-pr',
      args: '123',
      rawText: 'cc /review-pr 123',
    });
  });

  it('should treat unknown cc commands as claude commands', () => {
    expect(parseCommand('cc /some-unknown-cmd arg1 arg2')).toEqual({
      type: 'claude_command',
      command: 'some-unknown-cmd',
      args: 'arg1 arg2',
      rawText: 'cc /some-unknown-cmd arg1 arg2',
    });
  });

  it('should treat plain text as plain_text type', () => {
    expect(parseCommand('implement authentication')).toEqual({
      type: 'plain_text',
      command: undefined,
      args: undefined,
      rawText: 'implement authentication',
    });
  });

  it('should handle case insensitive cc prefix', () => {
    expect(parseCommand('CC /status').type).toBe('bridge_command');
    expect(parseCommand('Cc /help').type).toBe('bridge_command');
  });

  it('should trim whitespace', () => {
    expect(parseCommand('  cc /status  ')).toEqual({
      type: 'bridge_command',
      command: 'status',
      args: undefined,
      rawText: 'cc /status',
    });
  });

  it('should handle text starting with cc but not a command', () => {
    expect(parseCommand('cc is cool')).toEqual({
      type: 'plain_text',
      command: undefined,
      args: undefined,
      rawText: 'cc is cool',
    });
  });
});
