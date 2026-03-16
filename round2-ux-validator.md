# 統合設計書 — Claude Code Slack Bridge MVP

作成日: 2026-03-13
ベース: Round 1 レポート3本 + Synthesis

---

## 1. 統合アーキテクチャ

### 1.1 全体構成図

```
┌──────────────────────────────────────────────────────────────────────┐
│                         Slack Workspace                              │
│                                                                      │
│   ┌──────────────────────┐    ┌──────────────────────────────────┐   │
│   │   #claude-project-x   │    │   (将来) Home Tab / DM 管理     │   │
│   │                      │    │                                  │   │
│   │  [msg] → 新規セッション │    │                                  │   │
│   │  [thread] → セッション継続│   │                                  │   │
│   └──────────┬───────────┘    └──────────────────────────────────┘   │
│              │                                                       │
└──────────────┼───────────────────────────────────────────────────────┘
               │ WebSocket (Socket Mode)
               ▼
┌──────────────────────────────────────────────────────────────────────┐
│                    Bridge Server (TypeScript / Node.js)               │
│                                                                      │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │  Slack Layer (Bolt App — Socket Mode)                          │  │
│  │                                                                │  │
│  │  ┌────────────────┐  ┌────────────────┐  ┌─────────────────┐  │  │
│  │  │ EventHandler   │  │ CommandParser  │  │ ResponseBuilder │  │  │
│  │  │                │  │                │  │                 │  │  │
│  │  │ message        │  │ "cc /xxx"検出   │  │ mrkdwn変換      │  │  │
│  │  │ app_mention    │  │ 通常テキスト判別 │  │ 長文分割         │  │  │
│  │  └───────┬────────┘  └───────┬────────┘  │ ファイルアップロード│ │  │
│  │          │                   │           └─────────────────┘  │  │
│  └──────────┼───────────────────┼────────────────────────────────┘  │
│             └─────────┬─────────┘                                    │
│                       ▼                                              │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │  Bridge Core                                                   │  │
│  │                                                                │  │
│  │  ┌──────────────────┐  ┌──────────────┐  ┌─────────────────┐  │  │
│  │  │ SessionManager   │  │ SessionQueue │  │ ClaudeExecutor  │  │  │
│  │  │                  │  │              │  │                 │  │  │
│  │  │ resolveSession() │  │ enqueue()    │  │ spawn claude -p │  │  │
│  │  │ createSession()  │  │ processNext()│  │ --session-id    │  │  │
│  │  │ listSessions()   │  │ (per-session)│  │ -r (継続時)     │  │  │
│  │  └───────┬──────────┘  └──────┬───────┘  │ --permission-   │  │  │
│  │          │                    │          │   mode auto     │  │  │
│  │          │                    │          └────────┬────────┘  │  │
│  └──────────┼────────────────────┼──────────────────┼────────────┘  │
│             ▼                    │                   │               │
│  ┌─────────────────────┐         │                   ▼               │
│  │ StateStore (SQLite)  │         │          ┌──────────────────┐    │
│  │                     │         │          │ child_process    │    │
│  │ channel_workdir     │◄────────┘          │ claude -p ...    │    │
│  │ thread_session      │                    │ (都度起動モデル)  │    │
│  │ active_process      │                    └──────────────────┘    │
│  └─────────────────────┘                                            │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

### 1.2 コンポーネント間インターフェース

```
index.ts
  │
  ├──► SlackApp (Bolt)
  │     ├── EventHandler.onMessage(event)
  │     │     └──► SessionManager.resolveOrCreate(channelId, threadTs)
  │     │           └──► SessionQueue.enqueue(sessionId, task)
  │     │                 └──► ClaudeExecutor.execute(options)
  │     │                       └──► ResponseBuilder.format(output)
  │     │                             └──► SlackApp.postMessage(...)
  │     └── EventHandler.onAppMention(event)
  │           └── (同上のフロー)
  │
  └──► StateStore
        ├── ChannelWorkdirRepo
        ├── ThreadSessionRepo
        └── ActiveProcessRepo
```

### 1.3 設計原則

| 原則 | 説明 |
|------|------|
| 都度起動モデル (V2) | メッセージごとに `claude -p` を spawn。セッション永続化は Claude Code 側に委任 |
| スレッド=セッション (V4) | チャンネル直下メッセージ→新規セッション、スレッド返信→継続 |
| 2段階レスポンス (V5) | 即時ack + リアクション → 非同期実行 → 結果投稿 |
| セッション直列化 | 同一セッション内のリクエストはキューで直列処理。異なるセッション間は並行可 |

---

## 2. TypeScript型定義（主要インターフェース）

```typescript
// ============================================================
// config.ts — 設定
// ============================================================

export interface BridgeConfig {
  slack: {
    botToken: string;         // xoxb-...
    appToken: string;         // xapp-...
    signingSecret: string;
    channelId: string;        // MVP: 単一チャンネル固定
  };
  bridge: {
    defaultWorkingDirectory: string;
    commandTimeoutMs: number;       // デフォルト: 300_000 (5分)
    maxConcurrentSessions: number;  // デフォルト: 3
    maxBudgetPerSession?: number;   // ドル単位。未設定なら無制限
    permissionMode: string;         // デフォルト: 'auto'
  };
  database: {
    path: string;                   // デフォルト: './data/bridge.db'
  };
  logging: {
    level: 'error' | 'warn' | 'info' | 'debug';
    dir: string;
  };
}

// ============================================================
// executor.ts — Claude CLI 実行
// ============================================================

export interface ExecuteOptions {
  /** ユーザーのプロンプトテキスト */
  prompt: string;
  /** Claude Code セッション ID (UUID v4) */
  sessionId: string;
  /** 作業ディレクトリの絶対パス */
  workingDirectory: string;
  /** true = 既存セッション継続 (-r)、false = 新規セッション (--session-id) */
  isResume: boolean;
  /** タイムアウト (ms)。省略時は config.bridge.commandTimeoutMs */
  timeoutMs?: number;
  /** セッションあたりの最大コスト (USD)。省略時は config.bridge.maxBudgetPerSession */
  maxBudgetUsd?: number;
}

export interface ExecuteResult {
  /** Claude Code の標準出力（応答テキスト） */
  stdout: string;
  /** 標準エラー出力 */
  stderr: string;
  /** プロセス終了コード */
  exitCode: number;
  /** タイムアウトで強制終了されたか */
  timedOut: boolean;
  /** 実行にかかった時間 (ms) */
  durationMs: number;
}

// ============================================================
// session-manager.ts — セッション管理
// ============================================================

export interface SessionInfo {
  sessionId: string;
  channelId: string;
  threadTs: string;
  workingDirectory: string;
  status: 'active' | 'completed' | 'error';
  createdAt: string;
  lastActiveAt: string;
}

export interface SessionResolution {
  sessionId: string;
  workingDirectory: string;
  isResume: boolean;
}

export interface ISessionManager {
  /**
   * Slack スレッド情報からセッションを解決する。
   * マッピングが存在すれば既存セッション (isResume=true)、
   * なければ新規作成 (isResume=false)。
   */
  resolveOrCreate(channelId: string, threadTs: string): Promise<SessionResolution>;

  /** アクティブセッション一覧を返す */
  listActive(): Promise<SessionInfo[]>;

  /** セッションステータスを更新する */
  updateStatus(sessionId: string, status: SessionInfo['status']): Promise<void>;

  /** 最終アクティブ日時を更新する */
  touch(sessionId: string): Promise<void>;
}

// ============================================================
// queue.ts — セッション単位の直列キュー
// ============================================================

export interface QueueTask {
  sessionId: string;
  prompt: string;
  workingDirectory: string;
  isResume: boolean;
  slackChannelId: string;
  slackThreadTs: string;
  slackMessageTs: string;
}

export interface ISessionQueue {
  /** タスクをキューに追加。セッション内は直列、セッション間は並行 */
  enqueue(task: QueueTask): Promise<void>;
  /** 現在キューに入っているタスク数 */
  pendingCount(sessionId: string): number;
}

// ============================================================
// formatter.ts — 出力フォーマット
// ============================================================

export type SlackOutput =
  | { type: 'single'; text: string }
  | { type: 'multi'; messages: string[] }
  | { type: 'file'; content: string; filename: string };

export interface IResponseBuilder {
  /** Markdown → Slack mrkdwn 変換 */
  markdownToMrkdwn(md: string): string;

  /** 長文を Slack 制限に合わせて分割判定 */
  splitResponse(text: string): SlackOutput;
}

// ============================================================
// store — データベース型
// ============================================================

export interface ChannelWorkdirRow {
  channel_id: string;
  working_directory: string;
  created_at: string;
  updated_at: string;
}

export interface ThreadSessionRow {
  thread_ts: string;
  channel_id: string;
  session_id: string;
  working_directory: string;
  status: string;
  created_at: string;
  last_active_at: string;
}

export interface ActiveProcessRow {
  id: number;
  session_id: string;
  pid: number;
  started_at: string;
  status: string;
  slack_channel_id: string;
  slack_thread_ts: string;
  prompt_text: string | null;
  completed_at: string | null;
}
```

---

## 3. 修正済みExecutor実装

Round 1 Synthesis の P0 問題 (P0-1, P0-2) および Emergent Insight #3 を反映。

### 3.1 修正ポイント一覧

| 問題ID | 修正内容 |
|--------|----------|
| P0-1 | セッション新規: `claude -p --session-id <uuid> "prompt"` (cwdはspawnオプション) |
| P0-1 | セッション継続: `claude -p -r <session-id> "prompt"` (`--session-id`と`-r`は排他) |
| P0-2 | `--permission-mode auto` をデフォルト追加 |
| P1-2 | `--max-budget-usd` を環境変数 `MAX_BUDGET_PER_SESSION` から設定可能に |

### 3.2 修正済みコード

```typescript
import { spawn, ChildProcess } from 'child_process';
import { BridgeConfig, ExecuteOptions, ExecuteResult } from './types';

export class ClaudeExecutor {
  constructor(private config: BridgeConfig) {}

  async execute(options: ExecuteOptions): Promise<ExecuteResult> {
    const {
      prompt,
      sessionId,
      workingDirectory,
      isResume,
      timeoutMs = this.config.bridge.commandTimeoutMs,
      maxBudgetUsd = this.config.bridge.maxBudgetPerSession,
    } = options;

    // ── コマンド引数の構築 ──
    const args = this.buildArgs({ prompt, sessionId, isResume, maxBudgetUsd });

    const startTime = Date.now();

    return new Promise<ExecuteResult>((resolve) => {
      const proc: ChildProcess = spawn('claude', args, {
        // CWD は spawn のオプションで指定（--cwd オプションは存在しない）
        cwd: workingDirectory,
        env: {
          ...process.env,
          // ネスト防止チェックを回避（ブリッジは Claude Code 内から起動されるわけではない）
          CLAUDECODE: undefined,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      let timedOut = false;

      // ── タイムアウト制御 ──
      const timer = setTimeout(() => {
        timedOut = true;
        proc.kill('SIGTERM');
        setTimeout(() => {
          if (!proc.killed) {
            proc.kill('SIGKILL');
          }
        }, 5_000);
      }, timeoutMs);

      proc.stdout?.on('data', (data: Buffer) => {
        stdout += data.toString();
      });

      proc.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString();
      });

      proc.on('close', (code: number | null) => {
        clearTimeout(timer);
        resolve({
          stdout,
          stderr,
          exitCode: code ?? 1,
          timedOut,
          durationMs: Date.now() - startTime,
        });
      });

      proc.on('error', (err: Error) => {
        clearTimeout(timer);
        resolve({
          stdout,
          stderr: stderr + '\n' + err.message,
          exitCode: 1,
          timedOut: false,
          durationMs: Date.now() - startTime,
        });
      });
    });
  }

  /**
   * Claude CLI の引数を構築する。
   *
   * 新規セッション:
   *   claude -p --session-id <uuid> --permission-mode auto [--max-budget-usd N] "prompt"
   *
   * セッション継続:
   *   claude -p -r <session-id> --permission-mode auto [--max-budget-usd N] "prompt"
   *
   * --session-id と -r は排他的。
   *   - --session-id: 新規セッションに事前に UUID を割り当てる
   *   - -r: 既存セッション ID を指定して会話を再開する
   */
  private buildArgs(params: {
    prompt: string;
    sessionId: string;
    isResume: boolean;
    maxBudgetUsd?: number;
  }): string[] {
    const args: string[] = ['-p'];

    // ── セッション指定（排他） ──
    if (params.isResume) {
      // 既存セッションの継続: -r <session-id>
      args.push('-r', params.sessionId);
    } else {
      // 新規セッション作成: --session-id <uuid>
      args.push('--session-id', params.sessionId);
    }

    // ── 権限モード（P0-2 修正: auto をデフォルトに） ──
    args.push('--permission-mode', this.config.bridge.permissionMode || 'auto');

    // ── コスト制御（P1-2: 環境変数から設定可能） ──
    if (params.maxBudgetUsd !== undefined && params.maxBudgetUsd > 0) {
      args.push('--max-budget-usd', params.maxBudgetUsd.toString());
    }

    // ── プロンプト（最後に配置） ──
    args.push(params.prompt);

    return args;
  }
}
```

### 3.3 コマンド組み立て例

```
■ 新規セッション (isResume = false)
  claude -p \
    --session-id 550e8400-e29b-41d4-a716-446655440000 \
    --permission-mode auto \
    --max-budget-usd 2.00 \
    "認証機能を実装して"

  → spawn の cwd オプション: /Users/user/dev/my-project

■ セッション継続 (isResume = true)
  claude -p \
    -r 550e8400-e29b-41d4-a716-446655440000 \
    --permission-mode auto \
    --max-budget-usd 2.00 \
    "テストも追加して"

  → spawn の cwd オプション: /Users/user/dev/my-project
```

---

## 4. データフロー（5シナリオ）

### 4.1 新規メッセージ（新規セッション作成）

```
User                Slack API         EventHandler      SessionManager    SessionQueue     ClaudeExecutor    StateStore
 │                     │                  │                  │                │                │                │
 │  チャンネル直下に     │                  │                  │                │                │                │
 │  メッセージ投稿       │                  │                  │                │                │                │
 ├────────────────────►│                  │                  │                │                │                │
 │                     │  message event   │                  │                │                │                │
 │                     ├─────────────────►│                  │                │                │                │
 │                     │  200 OK (ack)    │                  │                │                │                │
 │                     │◄─────────────────┤                  │                │                │                │
 │                     │                  │                  │                │                │                │
 │                     │  reactions.add   │                  │                │                │                │
 │                     │  (⏳ hourglass)  │                  │                │                │                │
 │                     │◄─────────────────┤                  │                │                │                │
 │                     │                  │                  │                │                │                │
 │                     │                  │ resolveOrCreate  │                │                │                │
 │                     │                  │ (channelId,      │                │                │                │
 │                     │                  │  message.ts)     │                │                │                │
 │                     │                  ├─────────────────►│                │                │                │
 │                     │                  │                  │                │                │                │
 │                     │                  │                  │  thread_session│                │                │
 │                     │                  │                  │  にマッピングなし│                │                │
 │                     │                  │                  │  → UUID v4 生成│                │                │
 │                     │                  │                  ├───────────────────────────────────────────────────►│
 │                     │                  │                  │               INSERT thread_session               │
 │                     │                  │                  │◄──────────────────────────────────────────────────┤
 │                     │                  │                  │                │                │                │
 │                     │                  │  { sessionId,    │                │                │                │
 │                     │                  │    workDir,      │                │                │                │
 │                     │                  │    isResume:false}│                │                │                │
 │                     │                  │◄─────────────────┤                │                │                │
 │                     │                  │                  │                │                │                │
 │                     │                  │          enqueue(task)            │                │                │
 │                     │                  ├──────────────────────────────────►│                │                │
 │                     │                  │                  │                │                │                │
 │                     │                  │                  │                │  execute()     │                │
 │                     │                  │                  │                ├───────────────►│                │
 │                     │                  │                  │                │                │                │
 │                     │                  │                  │                │  spawn:        │                │
 │                     │                  │                  │                │  claude -p     │                │
 │                     │                  │                  │                │  --session-id  │                │
 │                     │                  │                  │                │  <uuid>        │                │
 │                     │                  │                  │                │  --permission- │                │
 │                     │                  │                  │                │  mode auto     │                │
 │                     │                  │                  │                │  "prompt"      │                │
 │                     │                  │                  │                │  cwd: /project │                │
 │                     │                  │                  │                │                │                │
 │                     │                  │                  │                │  INSERT        │                │
 │                     │                  │                  │                │  active_process│                │
 │                     │                  │                  │                ├───────────────────────────────►│
 │                     │                  │                  │                │                │                │
 │                     │                  │                  │                │  ... 実行中 ... │                │
 │                     │                  │                  │                │                │                │
 │                     │                  │                  │                │  ExecuteResult │                │
 │                     │                  │                  │                │◄───────────────┤                │
 │                     │                  │                  │                │                │                │
 │                     │                  │                  │                │  UPDATE        │                │
 │                     │                  │                  │                │  active_process│                │
 │                     │                  │                  │                │  status=       │                │
 │                     │                  │                  │                │  'completed'   │                │
 │                     │                  │                  │                ├───────────────────────────────►│
 │                     │                  │                  │                │                │                │
 │                     │  chat.postMessage│                  │                │                │                │
 │                     │  (thread reply)  │                  │                │                │                │
 │                     │◄─────────────────┤                  │                │                │                │
 │                     │                  │                  │                │                │                │
 │                     │  reactions.remove│                  │                │                │                │
 │                     │  (⏳→✅)         │                  │                │                │                │
 │                     │◄─────────────────┤                  │                │                │                │
 │  スレッド内に応答     │                  │                  │                │                │                │
 │◄────────────────────┤                  │                  │                │                │                │
```

### 4.2 スレッド返信（セッション継続）

```
User → Slack: スレッド内に返信（thread_ts が既存メッセージの ts）
  │
  ▼
EventHandler: message event を受信 → 即時 ack + ⏳ リアクション
  │
  ▼
SessionManager.resolveOrCreate(channelId, threadTs)
  │  thread_session テーブルを検索 → マッピングあり
  │  → { sessionId: "existing-uuid", workDir: "/project", isResume: true }
  │
  ▼
SessionQueue.enqueue(task)
  │  同一 sessionId のタスクがキュー内にあれば待機（直列化）
  │
  ▼
ClaudeExecutor.execute({
  prompt: "テストも追加して",
  sessionId: "existing-uuid",
  workingDirectory: "/Users/user/dev/my-project",
  isResume: true,                     // ← ここが true
})
  │
  │  構築されるコマンド:
  │  claude -p -r existing-uuid --permission-mode auto "テストも追加して"
  │           ^^^^^^^^^^^^^^^^^^
  │           -r で既存セッションを再開（--session-id ではなく -r）
  │
  ▼
結果を Slack スレッドに投稿 → ⏳ を ✅ に置換
```

### 4.3 `cc /commit` コマンド実行

```
User → Slack: スレッド内に "cc /commit -m 'fix auth bug'" と投稿
  │
  ▼
EventHandler: message event を受信 → 即時 ack + ⏳
  │
  ▼
CommandParser: テキストを解析
  │  正規表現: /^cc\s+\/(\S+)(.*)$/i
  │  マッチ: command = "commit", args = "-m 'fix auth bug'"
  │  → prompt を組み立て: "/commit -m 'fix auth bug'"
  │    (Claude Code のスラッシュコマンドとしてそのまま渡す)
  │
  ▼
SessionManager.resolveOrCreate(channelId, threadTs)
  │  → isResume: true（スレッド内なので既存セッション）
  │
  ▼
ClaudeExecutor.execute({
  prompt: "/commit -m 'fix auth bug'",
  sessionId: "existing-uuid",
  isResume: true,
  ...
})
  │
  │  コマンド:
  │  claude -p -r existing-uuid --permission-mode auto "/commit -m 'fix auth bug'"
  │
  ▼
結果を Slack スレッドに投稿（コミットメッセージ・diff 等）
  │
  ▼
⏳ を ✅ に置換
```

### 4.4 長文応答の処理

```
ClaudeExecutor.execute() → ExecuteResult { stdout: "... 15,000文字 ..." }
  │
  ▼
ResponseBuilder.splitResponse(stdout)
  │
  ├─ stdout.length <= 3,900 文字
  │    → { type: 'single', text: mrkdwn変換済みテキスト }
  │    → chat.postMessage で1メッセージ投稿
  │
  ├─ 3,900 < stdout.length <= 39,000 文字
  │    → { type: 'multi', messages: [chunk1, chunk2, ...] }
  │    → 分割ロジック:
  │      1. Markdown 見出し境界で分割
  │      2. コードブロック境界で分割（コードブロック途中では切らない）
  │      3. 空行（パラグラフ境界）で分割
  │      4. 文末で分割
  │      5. 強制分割（上記すべて不可の場合）
  │    → 各 chunk を mrkdwn 変換
  │    → chunk1: chat.postMessage (thread reply)
  │      chunk2〜: chat.postMessage (thread reply, 連続投稿)
  │
  └─ stdout.length > 39,000 文字
       → { type: 'file', content: stdout, filename: 'response.md' }
       → files.uploadV2 でファイルとしてアップロード
       → initial_comment: "応答が長いためファイルとして添付しました"
```

### 4.5 エラー発生時

```
■ パターン A: プロセスクラッシュ (exitCode ≠ 0, timedOut = false)
  │
  ClaudeExecutor.execute() → { exitCode: 1, stderr: "Error: ...", timedOut: false }
  │
  ▼
  active_process テーブルの status を 'failed' に更新
  │
  ▼
  Slack スレッドにエラーメッセージを投稿:
    ":x: エラーが発生しました\n```\n{stderr の先頭 500 文字}\n```\nスレッド内で再度メッセージを送信するとリトライできます。"
  │
  ▼
  ⏳ リアクションを :x: に置換


■ パターン B: タイムアウト (timedOut = true)
  │
  ClaudeExecutor → timeoutMs 超過 → SIGTERM → 5秒待ち → SIGKILL
  │
  ▼
  active_process テーブルの status を 'timeout' に更新
  │
  ▼
  Slack スレッドに通知:
    ":warning: 処理がタイムアウトしました (制限: 5分)\n
     スレッド内でメッセージを送るとセッションを継続できます。
     タスクを分割して再実行することを推奨します。"
  │
  ▼
  ⏳ を :warning: に置換


■ パターン C: セッション不整合（Claude Code 側にセッションファイルが存在しない）
  │
  ClaudeExecutor → stderr に "session not found" 相当のエラー
  │
  ▼
  thread_session テーブルから旧マッピングを削除
  │
  ▼
  新規セッションとして再作成 (isResume = false で再実行)
  │
  ▼
  Slack スレッドに通知:
    ":arrows_counterclockwise: セッションをリセットしました。新しいセッションで処理を続行します。"


■ パターン D: Slack API エラー（投稿失敗）
  │
  chat.postMessage → HTTP 429 / 5xx
  │
  ▼
  指数バックオフでリトライ (1秒 → 2秒 → 4秒、最大3回)
  │
  ├─ リトライ成功 → 正常フローに復帰
  └─ リトライ失敗 → ログに ERROR 記録。ユーザーへの通知は不可（Slack API 自体が応答しないため）
```

---

## 5. 設定ファイル一覧

### 5.1 .env.example

```bash
# ============================================================
# Slack 設定
# ============================================================

# Bot User OAuth Token (xoxb-...)
# OAuth & Permissions ページで取得
SLACK_BOT_TOKEN=xoxb-your-bot-token

# Socket Mode 用 App-Level Token (xapp-...)
# Settings → Basic Information → App-Level Tokens で生成
# 必須スコープ: connections:write
SLACK_APP_TOKEN=xapp-your-app-token

# リクエスト署名検証用シークレット
# Settings → Basic Information → App Credentials → Signing Secret
SLACK_SIGNING_SECRET=your-signing-secret

# MVP: Bot が応答するチャンネル ID
# チャンネル名ではなく ID (例: C01ABCDEFGH)
# チャンネル右クリック → 「リンクをコピー」の末尾、または
# チャンネル詳細の最下部に表示される
SLACK_CHANNEL_ID=C01ABCDEFGH

# ============================================================
# Bridge 設定
# ============================================================

# デフォルトの作業ディレクトリ（絶対パス）
# Claude Code がファイル操作を行うルートディレクトリ
DEFAULT_WORKING_DIRECTORY=/Users/you/dev/your-project

# claude -p のタイムアウト (ms)
# デフォルト: 300000 (5分)
COMMAND_TIMEOUT_MS=300000

# 同時実行可能なセッション数の上限
# デフォルト: 3
MAX_CONCURRENT_SESSIONS=3

# セッションあたりの最大コスト (USD)
# claude -p の --max-budget-usd に渡される
# 未設定または 0 の場合は制限なし
MAX_BUDGET_PER_SESSION=2.00

# Claude Code の権限モード
# 'auto' = 自動判断で権限付与（推奨）
# 'default' = 対話的確認（-p モードでは非推奨）
# 'acceptEdits' = ファイル編集を自動承認
# 'bypassPermissions' = 全権限バイパス（サンドボックス環境のみ）
PERMISSION_MODE=auto

# ============================================================
# データベース設定
# ============================================================

# SQLite データベースファイルのパス
# デフォルト: ./data/bridge.db
DATABASE_PATH=./data/bridge.db

# ============================================================
# ログ設定
# ============================================================

# ログレベル: error | warn | info | debug
LOG_LEVEL=info

# ログファイルの出力ディレクトリ
LOG_DIR=./logs
```

### 5.2 package.json

```json
{
  "name": "claude-slack-bridge",
  "version": "0.1.0",
  "description": "Slack から Claude Code CLI を操作するブリッジサーバー",
  "type": "module",
  "main": "dist/index.js",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsc",
    "start": "node dist/index.js",
    "test": "vitest",
    "test:run": "vitest run",
    "lint": "eslint src/",
    "typecheck": "tsc --noEmit",
    "db:reset": "rm -f data/bridge.db && echo 'Database reset'"
  },
  "dependencies": {
    "@slack/bolt": "^4.1.0",
    "better-sqlite3": "^11.0.0",
    "uuid": "^10.0.0",
    "winston": "^3.14.0",
    "zod": "^3.23.0",
    "dotenv": "^16.4.0"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.0",
    "@types/node": "^22.0.0",
    "@types/uuid": "^10.0.0",
    "eslint": "^9.0.0",
    "tsx": "^4.19.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  },
  "engines": {
    "node": ">=20.0.0"
  }
}
```

### 5.3 tsconfig.json

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022"],
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noImplicitReturns": true,
    "noFallthroughCasesInSwitch": true,
    "isolatedModules": true
  },
  "include": ["src/**/*.ts"],
  "exclude": ["node_modules", "dist", "tests"]
}
```

---

## 6. ディレクトリ構造

```
claude-slack-bridge/
├── src/
│   ├── index.ts                    # エントリポイント: Bolt App 初期化・起動
│   ├── config.ts                   # 環境変数 → BridgeConfig 変換 (zod バリデーション)
│   ├── types.ts                    # 共通型定義（§2 の全インターフェース）
│   │
│   ├── slack/
│   │   ├── event-handler.ts        # message / app_mention イベント処理
│   │   ├── command-parser.ts       # "cc /xxx" パターン検出・分離
│   │   └── response-builder.ts     # mrkdwn 変換 + 長文分割 + ファイルアップロード判定
│   │
│   ├── bridge/
│   │   ├── executor.ts             # ClaudeExecutor — claude -p の spawn・結果収集
│   │   ├── session-manager.ts      # SessionManager — セッション解決・作成・一覧
│   │   └── queue.ts                # SessionQueue — セッション単位の直列キュー
│   │
│   ├── store/
│   │   ├── database.ts             # SQLite 接続・テーブル作成（マイグレーション）
│   │   ├── channel-workdir.ts      # channel_workdir テーブル CRUD
│   │   ├── thread-session.ts       # thread_session テーブル CRUD
│   │   └── active-process.ts       # active_process テーブル CRUD
│   │
│   └── utils/
│       ├── logger.ts               # Winston ロガー設定
│       └── errors.ts               # カスタムエラークラス定義
│
├── data/                           # SQLite DB ファイル格納 (.gitignore 対象)
│   └── .gitkeep
│
├── logs/                           # ログファイル出力先 (.gitignore 対象)
│   └── .gitkeep
│
├── tests/
│   ├── executor.test.ts            # ClaudeExecutor 単体テスト
│   ├── session-manager.test.ts     # SessionManager 単体テスト
│   ├── queue.test.ts               # SessionQueue 単体テスト
│   ├── command-parser.test.ts      # CommandParser 単体テスト
│   └── response-builder.test.ts    # ResponseBuilder 単体テスト
│
├── .env.example                    # 環境変数テンプレート
├── .gitignore
├── package.json
├── tsconfig.json
├── vitest.config.ts
└── README.md
```

---

## 7. MVP実装チェックリスト（実装順序付き）

実装はレイヤー順 (下位→上位) で行う。各タスクに依存関係と推定時間を付記。

### Phase 0: プロジェクト基盤 (0.5日)

| # | タスク | 依存 | 推定 |
|---|--------|------|------|
| 0-1 | `npm init` + package.json 作成 + 依存インストール | なし | 15分 |
| 0-2 | tsconfig.json / vitest.config.ts 作成 | 0-1 | 10分 |
| 0-3 | .env.example 作成 + dotenv 設定 | 0-1 | 10分 |
| 0-4 | `src/config.ts` — zod で環境変数をバリデーション → BridgeConfig 生成 | 0-3 | 30分 |
| 0-5 | `src/utils/logger.ts` — Winston ロガー初期化 | 0-1 | 20分 |
| 0-6 | `src/utils/errors.ts` — カスタムエラークラス (BridgeError, TimeoutError 等) | 0-1 | 15分 |
| 0-7 | `src/types.ts` — 全インターフェース定義 (§2 の内容) | 0-2 | 20分 |
| 0-8 | .gitignore 作成 (node_modules, dist, data/*.db, logs/, .env) | なし | 5分 |

### Phase 1: Store レイヤー (0.5日)

| # | タスク | 依存 | 推定 |
|---|--------|------|------|
| 1-1 | `src/store/database.ts` — SQLite 接続 + 3テーブル CREATE | 0-4 | 30分 |
| 1-2 | `src/store/channel-workdir.ts` — CRUD | 1-1, 0-7 | 20分 |
| 1-3 | `src/store/thread-session.ts` — CRUD | 1-1, 0-7 | 30分 |
| 1-4 | `src/store/active-process.ts` — CRUD | 1-1, 0-7 | 20分 |
| 1-5 | Store レイヤーの単体テスト | 1-2, 1-3, 1-4 | 30分 |

### Phase 2: Bridge Core レイヤー (1日)

| # | タスク | 依存 | 推定 |
|---|--------|------|------|
| 2-1 | `src/bridge/executor.ts` — ClaudeExecutor (§3 の修正済み実装) | 0-4, 0-5, 0-6 | 45分 |
| 2-2 | executor.test.ts — mock spawn でのテスト | 2-1 | 30分 |
| 2-3 | `src/bridge/session-manager.ts` — resolveOrCreate / listActive / updateStatus | 1-2, 1-3 | 45分 |
| 2-4 | session-manager.test.ts | 2-3 | 30分 |
| 2-5 | `src/bridge/queue.ts` — SessionQueue (セッション単位直列、セッション間並行) | 2-1, 1-4 | 45分 |
| 2-6 | queue.test.ts | 2-5 | 30分 |

### Phase 3: Slack レイヤー (0.5日)

| # | タスク | 依存 | 推定 |
|---|--------|------|------|
| 3-1 | `src/slack/command-parser.ts` — "cc /xxx" パターン検出 | 0-7 | 20分 |
| 3-2 | command-parser.test.ts | 3-1 | 15分 |
| 3-3 | `src/slack/response-builder.ts` — mrkdwn 変換 + splitResponse | 0-7 | 45分 |
| 3-4 | response-builder.test.ts | 3-3 | 30分 |
| 3-5 | `src/slack/event-handler.ts` — onMessage / onAppMention ハンドラ | 2-3, 2-5, 3-1, 3-3 | 60分 |

### Phase 4: 統合・エントリポイント (0.5日)

| # | タスク | 依存 | 推定 |
|---|--------|------|------|
| 4-1 | `src/index.ts` — Bolt App 初期化、Socket Mode 接続、ハンドラ登録 | 3-5 |30分 |
| 4-2 | Slack App 作成 (api.slack.com) + OAuth スコープ設定 + Socket Mode 有効化 | なし | 20分 |
| 4-3 | .env に実際のトークンを設定 | 4-2 | 5分 |
| 4-4 | `npm run dev` で起動 → 手動 E2E テスト | 4-1, 4-3 | 30分 |
| 4-5 | エラーハンドリング調整 (実際のエラーパターンを確認して改善) | 4-4 | 30分 |
| 4-6 | 起動時リカバリーチェック (status='running' の orphan プロセス検出) | 4-1, 1-4 | 20分 |

### 依存関係グラフ

```
Phase 0 (基盤)
  │
  ├──► Phase 1 (Store)
  │     │
  │     └──► Phase 2 (Bridge Core)
  │           │
  │           └──► Phase 3 (Slack Layer)    ◄── Phase 0 (types.ts)
  │                 │
  │                 └──► Phase 4 (統合)     ◄── Slack App 作成 (並行可)
  │
  └──► Slack App 作成 (4-2) は Phase 0 と並行して実施可能
```

### MVP 完了判定基準

以下の全てが動作すること:

- [ ] Slack チャンネルにメッセージ投稿 → Claude Code が応答 → スレッド内に返信
- [ ] スレッド内に追加メッセージ → 同一セッションが継続 → コンテキストを保持した応答
- [ ] `cc /commit` → Claude Code の /commit が実行される
- [ ] 処理中に ⏳ リアクション表示 → 完了後に ✅ に置換
- [ ] タイムアウト時にユーザーに通知
- [ ] プロセスクラッシュ時にエラーメッセージ表示

---

## 8. 技術的注意事項

### 8.1 セッション管理の重要な違い

| 操作 | CLIコマンド | 用途 |
|------|-----------|------|
| 新規セッション (ID事前指定) | `claude -p --session-id <uuid> "prompt"` | Bridge側でIDを管理したい場合 |
| セッション継続 | `claude -p -r <session-id> "prompt"` | 既存の会話を再開 |

**`--session-id` と `-r` は排他的に使用すること。** 両方を同時に指定した場合の挙動は未定義。

### 8.2 CWD（作業ディレクトリ）の制御

Claude Code CLI には `--cwd` オプションが存在しない。作業ディレクトリは spawn のオプションで制御する。

```typescript
spawn('claude', args, { cwd: workingDirectory });
```

セッションは作業ディレクトリに紐づいて保存されるため、同一セッションIDを異なるCWDで使い回さないこと。ただし `-r` による再開時は元のCWDと異なっていてもセッション履歴は復元される。

### 8.3 CLAUDECODE 環境変数

Claude Code はセッション内で `CLAUDECODE=1` を設定する。ブリッジから spawn する際にこの変数が引き継がれるとネスト禁止チェックに引っかかる可能性がある。spawn 時に明示的に undefined にする。

```typescript
spawn('claude', args, {
  env: { ...process.env, CLAUDECODE: undefined },
});
```

### 8.4 Slack 3秒制限

Socket Mode では HTTP ack ではなく `ack()` コールバックで即時応答する。ack 後に非同期で重い処理を実行する。Bolt フレームワークのイベントハンドラで `ack()` を最初に呼ぶパターンを徹底する。

```typescript
app.event('message', async ({ event, client, ack }) => {
  await ack();  // 即時応答（ここまでが3秒制限の範囲）

  // 以降は非同期で処理（時間制限なし）
  await processMessage(event, client);
});
```

**注意:** Socket Mode の場合、Bolt は自動的に ack を行うが、明示的に処理の順序を制御するため、ハンドラの冒頭で非同期処理をトリガーし、重い処理は await せずにキューに入れるパターンが安全。

### 8.5 コスト制御

`--max-budget-usd` はセッション単位のコスト上限。環境変数 `MAX_BUDGET_PER_SESSION` から読み取る。未設定の場合は制限なし。Slack 経由の誤操作で大量のAPIコストが発生するリスクを軽減するため、設定を推奨する。

### 8.6 並行実行の制約

- **同一セッション内:** 直列実行のみ。Claude Code のセッションファイルへの並行書き込みは競合を起こす。
- **異なるセッション間:** 並行実行可。`MAX_CONCURRENT_SESSIONS` で上限を制御。
- **セマフォの実装:** SessionQueue 内で同時実行セッション数をカウントし、上限に達した場合は待機キューに入れる。

### 8.7 Markdown → Slack mrkdwn 変換の注意点

コードブロック（` ``` `）内のテキストは変換対象外とすること。変換はコードブロック外の部分にのみ適用する。

主な変換ルール:
| Markdown | Slack mrkdwn |
|----------|-------------|
| `**bold**` | `*bold*` |
| `*italic*` | `_italic_` |
| `~~strike~~` | `~strike~` |
| `[text](url)` | `<url\|text>` |
| `# Heading` | `*Heading*` |
| `- item` | `• item` |

### 8.8 将来の拡張ポイント

| 機能 | 対応するCLIオプション | Phase |
|------|---------------------|-------|
| リアルタイムストリーミング | `--output-format stream-json --include-partial-messages` | Phase 2+ |
| セッション分岐 | `--fork-session` | Phase 3 |
| MCPサーバーモード | `claude mcp serve` | Phase 4 |
| 双方向ストリーミング | `--input-format stream-json --output-format stream-json` | Phase 4 |
| カスタムエージェント | `--agent` / `--agents` | Phase 4 |
| Slack AI Streaming | Slack chat streaming API (2025/10) | Phase 4 |

### 8.9 Slack App 作成手順（MVP最小構成）

1. https://api.slack.com/apps → Create New App → From scratch
2. App Name: "Claude Code Bridge"
3. **Socket Mode を有効化:**
   - Settings → Socket Mode → Enable
   - App-Level Token を生成（スコープ: `connections:write`）→ `SLACK_APP_TOKEN`
4. **Bot Token Scopes を設定:**
   - OAuth & Permissions → Bot Token Scopes:
   - `app_mentions:read`, `chat:write`, `channels:history`, `channels:read`, `reactions:write`, `files:write`, `files:read`
5. **Event Subscriptions を有効化:**
   - Event Subscriptions → Enable Events
   - Subscribe to bot events: `message.channels`, `app_mention`
6. **ワークスペースにインストール:**
   - Install App → Install to Workspace
   - Bot User OAuth Token (`xoxb-...`) → `SLACK_BOT_TOKEN`
7. **Signing Secret を取得:**
   - Settings → Basic Information → App Credentials → Signing Secret → `SLACK_SIGNING_SECRET`
8. **チャンネルに Bot を招待:**
   - 対象チャンネルで `/invite @Claude Code Bridge`
