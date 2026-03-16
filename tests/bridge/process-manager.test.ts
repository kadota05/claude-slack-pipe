import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { ProcessManager } from '../../src/bridge/process-manager.js';
import type { ProcessManagerConfig } from '../../src/types.js';

function createMockProcess() {
  const proc = new EventEmitter() as any;
  proc.pid = Math.floor(Math.random() * 100000);
  proc.kill = vi.fn();
  proc.stdin = null;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  return proc;
}

const defaultConfig: ProcessManagerConfig = {
  maxConcurrentPerUser: 2,
  maxConcurrentGlobal: 3,
  defaultTimeoutMs: 60_000,
  maxTimeoutMs: 300_000,
  defaultBudgetUsd: 1.0,
  maxBudgetUsd: 10.0,
};

describe('ProcessManager', () => {
  let pm: ProcessManager;

  beforeEach(() => {
    vi.useFakeTimers();
    pm = new ProcessManager(defaultConfig);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should allow starting when under limits', () => {
    expect(pm.canStart('U_USER1')).toBe(true);
  });

  it('should register a process and track it', () => {
    const proc = createMockProcess();
    const managed = pm.register({
      sessionId: 'sess-1',
      userId: 'U_USER1',
      channelId: 'C_CH1',
      projectId: 'proj-1',
      process: proc,
    });

    expect(managed.sessionId).toBe('sess-1');
    expect(managed.status).toBe('running');
    expect(pm.getRunningCount()).toBe(1);
  });

  it('should enforce per-user concurrency limit', () => {
    for (let i = 0; i < 2; i++) {
      const proc = createMockProcess();
      pm.register({
        sessionId: `sess-user-${i}`,
        userId: 'U_USER1',
        channelId: 'C_CH1',
        projectId: 'proj-1',
        process: proc,
      });
    }

    expect(pm.canStart('U_USER1')).toBe(false);
    // A different user should still be allowed
    expect(pm.canStart('U_USER2')).toBe(true);
  });

  it('should enforce global concurrency limit', () => {
    for (let i = 0; i < 3; i++) {
      const proc = createMockProcess();
      pm.register({
        sessionId: `sess-global-${i}`,
        userId: `U_USER${i}`,
        channelId: 'C_CH1',
        projectId: 'proj-1',
        process: proc,
      });
    }

    expect(pm.canStart('U_NEW_USER')).toBe(false);
    expect(pm.getRunningCount()).toBe(3);
  });

  it('should remove process on exit event', () => {
    const proc = createMockProcess();
    pm.register({
      sessionId: 'sess-exit',
      userId: 'U_USER1',
      channelId: 'C_CH1',
      projectId: 'proj-1',
      process: proc,
    });

    expect(pm.getRunningCount()).toBe(1);

    proc.emit('exit', 0);

    expect(pm.getRunningCount()).toBe(0);
    expect(pm.get('sess-exit')).toBeUndefined();
  });

  it('should send SIGTERM on timeout', () => {
    const proc = createMockProcess();
    pm.register({
      sessionId: 'sess-timeout',
      userId: 'U_USER1',
      channelId: 'C_CH1',
      projectId: 'proj-1',
      process: proc,
      timeoutMs: 10_000,
    });

    vi.advanceTimersByTime(10_000);

    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
    expect(pm.get('sess-timeout')!.status).toBe('timed-out');
  });

  it('should send SIGKILL after grace period on timeout', () => {
    const proc = createMockProcess();
    pm.register({
      sessionId: 'sess-timeout-kill',
      userId: 'U_USER1',
      channelId: 'C_CH1',
      projectId: 'proj-1',
      process: proc,
      timeoutMs: 10_000,
    });

    // Trigger timeout
    vi.advanceTimersByTime(10_000);
    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');

    // Advance past grace period
    vi.advanceTimersByTime(5_000);
    expect(proc.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('should kill a specific session', () => {
    const proc = createMockProcess();
    pm.register({
      sessionId: 'sess-kill',
      userId: 'U_USER1',
      channelId: 'C_CH1',
      projectId: 'proj-1',
      process: proc,
    });

    pm.kill('sess-kill');

    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
    expect(pm.get('sess-kill')!.status).toBe('cancelled');

    // After grace period, SIGKILL
    vi.advanceTimersByTime(5_000);
    expect(proc.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('should kill all running processes', async () => {
    const procs: any[] = [];
    for (let i = 0; i < 3; i++) {
      const proc = createMockProcess();
      procs.push(proc);
      pm.register({
        sessionId: `sess-killall-${i}`,
        userId: `U_USER${i}`,
        channelId: 'C_CH1',
        projectId: 'proj-1',
        process: proc,
      });
    }

    await pm.killAll();

    for (const proc of procs) {
      expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
    }
  });
});
