import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { logger } from './utils/logger.js';
import type { SessionCoordinator } from './bridge/session-coordinator.js';

interface AutoUpdaterOptions {
  sessionCoordinator: SessionCoordinator;
  shutdown: (reason: string) => Promise<void>;
  interval: number;
  enabled: boolean;
  projectRoot: string;
}

export class AutoUpdater {
  private readonly coordinator: SessionCoordinator;
  private readonly shutdownFn: (reason: string) => Promise<void>;
  private readonly interval: number;
  private readonly enabled: boolean;
  private readonly projectRoot: string;
  private timer: ReturnType<typeof setInterval> | null = null;
  private _pendingUpdate = false;

  constructor(options: AutoUpdaterOptions) {
    this.coordinator = options.sessionCoordinator;
    this.shutdownFn = options.shutdown;
    this.interval = options.interval;
    this.enabled = options.enabled;
    this.projectRoot = options.projectRoot;
  }

  start(): void {
    if (!this.enabled) {
      logger.info('[AutoUpdater] Auto-update is disabled');
      return;
    }

    if (!this.isOnMainBranch()) {
      logger.warn('[AutoUpdater] Not on main branch, auto-update disabled');
      return;
    }

    logger.info(`[AutoUpdater] Starting with interval ${this.interval}ms`);
    this.timer = setInterval(() => {
      this.checkForUpdate().catch((err) => {
        logger.warn('[AutoUpdater] Check failed', { error: err?.message || err });
      });
    }, this.interval);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  isPendingUpdate(): boolean {
    return this._pendingUpdate;
  }

  async onSessionIdle(): Promise<void> {
    if (!this._pendingUpdate) return;
    if (!this.coordinator.isAllIdle()) return;

    await this.applyUpdate();
  }

  async checkForUpdate(): Promise<void> {
    const hasUpdate = this.fetchAndCompare();
    if (!hasUpdate) {
      logger.debug('[AutoUpdater] No updates available');
      return;
    }

    logger.info('[AutoUpdater] Update detected');
    this._pendingUpdate = true;

    if (this.coordinator.isAllIdle()) {
      await this.applyUpdate();
    } else {
      logger.info('[AutoUpdater] Sessions active, waiting for idle');
    }
  }

  private fetchAndCompare(): boolean {
    try {
      const opts = { cwd: this.projectRoot, timeout: 60_000 };
      logger.info('[AutoUpdater] Running fetchAndCompare', { cwd: this.projectRoot });
      execSync('git fetch origin main', opts);
      const local = execSync('git rev-parse HEAD', opts).toString().trim();
      const remote = execSync('git rev-parse origin/main', opts).toString().trim();
      logger.info('[AutoUpdater] Compare result', { local: local.slice(0, 7), remote: remote.slice(0, 7), hasUpdate: local !== remote });
      return local !== remote;
    } catch (err: any) {
      logger.warn('[AutoUpdater] git fetch failed', { error: err?.message });
      return false;
    }
  }

  private async applyUpdate(): Promise<void> {
    try {
      const opts = { cwd: this.projectRoot, timeout: 60_000 };

      this.cleanGitLocks();

      const beforeHead = execSync('git rev-parse HEAD', opts).toString().trim();

      logger.info('[AutoUpdater] Running git pull origin main');
      execSync('git pull origin main', opts);

      // Check if package-lock.json changed
      const changedFiles = execSync(
        `git diff ${beforeHead} HEAD --name-only`,
        opts,
      ).toString();

      if (changedFiles.includes('package-lock.json')) {
        logger.info('[AutoUpdater] package-lock.json changed, running npm install');
        execSync('npm install', { cwd: this.projectRoot, timeout: 120_000 });
      }

      logger.info('[AutoUpdater] Update applied, shutting down for restart');
      await this.shutdownFn('auto-update');
    } catch (err: any) {
      logger.warn('[AutoUpdater] Update failed, skipping', { error: err?.message });
      this._pendingUpdate = false;
    }
  }

  private cleanGitLocks(): void {
    const lockFile = path.join(this.projectRoot, '.git', 'index.lock');
    try {
      if (fs.existsSync(lockFile)) {
        fs.unlinkSync(lockFile);
        logger.info('[AutoUpdater] Removed stale .git/index.lock');
      }
    } catch { /* best-effort */ }
  }

  private isOnMainBranch(): boolean {
    try {
      const branch = execSync('git rev-parse --abbrev-ref HEAD', {
        cwd: this.projectRoot,
      }).toString().trim();
      return branch === 'main';
    } catch {
      return false;
    }
  }
}
