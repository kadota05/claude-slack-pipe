import fs from 'node:fs';
import path from 'node:path';
import { logger } from './utils/logger.js';

const HEARTBEAT_FILE = 'heartbeat';
const INTERVAL_MS = 30_000;
const STALENESS_MS = 60_000;

export class Heartbeat {
  private readonly filePath: string;
  private intervalId: ReturnType<typeof setInterval> | null = null;

  constructor(dataDir: string) {
    this.filePath = path.join(dataDir, HEARTBEAT_FILE);
  }

  start(): void {
    this.write();
    this.intervalId = setInterval(() => this.write(), INTERVAL_MS);
    logger.info('Heartbeat started', { path: this.filePath });
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    try {
      fs.unlinkSync(this.filePath);
    } catch {
      // File may not exist
    }
    logger.info('Heartbeat stopped');
  }

  isAlive(): boolean {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf-8').trim();
      const ts = parseInt(raw, 10);
      if (isNaN(ts)) return false;
      return Date.now() - ts < STALENESS_MS;
    } catch {
      return false;
    }
  }

  private write(): void {
    try {
      fs.writeFileSync(this.filePath, String(Date.now()));
    } catch (err) {
      logger.error('Failed to write heartbeat', { error: (err as Error).message });
    }
  }
}
