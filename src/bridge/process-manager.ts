import type { ChildProcess } from 'node:child_process';
import type { ProcessManagerConfig, ManagedProcess } from '../types.js';
import { ProcessError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

const KILL_GRACE_MS = 5_000;

export class ProcessManager {
  private readonly processes = new Map<string, ManagedProcess>();
  private readonly config: ProcessManagerConfig;

  constructor(config: ProcessManagerConfig) {
    this.config = config;
  }

  canStart(userId: string): boolean {
    const userCount = this.getUserRunningCount(userId);
    if (userCount >= this.config.maxConcurrentPerUser) {
      return false;
    }
    if (this.processes.size >= this.config.maxConcurrentGlobal) {
      return false;
    }
    return true;
  }

  register(opts: {
    sessionId: string;
    userId: string;
    channelId: string;
    projectId: string;
    process: ChildProcess;
    budgetUsd?: number;
    timeoutMs?: number;
  }): ManagedProcess {
    const timeoutMs = opts.timeoutMs ?? this.config.defaultTimeoutMs;

    const timeoutTimer = setTimeout(() => {
      this.handleTimeout(opts.sessionId, timeoutMs);
    }, timeoutMs);

    const managed: ManagedProcess = {
      sessionId: opts.sessionId,
      userId: opts.userId,
      channelId: opts.channelId,
      projectId: opts.projectId,
      process: opts.process,
      startedAt: new Date(),
      timeoutTimer,
      status: 'running',
      budgetUsd: opts.budgetUsd ?? this.config.defaultBudgetUsd,
    };

    this.processes.set(opts.sessionId, managed);

    // Auto-cleanup on process exit
    opts.process.on('exit', () => {
      this.remove(opts.sessionId);
    });

    logger.debug('Process registered', { sessionId: opts.sessionId, pid: opts.process.pid });
    return managed;
  }

  kill(sessionId: string): void {
    const managed = this.processes.get(sessionId);
    if (!managed) return;

    managed.status = 'cancelled';
    managed.process.kill('SIGTERM');

    // Schedule SIGKILL after grace period
    const killTimer = setTimeout(() => {
      if (this.processes.has(sessionId)) {
        managed.process.kill('SIGKILL');
      }
    }, KILL_GRACE_MS);

    // Don't block Node from exiting
    killTimer.unref?.();
  }

  async killAll(): Promise<void> {
    const sessionIds = [...this.processes.keys()];
    for (const sessionId of sessionIds) {
      this.kill(sessionId);
    }
  }

  getRunningCount(): number {
    return this.processes.size;
  }

  get(sessionId: string): ManagedProcess | undefined {
    return this.processes.get(sessionId);
  }

  private getUserRunningCount(userId: string): number {
    let count = 0;
    for (const managed of this.processes.values()) {
      if (managed.userId === userId) count++;
    }
    return count;
  }

  private remove(sessionId: string): void {
    const managed = this.processes.get(sessionId);
    if (!managed) return;

    clearTimeout(managed.timeoutTimer);
    this.processes.delete(sessionId);
    logger.debug('Process removed', { sessionId });
  }

  private handleTimeout(sessionId: string, timeoutMs: number): void {
    const managed = this.processes.get(sessionId);
    if (!managed) return;

    logger.warn('Process timed out', { sessionId, timeoutMs });
    managed.status = 'timed-out';
    managed.process.kill('SIGTERM');

    // SIGKILL after grace period
    const killTimer = setTimeout(() => {
      if (this.processes.has(sessionId)) {
        managed.process.kill('SIGKILL');
      }
    }, KILL_GRACE_MS);

    killTimer.unref?.();
  }
}
