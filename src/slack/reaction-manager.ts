import { logger } from '../utils/logger.js';

interface SlackClient {
  reactions: {
    add: (args: { channel: string; timestamp: string; name: string }) => Promise<any>;
    remove: (args: { channel: string; timestamp: string; name: string }) => Promise<any>;
  };
}

const EMOJI_PROCESSING = 'hourglass_flowing_sand';
const EMOJI_SUCCESS = 'white_check_mark';
const EMOJI_ERROR = 'x';
const EMOJI_WARNING = 'warning';

export class ReactionManager {
  constructor(private readonly client: SlackClient) {}

  async addProcessing(channel: string, timestamp: string): Promise<void> {
    await this.safeAdd(channel, timestamp, EMOJI_PROCESSING);
  }

  async replaceWithSuccess(channel: string, timestamp: string): Promise<void> {
    await this.safeRemove(channel, timestamp, EMOJI_PROCESSING);
    await this.safeAdd(channel, timestamp, EMOJI_SUCCESS);
  }

  async replaceWithError(channel: string, timestamp: string): Promise<void> {
    await this.safeRemove(channel, timestamp, EMOJI_PROCESSING);
    await this.safeAdd(channel, timestamp, EMOJI_ERROR);
  }

  async replaceWithWarning(channel: string, timestamp: string): Promise<void> {
    await this.safeRemove(channel, timestamp, EMOJI_PROCESSING);
    await this.safeAdd(channel, timestamp, EMOJI_WARNING);
  }

  private async safeAdd(
    channel: string,
    timestamp: string,
    name: string,
  ): Promise<void> {
    try {
      await this.client.reactions.add({ channel, timestamp, name });
    } catch (err) {
      logger.debug('Failed to add reaction', { channel, timestamp, name, error: err });
    }
  }

  private async safeRemove(
    channel: string,
    timestamp: string,
    name: string,
  ): Promise<void> {
    try {
      await this.client.reactions.remove({ channel, timestamp, name });
    } catch (err) {
      logger.debug('Failed to remove reaction', { channel, timestamp, name, error: err });
    }
  }
}
