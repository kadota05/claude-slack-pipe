# Round 1: Claude Code CLI セッションログ構造 実機調査レポート

調査日: 2026-03-15
調査環境: macOS Darwin 25.3.0, Claude Code CLI v2.1.63-v2.1.72

---

## 1. `.claude/` ディレクトリ全体構造

```
~/.claude/
├── .credentials.json          # 認証情報
├── CLAUDE.md                  # グローバルユーザー指示
├── backups/                   # バックアップ
├── cache/                     # キャッシュ
├── file-history/              # ファイル変更履歴
├── history.jsonl              # ユーザー入力履歴（全プロジェクト横断）
├── mcp-needs-auth-cache.json  # MCP認証キャッシュ
├── paste-cache/               # ペースト内容キャッシュ
├── plans/                     # プラン
├── plugins/                   # プラグイン
├── projects/                  # ★ プロジェクト別セッションログ（主要対象）
├── session-env/               # セッション環境変数（セッションIDディレクトリ, 中身は空）
├── sessions/                  # 実行中セッションのPID管理
├── settings.json              # ユーザー設定
├── settings.local.json        # ローカル設定
├── shell-snapshots/           # シェルスナップショット
├── skills/                    # スキル
├── tasks/                     # タスク管理
└── telemetry/                 # テレメトリ
```

### `sessions/` ディレクトリ（実行中セッション管理）

```json
// ~/.claude/sessions/55757.json（ファイル名はPID）
{"pid":55757,"sessionId":"eca032b3-b763-4e12-adba-e9f27d97be69","cwd":"/Users/archeco055/dev/Discussion","startedAt":1773581272435}
```

- **PID番号をファイル名**にしたJSONファイル
- 実行中のClaude Codeプロセスとセッションの紐づけ
- `startedAt`: Unixタイムスタンプ（ミリ秒）

### `history.jsonl`（ユーザー入力履歴）

```json
{
  "display": "以下のフォルダ構成をdevフォルダ下に作ってください。",
  "pastedContents": {"1": {"id": 1, "type": "text", "content": "..."}},
  "timestamp": 1771404815078,
  "project": "C:\\Users\\ryo62",
  "sessionId": "0d06f16b-ebb8-4ace-9477-17eea57474db"
}
```

- JSONL形式、ユーザーの全入力を時系列で記録
- `pastedContents`: ペーストされたテキスト/画像の内容（大きい場合は `contentHash` のみ）
- `project`: プロジェクトパス（フルパス）
- `sessionId`: 対応するセッションUUID

---

## 2. `projects/` ディレクトリ構造

### 2.1 ディレクトリ名のマッピング規則

パスの区切り文字 `/` および `\` を `-` に置換し、先頭に `-` を付与。

| 実パス | ディレクトリ名 |
|--------|--------------|
| `/Users/archeco055/dev/Discussion` | `-Users-archeco055-dev-Discussion` |
| `/Users/archeco055` | `-Users-archeco055` |
| `/Users` | `-Users` |
| `/private/tmp` | `-private-tmp` |

### 2.2 プロジェクトディレクトリ内の構造

```
~/.claude/projects/-Users-archeco055-dev-Discussion/
├── memory/                                        # プロジェクト別メモリ
│   ├── MEMORY.md
│   ├── user_apple.md
│   └── user_banana.md
├── <session-uuid>.jsonl                           # ★ セッションログ本体
├── <session-uuid>/                                # セッション付随ディレクトリ（任意）
│   ├── subagents/                                 # サブエージェントのログ
│   │   └── agent-<hash>.jsonl
│   └── tool-results/                              # 大きなツール結果の外部保存
│       ├── <hash>.txt
│       └── mcp-<tool-name>-<timestamp>.txt
└── e49b99d3-c41b-4e57-8311-96a1fa1a1c60.jsonl    # 例: UUIDのJSONLセッションログ
```

### 2.3 セッションファイルの命名規則

- **メインセッション**: `<uuid>.jsonl` (例: `0ea55c12-f9be-47b0-8909-fc9ec9780c9b.jsonl`)
- **サブエージェント**: `agent-<hex-hash>.jsonl` (例: `agent-a0947c7de0c5aa224.jsonl`)
- **ツール結果**: `<hash>.txt` または `toolu_<id>.txt` または `mcp-<tool>-<timestamp>.txt`

判別ロジック（claude-code-viewerと一致）:
```typescript
const isRegularSessionFile = (filename: string): boolean =>
  filename.endsWith(".jsonl") && !filename.startsWith("agent-");
```

---

## 3. セッションログ (JSONL) フォーマット仕様

### 3.1 概要

- **形式**: JSONL（1行1JSON）
- **エンコーディング**: UTF-8
- **各行は独立したイベント**で、`type` フィールドで種別を判別

### 3.2 メッセージtype一覧と出現頻度（実測値）

| type | 説明 | 典型的な出現比率 |
|------|------|-----------------|
| `progress` | 処理進捗（フック、エージェント、Bash実行等） | 最多（~66%） |
| `assistant` | AIの応答メッセージ | ~17% |
| `user` | ユーザーの入力メッセージ | ~11% |
| `file-history-snapshot` | ファイル変更スナップショット | ~3% |
| `queue-operation` | メッセージキュー操作（enqueue/dequeue） | ~2% |
| `system` | システムイベント（ターン終了、コンパクト等） | ~1% |
| `summary` | コンパクト後のサマリー | 稀 |
| `custom-title` | カスタムタイトル設定 | 稀 |
| `agent-name` | エージェント名設定 | 稀 |

### 3.3 共通フィールド（BaseEntry）

全メッセージタイプに共通するフィールド:

```json
{
  "parentUuid": "uuid-or-null",       // 親メッセージのUUID（会話ツリー構造）
  "isSidechain": false,               // サイドチェーン（分岐）かどうか
  "userType": "external",             // 常に "external"
  "cwd": "/path/to/project",          // 現在の作業ディレクトリ
  "sessionId": "uuid",                // セッションUUID
  "version": "2.1.63",                // Claude Code CLIバージョン
  "uuid": "uuid",                     // このメッセージ固有のUUID
  "timestamp": "2026-03-03T06:10:36.103Z",  // ISO 8601形式
  "gitBranch": "HEAD",                // Gitブランチ（optional）
  "isMeta": false,                    // メタ情報かどうか（optional）
  "agentId": "string",                // エージェントID（optional）
  "isCompactSummary": false           // コンパクトサマリーか（optional）
}
```

### 3.4 各typeのフォーマット詳細

#### (A) `type: "user"` - ユーザーメッセージ

```json
{
  "type": "user",
  "message": {
    "role": "user",
    "content": "テキストまたは配列"
  }
}
```

`message.content` は以下のいずれか:
- `string`: プレーンテキスト
- `Array<string | TextContent | ToolResultContent | ImageContent | DocumentContent>`

**ToolResultContent (ユーザーメッセージ内)**:
```json
{
  "type": "tool_result",
  "tool_use_id": "toolu_017J6FuMbheLtyseP8FGXX2o",
  "content": "Launching skill: superpowers:brainstorming"
}
```

#### (B) `type: "assistant"` - アシスタント応答

```json
{
  "type": "assistant",
  "requestId": "string (optional)",
  "message": {
    "model": "claude-opus-4-6",
    "id": "msg_01FViYmwUYrtcsG34xdKcDCy",
    "type": "message",
    "role": "assistant",
    "content": [
      {"type": "thinking", "thinking": "...", "signature": "..."},
      {"type": "text", "text": "..."},
      {"type": "tool_use", "id": "toolu_xxx", "name": "Read", "input": {"file_path": "..."}}
    ],
    "stop_reason": "end_turn",
    "stop_sequence": null,
    "usage": {
      "input_tokens": 3,
      "cache_creation_input_tokens": 37835,
      "cache_read_input_tokens": 10786,
      "cache_creation": {
        "ephemeral_5m_input_tokens": 0,
        "ephemeral_1h_input_tokens": 37835
      },
      "output_tokens": 9,
      "service_tier": "standard",
      "inference_geo": "not_available"
    }
  }
}
```

**contentの種類**（実測: tool_use 82回、text 43回、thinking 29回）:
- `thinking`: 思考プロセス（Extended Thinking） - `thinking`, `signature` フィールド
- `text`: テキスト応答 - `text` フィールド
- `tool_use`: ツール呼び出し - `id`, `name`, `input`, `caller`(optional) フィールド

**観測されたツール名**: `Read`, `Edit`, `Bash`, `Grep`, `Glob`, `Agent`, `Skill`, `TaskCreate`, `TaskUpdate`, `TaskOutput`, `AskUserQuestion`

**usage フィールド**: コスト計算に必要なトークン数を完全に記録。
実測値（1セッション合計）: input_tokens=3,281 / output_tokens=89,110 / cache_creation=1,533,001 / cache_read=11,918,122

#### (C) `type: "system"` - システムイベント

`subtype` で細分化（実測: turn_duration 115回、stop_hook_summary 38回、compact_boundary 25回、local_command 11回）:

**turn_duration** (ターン所要時間):
```json
{
  "type": "system",
  "subtype": "turn_duration",
  "durationMs": 1823542,
  "slug": "splendid-strolling-tome",
  "timestamp": "2026-03-03T06:54:37.730Z"
}
```

**compact_boundary** (コンパクト境界):
```json
{
  "type": "system",
  "subtype": "compact_boundary",
  "content": "Conversation compacted",
  "level": "info",
  "logicalParentUuid": "uuid",
  "compactMetadata": {
    "trigger": "manual | auto",
    "preTokens": 141085
  }
}
```

**stop_hook_summary** (フック実行サマリー):
```json
{
  "type": "system",
  "subtype": "stop_hook_summary",
  "hookCount": 1,
  "hookInfos": [],
  "preventedContinuation": false
}
```

**local_command** (ローカルコマンド実行):
```json
{
  "type": "system",
  "subtype": "local_command",
  "content": "<local-command-stdout>...</local-command-stdout>",
  "level": "info"
}
```

**api_error** (APIエラー):
```json
{
  "type": "system",
  "subtype": "api_error",
  "statusCode": 529,
  "requestId": "...",
  "retryInfo": {...}
}
```

#### (D) `type: "progress"` - 進捗イベント

`data.type` で細分化（実測: agent_progress 347回、bash_progress 223回、hook_progress 34回、waiting_for_task 8回）:

```json
{
  "type": "progress",
  "data": {
    "type": "hook_progress",
    "hookEvent": "SessionStart",
    "hookName": "SessionStart:startup",
    "command": "..."
  },
  "toolUseID": "uuid",
  "parentToolUseID": "uuid"
}
```

#### (E) `type: "file-history-snapshot"` - ファイル履歴スナップショット

```json
{
  "type": "file-history-snapshot",
  "messageId": "uuid",
  "snapshot": {
    "messageId": "uuid",
    "trackedFileBackups": {},
    "timestamp": "2026-03-03T06:18:20.387Z"
  },
  "isSnapshotUpdate": false
}
```

#### (F) `type: "queue-operation"` - キュー操作

```json
{
  "type": "queue-operation",
  "operation": "enqueue",
  "timestamp": "2026-03-03T06:22:38.894Z",
  "sessionId": "uuid",
  "content": "ユーザーが入力キューに追加したテキスト"
}
```

#### (G) `type: "summary"` - コンパクトサマリー

```json
{
  "type": "summary",
  "summary": "会話のサマリーテキスト",
  "leafUuid": "uuid"
}
```

---

## 4. claude-code-viewer のパース実装分析

### 4.1 リポジトリ構成

GitHub: https://github.com/d-kimuson/claude-code-viewer

```
src/lib/conversation-schema/
├── index.ts                    # ConversationSchema (zodのunion型)
├── content/
│   ├── DocumentContentSchema.ts
│   ├── ImageContentSchema.ts
│   ├── TextContentSchema.ts
│   ├── ThinkingContentSchema.ts
│   ├── ToolResultContentSchema.ts
│   └── ToolUseContentSchema.ts
├── entry/
│   ├── BaseEntrySchema.ts      # 共通フィールド定義
│   ├── UserEntrySchema.ts
│   ├── AssistantEntrySchema.ts
│   ├── SystemEntrySchema.ts    # subtype別のunion
│   ├── ProgressEntrySchema.ts
│   ├── SummaryEntrySchema.ts
│   ├── FileHIstorySnapshotEntrySchema.ts
│   ├── QueueOperationEntrySchema.ts
│   ├── CustomTitleEntrySchema.ts
│   └── AgentNameEntrySchema.ts
├── message/
│   ├── UserMessageSchema.ts
│   └── AssistantMessageSchema.ts
└── tool/
    ├── CommonToolSchema.ts
    ├── StructuredPatchSchema.ts
    ├── TodoSchema.ts
    └── index.ts
```

### 4.2 セッション一覧の構築方法

`src/server/core/` のアーキテクチャ:

1. **プロジェクト列挙**: `projects/` 配下のディレクトリを列挙
2. **プロジェクトID**: `base64url` エンコードを使用（URLパラメータ用。ディスク上のハイフン置換とは別物）
   ```typescript
   // ディスク上のディレクトリ名からプロジェクトパスへの変換ではない
   export const encodeProjectId = (path: string): string =>
     Buffer.from(path, "utf-8").toString("base64url");
   ```
3. **セッションファイル判別**: `.jsonl` で終わり `agent-` で始まらないファイルがセッション
   ```typescript
   export const isRegularSessionFile = (filename: string): boolean =>
     filename.endsWith(".jsonl") && !filename.startsWith("agent-");
   ```
4. **セッションメタデータ算出** (`SessionMetaService`):
   - `messageCount`: メッセージ数
   - `firstUserMessage`: 最初のユーザーメッセージをパースして取得
   - コスト: 全assistantメッセージ + サブエージェントのusageを合算
   - `modelName`: 最後に使用されたモデル名

### 4.3 コスト計算ロジック

`calculateSessionCost.ts` + `aggregateTokenUsageAndCost.ts`:

- `normalizeModelName()`: モデル名を正規化（例: `claude-opus-4-5-20251101` -> `claude-opus-4.5`）
- モデル別の料金レート表（$/M tokens）でUSD換算
- サブエージェント (`agent-*.jsonl`) のトークンも合算対象
- トークンカテゴリ: input / output / cache_creation / cache_read の4種

### 4.4 プロジェクトメタデータ

```typescript
const projectMetaSchema = z.object({
  projectName: z.string().nullable(),
  projectPath: z.string().nullable(),
  sessionCount: z.number(),
});
```

### 4.5 セッションメタデータ

```typescript
const sessionMetaSchema = z.object({
  messageCount: z.number(),
  firstUserMessage: parsedUserMessageSchema,
  totalCostUsd: z.number(),
  costBreakdown: z.object({
    inputCostUsd: z.number(),
    outputCostUsd: z.number(),
    cacheCreationCostUsd: z.number(),
    cacheReadCostUsd: z.number(),
  }),
  totalTokens: z.object({
    inputTokens: z.number(),
    outputTokens: z.number(),
    cacheCreationTokens: z.number(),
    cacheReadTokens: z.number(),
  }),
  modelName: z.string().optional(),
});
```

---

## 5. パース用 TypeScript 型定義の提案

```typescript
// ========================================
// Content型
// ========================================

interface ThinkingContent {
  type: "thinking";
  thinking: string;
  signature: string;
}

interface TextContent {
  type: "text";
  text: string;
}

interface ToolUseContent {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
  caller?: string;
}

interface ToolResultContent {
  type: "tool_result";
  tool_use_id: string;
  content: string | Array<unknown>;
}

interface ImageContent {
  type: "image";
  source: { type: string; media_type: string; data: string };
}

interface DocumentContent {
  type: "document";
  source: { type: string; media_type: string; data: string };
}

type AssistantContentBlock = ThinkingContent | TextContent | ToolUseContent;
type UserContentBlock = string | TextContent | ToolResultContent | ImageContent | DocumentContent;

// ========================================
// Message型
// ========================================

interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  cache_creation?: {
    ephemeral_5m_input_tokens: number;
    ephemeral_1h_input_tokens: number;
  };
  service_tier?: string;
  inference_geo?: string;
  server_tool_use?: {
    web_search_requests?: number;
  };
}

interface AssistantMessage {
  model: string;
  id: string;
  type: "message";
  role: "assistant";
  content: AssistantContentBlock[];
  stop_reason: "end_turn" | "tool_use" | "max_tokens" | null;
  stop_sequence: string | null;
  usage: TokenUsage;
}

interface UserMessage {
  role: "user";
  content: string | UserContentBlock[];
}

// ========================================
// BaseEntry（共通フィールド）
// ========================================

interface BaseEntry {
  parentUuid: string | null;
  isSidechain: boolean;
  userType: "external";
  cwd: string;
  sessionId: string;
  version: string;
  uuid: string;
  timestamp: string; // ISO 8601
  gitBranch?: string;
  isMeta?: boolean;
  agentId?: string;
  isCompactSummary?: boolean;
  toolUseResult?: unknown;
  logicalParentUuid?: string;
  slug?: string;
}

// ========================================
// Entry型（各type）
// ========================================

interface UserEntry extends BaseEntry {
  type: "user";
  message: UserMessage;
}

interface AssistantEntry extends BaseEntry {
  type: "assistant";
  message: AssistantMessage;
  requestId?: string;
  isApiErrorMessage?: boolean;
}

// --- System subtypes ---

interface TurnDurationEntry extends BaseEntry {
  type: "system";
  subtype: "turn_duration";
  durationMs: number;
}

interface CompactBoundaryEntry extends BaseEntry {
  type: "system";
  subtype: "compact_boundary";
  content: string;
  level: string;
  compactMetadata?: {
    trigger: "manual" | "auto";
    preTokens: number;
  };
}

interface StopHookSummaryEntry extends BaseEntry {
  type: "system";
  subtype: "stop_hook_summary";
  hookCount: number;
  hookInfos: unknown[];
  preventedContinuation: boolean;
}

interface LocalCommandEntry extends BaseEntry {
  type: "system";
  subtype: "local_command";
  content: string;
  level: string;
}

interface ApiErrorEntry extends BaseEntry {
  type: "system";
  subtype: "api_error";
  statusCode: number;
  requestId?: string;
}

type SystemEntry =
  | TurnDurationEntry
  | CompactBoundaryEntry
  | StopHookSummaryEntry
  | LocalCommandEntry
  | ApiErrorEntry;

// --- Progress ---

interface ProgressEntry extends BaseEntry {
  type: "progress";
  data: {
    type: "hook_progress" | "agent_progress" | "bash_progress" | "waiting_for_task";
    [key: string]: unknown;
  };
  toolUseID?: string;
  parentToolUseID?: string;
}

// --- その他 ---

interface FileHistorySnapshotEntry {
  type: "file-history-snapshot";
  messageId: string;
  snapshot: {
    messageId: string;
    trackedFileBackups: Record<string, unknown>;
    timestamp: string;
  };
  isSnapshotUpdate: boolean;
}

interface QueueOperationEntry {
  type: "queue-operation";
  operation: "enqueue" | "dequeue";
  timestamp: string;
  sessionId: string;
  content: string;
}

interface SummaryEntry {
  type: "summary";
  summary: string;
  leafUuid: string;
}

// ========================================
// Union型
// ========================================

type SessionLogEntry =
  | UserEntry
  | AssistantEntry
  | SystemEntry
  | ProgressEntry
  | FileHistorySnapshotEntry
  | QueueOperationEntry
  | SummaryEntry;

// ========================================
// メタデータ算出用の型
// ========================================

interface CostBreakdown {
  totalUsd: number;
  inputCostUsd: number;
  outputCostUsd: number;
  cacheCreationCostUsd: number;
  cacheReadCostUsd: number;
}

interface TokenSummary {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}

interface SessionMeta {
  sessionId: string;
  projectPath: string;
  firstUserMessage: string;
  messageCount: number;
  firstTimestamp: string;
  lastTimestamp: string;
  totalCost: CostBreakdown;
  totalTokens: TokenSummary;
  modelName: string | null;
  version: string;
  slug?: string;
}

interface ProjectMeta {
  projectName: string | null;
  projectPath: string | null;
  sessionCount: number;
}

// ========================================
// history.jsonl のエントリ型
// ========================================

interface HistoryEntry {
  display: string;
  pastedContents: Record<string, {
    id: number;
    type: "text" | "image";
    content?: string;
    contentHash?: string;
  }>;
  timestamp: number; // Unix ms
  project: string;   // フルパス
  sessionId: string;
}

// ========================================
// sessions/<pid>.json の型
// ========================================

interface ActiveSession {
  pid: number;
  sessionId: string;
  cwd: string;
  startedAt: number; // Unix ms
}
```

---

## 6. CLIの出力仕様

### 6.1 `claude -p --output-format json`

非インタラクティブモードの出力スキーマ:
```json
{
  "type": "result",
  "subtype": "success",
  "result": "応答テキスト",
  "session_id": "uuid",
  "total_cost_usd": 0.042,
  "duration_ms": 12345,
  "stop_reason": "end_turn"
}
```

### 6.2 セッション関連CLIフラグ

| フラグ | 説明 |
|--------|------|
| `--session-id <uuid>` | 指定UUIDでセッションを作成/再開 |
| `-r, --resume [value]` | セッションIDでresume、または対話的ピッカー |
| `-c, --continue` | 現在ディレクトリの最新セッションを再開 |
| `--fork-session` | resume時に新しいセッションIDで分岐 |
| `--from-pr [value]` | PRに紐づくセッションをresume |
| `-n, --name <name>` | セッションの表示名を設定 |
| `--no-session-persistence` | セッション永続化を無効化（`--print` 時のみ） |

### 6.3 セッション一覧取得

**CLIにセッション一覧を取得するサブコマンドは存在しない**。`claude sessions list` のようなコマンドは未実装。セッション一覧の取得には `~/.claude/projects/` のファイルシステムを直接走査する必要がある。

---

## 7. 発見した未文書の挙動と注意点

### 7.1 プロジェクトパスの逆変換が非可逆

ディレクトリ名 `-Users-archeco055-dev-test-Extractor` は以下のどちらか判別不能:
- `/Users/archeco055/dev/test-Extractor`（パスに `-` を含む）
- `/Users/archeco055/dev/test/Extractor`（別階層）

**対策**: セッションログ内の `cwd` フィールドにフルパスが記録されているため、最初のエントリの `cwd` を読めば正確なパスが取得可能。`history.jsonl` の `project` フィールドも利用可能。

### 7.2 `parentUuid` によるツリー構造

メッセージは `parentUuid` -> `uuid` でリンクリスト/ツリーを形成する。`compact_boundary` では `parentUuid` が `null` にリセットされ、代わりに `logicalParentUuid` で論理的な接続を保持する。

### 7.3 `slug` フィールド

`system` の `turn_duration` エントリに `slug` フィールド（例: `"splendid-strolling-tome"`）が含まれる。これはセッションの人間可読な識別子であり、`/resume` の対話的ピッカーで表示される。

### 7.4 `isSidechain` フラグ

会話の分岐（undo/redo等）を示す。パース時に `isSidechain: true` のエントリは「正規の会話フロー」から除外すべき場合がある。

### 7.5 `version` フィールドの活用

セッションログの各エントリに `version` が記録されているため、CLIバージョンアップによるフォーマット変更の検出に利用可能。調査環境では `2.1.49` から `2.1.72` までの範囲を確認。

### 7.6 ツール結果の外部保存

大きなツール出力は `<session-uuid>/tool-results/` ディレクトリに外部保存される。セッションログ内では参照のみが記録される可能性がある。MCP由来の結果は `mcp-<tool-name>-<timestamp>.txt` 形式。

### 7.7 `session-env/` ディレクトリ

セッションUUIDをディレクトリ名とする空ディレクトリが大量に存在（237個確認）。用途はセッション環境変数の保持と推測されるが、中身は空。セッションの存在証明として使える可能性がある。

### 7.8 コスト情報はログから算出のみ

CLIの `--output-format json` では `total_cost_usd` が出力されるが、セッションログファイルにはコストの合計値は記録されない。assistant メッセージの `usage` からサブエージェント分も含めて都度計算する必要がある。

### 7.9 hook_progress の hookEvent で新規/再開を判別

`hookName` フィールドで `SessionStart:startup`（新規）と `SessionStart:resume`（再開）の区別が可能。これによりセッションが新規作成か再開かを判別できる。

### 7.10 queue-operation の役割

ユーザーがアシスタントの応答中にメッセージを入力した場合、`enqueue` 操作でキューに蓄積され、ターン終了後に処理される。`content` フィールドにキューに入れられたメッセージ本文が含まれる。

### 7.11 file-history-snapshot と queue-operation は BaseEntry を継承しない

`file-history-snapshot` と `queue-operation` は共通フィールド（`parentUuid`, `cwd`, `version` 等）を持たない独自フォーマット。パーサー実装時にはこの点を考慮する必要がある。

### 7.12 セッションファイルのサイズ分布

Discussion プロジェクトで確認した範囲:
- 最小: ~1KB（hookのみで会話なし）
- 中央値: ~30-600KB
- 最大: ~9.4MB（長時間セッション）
- サブエージェント1ファイル: ~200-470KB
