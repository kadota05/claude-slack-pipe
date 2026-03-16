// src/slack/reaction-manager.ts
import { logger } from '../utils/logger.js';

export class ReactionManager {
  constructor(private readonly client: any) {}

  async addSpawning(channel: string, timestamp: string): Promise<void> {
    await this.safeAdd(channel, timestamp, 'hourglass_flowing_sand');
  }

  async replaceWithProcessing(channel: string, timestamp: string): Promise<void> {
    await this.safeRemove(channel, timestamp, 'hourglass_flowing_sand');
    await this.safeAdd(channel, timestamp, 'brain');
  }

  async replaceWithDone(channel: string, timestamp: string): Promise<void> {
    await this.safeRemove(channel, timestamp, 'brain');
    await this.safeAdd(channel, timestamp, 'white_check_mark');
    setTimeout(async () => {
      await this.safeRemove(channel, timestamp, 'white_check_mark');
    }, 3000);
  }

  async addQueued(channel: string, timestamp: string): Promise<void> {
    await this.safeAdd(channel, timestamp, 'hourglass_flowing_sand');
  }

  private async safeAdd(channel: string, timestamp: string, name: string): Promise<void> {
    try {
      await this.client.reactions.add({ channel, timestamp, name });
    } catch (err) {
      logger.debug(`Failed to add reaction ${name}`, { error: (err as Error).message });
    }
  }

  private async safeRemove(channel: string, timestamp: string, name: string): Promise<void> {
    try {
      await this.client.reactions.remove({ channel, timestamp, name });
    } catch (err) {
      logger.debug(`Failed to remove reaction ${name}`, { error: (err as Error).message });
    }
  }
}
