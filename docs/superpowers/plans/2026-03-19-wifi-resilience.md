# WiFi Resilience Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** WiFi切断時にBridgeが自動的に復帰し、切断/復帰をユーザーに通知する。

**Architecture:** macOSの`scutil`子プロセスでネットワーク変化をイベント駆動で検知。切断時はbest-effortで通知、復帰時はlaunchd経由でプロセスを再起動。起動前に送られたメッセージは`startedAt`タイムスタンプで破棄。

**Tech Stack:** TypeScript, Node.js child_process, macOS scutil, Slack Bolt

**Spec:** `docs/superpowers/specs/2026-03-19-wifi-resilience-design.md`

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `src/utils/network-watcher.ts` | Create | scutil子プロセス管理、デバウンス、disconnected/reconnectedイベント |
| `src/index.ts` | Modify | NetworkWatcher統合、通知、ギャップ破棄、unhandledRejection、restart-pending拡張 |

**Task dependencies:** Task 1 → Task 2 → Task 3 → Task 4 → Task 5 → Task 6（順序通り実行）

**Note:** 既存の `cc /restart-bridge` コマンドは旧形式（単一オブジェクト）で `restart-pending.json` を書き込む。Task 4 の後方互換ロジックでそのまま動作するため、書き込み側は変更しない。

---

### Task 1: NetworkWatcher — scutilベースのネットワーク変化検知

**Files:**
- Create: `src/utils/network-watcher.ts`

- [ ] **Step 1: Create NetworkWatcher class**

```typescript
// src/utils/network-watcher.ts
import { spawn, type ChildProcess } from 'node:child_process';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { logger } from './logger.js';

/**
 * Watches for macOS network state changes using scutil.
 * Emits 'disconnected' when all external IPs disappear.
 * Emits 'reconnected' when an external IP appears.
 */
export class NetworkWatcher extends EventEmitter {
  private proc: ChildProcess | null = null;
  private stopped = false;
  private restartCount = 0;
  private restartWindowStart = 0;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private lastState: 'connected' | 'disconnected' | null = null;

  start(): void {
    if (this.proc || this.stopped) return;
    this.spawnScutil();
    // Set initial state without emitting
    this.lastState = this.hasExternalIP() ? 'connected' : 'disconnected';
    logger.info(`[NetworkWatcher] Started, initial state: ${this.lastState}`);
  }

  stop(): void {
    this.stopped = true;
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.proc) {
      this.proc.kill();
      this.proc = null;
    }
  }

  private spawnScutil(): void {
    this.proc = spawn('/usr/sbin/scutil', [], {
      stdio: ['pipe', 'pipe', 'ignore'],
    });

    this.proc.stdin!.write('n.add State:/Network/Global/IPv4\n');
    this.proc.stdin!.write('n.add State:/Network/Global/IPv6\n');
    this.proc.stdin!.write('n.watch\n');

    this.proc.stdout!.on('data', (data: Buffer) => {
      const text = data.toString();
      if (text.includes('changed key')) {
        this.onNetworkChange();
      }
    });

    this.proc.on('exit', (code) => {
      this.proc = null;
      if (this.stopped) return;

      // Rate-limit restarts: max 5 per minute
      const now = Date.now();
      if (now - this.restartWindowStart > 60_000) {
        this.restartCount = 0;
        this.restartWindowStart = now;
      }
      this.restartCount++;

      if (this.restartCount > 5) {
        logger.error(`[NetworkWatcher] scutil restarted too many times, disabling`);
        return;
      }

      logger.warn(`[NetworkWatcher] scutil exited (code ${code}), restarting in 1s`);
      setTimeout(() => this.spawnScutil(), 1000);
    });
  }

  private onNetworkChange(): void {
    // Debounce: wait 5s for stability before emitting
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      const hasIP = this.hasExternalIP();
      const newState = hasIP ? 'connected' : 'disconnected';

      if (newState === this.lastState) return; // No actual change
      this.lastState = newState;

      if (newState === 'disconnected') {
        logger.warn('[NetworkWatcher] Network disconnected');
        this.emit('disconnected');
      } else {
        logger.info('[NetworkWatcher] Network reconnected');
        this.emit('reconnected');
      }
    }, 5000);
  }

  private hasExternalIP(): boolean {
    const ifaces = os.networkInterfaces();
    for (const addrs of Object.values(ifaces)) {
      if (!addrs) continue;
      for (const addr of addrs) {
        if (!addr.internal && addr.family === 'IPv4') return true;
      }
    }
    return false;
  }
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/utils/network-watcher.ts
git commit -m "feat: add NetworkWatcher with scutil-based network change detection"
```

---

### Task 2: ギャップメッセージ破棄 — 起動前メッセージの無視

**Files:**
- Modify: `src/index.ts` — `main()`関数の先頭付近と`handleMessage()`

- [ ] **Step 1: Add startedAt and filter in handleMessage**

`src/index.ts`の`main()`内、`const config = loadConfig();`の直後に追加:

```typescript
// Record startup time for gap message filtering
// Messages sent before this time (during process downtime) will be ignored.
const startedAt = Date.now() / 1000; // Slack ts format (seconds since epoch)
```

`handleMessage()`内、`if (event.bot_id || event.subtype)` チェック（151行目）の直後、`const userId = event.user;`（153行目）の前に追加:

```typescript
// Drop messages sent before this process started (e.g. during WiFi outage, crash)
if (parseFloat(event.ts) < startedAt) {
  logger.info('[Resilience] Dropping message from before process start', {
    ts: event.ts, startedAt,
  });
  return;
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat: drop messages sent before process startup"
```

---

### Task 3: crash防止 — unhandledRejection handler

**Files:**
- Modify: `src/index.ts` — `app.start()`成功後のセクション

- [ ] **Step 1: Add unhandledRejection handler**

`src/index.ts`の`await startApp(app);`と`logger.info('Claude Code Slack Bridge is running (Phase 2)');`の直後に追加:

```typescript
// Prevent Slack SDK's reconnection failure from crashing the process.
// When WiFi drops, the SDK's internal reconnect throws RequestError as
// an unhandled rejection. We catch it here to keep the process alive
// until NetworkWatcher detects WiFi recovery and triggers a clean restart.
let isShuttingDown = false;
process.on('unhandledRejection', (reason: unknown) => {
  if (isShuttingDown) return;
  logger.error('[Resilience] Unhandled rejection caught (crash prevented)', {
    error: reason instanceof Error ? reason.message : String(reason),
  });
});
```

shutdown関数内の先頭に`isShuttingDown = true;`を追加。また、crash history クリアの条件を拡張:

```typescript
if ((signal === 'restart-bridge' || signal === 'wifi-reconnect') && process.env.MANAGED_BY_LAUNCHD) {
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat: catch unhandled rejections to prevent SDK crash"
```

---

### Task 4: restart-pending.json の複数メッセージ対応

**Files:**
- Modify: `src/index.ts` — restart-pending.json読み込みロジック（880〜894行付近）

- [ ] **Step 1: Extend restart-pending.json reader for array format**

現在のコード（`restartPendingFile`読み込み部分）を以下に置き換え:

```typescript
// Update restart message if pending
const restartPendingFile = path.join(os.homedir(), '.claude-slack-pipe', 'restart-pending.json');
try {
  if (fs.existsSync(restartPendingFile)) {
    const raw = JSON.parse(fs.readFileSync(restartPendingFile, 'utf-8'));
    fs.unlinkSync(restartPendingFile);

    // Support both old format ({ channel, ts }) and new format ({ messages: [...] })
    const messages: Array<{ channel: string; ts: string }> =
      raw.messages ? raw.messages : [raw];

    for (const pending of messages) {
      if (!pending.channel || !pending.ts) continue;
      try {
        await app.client.chat.update({
          channel: pending.channel,
          ts: pending.ts,
          text: '✅ Bridgeの再起動が完了しました',
        });
      } catch (err) {
        logger.warn('Failed to update restart message', {
          channel: pending.channel, ts: pending.ts,
          error: (err as Error).message,
        });
      }
    }
  }
} catch (err) {
  logger.warn('Failed to process restart-pending file', { error: (err as Error).message });
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat: support multiple messages in restart-pending.json"
```

---

### Task 5: NetworkWatcher統合 — 切断/復帰ハンドラ

**Files:**
- Modify: `src/index.ts` — import追加、shutdown前のセクション

- [ ] **Step 1: Add import**

`src/index.ts`の先頭importセクションに追加:

```typescript
import { NetworkWatcher } from './utils/network-watcher.js';
```

- [ ] **Step 2: Add NetworkWatcher integration after app.start()**

`unhandledRejection`ハンドラの後、shutdown関数の前に以下を追加:

```typescript
// --- WiFi resilience: auto-reconnect on network change ---
const networkWatcher = new NetworkWatcher();

// Track which threads received disconnect notifications (for reconnect updates)
const disconnectNotifiedThreads: Array<{ channel: string; threadTs: string }> = [];

networkWatcher.on('disconnected', async () => {
  if (isShuttingDown) return;
  logger.warn('[Resilience] WiFi disconnected, notifying active sessions');

  // Notify recently active sessions (within 10 minutes)
  const cutoff = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const recentSessions = sessionIndexStore.getActive()
    .filter((e) => e.lastActiveAt >= cutoff);

  for (const entry of recentSessions) {
    try {
      await app.client.chat.postMessage({
        channel: entry.channelId,
        thread_ts: entry.threadTs,
        text: '⚠️ PCのWiFi接続が切れました。再接続されるまでメッセージは処理されません。',
      });
      disconnectNotifiedThreads.push({
        channel: entry.channelId,
        threadTs: entry.threadTs,
      });
    } catch {
      // Best-effort: network may already be down
    }
  }
});

networkWatcher.on('reconnected', async () => {
  if (isShuttingDown) return;
  logger.info('[Resilience] WiFi reconnected, restarting Bridge via launchd');

  // Wait for DHCP/DNS to stabilize
  await new Promise((r) => setTimeout(r, 2000));

  // Post reconnect notification to threads that got disconnect notice
  const pendingMessages: Array<{ channel: string; ts: string; thread_ts: string }> = [];
  for (const thread of disconnectNotifiedThreads) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const result = await app.client.chat.postMessage({
          channel: thread.channel,
          thread_ts: thread.threadTs,
          text: '🔄 WiFiの再接続を検知しました。Bridgeを再起動しています...',
        });
        if (result.ts) {
          pendingMessages.push({
            channel: thread.channel,
            ts: result.ts,
            thread_ts: thread.threadTs,
          });
        }
        break;
      } catch {
        if (attempt < 3) await new Promise((r) => setTimeout(r, 3000));
      }
    }
  }

  // Save pending messages for the new process to update
  if (pendingMessages.length > 0) {
    const restartFile = path.join(os.homedir(), '.claude-slack-pipe', 'restart-pending.json');
    try {
      fs.writeFileSync(restartFile, JSON.stringify({ messages: pendingMessages }));
    } catch { /* best-effort */ }
  }

  // Reuse existing shutdown flow (same as /restart-bridge)
  await shutdown('wifi-reconnect');
});

networkWatcher.start();
```

- [ ] **Step 3: Add networkWatcher.stop() to shutdown function**

既存の`shutdown`関数内の`tunnelManager.stopAll();`の直後に追加:

```typescript
networkWatcher.stop();
```

- [ ] **Step 4: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add src/index.ts
git commit -m "feat: integrate NetworkWatcher for WiFi disconnect/reconnect handling"
```

---

### Task 6: 手動テスト

**Files:** None (verification only)

- [ ] **Step 1: Bridgeを起動して正常動作を確認**

ユーザーに`cc /restart-bridge`で再起動を依頼。ログに以下が出ることを確認:
- `[NetworkWatcher] Started, initial state: connected`
- `Claude Code Slack Bridge is running (Phase 2)`

- [ ] **Step 2: 知見ドキュメント作成**

`docs/knowledge/2026-03-19-wifi-resilience.md` に以下を記録:
- 症状: WiFi切断時にBridgeがcrash loopに入り復帰しない
- 根本原因: Slack SDK (`@slack/socket-mode`) が `RequestError` を回復不可能と判定
- 修正内容: scutilベースのNetworkWatcherで切断/復帰検知、unhandledRejection catch、launchd再起動
- 教訓: Socket Mode SDKのエラーハンドリングは信頼できない。アプリレイヤーで回復機構を持つべき。

- [ ] **Step 3: Commit knowledge doc**

```bash
git add docs/knowledge/2026-03-19-wifi-resilience.md
git commit -m "docs: add knowledge file for WiFi resilience fix"
```
