# launchdデーモン化 + `/restart-bridge` コマンド 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bridgeをlaunchdデーモンとして管理し、Slackから `cc /restart-bridge` で安全に再起動できるようにする

**Architecture:** launchdがBridgeプロセスのライフサイクルを管理。`/restart-bridge` botコマンドでgraceful shutdownし、launchdが自動再起動。PIDファイルを廃止してClaude CLIの自殺経路を断つ。

**Tech Stack:** TypeScript, macOS launchd, Slack Bolt

**Spec:** `docs/superpowers/specs/2026-03-19-launchd-daemon-design.md`

---

## ファイル構成

| 操作 | ファイル | 責務 |
|---|---|---|
| Create | `launchd/com.user.claude-slack-pipe.plist.template` | launchd設定テンプレート |
| Modify | `src/slack/command-parser.ts` | `restart-bridge` をBOT_COMMANDSに追加 |
| Modify | `src/index.ts` | PIDロック条件分岐、`/restart-bridge` ハンドリング、クラッシュガード、ログローテーション |
| Modify | `CLAUDE.md` | 再起動手順をlaunchd方式に変更 |
| Modify | `README.md` | 起動方法セクションをlaunchd方式に更新 |
| Modify | `.claude/skills/setup.md` | セットアップ手順をlaunchd方式に変更 |
| Keep | `src/utils/pid-lock.ts` | launchd未使用時のフォールバックとして残す |

---

### Task 1: コマンドパーサー + PIDロック条件分岐

**Files:**
- Modify: `src/slack/command-parser.ts:3`
- Modify: `src/index.ts:62` (pidLock取得箇所)
- Modify: `src/index.ts:814-828` (shutdown関数)

PIDロック変更を先に行い、後続のTask 2で `shutdown()` を呼ぶ際に `pidLock?.release()` が安全に動作するようにする。

- [ ] **Step 1: `BOT_COMMANDS` に `restart-bridge` を追加**

`src/slack/command-parser.ts` 行3を変更：

old:
```typescript
const BOT_COMMANDS = new Set(['end', 'status', 'restart']);
```

new:
```typescript
const BOT_COMMANDS = new Set(['end', 'status', 'restart', 'restart-bridge']);
```

- [ ] **Step 2: `index.ts` に `path` と `os` の import を追加**

`src/index.ts` のimportセクション（行19の `import fs` の後）に追加：

```typescript
import path from 'node:path';
import os from 'node:os';
```

- [ ] **Step 3: PIDロックを条件分岐に変更**

`src/index.ts` 行62を変更：

old:
```typescript
  const pidLock = acquirePidLock(config.dataDir);
```

new:
```typescript
  // Singleton lock — skip when managed by launchd
  let pidLock: { release: () => void } | null = null;
  if (!process.env.MANAGED_BY_LAUNCHD) {
    pidLock = acquirePidLock(config.dataDir);
  }
```

- [ ] **Step 4: `shutdown()` の `pidLock.release()` を optional chaining に変更**

`src/index.ts` 行822を変更：

old:
```typescript
    pidLock.release();
```

new:
```typescript
    pidLock?.release();
```

- [ ] **Step 5: コミット**

```bash
git add src/slack/command-parser.ts src/index.ts
git commit -m "feat: add restart-bridge command and conditional PID lock"
```

---

### Task 2: `/restart-bridge` ハンドラー実装

**Files:**
- Modify: `src/index.ts:164-165` (bot_command 分岐)

- [ ] **Step 1: `restart-bridge` ハンドラーを `indexEntry` 取得の前に挿入**

`src/index.ts` の行164-165を変更。`restart-bridge` はBridge全体の操作でセッション不要なため、`indexEntry` チェックの前に配置する。

old:
```typescript
    if (parsed.type === 'bot_command') {
      const indexEntry = sessionIndexStore.findByThreadTs(threadTs);
```

new:
```typescript
    if (parsed.type === 'bot_command') {
      // restart-bridge is a global command — no session context needed
      if (parsed.command === 'restart-bridge') {
        if (!auth.isAdmin(userId)) {
          await app.client.chat.postEphemeral({
            channel: channelId,
            user: userId,
            text: '⛔ This command requires admin privileges.',
          });
          return;
        }
        await app.client.chat.postMessage({
          channel: channelId,
          thread_ts: threadTs,
          text: '🔄 Bridgeを再起動します...',
        });
        await shutdown('restart-bridge');
        return;
      }

      const indexEntry = sessionIndexStore.findByThreadTs(threadTs);
```

- [ ] **Step 2: コミット**

```bash
git add src/index.ts
git commit -m "feat: implement /restart-bridge handler with admin auth"
```

---

### Task 3: クラッシュループ防止（サーキットブレーカー）

**Files:**
- Modify: `src/index.ts` (main関数の先頭、`const config = loadConfig()` の前)

- [ ] **Step 1: クラッシュガードを `main()` の先頭に追加**

`src/index.ts` の `async function main(): Promise<void> {` の直後（`const config = loadConfig();` の前）に挿入：

old:
```typescript
async function main(): Promise<void> {
  const config = loadConfig();
```

new:
```typescript
async function main(): Promise<void> {
  // Circuit breaker — prevent crash loops under launchd
  if (process.env.MANAGED_BY_LAUNCHD) {
    const crashFile = path.join(
      os.homedir(),
      '.claude-slack-pipe',
      'crash-history.json',
    );
    const now = Date.now();
    let history: number[] = [];
    try {
      history = JSON.parse(fs.readFileSync(crashFile, 'utf-8'));
    } catch { /* first run or corrupt */ }
    // Keep only entries within 60s window, cap at 4
    history = history.filter((t) => now - t < 60_000).slice(-4);
    if (history.length >= 4) {
      logger.error('Crash loop detected (5 crashes in 60s), exiting. Fix the issue and restart with: launchctl kickstart gui/$(id -u)/com.user.claude-slack-pipe');
      process.exit(0); // exit(0) so launchd KeepAlive doesn't respawn
    }
    history.push(now);
    fs.mkdirSync(path.dirname(crashFile), { recursive: true });
    fs.writeFileSync(crashFile, JSON.stringify(history));
  }

  const config = loadConfig();
```

ロジック: 60秒以内に4件の履歴がある状態で5回目の起動 → ループ判定して停止。

- [ ] **Step 2: コミット**

```bash
git add src/index.ts
git commit -m "feat: add crash loop circuit breaker for launchd"
```

---

### Task 4: ログローテーション

**Files:**
- Modify: `src/index.ts` (main関数内、`const config = loadConfig()` の直後)

- [ ] **Step 1: 簡易ログローテーションを追加**

`const config = loadConfig();` の直後、`fs.mkdirSync(config.dataDir, ...)` の前に挿入：

old:
```typescript
  const config = loadConfig();

  // Ensure data directory exists
  fs.mkdirSync(config.dataDir, { recursive: true });
```

new:
```typescript
  const config = loadConfig();

  // Simple log rotation for launchd stdout/stderr files
  if (process.env.MANAGED_BY_LAUNCHD) {
    const MAX_LOG_SIZE = 10 * 1024 * 1024; // 10MB
    for (const logFile of ['bridge.stdout.log', 'bridge.stderr.log']) {
      const logPath = path.join(config.dataDir, logFile);
      try {
        const stat = fs.statSync(logPath);
        if (stat.size > MAX_LOG_SIZE) {
          fs.renameSync(logPath, logPath + '.old');
          logger.info(`Rotated ${logFile} (${(stat.size / 1024 / 1024).toFixed(1)}MB)`);
        }
      } catch { /* file doesn't exist yet */ }
    }
  }

  // Ensure data directory exists
  fs.mkdirSync(config.dataDir, { recursive: true });
```

- [ ] **Step 2: コミット**

```bash
git add src/index.ts
git commit -m "feat: add simple log rotation for launchd log files"
```

---

### Task 5: launchd plistテンプレート作成

**Files:**
- Create: `launchd/com.user.claude-slack-pipe.plist.template`

- [ ] **Step 1: ディレクトリ作成とテンプレートファイル作成**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.user.claude-slack-pipe</string>

  <key>ProgramArguments</key>
  <array>
    <string>caffeinate</string>
    <string>-i</string>
    <string>{{NODE_PATH}}</string>
    <string>{{PROJECT_DIR}}/node_modules/.bin/tsx</string>
    <string>src/index.ts</string>
  </array>

  <key>WorkingDirectory</key>
  <string>{{PROJECT_DIR}}</string>

  <key>KeepAlive</key>
  <true/>

  <key>RunAtLoad</key>
  <true/>

  <key>StandardOutPath</key>
  <string>{{DATA_DIR}}/bridge.stdout.log</string>

  <key>StandardErrorPath</key>
  <string>{{DATA_DIR}}/bridge.stderr.log</string>

  <key>ThrottleInterval</key>
  <integer>5</integer>

  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin</string>
    <key>MANAGED_BY_LAUNCHD</key>
    <string>1</string>
  </dict>
</dict>
</plist>
```

- [ ] **Step 2: コミット**

```bash
git add launchd/
git commit -m "feat: add launchd plist template"
```

---

### Task 6: CLAUDE.md 更新

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: 「Bridgeプロセスの再起動」セクションを書き換え**

`## Bridgeプロセスの再起動（必須）` セクション全体を以下に置換：

```markdown
## Bridgeプロセスの再起動（必須）

`src/` 配下のコードを変更したら、必ずBridgeプロセスを再起動すること。

### launchd管理下の場合（推奨）

Slackで以下を送信するだけで再起動される（admin権限が必要）：

```
cc /restart-bridge
```

またはターミナルから：
```bash
launchctl kickstart -k gui/$(id -u)/com.user.claude-slack-pipe
```

### 手動起動の場合（launchd未設定時）

```bash
# 実行中のBridgeを終了
pkill -f 'tsx src/index.ts'
# 少し待ってから再起動
sleep 2 && caffeinate -i npx tsx src/index.ts
```

- **必ず `run_in_background: true` で起動すること。** Bashツールのtimeoutは最大10分のため、フォアグラウンドで起動するとプロセスが強制killされる。

**重要:** Bashで `kill` コマンドを使ってBridgeプロセスを直接killしないこと。Bridge自身が処理中のSlack応答が途切れる原因になる。必ず `cc /restart-bridge` か `launchctl kickstart` を使うこと。
```

- [ ] **Step 2: `caffeinate` と `pmset` の説明、ENOENT対処セクションはそのまま残す**

- [ ] **Step 3: コミット**

```bash
git add CLAUDE.md
git commit -m "docs: update CLAUDE.md with launchd restart instructions"
```

---

### Task 7: README.md 更新

**Files:**
- Modify: `README.md`

- [ ] **Step 1: 起動方法セクションにlaunchd方式を追加**

既存の手動起動手順の前に「推奨: launchd」セクションを追加し、手動起動は「代替」として残す。内容はCLAUDE.mdのlaunchdセクションと整合させる。

- [ ] **Step 2: コミット**

```bash
git add README.md
git commit -m "docs: update README.md with launchd setup instructions"
```

---

### Task 8: setup.md 更新

**Files:**
- Modify: `.claude/skills/setup.md`

- [ ] **Step 1: タスク6（Bridge起動）をlaunchd方式に変更**

既存の「`npx tsx src/index.ts` を `run_in_background: true` で実行」を以下に置換：

1. テンプレートからplistを生成:
   ```bash
   NODE_PATH=$(which node)
   PROJECT_DIR=$(pwd)
   DATA_DIR="$HOME/.claude-slack-pipe"
   mkdir -p ~/Library/LaunchAgents
   sed -e "s|{{NODE_PATH}}|$NODE_PATH|g" \
       -e "s|{{PROJECT_DIR}}|$PROJECT_DIR|g" \
       -e "s|{{DATA_DIR}}|$DATA_DIR|g" \
       launchd/com.user.claude-slack-pipe.plist.template \
       > ~/Library/LaunchAgents/com.user.claude-slack-pipe.plist
   ```

2. launchdに登録:
   ```bash
   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.user.claude-slack-pipe.plist
   ```

3. 起動確認:
   ```bash
   sleep 3 && tail -20 ~/.claude-slack-pipe/bridge.stdout.log
   ```
   → `Claude Code Slack Bridge is running` が出ることを確認

手動起動のフォールバックも残す：
   ```bash
   caffeinate -i npx tsx src/index.ts
   ```
   （`run_in_background: true` で実行）

- [ ] **Step 2: コミット**

```bash
git add .claude/skills/setup.md
git commit -m "docs: update setup.md with launchd setup instructions"
```
