// tests/auto-updater.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import fs from 'node:fs';

vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
}));

vi.mock('node:fs', () => ({
  default: {
    existsSync: vi.fn(),
    unlinkSync: vi.fn(),
  },
}));

vi.mock('../src/utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
}));

import { AutoUpdater } from '../src/auto-updater.js';

const PROJECT_ROOT = '/fake/project';
const LOCAL_HASH = 'aaaa1111';
const REMOTE_HASH = 'bbbb2222';

function makeCoordinator(allIdle = true) {
  return {
    isAllIdle: vi.fn().mockReturnValue(allIdle),
    onIdleCallback: undefined as (() => void) | undefined,
  };
}

function makeShutdown() {
  return vi.fn().mockResolvedValue(undefined);
}

function makeUpdater(overrides: {
  enabled?: boolean;
  allIdle?: boolean;
  interval?: number;
} = {}) {
  const coordinator = makeCoordinator(overrides.allIdle ?? true);
  const shutdown = makeShutdown();
  const updater = new AutoUpdater({
    sessionCoordinator: coordinator as any,
    shutdown,
    interval: overrides.interval ?? 1800000,
    enabled: overrides.enabled ?? true,
    projectRoot: PROJECT_ROOT,
  });
  return { updater, coordinator, shutdown };
}

// Helper: mock execSync for isOnMainBranch returning 'main'
function mockOnMainBranch() {
  vi.mocked(execSync).mockReturnValueOnce(Buffer.from('main\n'));
}

// Helper: mock execSync sequence for fetchAndCompare with update available
function mockFetchWithUpdate() {
  vi.mocked(execSync)
    .mockReturnValueOnce(Buffer.from(''))                  // git fetch origin main
    .mockReturnValueOnce(Buffer.from(`${LOCAL_HASH}\n`))  // git rev-parse HEAD (local)
    .mockReturnValueOnce(Buffer.from(`${REMOTE_HASH}\n`)); // git rev-parse origin/main
}

// Helper: mock execSync sequence for fetchAndCompare with no update (same hash)
function mockFetchNoUpdate() {
  vi.mocked(execSync)
    .mockReturnValueOnce(Buffer.from(''))                  // git fetch origin main
    .mockReturnValueOnce(Buffer.from(`${LOCAL_HASH}\n`))  // git rev-parse HEAD
    .mockReturnValueOnce(Buffer.from(`${LOCAL_HASH}\n`)); // git rev-parse origin/main (same)
}

// Helper: mock applyUpdate sequence (after fetchAndCompare already consumed mocks)
function mockApplyUpdate(changedFiles: string) {
  vi.mocked(execSync)
    .mockReturnValueOnce(Buffer.from(`${LOCAL_HASH}\n`))  // git rev-parse HEAD (beforeHead)
    .mockReturnValueOnce(Buffer.from(''))                  // git pull origin main
    .mockReturnValueOnce(Buffer.from(changedFiles));       // git diff HEAD --name-only
}

describe('AutoUpdater', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(execSync).mockReset();
    vi.mocked(fs.existsSync).mockReset();
    vi.mocked(fs.unlinkSync).mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('constructor / start / stop', () => {
    it('should not start polling when disabled', () => {
      const { updater } = makeUpdater({ enabled: false });
      updater.start();
      // No execSync calls because disabled check returns early
      expect(vi.mocked(execSync)).not.toHaveBeenCalled();
    });

    it('should not start polling when not on main branch', () => {
      vi.mocked(execSync).mockReturnValueOnce(Buffer.from('feat/some-branch\n'));
      const { updater } = makeUpdater({ enabled: true });
      updater.start();
      // Only one execSync call for branch check
      expect(vi.mocked(execSync)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(execSync)).toHaveBeenCalledWith(
        'git rev-parse --abbrev-ref HEAD',
        expect.objectContaining({ cwd: PROJECT_ROOT }),
      );
    });

    it('isPendingUpdate returns false initially', () => {
      const { updater } = makeUpdater();
      expect(updater.isPendingUpdate()).toBe(false);
    });

    it('should start polling when enabled and on main branch', () => {
      mockOnMainBranch();
      const { updater } = makeUpdater({ enabled: true, interval: 5000 });
      updater.start();
      expect(vi.mocked(execSync)).toHaveBeenCalledWith(
        'git rev-parse --abbrev-ref HEAD',
        expect.objectContaining({ cwd: PROJECT_ROOT }),
      );
    });

    it('stop clears the interval timer', () => {
      mockOnMainBranch();
      // Mock fetch check to return no update so we don't trigger applyUpdate
      mockFetchNoUpdate();
      const { updater } = makeUpdater({ enabled: true, interval: 5000 });
      updater.start();
      updater.stop();
      // After stop, advancing timers should not trigger more execSync calls
      const callCountAfterStop = vi.mocked(execSync).mock.calls.length;
      vi.advanceTimersByTime(10000);
      expect(vi.mocked(execSync).mock.calls.length).toBe(callCountAfterStop);
    });
  });

  describe('checkForUpdate', () => {
    it('should call shutdown when idle and update available', async () => {
      mockFetchWithUpdate();
      mockApplyUpdate('src/index.ts\n');
      vi.mocked(fs.existsSync).mockReturnValue(false);

      const { updater, shutdown } = makeUpdater({ allIdle: true });
      await updater.checkForUpdate();

      expect(updater.isPendingUpdate()).toBe(true);
      expect(shutdown).toHaveBeenCalledWith('auto-update');
    });

    it('should set pendingUpdate but not shutdown when sessions active', async () => {
      mockFetchWithUpdate();

      const { updater, coordinator, shutdown } = makeUpdater({ allIdle: false });
      await updater.checkForUpdate();

      expect(updater.isPendingUpdate()).toBe(true);
      expect(shutdown).not.toHaveBeenCalled();
    });

    it('should not set pendingUpdate when no update (same HEADs)', async () => {
      mockFetchNoUpdate();

      const { updater, shutdown } = makeUpdater({ allIdle: true });
      await updater.checkForUpdate();

      expect(updater.isPendingUpdate()).toBe(false);
      expect(shutdown).not.toHaveBeenCalled();
    });

    it('should handle git fetch failure gracefully', async () => {
      vi.mocked(execSync).mockImplementationOnce(() => {
        throw new Error('git fetch failed: network error');
      });

      const { updater, shutdown } = makeUpdater({ allIdle: true });
      await expect(updater.checkForUpdate()).resolves.not.toThrow();

      expect(updater.isPendingUpdate()).toBe(false);
      expect(shutdown).not.toHaveBeenCalled();
    });
  });

  describe('onSessionIdle', () => {
    it('should apply update and shutdown when pending and all idle', async () => {
      mockFetchWithUpdate();
      mockApplyUpdate('package.json\n');
      vi.mocked(fs.existsSync).mockReturnValue(false);

      const { updater, coordinator, shutdown } = makeUpdater({ allIdle: false });
      // First trigger checkForUpdate with sessions active to set pendingUpdate
      await updater.checkForUpdate();
      expect(updater.isPendingUpdate()).toBe(true);
      expect(shutdown).not.toHaveBeenCalled();

      // Now sessions become idle
      coordinator.isAllIdle.mockReturnValue(true);
      // Mock applyUpdate calls (git rev-parse HEAD, git pull, git diff)
      vi.mocked(execSync)
        .mockReturnValueOnce(Buffer.from(`${LOCAL_HASH}\n`)) // beforeHead
        .mockReturnValueOnce(Buffer.from(''))                 // git pull
        .mockReturnValueOnce(Buffer.from('package.json\n'));  // git diff

      await updater.onSessionIdle();
      expect(shutdown).toHaveBeenCalledWith('auto-update');
    });

    it('should do nothing when no pending update', async () => {
      const { updater, shutdown } = makeUpdater({ allIdle: true });
      expect(updater.isPendingUpdate()).toBe(false);

      await updater.onSessionIdle();

      expect(shutdown).not.toHaveBeenCalled();
      expect(vi.mocked(execSync)).not.toHaveBeenCalled();
    });

    it('should do nothing when not all idle', async () => {
      mockFetchWithUpdate();

      const { updater, coordinator, shutdown } = makeUpdater({ allIdle: false });
      await updater.checkForUpdate();
      expect(updater.isPendingUpdate()).toBe(true);

      // Still not idle
      coordinator.isAllIdle.mockReturnValue(false);
      const callsBefore = vi.mocked(execSync).mock.calls.length;

      await updater.onSessionIdle();

      expect(shutdown).not.toHaveBeenCalled();
      // No additional execSync calls
      expect(vi.mocked(execSync).mock.calls.length).toBe(callsBefore);
    });
  });

  describe('applyUpdate internals', () => {
    it('should run npm install when package-lock.json changed in git diff output', async () => {
      mockFetchWithUpdate();
      vi.mocked(fs.existsSync).mockReturnValue(false);
      vi.mocked(execSync)
        .mockReturnValueOnce(Buffer.from(`${LOCAL_HASH}\n`))            // beforeHead
        .mockReturnValueOnce(Buffer.from(''))                             // git pull
        .mockReturnValueOnce(Buffer.from('package-lock.json\nsrc/x.ts\n')) // git diff
        .mockReturnValueOnce(Buffer.from(''));                             // npm install

      const { updater, shutdown } = makeUpdater({ allIdle: true });
      await updater.checkForUpdate();

      const calls = vi.mocked(execSync).mock.calls.map((c) => c[0] as string);
      expect(calls).toContain('npm install');
      expect(shutdown).toHaveBeenCalledWith('auto-update');
    });

    it('should NOT run npm install when package-lock.json NOT in git diff output', async () => {
      mockFetchWithUpdate();
      vi.mocked(fs.existsSync).mockReturnValue(false);
      vi.mocked(execSync)
        .mockReturnValueOnce(Buffer.from(`${LOCAL_HASH}\n`))  // beforeHead
        .mockReturnValueOnce(Buffer.from(''))                   // git pull
        .mockReturnValueOnce(Buffer.from('src/index.ts\n'));    // git diff (no package-lock)

      const { updater, shutdown } = makeUpdater({ allIdle: true });
      await updater.checkForUpdate();

      const calls = vi.mocked(execSync).mock.calls.map((c) => c[0] as string);
      expect(calls).not.toContain('npm install');
      expect(shutdown).toHaveBeenCalledWith('auto-update');
    });

    it('should clean git locks before pulling', async () => {
      mockFetchWithUpdate();
      vi.mocked(fs.existsSync).mockReturnValue(true); // lock file exists
      vi.mocked(execSync)
        .mockReturnValueOnce(Buffer.from(`${LOCAL_HASH}\n`)) // beforeHead
        .mockReturnValueOnce(Buffer.from(''))                  // git pull
        .mockReturnValueOnce(Buffer.from('src/x.ts\n'));       // git diff

      const { updater } = makeUpdater({ allIdle: true });
      await updater.checkForUpdate();

      expect(vi.mocked(fs.existsSync)).toHaveBeenCalledWith(
        expect.stringContaining('index.lock'),
      );
      expect(vi.mocked(fs.unlinkSync)).toHaveBeenCalledWith(
        expect.stringContaining('index.lock'),
      );
    });

    it('should NOT remove lock file when it does not exist', async () => {
      mockFetchWithUpdate();
      vi.mocked(fs.existsSync).mockReturnValue(false); // no lock file
      vi.mocked(execSync)
        .mockReturnValueOnce(Buffer.from(`${LOCAL_HASH}\n`)) // beforeHead
        .mockReturnValueOnce(Buffer.from(''))                  // git pull
        .mockReturnValueOnce(Buffer.from('src/x.ts\n'));       // git diff

      const { updater } = makeUpdater({ allIdle: true });
      await updater.checkForUpdate();

      expect(vi.mocked(fs.unlinkSync)).not.toHaveBeenCalled();
    });

    it('should reset pendingUpdate on failure', async () => {
      mockFetchWithUpdate();
      vi.mocked(fs.existsSync).mockReturnValue(false);
      // git rev-parse HEAD (beforeHead) succeeds, then git pull throws
      vi.mocked(execSync)
        .mockReturnValueOnce(Buffer.from(`${LOCAL_HASH}\n`)) // beforeHead
        .mockImplementationOnce(() => {
          throw new Error('git pull failed: conflict');
        });

      const { updater, shutdown } = makeUpdater({ allIdle: true });
      await updater.checkForUpdate();

      expect(updater.isPendingUpdate()).toBe(false);
      expect(shutdown).not.toHaveBeenCalled();
    });
  });
});
