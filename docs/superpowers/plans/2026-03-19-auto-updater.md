# Auto Updater Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** mainブランチの更新を定期検知し、アイドル時に自動で `git pull` → 再起動する仕組みを組み込む。

**Architecture:** 既存のBridgeプロセス内に `AutoUpdater` クラスを追加。30分ごとに `git fetch` でリモートをチェックし、差分があればメッセージブロック → アイドル待ち → `git pull` → `shutdown()` のフローで安全に更新する。

**Tech Stack:** TypeScript, Node.js `child_process.execSync`, vitest

**Spec:** `docs/superpowers/specs/2026-03-19-auto-updater-design.md`

---

## File Structure

| ファイル | 役割 |
|---|---|
| `src/auto-updater.ts` | 新規作成。定期チェック、更新適用、メッセージブロック判定 |
| `src/config.ts` | 変更。`autoUpdateEnabled`, `autoUpdateIntervalMs` を追加 |
| `src/index.ts` | 変更。AutoUpdater初期化、shutdown reason追加、メッセージブロック |
| `src/bridge/session-coordinator.ts` | 変更。`isAllIdle()` メソッド追加 |
| `.env.example` | 変更。設定項目追加 |
| `tests/auto-updater.test.ts` | 新規作成。AutoUpdaterのユニットテスト |
| `tests/bridge/session-coordinator.test.ts` | 変更。`isAllIdle()` のテスト追加 |
| `tests/config.test.ts` | 変更。新設定項目のテスト追加 |

---

### Task 1: config.ts に設定項目を追加

**Files:**
- Modify: `src/config.ts`
- Modify: `.env.example`
- Modify: `tests/config.test.ts`

- [ ] **Step 1: Write the failing test**

`tests/config.test.ts` に以下を追加（既存テストの動的importパターンに合わせる）:

```typescript
it('should include autoUpdateEnabled defaulting to true', async () => {
  delete process.env.AUTO_UPDATE_ENABLED;
  const { loadConfig } = await import('../src/config.js');
  const config = loadConfig();
  expect(config.autoUpdateEnabled).toBe(true);
});

it('should include autoUpdateIntervalMs defaulting to 1800000', async () => {
  delete process.env.AUTO_UPDATE_INTERVAL_MS;
  const { loadConfig } = await import('../src/config.js');
  const config = loadConfig();
  expect(config.autoUpdateIntervalMs).toBe(1800000);
});
```

既存の `beforeEach` に `delete process.env.AUTO_UPDATE_ENABLED` と `delete process.env.AUTO_UPDATE_INTERVAL_MS` を追加すること。

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/config.test.ts`
Expected: FAIL — `autoUpdateEnabled` / `autoUpdateIntervalMs` が存在しない

- [ ] **Step 3: Implement config changes**

`src/config.ts` の `configSchema` に追加:

```typescript
autoUpdateEnabled: z.boolean().default(true),
autoUpdateIntervalMs: z.number().int().positive().default(1800000),
```

`loadConfig()` の `raw` オブジェクトに追加:

```typescript
autoUpdateEnabled: process.env.AUTO_UPDATE_ENABLED !== 'false',
autoUpdateIntervalMs: Number(process.env.AUTO_UPDATE_INTERVAL_MS || '1800000'),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/config.test.ts`
Expected: PASS

- [ ] **Step 5: Update .env.example**

`.env.example` の末尾に追加:

```
# Auto Update
AUTO_UPDATE_ENABLED=true
AUTO_UPDATE_INTERVAL_MS=1800000
```

- [ ] **Step 6: Commit**

```bash
git add src/config.ts .env.example tests/config.test.ts
git commit -m "feat: add auto-update config options"
```

---

### Task 2: SessionCoordinator に isAllIdle() を追加

**Files:**
- Modify: `src/bridge/session-coordinator.ts`
- Modify: `tests/bridge/session-coordinator.test.ts`

- [ ] **Step 1: Write the failing test**

`tests/bridge/session-coordinator.test.ts` に以下を追加:

```typescript
describe('isAllIdle', () => {
  it('should return true when no sessions exist', () => {
    expect(coordinator.isAllIdle()).toBe(true);
  });

  it('should return true when all sessions are dead or idle', () => {
    // Create sessions and set their states to idle/dead
    // Then verify isAllIdle() returns true
  });

  it('should return false when any session is processing', () => {
    // Create a session in processing state
    // Then verify isAllIdle() returns false
  });
});
```

テストの具体的なセットアップは既存テストのパターン（`tests/bridge/session-coordinator.test.ts`）に合わせる。`ending` 状態のテストも含めること。

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/bridge/session-coordinator.test.ts`
Expected: FAIL — `isAllIdle` が存在しない

- [ ] **Step 3: Implement isAllIdle() and onIdleCallback**

`src/bridge/session-coordinator.ts` に追加:

```typescript
// Public callback for auto-update idle notification
onIdleCallback?: () => void;

isAllIdle(): boolean {
  for (const entry of this.entries.values()) {
    const s = entry.session.state;
    if (s === 'processing' || s === 'starting' || s === 'ending') {
      return false;
    }
  }
  return true;
}
```

`wireEvents` 内の既存 `to === 'idle'` ハンドラの末尾に追加:

```typescript
if (to === 'idle') {
  this.onIdleCallback?.();
}
```

- [ ] **Step 3b: Write test for onIdleCallback**

```typescript
describe('onIdleCallback', () => {
  it('should call onIdleCallback when session transitions to idle', () => {
    const callback = vi.fn();
    coordinator.onIdleCallback = callback;
    // Trigger session state change to idle
    // Verify callback was called
  });
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/bridge/session-coordinator.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/bridge/session-coordinator.ts tests/bridge/session-coordinator.test.ts
git commit -m "feat: add isAllIdle() to SessionCoordinator"
```

---

### Task 3: AutoUpdater コアロジック（git操作のモック付きテスト）

**Files:**
- Create: `src/auto-updater.ts`
- Create: `tests/auto-updater.test.ts`

- [ ] **Step 1: Write the failing test — constructor and start/stop**

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AutoUpdater } from '../src/auto-updater.js';

// Mock child_process.execSync
vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
}));

describe('AutoUpdater', () => {
  let mockCoordinator: any;
  let mockShutdown: any;

  beforeEach(() => {
    mockCoordinator = {
      isAllIdle: vi.fn().mockReturnValue(true),
    };
    mockShutdown = vi.fn();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('should not start polling when disabled', () => {
    const updater = new AutoUpdater({
      sessionCoordinator: mockCoordinator,
      shutdown: mockShutdown,
      interval: 1800000,
      enabled: false,
      projectRoot: '/tmp/test',
    });
    updater.start();
    expect(updater.isPendingUpdate()).toBe(false);
    updater.stop();
  });

  it('should report isPendingUpdate as false initially', () => {
    const updater = new AutoUpdater({
      sessionCoordinator: mockCoordinator,
      shutdown: mockShutdown,
      interval: 1800000,
      enabled: true,
      projectRoot: '/tmp/test',
    });
    expect(updater.isPendingUpdate()).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/auto-updater.test.ts`
Expected: FAIL — モジュールが存在しない

- [ ] **Step 3: Implement AutoUpdater skeleton**

`src/auto-updater.ts` を作成:

```typescript
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
  private readonly shutdown: (reason: string) => Promise<void>;
  private readonly interval: number;
  private readonly enabled: boolean;
  private readonly projectRoot: string;
  private timer: ReturnType<typeof setInterval> | null = null;
  private _pendingUpdate = false;

  constructor(options: AutoUpdaterOptions) {
    this.coordinator = options.sessionCoordinator;
    this.shutdown = options.shutdown;
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
      execSync('git fetch origin main', opts);
      const local = execSync('git rev-parse HEAD', opts).toString().trim();
      const remote = execSync('git rev-parse origin/main', opts).toString().trim();
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
      await this.shutdown('auto-update');
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/auto-updater.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/auto-updater.ts tests/auto-updater.test.ts
git commit -m "feat: add AutoUpdater core class"
```

---

### Task 4: AutoUpdater テスト — 更新検出・適用・ブロック

**Files:**
- Modify: `tests/auto-updater.test.ts`

- [ ] **Step 1: Write tests for update detection and apply flow**

```typescript
describe('checkForUpdate', () => {
  it('should set pendingUpdate and call shutdown when idle and update available', async () => {
    const { execSync } = await import('node:child_process');
    const mockExec = vi.mocked(execSync);

    // git fetch succeeds
    // local HEAD differs from origin/main
    mockExec
      .mockReturnValueOnce(Buffer.from('')) // git fetch
      .mockReturnValueOnce(Buffer.from('abc123')) // local HEAD
      .mockReturnValueOnce(Buffer.from('def456')) // remote HEAD
      // applyUpdate calls
      .mockReturnValueOnce(Buffer.from('abc123')) // beforeHead
      .mockReturnValueOnce(Buffer.from('')) // git pull
      .mockReturnValueOnce(Buffer.from('src/index.ts\n')); // git diff (no package-lock)

    const updater = new AutoUpdater({
      sessionCoordinator: mockCoordinator,
      shutdown: mockShutdown,
      interval: 1800000,
      enabled: true,
      projectRoot: '/tmp/test',
    });

    await updater.checkForUpdate();

    expect(mockShutdown).toHaveBeenCalledWith('auto-update');
  });

  it('should set pendingUpdate but not shutdown when sessions active', async () => {
    mockCoordinator.isAllIdle.mockReturnValue(false);

    const { execSync } = await import('node:child_process');
    const mockExec = vi.mocked(execSync);
    mockExec
      .mockReturnValueOnce(Buffer.from('')) // git fetch
      .mockReturnValueOnce(Buffer.from('abc123')) // local HEAD
      .mockReturnValueOnce(Buffer.from('def456')); // remote HEAD

    const updater = new AutoUpdater({
      sessionCoordinator: mockCoordinator,
      shutdown: mockShutdown,
      interval: 1800000,
      enabled: true,
      projectRoot: '/tmp/test',
    });

    await updater.checkForUpdate();

    expect(updater.isPendingUpdate()).toBe(true);
    expect(mockShutdown).not.toHaveBeenCalled();
  });

  it('should not set pendingUpdate when no update available', async () => {
    const { execSync } = await import('node:child_process');
    const mockExec = vi.mocked(execSync);
    mockExec
      .mockReturnValueOnce(Buffer.from('')) // git fetch
      .mockReturnValueOnce(Buffer.from('abc123')) // local HEAD
      .mockReturnValueOnce(Buffer.from('abc123')); // remote HEAD (same)

    const updater = new AutoUpdater({
      sessionCoordinator: mockCoordinator,
      shutdown: mockShutdown,
      interval: 1800000,
      enabled: true,
      projectRoot: '/tmp/test',
    });

    await updater.checkForUpdate();

    expect(updater.isPendingUpdate()).toBe(false);
    expect(mockShutdown).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify passes**

Run: `npx vitest run tests/auto-updater.test.ts`
Expected: PASS

- [ ] **Step 3: Write test for onSessionIdle**

```typescript
describe('onSessionIdle', () => {
  it('should apply update and shutdown when pending and all idle', async () => {
    // Setup: trigger checkForUpdate with sessions active
    // Then call onSessionIdle when coordinator returns isAllIdle=true
    // Verify shutdown called
  });

  it('should do nothing when no pending update', async () => {
    const updater = new AutoUpdater({ ... });
    await updater.onSessionIdle();
    expect(mockShutdown).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 4: Write test for npm install trigger**

```typescript
it('should run npm install when package-lock.json changed', async () => {
  // Setup execSync mocks where git diff includes package-lock.json
  // Verify npm install was called
});
```

- [ ] **Step 5: Run all tests**

Run: `npx vitest run tests/auto-updater.test.ts`
Expected: ALL PASS

- [ ] **Step 6: Commit**

```bash
git add tests/auto-updater.test.ts
git commit -m "test: add comprehensive AutoUpdater tests"
```

---

### Task 5: index.ts への組み込み

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Import AutoUpdater**

`src/index.ts` のimport部分に追加:

```typescript
import { AutoUpdater } from './auto-updater.js';
```

- [ ] **Step 2: Initialize and start AutoUpdater after shutdown definition**

**重要:** `shutdown` は `const` で定義されている（L998）ため、TDZ（Temporal Dead Zone）により定義前にアクセスすると `ReferenceError` になる。AutoUpdater の初期化は `shutdown` 定義の**後**に行うこと。

`shutdown` 関数定義後、`process.on('SIGTERM', ...)` の前（L1015付近）に以下を追加:

```typescript
const autoUpdater = new AutoUpdater({
  sessionCoordinator: coordinator,
  shutdown,
  interval: config.autoUpdateIntervalMs,
  enabled: config.autoUpdateEnabled,
  projectRoot: process.cwd(),
});

coordinator.onIdleCallback = () => {
  autoUpdater.onSessionIdle().catch((err) => {
    logger.warn('[AutoUpdater] onSessionIdle failed', { error: err?.message });
  });
};

autoUpdater.start();
```

- [ ] **Step 4: Add auto-update to shutdown crash-history clear**

`src/index.ts` L1008 の条件を変更:

```typescript
// Before:
if ((signal === 'restart-bridge' || signal === 'wifi-reconnect') && process.env.MANAGED_BY_LAUNCHD) {

// After:
if ((signal === 'restart-bridge' || signal === 'wifi-reconnect' || signal === 'auto-update') && process.env.MANAGED_BY_LAUNCHD) {
```

- [ ] **Step 5: Stop AutoUpdater in shutdown**

`shutdown` 関数内、`isShuttingDown = true` の直後に追加:

```typescript
autoUpdater.stop();
```

- [ ] **Step 6: Add message block check in handleMessage**

`handleMessage` 関数内、dedupチェックの後・authチェックの前（L196付近）に追加。この位置にすることで、botメッセージやIM以外のメッセージ、startedAt前のメッセージには反応せず、かつauthチェック前に更新中メッセージを返せる:

```typescript
// Block messages during auto-update
if (autoUpdater.isPendingUpdate()) {
  await app.client.chat.postMessage({
    channel: event.channel,
    thread_ts: event.thread_ts || event.ts,
    text: '🔄 システムを最新バージョンに更新中です。少々お待ちください。',
  });
  return;
}
```

**注意:** `autoUpdater` は `shutdown` 定義後に初期化されるため、`handleMessage` から参照できるスコープにあることを確認すること。必要に応じてモジュールスコープの変数やクロージャで共有する。

- [ ] **Step 8: Run full test suite**

Run: `npx vitest run`
Expected: ALL PASS

- [ ] **Step 9: Commit**

```bash
git add src/index.ts src/bridge/session-coordinator.ts
git commit -m "feat: integrate AutoUpdater into Bridge startup"
```

---

### Task 6: 動作確認と最終テスト

- [ ] **Step 1: Run lint**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 2: Run full test suite**

Run: `npx vitest run`
Expected: ALL PASS

- [ ] **Step 3: Commit any fixes**

必要に応じて修正をコミット。

- [ ] **Step 4: ユーザーにBridge再起動を依頼**

> コードを変更しました。Slackで `cc /restart-bridge` と送信して再起動してください。
