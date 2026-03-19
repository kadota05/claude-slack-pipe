// src/slack/reaction-manager.ts
import { logger } from '../utils/logger.js';

export class ReactionManager {
  private lastDoneBySession = new Map<string, { channel: string; ts: string }>();

  constructor(private readonly client: any) {}

  async addSpawning(channel: string, timestamp: string): Promise<void> {
    await this.safeAdd(channel, timestamp, 'hourglass_flowing_sand');
  }

  async replaceWithProcessing(sessionId: string, channel: string, timestamp: string): Promise<void> {
    const lastDone = this.lastDoneBySession.get(sessionId);
    if (lastDone) {
      await this.safeRemove(lastDone.channel, lastDone.ts, 'white_check_mark');
      this.lastDoneBySession.delete(sessionId);
    }
    await this.safeRemove(channel, timestamp, 'hourglass_flowing_sand');
    await this.safeAdd(channel, timestamp, 'brain');
  }

  async replaceWithDone(sessionId: string, channel: string, timestamp: string): Promise<void> {
    await this.safeRemove(channel, timestamp, 'brain');
    await this.safeAdd(channel, timestamp, 'white_check_mark');
    this.lastDoneBySession.set(sessionId, { channel, ts: timestamp });
  }

  async removeProcessing(channel: string, timestamp: string): Promise<void> {
    await this.safeRemove(channel, timestamp, 'brain');
    await this.safeRemove(channel, timestamp, 'hourglass_flowing_sand');
  }

  async addQueued(channel: string, timestamp: string): Promise<void> {
    await this.safeAdd(channel, timestamp, 'hourglass_flowing_sand');
  }

  cleanupSession(sessionId: string): void {
    this.lastDoneBySession.delete(sessionId);
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
