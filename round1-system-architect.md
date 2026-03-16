# claude-slack-bridge: システムアーキテクト分析レポート

## I5: `.claude/projects/` の構造解析

### 実測に基づくディレクトリ構造

```
~/.claude/projects/
├── -Users-archeco055-dev-Discussion/          # プロジェクトディレクトリ
│   ├── 0ea55c12-f9be-47b0-8909-fc9ec9780c9b.jsonl   # セッションログ（JSONL）
│   ├── 0ea55c12-f9be-47b0-8909-fc9ec9780c9b/        # セッション付属データ（オプション）
│   │   ├── subagents/                                 # サブエージェントのログ
│   │   │   └── agent-a0498fca7a2b9930d.jsonl
│   │   └── tool-results/                              # ツール実行結果のキャッシュ
│   │       ├── b0bbd32.txt
│   │       └── mcp-plugin_playwright_playwright-browser_navigate-*.txt
│   ├── 15c71379-f1ad-4321-9dbe-0c723e2c4337.jsonl   # 別のセッション
│   ├── memory/                                        # プロジェクトメモリ
│   │   ├── MEMORY.md
│   │   └── user_banana.md
│   └── ...
├── -Users-archeco055-dev-Cowork/
├── e49b99d3-c41b-4e57-8311-96a1fa1a1c60.jsonl       # ルート直下のセッション（プロジェクトなし）
└── ...
```

### プロジェクトパスの変換ルール

`claude-code-viewer` の `computeClaudeProjectFilePath` から確認:

```
/Users/archeco055/dev/Discussion
↓ 末尾スラッシュ除去 → スラッシュをハイフンに置換
-Users-archeco055-dev-Discussion
```

実装:

```typescript
function projectPathToDirectoryName(projectPath: string): string {
  return projectPath.replace(/\/$/, '').replace(/\//g, '-');
}

function directoryNameToProjectPath(dirName: string): string {
  // 先頭の "-" はルート "/" に対応
  return dirName.replace(/-/g, '/');
}
```

### セッションログのファイル形式: JSONL

各行が独立したJSONオブジェクト。`type` フィールドで判別される以下のエントリタイプが存在する:

| type | 説明 | 出現頻度 |
|------|------|----------|
| `queue-operation` | メッセージキュー操作（enqueue/dequeue/remove/popAll） | セッション開始時 |
| `progress` | フック実行等の進捗通知 | 各ターン |
| `user` | ユーザーメッセージ | 各ターン |
| `assistant` | アシスタント応答（thinking, text, tool_use含む） | 各ターン |
| `system` | システムイベント（turn_duration, api_error, stop_hook_summary等） | 随時 |
| `file-history-snapshot` | ファイル変更履歴のスナップショット | 随時 |
| `last-prompt` | セッション最後のプロンプト | セッション末尾 |
| `summary` | 会話要約（compact化時） | compact発生時 |
| `custom-title` | ユーザーが設定したセッションタイトル | オプション |
| `agent-name` | エージェント名 | サブエージェント関連 |

### プロジェクト一覧の検出ロジック

```typescript
import * as fs from 'node:fs';
import * as path from 'node:path';

const CLAUDE_PROJECTS_DIR = path.join(
  process.env.HOME ?? '',
  '.claude',
  'projects'
);

interface ProjectInfo {
  id: string;           // ディレクトリ名（例: "-Users-archeco055-dev-Discussion"）
  projectPath: string;  // 元のパス（例: "/Users/archeco055/dev/Discussion"）
  sessionCount: number;
  lastModified: Date;
}

function listProjects(): ProjectInfo[] {
  const entries = fs.readdirSync(CLAUDE_PROJECTS_DIR, { withFileTypes: true });

  return entries
    .filter(entry => entry.isDirectory() && entry.name.startsWith('-'))
    .map(entry => {
      const dirPath = path.join(CLAUDE_PROJECTS_DIR, entry.name);
      const jsonlFiles = fs.readdirSync(dirPath)
        .filter(f => f.endsWith('.jsonl'));

      // セッション数はUUID.jsonlファイルの数
      const sessionFiles = jsonlFiles.filter(f =>
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i.test(f)
      );

      const stats = sessionFiles.map(f =>
        fs.statSync(path.join(dirPath, f)).mtime
      );
      const lastModified = stats.length > 0
        ? new Date(Math.max(...stats.map(d => d.getTime())))
        : new Date(0);

      return {
        id: entry.name,
        projectPath: entry.name.replace(/-/g, '/'),
        sessionCount: sessionFiles.length,
        lastModified,
      };
    })
    .sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime());
}
```

### セッション一覧の取得方法

```typescript
interface SessionInfo {
  sessionId: string;
  projectId: string;
  firstPrompt: string | null;   // queue-operation(enqueue) の content
  lastPrompt: string | null;    // last-prompt の lastPrompt
  customTitle: string | null;   // custom-title の customTitle
  createdAt: Date;              // ファイルのbirthtime or 最初のtimestamp
  updatedAt: Date;              // ファイルのmtime
  fileSizeBytes: number;
}

function listSessions(projectId: string): SessionInfo[] {
  const projectDir = path.join(CLAUDE_PROJECTS_DIR, projectId);
  const files = fs.readdirSync(projectDir)
    .filter(f => /^[0-9a-f]{8}-.*\.jsonl$/i.test(f));

  return files.map(file => {
    const filePath = path.join(projectDir, file);
    const stat = fs.statSync(filePath);
    const sessionId = file.replace('.jsonl', '');

    // 軽量メタデータ取得: 先頭数行と末尾数行のみ読む
    const meta = extractSessionMeta(filePath);

    return {
      sessionId,
      projectId,
      firstPrompt: meta.firstPrompt,
      lastPrompt: meta.lastPrompt,
      customTitle: meta.customTitle,
      createdAt: stat.birthtime,
      updatedAt: stat.mtime,
      fileSizeBytes: stat.size,
    };
  }).sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
}
```

### 各セッションの会話内容の読み取り方法

```typescript
function extractSessionMeta(filePath: string): {
  firstPrompt: string | null;
  lastPrompt: string | null;
  customTitle: string | null;
} {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.trim().split('\n');

  let firstPrompt: string | null = null;
  let lastPrompt: string | null = null;
  let customTitle: string | null = null;

  // 先頭から firstPrompt を探す（通常最初の数行にある）
  for (let i = 0; i < Math.min(lines.length, 10); i++) {
    try {
      const entry = JSON.parse(lines[i]);
      if (entry.type === 'queue-operation' && entry.operation === 'enqueue') {
        firstPrompt = typeof entry.content === 'string'
          ? entry.content.slice(0, 200)
          : JSON.stringify(entry.content).slice(0, 200);
        break;
      }
    } catch { /* skip malformed lines */ }
  }

  // 末尾から lastPrompt, customTitle を探す
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 10); i--) {
    try {
      const entry = JSON.parse(lines[i]);
      if (entry.type === 'last-prompt' && !lastPrompt) {
        lastPrompt = typeof entry.lastPrompt === 'string'
          ? entry.lastPrompt.slice(0, 200)
          : null;
      }
      if (entry.type === 'custom-title' && !customTitle) {
        customTitle = entry.customTitle;
      }
    } catch { /* skip malformed lines */ }
  }

  return { firstPrompt, lastPrompt, customTitle };
}
```

---

## I6: `.claude/projects/` の監視方式

### 選択肢の比較

| 観点 | a) chokidar (ファイルウォッチ) | b) ポーリング | c) オンデマンド |
|------|------|------|------|
| **リアルタイム性** | 即時（<100ms） | 遅延あり（ポーリング間隔依存） | ユーザー操作時のみ |
| **CPU負荷** | 低（OS通知ベース） | 間隔次第で中〜高 | ほぼゼロ |
| **メモリ負荷** | ファイル数に比例（実測2,096 JSONL → 約10-20MB） | 低 | 低 |
| **実装複雑度** | 中（イベントハンドリング、デバウンス必要） | 低 | 最低 |
| **スケーラビリティ** | macOS FSEvents: ディレクトリ単位で効率的 | ファイル数に比例して劣化 | ファイル数に無関係 |
| **ユースケース適合** | Slackリアルタイム通知に最適 | 妥協案 | 最小限で十分な場合 |

### 推奨: ハイブリッド方式（c + 限定的 a）

claude-slack-bridgeのユースケースでは、**オンデマンド（c）を基本とし、自分が起動したセッションのみウォッチ（a）する**のが最適。

**理由:**
1. ブリッジが `claude -p` で起動するセッションは stdout/stderr で直接出力を受け取るため、ログファイル監視は本来不要
2. プロジェクト一覧やセッション一覧は Home Tab 表示時にオンデマンド取得で十分
3. 外部（ローカルターミナル等）で実行されたセッションのリアルタイム反映は Phase 2 の機能

```typescript
// Phase 1: オンデマンド（MVP）
class ProjectStore {
  private cache: Map<string, { data: ProjectInfo[]; fetchedAt: number }> = new Map();
  private readonly CACHE_TTL_MS = 30_000; // 30秒キャッシュ

  async getProjects(): Promise<ProjectInfo[]> {
    const cached = this.cache.get('projects');
    if (cached && Date.now() - cached.fetchedAt < this.CACHE_TTL_MS) {
      return cached.data;
    }

    const projects = listProjects();
    this.cache.set('projects', { data: projects, fetchedAt: Date.now() });
    return projects;
  }

  invalidate(): void {
    this.cache.clear();
  }
}

// Phase 2: アクティブセッションの出力はspawnのstdoutで取得
// → ファイル監視は不要。stdoutストリームを直接パースする。
```

### スケーラビリティ考慮

- 実測: 24プロジェクト、2,096セッションファイル、合計971MB
- セッション一覧取得時に全ファイルを `readFileSync` するのは非現実的
- **解決策**: `fs.statSync` でメタデータのみ取得し、内容は個別セッション選択時に遅延ロード

```typescript
// 軽量一覧: stat のみ（ファイル内容読まない）
function listSessionsLight(projectId: string): SessionInfoLight[] {
  const projectDir = path.join(CLAUDE_PROJECTS_DIR, projectId);
  return fs.readdirSync(projectDir)
    .filter(f => /^[0-9a-f]{8}-.*\.jsonl$/i.test(f))
    .map(file => {
      const stat = fs.statSync(path.join(projectDir, file));
      return {
        sessionId: file.replace('.jsonl', ''),
        updatedAt: stat.mtime,
        sizeBytes: stat.size,
      };
    })
    .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
}

// 詳細取得: 選択されたセッションのみ先頭/末尾読み
function getSessionDetail(projectId: string, sessionId: string): SessionInfo {
  // ... extractSessionMeta を使う
}
```

---

## I7: セッションログのパース

### パース戦略

`claude-code-viewer` は `zod` を使った厳密なスキーマ検証を採用しているが、claude-slack-bridge では **必要最小限のフィールドだけを抽出する軽量パーサー** が適切。

理由:
1. ブリッジは主に `claude -p --output-format json` の stdout を受け取るため、JSONL ログの直接パースは補助的な役割
2. 過剰な型検証はパフォーマンスコスト
3. Claude Code のバージョンアップでフィールドが追加されても壊れないよう、未知フィールドは無視する

### TypeScript 型定義

```typescript
// ========== 基本エントリ型 ==========

interface BaseEntry {
  type: string;
  uuid: string;
  parentUuid: string | null;
  timestamp: string;
  sessionId: string;
  isSidechain: boolean;
  cwd: string;
  version: string;
  gitBranch?: string;
}

// ========== エントリタイプ ==========

interface QueueOperationEntry {
  type: 'queue-operation';
  operation: 'enqueue' | 'dequeue' | 'remove' | 'popAll';
  content?: string | unknown[];
  sessionId: string;
  timestamp: string;
}

interface UserEntry extends BaseEntry {
  type: 'user';
  message: {
    role: 'user';
    content: string | UserMessageContent[];
  };
}

interface AssistantEntry extends BaseEntry {
  type: 'assistant';
  requestId?: string;
  message: {
    id: string;
    role: 'assistant';
    model: string;
    content: AssistantMessageContent[];
    stop_reason: string | null;
    usage: TokenUsage;
  };
}

interface SystemEntry extends BaseEntry {
  type: 'system';
  subtype?: 'turn_duration' | 'api_error' | 'stop_hook_summary'
           | 'local_command' | 'compact_boundary';
  durationMs?: number;
  content?: string;
}

interface LastPromptEntry {
  type: 'last-prompt';
  lastPrompt: string;
  sessionId: string;
}

interface CustomTitleEntry {
  type: 'custom-title';
  customTitle: string;
  sessionId: string;
}

interface SummaryEntry {
  type: 'summary';
  summary: string;
  leafUuid: string;
}

interface ProgressEntry extends BaseEntry {
  type: 'progress';
  data: Record<string, unknown>;
  toolUseID?: string;
}

interface FileHistorySnapshotEntry extends BaseEntry {
  type: 'file-history-snapshot';
}

// ========== コンテンツ型 ==========

type UserMessageContent =
  | string
  | { type: 'text'; text: string }
  | { type: 'tool_result'; tool_use_id: string; content: string | unknown[]; is_error?: boolean }
  | { type: 'image'; source: unknown }
  | { type: 'document'; source: unknown };

type AssistantMessageContent =
  | { type: 'thinking'; thinking: string; signature?: string }
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string | unknown[]; is_error?: boolean };

// ========== トークン使用量 ==========

interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation?: {
    ephemeral_5m_input_tokens: number;
    ephemeral_1h_input_tokens: number;
  };
  service_tier?: string | null;
}

// ========== 統合型 ==========

type SessionEntry =
  | QueueOperationEntry
  | UserEntry
  | AssistantEntry
  | SystemEntry
  | LastPromptEntry
  | CustomTitleEntry
  | SummaryEntry
  | ProgressEntry
  | FileHistorySnapshotEntry;
```

### セッションログから抽出すべき情報と用途

| 抽出対象 | ソース | Slack UIでの用途 |
|----------|--------|------------------|
| ユーザーメッセージ | `user` エントリの `message.content` | 会話履歴表示 |
| アシスタント応答テキスト | `assistant` エントリの `content[type=text]` | 会話履歴表示 |
| ツール呼び出し | `assistant` エントリの `content[type=tool_use]` | ツール使用の可視化 |
| トークン使用量 | `assistant` エントリの `message.usage` | コスト表示 |
| セッション時間 | `system[subtype=turn_duration]` の `durationMs` | パフォーマンス表示 |
| APIエラー | `system[subtype=api_error]` | エラー通知 |
| セッションタイトル | `custom-title` or 最初の `queue-operation(enqueue)` | セッション一覧 |
| 最後のプロンプト | `last-prompt` | セッション再開時の文脈 |

### 軽量パーサー実装

```typescript
function parseSessionLine(line: string): SessionEntry | null {
  try {
    const raw = JSON.parse(line);
    // type フィールドの存在だけチェックし、不明な type は null で返す
    if (!raw.type) return null;

    // 必要なフィールドだけ保持（メモリ効率）
    switch (raw.type) {
      case 'user':
        return {
          type: 'user',
          uuid: raw.uuid,
          parentUuid: raw.parentUuid,
          timestamp: raw.timestamp,
          sessionId: raw.sessionId,
          isSidechain: raw.isSidechain ?? false,
          cwd: raw.cwd,
          version: raw.version,
          message: raw.message,
        } as UserEntry;
      case 'assistant':
        return {
          type: 'assistant',
          uuid: raw.uuid,
          parentUuid: raw.parentUuid,
          timestamp: raw.timestamp,
          sessionId: raw.sessionId,
          isSidechain: raw.isSidechain ?? false,
          cwd: raw.cwd,
          version: raw.version,
          requestId: raw.requestId,
          message: raw.message,
        } as AssistantEntry;
      case 'last-prompt':
        return raw as LastPromptEntry;
      case 'custom-title':
        return raw as CustomTitleEntry;
      case 'queue-operation':
        return raw as QueueOperationEntry;
      default:
        return raw as SessionEntry;
    }
  } catch {
    return null;
  }
}

/** 会話表示用: user と assistant のみ抽出（sidechain除外） */
function extractConversation(filePath: string): (UserEntry | AssistantEntry)[] {
  const content = fs.readFileSync(filePath, 'utf-8');
  return content
    .trim()
    .split('\n')
    .map(parseSessionLine)
    .filter((e): e is UserEntry | AssistantEntry =>
      e !== null &&
      (e.type === 'user' || e.type === 'assistant') &&
      !e.isSidechain
    );
}

/** コスト計算用 */
function calculateSessionCost(entries: AssistantEntry[]): {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheCreationTokens: number;
  totalCacheReadTokens: number;
  estimatedCostUsd: number;
} {
  let totalInput = 0, totalOutput = 0, totalCacheCreate = 0, totalCacheRead = 0;

  for (const entry of entries) {
    const u = entry.message.usage;
    totalInput += u.input_tokens;
    totalOutput += u.output_tokens;
    totalCacheCreate += u.cache_creation_input_tokens ?? 0;
    totalCacheRead += u.cache_read_input_tokens ?? 0;
  }

  // Sonnet 4 pricing (例): input $3/MTok, output $15/MTok
  // 実際のモデル別料金は設定で管理すべき
  const estimatedCostUsd =
    (totalInput * 3 + totalOutput * 15 + totalCacheCreate * 3.75 + totalCacheRead * 0.3) / 1_000_000;

  return { totalInputTokens: totalInput, totalOutputTokens: totalOutput,
           totalCacheCreationTokens: totalCacheCreate, totalCacheReadTokens: totalCacheRead,
           estimatedCostUsd };
}
```

---

## I8: 同時実行制御、コスト制限、プロセス管理

### アーキテクチャ: プロセスマネージャー

```
┌─────────────────────────────────────────────────┐
│                  Slack Bolt App                  │
│   (Socket Mode - メッセージ受信)                  │
└───────────────┬─────────────────────────────────┘
                │
                ▼
┌─────────────────────────────────────────────────┐
│              ProcessManager                      │
│  ┌─────────────────────────────────────────┐    │
│  │  activeProcesses: Map<sessionId, Proc>  │    │
│  │  userSessions: Map<userId, sessionId[]> │    │
│  └─────────────────────────────────────────┘    │
│                                                  │
│  ・同時実行数制御                                 │
│  ・タイムアウト管理                               │
│  ・キャンセル処理                                 │
│  ・コスト制限パラメータ注入                        │
└───────────────┬─────────────────────────────────┘
                │ spawn
                ▼
┌─────────────────────────────────────────────────┐
│          claude -p --output-format json           │
│          --session-id <uuid>                      │
│          --max-budget-usd <limit>                 │
│          --permission-mode auto                   │
│          --allowedTools <whitelist>                │
└─────────────────────────────────────────────────┘
```

### インメモリプロセス管理

```typescript
import { ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

interface ManagedProcess {
  sessionId: string;
  userId: string;          // Slack User ID
  channelId: string;       // Slack Channel/DM ID
  projectId: string;       // プロジェクトディレクトリ名
  process: ChildProcess;
  startedAt: Date;
  timeoutTimer: NodeJS.Timeout;
  status: 'running' | 'completing' | 'cancelled' | 'timed-out';
  budgetUsd: number;
}

interface ProcessManagerConfig {
  maxConcurrentPerUser: number;    // ユーザーあたりの同時実行数上限
  maxConcurrentGlobal: number;     // グローバル同時実行数上限
  defaultTimeoutMs: number;        // デフォルトタイムアウト
  maxTimeoutMs: number;            // 最大タイムアウト
  defaultBudgetUsd: number;        // デフォルトコスト上限
  maxBudgetUsd: number;            // 最大コスト上限
}

const DEFAULT_CONFIG: ProcessManagerConfig = {
  maxConcurrentPerUser: 1,    // MVP: ユーザーあたり1セッション
  maxConcurrentGlobal: 3,     // ローカルPC負荷を考慮
  defaultTimeoutMs: 5 * 60 * 1000,  // 5分
  maxTimeoutMs: 30 * 60 * 1000,     // 30分
  defaultBudgetUsd: 1.0,
  maxBudgetUsd: 10.0,
};

class ProcessManager {
  private processes: Map<string, ManagedProcess> = new Map();
  private config: ProcessManagerConfig;

  constructor(config: Partial<ProcessManagerConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /** 実行中プロセス数の取得 */
  getActiveCount(): number {
    return [...this.processes.values()]
      .filter(p => p.status === 'running').length;
  }

  getUserActiveCount(userId: string): number {
    return [...this.processes.values()]
      .filter(p => p.userId === userId && p.status === 'running').length;
  }

  /** 新規セッション開始 */
  async startSession(params: {
    userId: string;
    channelId: string;
    projectPath: string;
    prompt: string;
    sessionId?: string;   // 再開時に指定
    budgetUsd?: number;
    timeoutMs?: number;
  }): Promise<{ sessionId: string } | { error: string }> {
    // 同時実行チェック
    if (this.getUserActiveCount(params.userId) >= this.config.maxConcurrentPerUser) {
      return { error: `同時実行上限（${this.config.maxConcurrentPerUser}）に達しています。実行中のセッションを終了してください。` };
    }
    if (this.getActiveCount() >= this.config.maxConcurrentGlobal) {
      return { error: `システム全体の同時実行上限（${this.config.maxConcurrentGlobal}）に達しています。しばらくお待ちください。` };
    }

    const sessionId = params.sessionId ?? randomUUID();
    const isResume = !!params.sessionId;
    const budgetUsd = Math.min(
      params.budgetUsd ?? this.config.defaultBudgetUsd,
      this.config.maxBudgetUsd
    );
    const timeoutMs = Math.min(
      params.timeoutMs ?? this.config.defaultTimeoutMs,
      this.config.maxTimeoutMs
    );

    // Claude CLI引数の組み立て
    const args = [
      '-p', params.prompt,
      '--output-format', 'json',
      '--permission-mode', 'auto',
      '--max-budget-usd', budgetUsd.toString(),
    ];

    if (isResume) {
      args.push('-r', sessionId);
    } else {
      args.push('--session-id', sessionId);
    }

    // allowedTools（I9で詳述）
    const allowedTools = getAllowedTools();
    if (allowedTools.length > 0) {
      args.push('--allowedTools', ...allowedTools);
    }

    const child = spawn('claude', args, {
      cwd: params.projectPath,
      env: {
        ...process.env,
        CLAUDECODE: 'undefined',  // VSCode拡張連携を無効化
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // タイムアウトタイマー
    const timeoutTimer = setTimeout(() => {
      this.cancelSession(sessionId, 'timeout');
    }, timeoutMs);

    const managed: ManagedProcess = {
      sessionId,
      userId: params.userId,
      channelId: params.channelId,
      projectId: projectPathToDirectoryName(params.projectPath),
      process: child,
      startedAt: new Date(),
      timeoutTimer,
      status: 'running',
      budgetUsd,
    };

    this.processes.set(sessionId, managed);

    // プロセス終了ハンドリング
    child.on('exit', (code, signal) => {
      clearTimeout(timeoutTimer);
      this.processes.delete(sessionId);
    });

    return { sessionId };
  }

  /** セッションのキャンセル */
  cancelSession(
    sessionId: string,
    reason: 'user' | 'timeout' | 'shutdown' = 'user'
  ): boolean {
    const managed = this.processes.get(sessionId);
    if (!managed || managed.status !== 'running') return false;

    managed.status = reason === 'timeout' ? 'timed-out' : 'cancelled';
    clearTimeout(managed.timeoutTimer);

    // 段階的終了: まず SIGTERM、5秒後に SIGKILL
    managed.process.kill('SIGTERM');
    setTimeout(() => {
      if (!managed.process.killed) {
        managed.process.kill('SIGKILL');
      }
    }, 5000);

    return true;
  }

  /** 全セッションの終了（シャットダウン時） */
  async shutdown(): Promise<void> {
    const promises: Promise<void>[] = [];
    for (const [sessionId] of this.processes) {
      this.cancelSession(sessionId, 'shutdown');
      promises.push(
        new Promise<void>(resolve => {
          const managed = this.processes.get(sessionId);
          if (managed) {
            managed.process.on('exit', () => resolve());
          } else {
            resolve();
          }
        })
      );
    }
    await Promise.allSettled(promises);
  }

  /** ステータス取得（Slack表示用） */
  getStatus(): {
    active: Array<{
      sessionId: string;
      userId: string;
      runningFor: number;
      budgetUsd: number;
    }>;
    totalActive: number;
  } {
    const active = [...this.processes.values()]
      .filter(p => p.status === 'running')
      .map(p => ({
        sessionId: p.sessionId,
        userId: p.userId,
        runningFor: Date.now() - p.startedAt.getTime(),
        budgetUsd: p.budgetUsd,
      }));

    return { active, totalActive: active.length };
  }
}
```

### 同時実行の方針

| 方針 | MVP | Phase 2 |
|------|-----|---------|
| ユーザーあたり同時実行数 | **1**（キュー不要、シンプル） | 2-3（キュー追加） |
| グローバル同時実行数 | **3** | 設定可能 |
| 同時実行超過時 | エラーメッセージ返却 | キューイング |

**MVP では 1 ユーザー 1 セッションに制限する理由:**
- ローカルPCのリソース制約（CPU、メモリ、API rate limit）
- Claude Code の `claude -p` は1プロセスでもかなりのリソースを消費
- ユーザー体験としてもシングルスレッドの方がわかりやすい

### タイムアウト戦略

```
               ┌──── Warning (4分) ────┐
               │                       │
    Start ─────┼───────────────────────┼──── Timeout (5分) ──── SIGTERM ──── 5s ──── SIGKILL
               │                       │
               └───── Slack通知 ────────┘
```

```typescript
// タイムアウト警告の実装
const WARNING_BEFORE_TIMEOUT_MS = 60_000; // 1分前に警告

function setupTimeoutWarning(
  managed: ManagedProcess,
  timeoutMs: number,
  slackClient: WebClient
): void {
  const warningMs = timeoutMs - WARNING_BEFORE_TIMEOUT_MS;
  if (warningMs > 0) {
    setTimeout(async () => {
      if (managed.status === 'running') {
        await slackClient.chat.postMessage({
          channel: managed.channelId,
          text: `\u26a0\ufe0f セッション \`${managed.sessionId.slice(0, 8)}...\` があと1分でタイムアウトします。`,
        });
      }
    }, warningMs);
  }
}
```

---

## I9: セキュリティ

### 1. Botを使えるユーザーの制限

```typescript
interface SecurityConfig {
  /** 許可されたSlackユーザーIDのリスト（空=全員許可） */
  allowedUserIds: string[];
  /** 許可されたSlackワークスペースID */
  allowedTeamIds: string[];
  /** 管理者ユーザーID（設定変更等が可能） */
  adminUserIds: string[];
}

// 環境変数から読み込み
function loadSecurityConfig(): SecurityConfig {
  return {
    allowedUserIds: (process.env.ALLOWED_USER_IDS ?? '')
      .split(',').filter(Boolean),
    allowedTeamIds: (process.env.ALLOWED_TEAM_IDS ?? '')
      .split(',').filter(Boolean),
    adminUserIds: (process.env.ADMIN_USER_IDS ?? '')
      .split(',').filter(Boolean),
  };
}

// ミドルウェアとして実装
function authMiddleware(config: SecurityConfig) {
  return async ({ message, next, client }: {
    message: any;
    next: () => Promise<void>;
    client: WebClient;
  }) => {
    const userId = message.user;
    const teamId = message.team;

    // ワークスペースチェック
    if (config.allowedTeamIds.length > 0 && !config.allowedTeamIds.includes(teamId)) {
      return; // 無視（エラー応答もしない）
    }

    // ユーザーチェック
    if (config.allowedUserIds.length > 0 && !config.allowedUserIds.includes(userId)) {
      await client.chat.postMessage({
        channel: message.channel,
        text: 'このBotの使用は許可されていません。管理者に問い合わせてください。',
      });
      return;
    }

    await next();
  };
}
```

### 2. `--permission-mode auto` のリスクと軽減策

| リスク | 深刻度 | 軽減策 |
|--------|--------|--------|
| ファイルシステムへの無制限アクセス | **高** | `--allowedTools` でツール制限 |
| 任意のシェルコマンド実行 | **高** | `Bash` ツールの除外または制限 |
| ネットワークアクセス | **中** | `WebFetch` の除外 |
| 秘密情報の漏洩（.env等） | **高** | プロジェクトの `.claude/settings.local.json` で deny パターン設定 |
| 無限ループ/リソース消耗 | **中** | `--max-budget-usd` + タイムアウト |

**`--permission-mode auto` は本質的にローカルPC上で任意のコード実行を許可するものであり、信頼できるユーザーのみが使用すべき。** ブリッジ経由でこれを公開する場合、以下の多層防御が必須:

### 3. `--allowedTools` によるツールホワイトリスト

```typescript
type SecurityLevel = 'strict' | 'standard' | 'permissive';

function getAllowedTools(level: SecurityLevel = 'standard'): string[] {
  const toolSets: Record<SecurityLevel, string[]> = {
    // 読み取り専用: コードレビューや質問応答に最適
    strict: [
      'Read',
      'Glob',
      'Grep',
      'ToolSearch',
      // Bash, Write, Edit, WebFetch 等は除外
    ],

    // 標準: 開発作業（ファイル編集あり、シェル制限付き）
    standard: [
      'Read',
      'Write',
      'Edit',
      'Glob',
      'Grep',
      'Bash',        // シェルコマンド実行
      'ToolSearch',
      // WebFetch, Agent 等は除外
    ],

    // 制限なし（信頼できる管理者のみ）
    permissive: [],  // 空 = 全ツール許可
  };

  return toolSets[level];
}

// ユーザーごとのセキュリティレベル
function getUserSecurityLevel(userId: string, config: SecurityConfig): SecurityLevel {
  if (config.adminUserIds.includes(userId)) return 'permissive';
  return 'standard';
}
```

### 4. 環境変数による設定一覧

```bash
# .env ファイル

# === Slack設定 ===
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...      # Socket Mode用

# === セキュリティ ===
ALLOWED_USER_IDS=U12345,U67890          # カンマ区切り、空=全員許可
ALLOWED_TEAM_IDS=T12345                 # ワークスペース制限
ADMIN_USER_IDS=U12345                   # 管理者

# === Claude Code設定 ===
CLAUDE_EXECUTABLE=claude                # Claude CLIのパス
DEFAULT_PROJECT_PATH=/Users/me/dev      # デフォルトプロジェクトパス
CLAUDE_PROJECTS_DIR=~/.claude/projects  # プロジェクトデータディレクトリ

# === 実行制限 ===
MAX_CONCURRENT_PER_USER=1
MAX_CONCURRENT_GLOBAL=3
DEFAULT_TIMEOUT_MS=300000               # 5分
MAX_TIMEOUT_MS=1800000                  # 30分
DEFAULT_BUDGET_USD=1.0
MAX_BUDGET_USD=10.0

# === ツール制限 ===
DEFAULT_SECURITY_LEVEL=standard         # strict | standard | permissive
ALLOWED_TOOLS=Read,Write,Edit,Glob,Grep,Bash,ToolSearch  # カスタム指定時

# === ログ ===
LOG_LEVEL=info
```

### 5. 追加のセキュリティ考慮事項

```typescript
// プロンプトインジェクション対策
function sanitizeUserInput(input: string): string {
  // Slackのメンション等を処理
  return input
    .replace(/<@[A-Z0-9]+>/g, '[user-mention]')  // ユーザーメンション
    .replace(/<#[A-Z0-9]+\|[^>]+>/g, '[channel]') // チャンネルメンション
    .replace(/<(https?:\/\/[^|>]+)(\|[^>]+)?>/g, '$1'); // URLの展開
}

// 出力のサニタイズ（Slackに返す前）
function sanitizeOutput(output: string): string {
  // 環境変数や秘密情報のパターンを検出・マスク
  return output
    .replace(/(sk-[a-zA-Z0-9]{20,})/g, 'sk-***REDACTED***')
    .replace(/(xoxb-[a-zA-Z0-9-]+)/g, 'xoxb-***REDACTED***')
    .replace(/(xapp-[a-zA-Z0-9-]+)/g, 'xapp-***REDACTED***')
    .replace(/([A-Za-z0-9+/]{40,}={0,2})/g, (match) => {
      // Base64っぽい長い文字列はマスク候補
      // 誤検知を避けるためパスやコードは除外
      if (match.includes('/') || match.includes('.')) return match;
      return '***POSSIBLE_SECRET***';
    });
}

// レート制限
class RateLimiter {
  private requests: Map<string, number[]> = new Map();
  private readonly windowMs: number;
  private readonly maxRequests: number;

  constructor(windowMs = 60_000, maxRequests = 10) {
    this.windowMs = windowMs;
    this.maxRequests = maxRequests;
  }

  check(userId: string): boolean {
    const now = Date.now();
    const userRequests = this.requests.get(userId) ?? [];
    const recentRequests = userRequests.filter(t => now - t < this.windowMs);

    if (recentRequests.length >= this.maxRequests) {
      return false; // レート制限超過
    }

    recentRequests.push(now);
    this.requests.set(userId, recentRequests);
    return true;
  }
}
```

---

## 推奨アーキテクチャ図

```
┌──────────────────────────────────────────────────────────────────┐
│                         Slack Workspace                          │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐                      │
│  │ User DM  │  │ User DM  │  │ Home Tab │                      │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘                      │
└───────┼──────────────┼─────────────┼────────────────────────────┘
        │              │             │
        ▼              ▼             ▼
┌──────────────────────────────────────────────────────────────────┐
│                    Socket Mode Connection                        │
└───────────────────────────┬──────────────────────────────────────┘
                            │
                            ▼
┌──────────────────────────────────────────────────────────────────┐
│                      Bolt App (TypeScript)                       │
│                                                                  │
│  ┌─────────────────────┐   ┌──────────────────────────────────┐ │
│  │   Auth Middleware    │   │        Rate Limiter              │ │
│  │  - User allowlist   │   │  - Per-user request throttle     │ │
│  │  - Team check       │   │                                  │ │
│  └─────────┬───────────┘   └──────────────┬───────────────────┘ │
│            │                               │                     │
│            ▼                               ▼                     │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │                   Message Router                            │ │
│  │  - DM message → Session Handler                             │ │
│  │  - /cancel    → Cancel Handler                              │ │
│  │  - /status    → Status Handler                              │ │
│  │  - Home Tab   → ProjectStore (on-demand read)               │ │
│  └────────────────────────┬────────────────────────────────────┘ │
│                           │                                      │
│            ┌──────────────┼──────────────┐                       │
│            ▼              ▼              ▼                        │
│  ┌──────────────┐ ┌─────────────┐ ┌──────────────┐              │
│  │ProcessManager│ │ProjectStore │ │Output Sanitiz│              │
│  │              │ │(on-demand)  │ │              │              │
│  │ Map<id,Proc> │ │             │ │ - Secret mask│              │
│  │ Concurrency  │ │ .claude/    │ │ - Slack fmt  │              │
│  │ Timeout      │ │ projects/   │ │              │              │
│  │ Budget       │ │ read-only   │ │              │              │
│  └──────┬───────┘ └─────────────┘ └──────────────┘              │
│         │                                                        │
└─────────┼────────────────────────────────────────────────────────┘
          │ spawn / SIGTERM / SIGKILL
          ▼
┌──────────────────────────────────────────────────────────────────┐
│  claude -p "<prompt>"                                            │
│    --output-format json                                          │
│    --session-id <uuid> | -r <uuid>                               │
│    --permission-mode auto                                        │
│    --max-budget-usd <limit>                                      │
│    --allowedTools Read,Write,Edit,Glob,Grep,Bash,ToolSearch      │
│                                                                  │
│  env: CLAUDECODE=undefined                                       │
│  cwd: <project-path>                                             │
│  stdout → JSON応答 → Slack                                       │
│  stderr → エラーログ                                              │
└──────────────────────────────────────────────────────────────────┘
```

---

## 推奨実装の優先度

### MVP (Phase 1)

| 優先度 | 項目 | 理由 |
|--------|------|------|
| **P0** | ユーザー認証（allowlist） | セキュリティの基本 |
| **P0** | ProcessManager（単一実行制御） | コア機能 |
| **P0** | `--max-budget-usd` + タイムアウト | コスト・リソース保護 |
| **P0** | `--allowedTools` standard セット | セキュリティ基本 |
| **P0** | 出力サニタイズ（秘密情報マスク） | 情報漏洩防止 |
| **P1** | プロジェクト一覧のオンデマンド取得 | Home Tab表示 |
| **P1** | セッション一覧（statベース軽量版） | セッション再開 |
| **P1** | レート制限 | 乱用防止 |
| **P1** | キャンセル機能（SIGTERM） | ユーザー操作 |

### Phase 2

| 優先度 | 項目 | 理由 |
|--------|------|------|
| **P2** | セッションログの詳細パース | 会話履歴表示 |
| **P2** | コスト集計・表示 | コスト可視化 |
| **P2** | ユーザー別セキュリティレベル | 柔軟な権限管理 |
| **P2** | 複数同時実行対応 | パワーユーザー向け |
| **P3** | ファイルウォッチャー（外部セッション検知） | 高度な機能 |
| **P3** | プロンプトインジェクション検知 | 高度なセキュリティ |

---

## 未解決のリスクと注意点

### 1. Claude Code CLIのバージョン依存性
- JONLログのスキーマは Claude Code のバージョンにより変化する（`claude-code-viewer` でも v2.0.28, v2.0.76, v2.1.0 等でスキーマ変更あり）
- **対策**: パーサーは未知のフィールド/type を無視し、必須フィールドのみに依存する
- `version` フィールドがエントリに含まれるため、バージョン別処理も可能

### 2. `--output-format json` の出力形式
- ブリッジは主に stdout の JSON 出力を使うが、この出力形式のスキーマが公式に文書化されているか要確認
- JSONL ログファイルとは別形式の可能性あり

### 3. `.claude/projects/` のディスク容量
- 実測で 971MB（24プロジェクト、2,096セッション）
- 長期運用でGBオーダーに膨張する可能性
- ブリッジ側では読み取りのみで、クリーンアップは Claude Code 本体またはユーザーに委ねる

### 4. セッションの同一性問題
- ブリッジが生成した `--session-id` と、ユーザーがローカルターミナルで使う session-id が競合する可能性
- **対策**: ブリッジ生成の session-id にプレフィックス（例: `slack-` は無効なUUID形式になるため不可）を使わず、ブリッジ側で管理する Map で自分が生成した session のみ追跡する

### 5. `--permission-mode auto` の根本的リスク
- Slack を経由して任意のコード実行が可能になる
- Slack アカウントが侵害された場合、ローカル PC への完全なアクセスを許すことになる
- **対策**: MFA 必須のワークスペース + 限定的な allowedTools + 厳格な allowlist

### 6. Slack メッセージサイズ制限
- Slack メッセージは最大 40,000 文字
- Claude の応答が長い場合の分割戦略が必要（`--output-format json` の結果パース後に分割）

### 7. プロセスのゾンビ化
- ブリッジ自体がクラッシュした場合、spawn した `claude` プロセスが残る
- **対策**: `process.on('exit')` / `process.on('SIGTERM')` で全子プロセスを kill する graceful shutdown の実装

```typescript
// Graceful shutdown
function setupGracefulShutdown(processManager: ProcessManager): void {
  const shutdown = async (signal: string) => {
    console.log(`Received ${signal}, shutting down...`);
    await processManager.shutdown();
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('uncaughtException', async (err) => {
    console.error('Uncaught exception:', err);
    await processManager.shutdown();
    process.exit(1);
  });
}
```
