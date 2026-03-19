// src/slack/command-parser.ts

const BOT_COMMANDS = new Set(['end', 'status', 'restart', 'restart-bridge']);
const BOT_COMMAND_ALIASES: Record<string, string> = { 'cli-status': 'status' };

export type ParsedCommand =
  | { type: 'bot_command'; command: string; args: string }
  | { type: 'passthrough'; content: string }
  | { type: 'plain_text'; content: string };

export function parseCommand(input: string): ParsedCommand {
  const trimmed = input.trim();

  // Check for cc / prefix or bare / prefix
  const ccMatch = trimmed.match(/^cc\s+\/(\S+)\s*(.*)/);
  const bareMatch = trimmed.match(/^\/(\S+)\s*(.*)/);

  const match = ccMatch || bareMatch;
  if (!match) {
    return { type: 'plain_text', content: trimmed };
  }

  const rawCommand = match[1];
  const args = match[2].trim();

  // Resolve aliases
  const command = BOT_COMMAND_ALIASES[rawCommand] ?? rawCommand;

  // Bot-handled commands
  if (BOT_COMMANDS.has(command)) {
    return { type: 'bot_command', command, args };
  }

  // Everything else with a slash is passthrough to CLI
  const content = `/${rawCommand}${args ? ' ' + args : ''}`;
  return { type: 'passthrough', content };
}
