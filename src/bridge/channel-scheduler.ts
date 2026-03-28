import cron from 'node-cron';
import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../utils/logger.js';

export interface ScheduleTrigger {
  name: string;
  cron: string;
  prompt: string;
}

interface ScheduleConfig {
  triggers: ScheduleTrigger[];
}

function isTooFrequent(cronExpr: string): boolean {
  const parts = cronExpr.trim().split(/\s+/);
  if (parts.length < 5) return true;
  const minuteField = parts[0];
  if (minuteField === '*' || minuteField === '*/1') return true;
  return false;
}

export class ChannelScheduler {
  private jobs = new Map<string, cron.ScheduledTask[]>();
  private channelLocks = new Map<string, boolean>();

  constructor(
    private readonly channelsDir: string,
    private readonly onTrigger: (channelId: string, trigger: ScheduleTrigger) => Promise<void>,
  ) {}

  get jobCount(): number {
    let count = 0;
    for (const tasks of this.jobs.values()) count += tasks.length;
    return count;
  }

  loadAll(): void {
    let channelIds: string[];
    try {
      channelIds = fs.readdirSync(this.channelsDir, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name);
    } catch {
      return;
    }
    for (const id of channelIds) this.loadChannel(id);
    logger.info(`Channel scheduler loaded ${this.jobCount} jobs`);
  }

  loadChannel(channelId: string): void {
    const existing = this.jobs.get(channelId);
    if (existing) {
      for (const task of existing) task.stop();
    }

    const schedulePath = path.join(this.channelsDir, channelId, 'schedule.json');
    let config: ScheduleConfig;
    try {
      config = JSON.parse(fs.readFileSync(schedulePath, 'utf-8'));
    } catch {
      this.jobs.set(channelId, []);
      return;
    }

    const tasks: cron.ScheduledTask[] = [];
    for (const trigger of config.triggers) {
      if (!cron.validate(trigger.cron)) {
        logger.warn(`Invalid cron: ${channelId}/${trigger.name}: ${trigger.cron}`);
        continue;
      }
      if (isTooFrequent(trigger.cron)) {
        logger.warn(`Trigger too frequent (min 2 min interval): ${channelId}/${trigger.name}: ${trigger.cron}`);
        continue;
      }

      const task = cron.schedule(trigger.cron, () => {
        if (this.channelLocks.get(channelId)) {
          logger.warn(`Skipping trigger ${channelId}/${trigger.name}: previous execution still running`);
          return;
        }
        this.channelLocks.set(channelId, true);
        logger.info(`Firing trigger: ${channelId}/${trigger.name}`);
        this.onTrigger(channelId, trigger)
          .catch(err => logger.error(`Trigger failed: ${channelId}/${trigger.name}`, err))
          .finally(() => this.channelLocks.set(channelId, false));
      });

      tasks.push(task);
    }
    this.jobs.set(channelId, tasks);
  }

  stopChannel(channelId: string): void {
    const existing = this.jobs.get(channelId);
    if (existing) {
      for (const task of existing) task.stop();
    }
    this.jobs.delete(channelId);
    this.channelLocks.delete(channelId);
  }

  stop(): void {
    for (const tasks of this.jobs.values()) {
      for (const task of tasks) task.stop();
    }
    this.jobs.clear();
    this.channelLocks.clear();
  }
}
