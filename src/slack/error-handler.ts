import { buildErrorBlocks } from './block-builder.js';
import { BridgeError, ExecutionError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

interface SlackClient {
  chat: {
    postMessage: (args: any) => Promise<any>;
  };
}

export interface DisplayErrorParams {
  error: Error;
  channelId: string;
  threadTs: string;
  originalPromptHash?: string;
}

export class ErrorDisplayHandler {
  constructor(private readonly client: SlackClient) {}

  async displayError(params: DisplayErrorParams): Promise<void> {
    const { error, channelId, threadTs, originalPromptHash } = params;

    let errorMessage: string;
    let sessionId = 'unknown';
    let exitCode: number | null = null;

    if (error instanceof ExecutionError) {
      errorMessage = error.context.stderr as string || error.message;
      sessionId = error.context.sessionId as string || 'unknown';
      exitCode = (error.context.exitCode as number) ?? null;
    } else if (error instanceof BridgeError) {
      errorMessage = error.message;
      sessionId = (error.context.sessionId as string) || 'unknown';
    } else {
      errorMessage = error.message;
    }

    const blocks = buildErrorBlocks({
      errorMessage,
      sessionId,
      exitCode,
      originalPromptHash,
    });

    try {
      await this.client.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs,
        text: `Error: ${errorMessage}`,
        blocks,
      });
    } catch (err) {
      logger.error('Failed to display error in Slack', {
        channelId,
        threadTs,
        error: err,
      });
    }
  }
}
