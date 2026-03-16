import type { ParsedCommand } from '../types.js';

const BRIDGE_COMMANDS = new Set([
  'status',
  'end',
  'help',
  'model',
  'rename',
  'panel',
]);

const CC_COMMAND_REGEX = /^cc\s+\/(\S+)(?:\s+(.+))?$/i;

export function parseCommand(input: string): ParsedCommand {
  const trimmed = input.trim();
  const match = trimmed.match(CC_COMMAND_REGEX);

  if (!match) {
    return {
      type: 'plain_text',
      command: undefined,
      args: undefined,
      rawText: trimmed,
    };
  }

  const command = match[1].toLowerCase();
  const args = match[2]?.trim() || undefined;
  const rawText = `cc /${command}${args ? ` ${args}` : ''}`;

  if (BRIDGE_COMMANDS.has(command)) {
    return { type: 'bridge_command', command, args, rawText };
  }

  return { type: 'claude_command', command, args, rawText };
}
