import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ChannelScheduler, type ScheduleTrigger } from '../../src/bridge/channel-scheduler.js';

describe('ChannelScheduler', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scheduler-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeSchedule(channelId: string, triggers: ScheduleTrigger[]) {
    const dir = path.join(tmpDir, 'channels', channelId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'schedule.json'), JSON.stringify({ triggers }));
  }

  describe('loadAll', () => {
    it('loads triggers from all channels', () => {
      writeSchedule('C_AAA', [{ name: 'daily', cron: '0 9 * * *', prompt: 'Report' }]);
      writeSchedule('C_BBB', [{ name: 'weekly', cron: '0 17 * * 5', prompt: 'Review' }]);

      const scheduler = new ChannelScheduler(path.join(tmpDir, 'channels'), async () => {});
      scheduler.loadAll();
      expect(scheduler.jobCount).toBe(2);
      scheduler.stop();
    });

    it('handles empty triggers', () => {
      writeSchedule('C_AAA', []);
      const scheduler = new ChannelScheduler(path.join(tmpDir, 'channels'), async () => {});
      scheduler.loadAll();
      expect(scheduler.jobCount).toBe(0);
      scheduler.stop();
    });

    it('handles missing directory', () => {
      const scheduler = new ChannelScheduler(path.join(tmpDir, 'nonexistent'), async () => {});
      scheduler.loadAll();
      expect(scheduler.jobCount).toBe(0);
      scheduler.stop();
    });

    it('rejects triggers with interval less than 1 minute', () => {
      writeSchedule('C_AAA', [{ name: 'spam', cron: '* * * * *', prompt: 'Too fast' }]);
      const scheduler = new ChannelScheduler(path.join(tmpDir, 'channels'), async () => {});
      scheduler.loadAll();
      expect(scheduler.jobCount).toBe(0);
      scheduler.stop();
    });
  });

  describe('loadChannel / stopChannel', () => {
    it('replaces existing jobs', () => {
      writeSchedule('C_AAA', [{ name: 'daily', cron: '0 9 * * *', prompt: 'Report' }]);
      const scheduler = new ChannelScheduler(path.join(tmpDir, 'channels'), async () => {});

      scheduler.loadChannel('C_AAA');
      expect(scheduler.jobCount).toBe(1);

      writeSchedule('C_AAA', [
        { name: 'daily', cron: '0 9 * * *', prompt: 'Report' },
        { name: 'weekly', cron: '0 17 * * 5', prompt: 'Review' },
      ]);
      scheduler.loadChannel('C_AAA');
      expect(scheduler.jobCount).toBe(2);
      scheduler.stop();
    });

    it('stopChannel removes all jobs for a channel', () => {
      writeSchedule('C_AAA', [{ name: 'daily', cron: '0 9 * * *', prompt: 'Report' }]);
      writeSchedule('C_BBB', [{ name: 'weekly', cron: '0 17 * * 5', prompt: 'Review' }]);

      const scheduler = new ChannelScheduler(path.join(tmpDir, 'channels'), async () => {});
      scheduler.loadAll();
      expect(scheduler.jobCount).toBe(2);

      scheduler.stopChannel('C_AAA');
      expect(scheduler.jobCount).toBe(1);
      scheduler.stop();
    });
  });
});
