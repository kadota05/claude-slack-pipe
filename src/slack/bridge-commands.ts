import type { SessionStore } from '../store/session-store.js';
import { logger } from '../utils/logger.js';

interface SlackClient {
  chat: {
    postMessage: (args: any) => Promise<any>;
    update: (args: any) => Promise<any>;
  };
}

export class BridgeCommandHandler {
  constructor(
    private readonly sessionStore: SessionStore,
    private readonly client: SlackClient,
  ) {}

  async handleHelp(channelId: string, threadTs: string): Promise<void> {
    const helpText = [
      '*Claude Code Bridge Commands*',
      '',
      '*Bridge commands:*',
      '`cc /status` - Show current session status',
      '`cc /end` - End the current session',
      '`cc /help` - Show this help message',
      '`cc /model <opus|sonnet|haiku>` - Change model',
      '`cc /rename <name>` - Rename session',
      '`cc /panel` - Toggle anchor panel',
      '',
      '*Claude Code commands (forwarded):*',
      '`cc /commit` - Create a git commit',
      '`cc /review-pr <N>` - Review a pull request',
      '`cc /compact` - Compact context',
      '`cc /clear` - Clear context',
      '`cc /diff` - Show changes',
      '`cc /<any>` - Any Claude Code slash command',
      '',
      '_Send plain text to chat with Claude Code_',
    ].join('\n');

    await this.client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text: helpText,
    });
  }

  async handleStatus(channelId: string, threadTs: string): Promise<void> {
    const session = this.sessionStore.findByThreadTs(threadTs);

    if (!session) {
      await this.client.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs,
        text: 'No active session in this thread.',
      });
      return;
    }

    const statusEmoji = session.status === 'active' ? ':large_green_circle:' : ':white_circle:';
    const statusText = [
      `${statusEmoji} *${session.name}*`,
      '',
      `*Session ID:* \`${session.sessionId.substring(0, 8)}\``,
      `*Project:* \`${session.projectPath}\``,
      `*Model:* ${session.model}`,
      `*Status:* ${session.status}`,
      `*Turns:* ${session.turnCount}`,
      `*Cost:* $${session.totalCost.toFixed(3)}`,
      `*Tokens:* ${session.totalInputTokens.toLocaleString()} in / ${session.totalOutputTokens.toLocaleString()} out`,
      `*Started:* ${session.startTime.toISOString()}`,
    ].join('\n');

    await this.client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text: statusText,
    });
  }

  async handleEnd(channelId: string, threadTs: string): Promise<void> {
    const session = this.sessionStore.findByThreadTs(threadTs);

    if (!session || session.status === 'ended') {
      await this.client.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs,
        text: 'No active session in this thread.',
      });
      return;
    }

    this.sessionStore.end(session.sessionId);

    await this.client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text: `:white_circle: Session *${session.name}* ended.\nTotal cost: $${session.totalCost.toFixed(3)} | Turns: ${session.turnCount}`,
    });

    logger.info('Session ended via cc /end', { sessionId: session.sessionId });
  }

  async dispatch(
    command: string,
    args: string | undefined,
    channelId: string,
    threadTs: string,
  ): Promise<void> {
    switch (command) {
      case 'help':
        return this.handleHelp(channelId, threadTs);
      case 'status':
        return this.handleStatus(channelId, threadTs);
      case 'end':
        return this.handleEnd(channelId, threadTs);
      case 'model':
        return this.handleModel(channelId, threadTs, args);
      case 'rename':
        return this.handleRename(channelId, threadTs, args);
      case 'panel':
        return this.handlePanel(channelId, threadTs);
      default:
        await this.client.chat.postMessage({
          channel: channelId,
          thread_ts: threadTs,
          text: `Unknown bridge command: \`${command}\`. Use \`cc /help\` for available commands.`,
        });
    }
  }

  private async handleModel(
    channelId: string,
    threadTs: string,
    args?: string,
  ): Promise<void> {
    const session = this.sessionStore.findByThreadTs(threadTs);
    if (!session) {
      await this.client.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs,
        text: 'No active session in this thread.',
      });
      return;
    }

    const validModels = ['opus', 'sonnet', 'haiku'] as const;
    const model = args?.trim().toLowerCase();
    if (!model || !validModels.includes(model as any)) {
      await this.client.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs,
        text: `Usage: \`cc /model <opus|sonnet|haiku>\`\nCurrent model: ${session.model}`,
      });
      return;
    }

    this.sessionStore.update(session.sessionId, { model: model as any });
    await this.client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text: `Model changed to *${model}*. Next message will use this model.`,
    });
  }

  private async handleRename(
    channelId: string,
    threadTs: string,
    args?: string,
  ): Promise<void> {
    const session = this.sessionStore.findByThreadTs(threadTs);
    if (!session) {
      await this.client.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs,
        text: 'No active session in this thread.',
      });
      return;
    }

    if (!args || args.trim() === '') {
      await this.client.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs,
        text: `Usage: \`cc /rename <new name>\`\nCurrent name: ${session.name}`,
      });
      return;
    }

    const newName = args.trim().substring(0, 150);
    this.sessionStore.update(session.sessionId, { name: newName });
    await this.client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text: `Session renamed to *${newName}*`,
    });
  }

  private async handlePanel(
    channelId: string,
    threadTs: string,
  ): Promise<void> {
    const session = this.sessionStore.findByThreadTs(threadTs);
    if (!session) {
      await this.client.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs,
        text: 'No active session in this thread.',
      });
      return;
    }

    const collapsed = !session.anchorCollapsed;
    this.sessionStore.update(session.sessionId, { anchorCollapsed: collapsed });
    await this.client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text: `Panel ${collapsed ? 'collapsed' : 'expanded'}.`,
    });
  }
}
