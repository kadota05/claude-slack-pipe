import { parseCommand, type ParsedCommand } from './command-parser.js';
import { logger } from '../utils/logger.js';

export interface SlackMessageEvent {
  text?: string;
  user?: string;
  channel?: string;
  ts?: string;
  thread_ts?: string;
  bot_id?: string;
  subtype?: string;
  files?: unknown[];
}

export type MessageClassification = 'command' | 'prompt' | 'ignore';

export function classifyMessage(event: SlackMessageEvent): MessageClassification {
  if (event.bot_id) return 'ignore';
  if (event.subtype && event.subtype !== 'file_share') return 'ignore';
  if ((!event.text || event.text.trim() === '') && (!event.files || event.files.length === 0)) return 'ignore';

  const parsed = parseCommand(event.text);
  if (parsed.type === 'bot_command' || parsed.type === 'passthrough') {
    return 'command';
  }

  return 'prompt';
}

export interface RoutedPrompt {
  text: string;
  userId: string;
  channelId: string;
  messageTs: string;
  threadTs: string;
}

export interface RoutedCommand {
  parsed: ParsedCommand;
  userId: string;
  channelId: string;
  messageTs: string;
  threadTs: string;
}

export interface EventRouterHandlers {
  onPrompt: (msg: RoutedPrompt) => Promise<void>;
  onCommand: (msg: RoutedCommand) => Promise<void>;
}

export class EventRouter {
  constructor(private readonly handlers: EventRouterHandlers) {}

  async handleMessage(event: SlackMessageEvent): Promise<void> {
    const classification = classifyMessage(event);

    if (classification === 'ignore') {
      logger.debug('Ignoring message', {
        user: event.user,
        botId: event.bot_id,
        subtype: event.subtype,
      });
      return;
    }

    const userId = event.user || '';
    const channelId = event.channel || '';
    const messageTs = event.ts || '';
    const threadTs = event.thread_ts || event.ts || '';

    if (classification === 'command') {
      const parsed = parseCommand(event.text!);
      await this.handlers.onCommand({
        parsed,
        userId,
        channelId,
        messageTs,
        threadTs,
      });
      return;
    }

    await this.handlers.onPrompt({
      text: event.text!,
      userId,
      channelId,
      messageTs,
      threadTs,
    });
  }
}
