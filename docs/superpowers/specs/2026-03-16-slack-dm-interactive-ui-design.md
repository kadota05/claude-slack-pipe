# Claude Code Slack Bridge - Slack DM インタラクティブUI設計書

作成日: 2026-03-16
ステータス: 確定（ブレインストーミング全決定事項の統合）

---

## 目次

1. [概要](#1-概要)
2. [アーキテクチャ](#2-アーキテクチャ)
3. [UI/UX設計](#3-uiux設計)
4. [データフロー](#4-データフロー)
5. [型定義](#5-型定義)
6. [Block Kit構成](#6-block-kit構成)
7. [セキュリティ](#7-セキュリティ)
8. [実装フェーズ](#8-実装フェーズ)

---

## 1. 概要

### 1.1 プロジェクトの目的

Claude Code CLI をSlack DM経由で操作するブリッジアプリケーション。ユーザーはSlack DMスレッド内でClaude Codeと対話し、App Home Tabでセッション管理を行う。

### 1.2 設計原則

- **DM専用**: チャンネルは使用しない。1セッション = 1 DMスレッド
- **インメモリ優先**: SQLite不要。`.claude/projects/` が唯一のデータソース
- **都度起動モデル**: `claude -p` を1プロンプト=1プロセスで起動
- **stream-json によるリアルタイム表示**: Agent SDK の `query()` で型安全なストリーム処理
- **モバイル対応**: テキストコマンド `cc /xxx` とBlock Kit UIの併用

### 1.3 技術スタック

| 要素 | 選択 |
|------|------|
| 言語 | TypeScript |
| Slackフレームワーク | Bolt for JS |
| 接続方式 | Socket Mode |
| Claude Code実行 | Agent SDK `query()` (primary) / CLI spawn (fallback) |
| ストリーミング | `--output-format stream-json --verbose` |
| 永続化 | インメモリ + `.claude/projects/` |

---

## 2. アーキテクチャ

### 2.1 システム構成図

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
│  │  - cc /xxx    → Command Handler                             │ │
│  │  - Actions    → Action Handler                              │ │
│  │  - Home Tab   → ProjectStore (on-demand read)               │ │
│  └────────────────────────┬────────────────────────────────────┘ │
│                           │                                      │
│            ┌──────────────┼──────────────┐                       │
│            ▼              ▼              ▼                        │
│  ┌──────────────┐ ┌─────────────┐ ┌──────────────┐              │
│  │ProcessManager│ │ProjectStore │ │StreamProcessor│             │
│  │              │ │(on-demand)  │ │               │              │
│  │ Map<id,Proc> │ │             │ │ - Throttler   │              │
│  │ Concurrency  │ │ .claude/    │ │ - BlockBuilder│              │
│  │ Timeout      │ │ projects/   │ │ - ToolSummary │              │
│  │ Budget       │ │ read-only   │ │               │              │
│  └──────┬───────┘ └─────────────┘ └──────────────┘              │
│         │                                                        │
└─────────┼────────────────────────────────────────────────────────┘
          │ Agent SDK query() / spawn
          ▼
┌──────────────────────────────────────────────────────────────────┐
│  claude -p "<prompt>"                                            │
│    --output-format stream-json --verbose                         │
│    --session-id <uuid> | -r <uuid>                               │
│    --permission-mode bypassPermissions                           │
│    --model <model-short-name>                                    │
│    --max-budget-usd <limit>                                      │
│                                                                  │
│  env: CLAUDECODE=undefined                                       │
│  cwd: <project-path>                                             │
└──────────────────────────────────────────────────────────────────┘
```

### 2.2 ディレクトリ構造

```
claude-slack-bridge/
├── src/
│   ├── index.ts
│   ├── config.ts
│   ├── types.ts
│   │
│   ├── slack/
│   │   ├── event-handler.ts       # DMメッセージ、アクション処理
│   │   ├── command-parser.ts      # cc /xxx テキストコマンドパーサー
│   │   ├── response-builder.ts    # 応答メッセージ構築
│   │   ├── block-builder.ts       # Block Kit JSON生成
│   │   ├── throttler.ts           # chat.update throttling
│   │   ├── tool-summarizer.ts     # ツール使用サマリー生成
│   │   └── modal-handler.ts       # モーダル interaction
│   │
│   ├── bridge/
│   │   ├── streaming-executor.ts  # Agent SDK ベース実行
│   │   ├── stream-processor.ts    # ストリーム処理ステートマシン
│   │   ├── executor.ts            # CLI spawn (fallback)
│   │   ├── session-manager.ts     # セッション管理
│   │   └── process-manager.ts     # プロセスライフサイクル管理
│   │
│   ├── store/
│   │   ├── project-store.ts       # .claude/projects/ 読み取り
│   │   ├── session-store.ts       # インメモリセッションメタデータ
│   │   └── tool-use-cache.ts      # モーダル表示用TTLキャッシュ
│   │
│   └── utils/
│       ├── logger.ts
│       ├── sanitizer.ts           # 入出力サニタイズ
│       └── errors.ts
│
├── tests/
│   ├── streaming-executor.test.ts
│   ├── stream-processor.test.ts
│   ├── block-builder.test.ts
│   ├── tool-summarizer.test.ts
│   ├── command-parser.test.ts
│   ├── session-manager.test.ts
│   └── response-builder.test.ts
│
├── package.json
├── tsconfig.json
└── .env.example
```

### 2.3 Claude Code実行モデル

**都度起動 (`claude -p`)**: 1プロンプト = 1プロセス。

- **新規セッション**: `--session-id <uuid>` でセッション作成
- **セッション継続**: `-r <uuid>` で既存セッションを再開
- **ストリーミング**: `--output-format stream-json --verbose` でリアルタイムイベント取得
- **ネスト防止**: spawn時に環境変数 `CLAUDECODE: undefined` を設定

### 2.4 プロジェクト検出

`.claude/projects/` ディレクトリから自動検出（事前登録不要）。

```
~/.claude/projects/
├── -Users-archeco055-dev-Discussion/    # パス変換: / → -
│   ├── <session-uuid>.jsonl             # セッションログ
│   ├── <session-uuid>/                  # 付随データ
│   │   ├── subagents/
│   │   └── tool-results/
│   └── memory/
│       └── MEMORY.md
├── -Users-archeco055-dev-Cowork/
└── ...
```

**パス変換規則**: `/Users/archeco055/dev/Discussion` → `-Users-archeco055-dev-Discussion`

**逆変換は非可逆**（パス中の `-` とディレクトリ区切りの `-` が区別不能）。セッションログ内の `cwd` フィールドから正確なパスを取得する。

**キャッシュ戦略**: オンデマンド + TTLキャッシュ（30秒）。

```typescript
class ProjectStore {
  private cache: Map<string, { data: ProjectInfo[]; fetchedAt: number }> = new Map();
  private readonly CACHE_TTL_MS = 30_000;

  async getProjects(): Promise<ProjectInfo[]> {
    const cached = this.cache.get('projects');
    if (cached && Date.now() - cached.fetchedAt < this.CACHE_TTL_MS) {
      return cached.data;
    }
    const projects = listProjects();
    this.cache.set('projects', { data: projects, fetchedAt: Date.now() });
    return projects;
  }
}
```

セッション一覧は `fs.statSync` で軽量取得し、内容は遅延ロード。

### 2.5 インメモリ揮発性対策

UUID v5 で `thread_ts` から `session_id` を決定的生成。Bridge再起動後も永続化不要でマッピングを復元できる。

```typescript
import { v5 as uuidv5 } from 'uuid';

const BRIDGE_NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8'; // 固定namespace

function threadTsToSessionId(threadTs: string): string {
  return uuidv5(threadTs, BRIDGE_NAMESPACE);
}
```

### 2.6 プロセス管理

```typescript
interface ManagedProcess {
  sessionId: string;
  userId: string;
  channelId: string;
  projectId: string;
  process: ChildProcess;
  startedAt: Date;
  timeoutTimer: NodeJS.Timeout;
  status: 'running' | 'completing' | 'cancelled' | 'timed-out';
  budgetUsd: number;
}

const DEFAULT_CONFIG: ProcessManagerConfig = {
  maxConcurrentPerUser: 1,    // MVP: ユーザーあたり1セッション
  maxConcurrentGlobal: 3,     // ローカルPC負荷を考慮
  defaultTimeoutMs: 5 * 60 * 1000,
  maxTimeoutMs: 30 * 60 * 1000,
  defaultBudgetUsd: 1.0,
  maxBudgetUsd: 10.0,
};
```

**Graceful shutdown**: SIGTERM → 5秒待機 → SIGKILL。`process.on('SIGTERM')` / `process.on('SIGINT')` で全子プロセスをクリーンアップ。

---

## 3. UI/UX設計

### 3.1 全体構成

| 画面 | 役割 |
|------|------|
| **App Home Tab** | ダッシュボード（プロジェクト一覧、アクティブセッション、過去のセッション履歴） |
| **DM スレッド** | 対話（1セッション = 1スレッド） |
| **モーダル** | 詳細表示（diff、stdout/stderr、サブエージェント詳細）、設定変更 |

DM一覧がセッション一覧として機能する。会話履歴は `.claude/projects/` のセッションログを直接読んでHome Tabに表示。

### 3.2 アンカーメッセージ（コントロールパネル）

スレッド最初のメッセージがセッション全体の制御UIとなる。`chat.update` で動的に状態を更新する。

#### 展開時レイアウト

```
┌─────────────────────────────────────────────────┐
│ my-webapp: 認証機能を実装して          [header]  │
├─────────────────────────────────────────────────┤
│ 🟢 アクティブセッション                          │
│ 📁 /Users/user/dev/my-webapp                    │
│                                                  │
│ Session: a1b2c3d4 | 開始: 14:30 | 💰 $0.23     │
│ 📊 45,000 / 200,000 tokens (22%)               │
├─────────────────────────────────────────────────┤
│ モデル            [Opus               ▾]        │
├─────────────────────────────────────────────────┤
│ [コマンド] [セッション終了]                        │
│                                                  │
│ スレッド内にメッセージを送信して対話開始            │
│ cc /help でコマンド一覧                           │
└─────────────────────────────────────────────────┘
```

#### 折りたたみ時（1行表示）

`chat.update` でコンパクト表示に切替。`cc /panel` テキストコマンドでもトグル可能。

```
🟢 my-webapp: 認証機能を実装して | Opus | 22% | $0.23 [▼ 展開]
```

#### アンカー更新タイミング

| トリガー | 更新内容 |
|---------|---------|
| モデル変更 | `initial_option` 更新 + スレッド内通知 |
| セッション名変更 | `header` テキスト更新 |
| 応答完了時 | コスト・トークン数の累積更新 |
| コンパクション発生時 | トークン数リセット表示 |
| セッション終了 | ステータス変更、select/button無効化 |

### 3.3 権限モード

`--permission-mode bypassPermissions` 固定。権限モードの選択UIは設けない。

### 3.4 モデル選択（3種）

`static_select` でアンカー内に配置。次のターンから適用。短縮名を `--model` に直接渡す（実機検証で動作確認済み）。

| UI表示 | `--model` 値 | 備考 |
|--------|-------------|------|
| Opus | `opus` | 最高性能 |
| Sonnet | `sonnet` | バランス型 |
| Haiku | `haiku` | 高速・低コスト |

### 3.5 コマンドメニュー（モーダル方式）

アンカーのactionsブロックに「コマンド」ボタンと「セッション終了」ボタンの2つを配置。

「コマンド」ボタンをタップするとモーダルが開き、カテゴリ別に `static_select` でコマンドを選択できる。引数が必要なコマンドは選択後に引数入力欄がモーダル内に表示される（モーダル内で完結）。

#### コマンドカテゴリ

| カテゴリ | コマンド |
|---------|---------|
| セッション管理 | /clear, /compact, /rename, /resume, /context, /cost, /status |
| 開発 | /diff, /plan, /review, /security-review, /simplify |
| モデル設定 | /model, /effort, /fast |
| その他 | /help, /usage, /memory, /skills, /export |

#### テキストコマンド一覧

テキストコマンド `cc /xxx` は引き続き全コマンド対応（50以上のClaude Codeコマンド全て）。

| コマンド | 種別 | 動作 |
|---------|------|------|
| `cc /status` | Bridge管理 | セッション情報表示 |
| `cc /end` | Bridge管理 | セッション終了 |
| `cc /help` | Bridge管理 | コマンド一覧表示 |
| `cc /model <model>` | Bridge管理 | モデル変更 |
| `cc /rename <name>` | Bridge管理 | セッション名変更 |
| `cc /panel` | Bridge管理 | アンカー展開/折りたたみトグル |
| `cc /commit` | Claude Code転送 | コミット実行 |
| `cc /review-pr <N>` | Claude Code転送 | PRレビュー |
| `cc /compact` | Claude Code転送 | コンテキスト圧縮 |
| `cc /clear` | Claude Code転送 | コンテキストクリア |
| `cc /<any>` | Claude Code転送 | 任意のClaude Codeコマンド |

### 3.6 モーダル表示対象一覧

#### ツール使用の詳細モーダル

| ツール | 表示内容 | フォーマット |
|--------|---------|------------|
| Read | ファイルパス、読み取り範囲、内容プレビュー | コードブロック |
| Edit | ファイルパス、old_string→new_string | diff形式（追加=緑、削除=赤） |
| Write | ファイルパス、書き込み内容全体 | コードブロック（全行緑） |
| Bash | コマンド、stdout、stderr、終了コード、実行時間 | コマンド+出力 |
| Grep | パターン、結果ファイル/行、コンテキスト行 | 検索結果リスト |
| Glob | パターン、マッチファイルリスト | ファイルパス一覧 |
| Agent | タスク説明、エージェントタイプ、使用モデル、ツール使用履歴、最終結果、実行時間、トークン数 | 折りたたみツール履歴 |
| WebFetch | URL、取得内容の要約 | URL+テキスト |
| WebSearch | 検索クエリ、結果リスト | タイトル+URL |
| NotebookEdit | ノートブックパス、編集セル、内容 | コードブロック |
| TodoWrite | タスク一覧（状態付き） | チェックリスト |
| MCP系ツール | サーバー名、ツール名、入出力 | JSON+テキスト |

#### その他のモーダル

| モーダル | 表示内容 |
|---------|---------|
| ファイル変更サマリー | 全変更ファイルのdiff一覧、追加/削除行数統計 |
| セッション情報 | ID、パス、モデル、トークン数/コンパクション距離、コスト、ターン数、名前変更入力欄 |
| エラー詳細 | エラーメッセージ、タイプ、対象ツール、入力パラメータ |
| コマンド一覧 | カテゴリ別コマンドselect + 引数入力欄 |

### 3.7 応答表示（ハイブリッド方式）

#### Message A（進捗メッセージ）

1メッセージを `chat.update` で逐次更新（1.2秒間隔のthrottling）。

**表示要素:**
- ステータスヘッダー: `"⏳ 処理中... (3/5ステップ) | 経過: 12s"`
- ツール使用ログ: 1行サマリー形式（例: `✅ Read src/auth.ts (247行)`）
- サブエージェント: `↳` でインデント表示、5個超は折りたたみ
- 思考スニペット: `💭` イタリック表示（最新50文字）
- 「詳細を見る」ボタン

#### Message B（結果メッセージ）

完了後に `chat.postMessage` で別メッセージとして投稿。

**表示要素:**
- 応答テキスト本文
- 変更ファイルサマリー
- コスト・所要時間・モデル情報

#### 詳細展開

**モーダル** で表示: diff表示、Bash stdout/stderr、サブエージェント詳細。

### 3.8 トークン数 / コンパクション表示

- `assistant` メッセージの `usage` フィールドからトークン数を累積追跡
- アンカー context に表示: `📊 45,000 / 200,000 tokens (22%)`
- 自動コンパクション閾値は `system` イベントの `compact_boundary` subtype から検知

### 3.9 待機表現

- **MVP**: リアクション絵文字（⏳ → ✅ / ❌）
- **stream-json有効時**: Message A の `chat.update` で進捗表示

### 3.10 エラー表示

- リアクション置換（⏳ → ❌ / ⚠️）+ Block Kit エラーメッセージ
- タイムアウト: 警告（1分前）→ SIGTERM → 5秒 → SIGKILL
- リトライボタン付き

### 3.11 長文応答の分割

| 文字数 | 方式 |
|--------|------|
| 3,900文字以下 | 単一メッセージ |
| 3,900 〜 39,000 | 複数メッセージ分割（コードブロック分断防止） |
| 39,000超 | `files.uploadV2` でファイルアップロード |

分割境界の優先順位: Markdown見出し > コードブロック終了 > 空行 > 文末 > 強制分割（行末）。

### 3.12 セッション命名

- **自動**: 最初のプロンプトから先頭30文字。`-n` フラグでCLI側にも反映
- **手動**: `cc /rename` またはセッション情報モーダル内で変更

### 3.13 App Home Tab

```
┌─────────────────────────────────────────────────┐
│ Claude Code Bridge                     [header]  │
│ 🟢 Bridge 稼働中                                │
├─────────────────────────────────────────────────┤
│ プロジェクト                                     │
│                                                  │
│ 📁 my-webapp                   [新規セッション]   │
│    /Users/user/dev/my-webapp                     │
│                                                  │
│ 📁 api-server                  [新規セッション]   │
│    /Users/user/dev/api-server                    │
├─────────────────────────────────────────────────┤
│ アクティブセッション                              │
│                                                  │
│ 🟢 my-webapp: 認証機能を実装して                  │
│    Session: a1b2c3d4 | 最終操作: 3分前            │
│                           [スレッドを開く]        │
├─────────────────────────────────────────────────┤
│ 最近のセッション（終了済み）                       │
│ ○ my-webapp: READMEを更新 — 1時間前              │
│ ○ api-server: バグ修正 — 3時間前                  │
└─────────────────────────────────────────────────┘
```

---

## 4. データフロー

### 4.1 メッセージ処理フロー（全体）

```
User → Slack DM: "認証機能を実装して"
  │
  ▼
EventHandler: message.im event → ack()
  │
  ├─ Auth Middleware: allowlist チェック
  ├─ Rate Limiter: 60秒 / 10リクエスト チェック
  ├─ Command Parser: cc /xxx 判定
  │    ├─ bridge_command → Bridge Handler（status, end, help, model, rename, panel）
  │    ├─ claude_command → Claude Code 転送（commit, review-pr, compact, etc.）
  │    └─ plain_text → プロンプトとして処理（以下のフロー）
  │
  ├─ SessionManager.resolveOrCreate()
  │    └─ UUID v5(thread_ts) → sessionId
  │
  ├─ ProcessManager.canStart() チェック
  │    ├─ ユーザーあたり同時実行数 <= 1
  │    └─ グローバル同時実行数 <= 3
  │
  ├─ reactions.add(⏳)
  │
  └─ StreamingClaudeExecutor.execute() → AsyncGenerator<SDKMessage>
```

### 4.2 ストリーミング処理フロー

```
Agent SDK query()
    │
    │  SDKMessage ストリーム
    ▼
┌─────────────────────────────────┐
│  StreamProcessor                │
│                                 │
│  ┌───────────────────────────┐  │
│  │ MessageAccumulator        │  │
│  │ - textBuffer: string      │  │
│  │ - toolUses: ToolUseStep[] │  │
│  │ - currentThinking: string │  │
│  │ - stepCount: number       │  │
│  │ - subAgentState: Map      │  │
│  └────────────┬──────────────┘  │
│               │                 │
│  ┌────────────▼──────────────┐  │
│  │ SlackUpdateThrottler      │  │
│  │ - minInterval: 1200ms     │  │
│  │ - pendingUpdate: Block[]  │  │
│  │ - lastUpdateAt: number    │  │
│  └────────────┬──────────────┘  │
│               │                 │
│  ┌────────────▼──────────────┐  │
│  │ BlockKitBuilder           │  │
│  │ - buildProgressBlocks()   │  │
│  │ - buildResultBlocks()     │  │
│  │ - buildModalBlocks()      │  │
│  └───────────────────────────┘  │
└─────────────────────────────────┘
    │
    ▼
  Slack API (chat.update / chat.postMessage)
```

### 4.3 SDKMessage イベント処理

| SDKMessage型 | 処理 |
|-------------|------|
| `SDKSystemMessage` (init) | Message A を投稿、session_id/model/cwd を取得 |
| `SDKPartialAssistantMessage` (content_block_start: text) | phase → `thinking` |
| `SDKPartialAssistantMessage` (content_block_start: tool_use) | phase → `tool_input`、ステップ追加 |
| `SDKPartialAssistantMessage` (content_block_delta: text_delta) | テキストバッファ追記、思考スニペット更新 |
| `SDKPartialAssistantMessage` (content_block_delta: input_json_delta) | ツール入力JSON蓄積 |
| `SDKPartialAssistantMessage` (content_block_stop) | ツール入力確定、phase → `tool_running` |
| `SDKAssistantMessage` | 完成メッセージ処理（usage累積等） |
| `SDKUserMessage` (tool_use_result) | ToolUseStep を `completed` に更新 |
| `SDKToolProgressMessage` | ツール実行中の進捗更新 |
| `SDKResultMessage` | Message A を最終状態に更新、Message B を投稿、リアクション更新 |

### 4.4 サブエージェントの識別

`SDKPartialAssistantMessage` と `SDKAssistantMessage` の `parent_tool_use_id` フィールドで判別:

- `null` → メインエージェントのメッセージ
- `"toolu_xxx"` → 指定された tool_use_id のサブエージェント内メッセージ

サブエージェント内のツール使用は `↳` でインデント表示。5個超は折りたたみ:

```
✅ `Read` src/auth/login.ts (247行)
✅ `Edit` src/auth/login.ts (+12/-3行)
✅ `Agent` code-reviewer → 完了 (8ツール, 15s)
  ↳ ✅ `Read` x3, `Grep` x3, `Edit` x2 — 📋 詳細を見る
```

---

## 5. 型定義

### 5.1 セッションメタデータ

```typescript
interface SessionMetadata {
  sessionId: string;              // UUID v5 (thread_ts から決定的生成)
  threadTs: string;               // Slack message timestamp (anchor)
  dmChannelId: string;            // DM channel ID
  projectPath: string;            // 作業ディレクトリ
  name: string;                   // セッション名 (header表示)
  model: ModelChoice;
  status: 'active' | 'ended';
  startTime: Date;
  totalCost: number;              // 累計コスト (USD)
  turnCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  lastActiveAt: Date;
  anchorCollapsed: boolean;       // アンカー折りたたみ状態
}

type ModelChoice = 'opus' | 'sonnet' | 'haiku';
```

### 5.2 プロセス管理

```typescript
interface ProcessManagerConfig {
  maxConcurrentPerUser: number;   // MVP: 1
  maxConcurrentGlobal: number;    // MVP: 3
  defaultTimeoutMs: number;       // 5分
  maxTimeoutMs: number;           // 30分
  defaultBudgetUsd: number;       // 1.0
  maxBudgetUsd: number;           // 10.0
}
```

### 5.3 ストリーム処理

```typescript
type ProcessingPhase =
  | 'idle'
  | 'thinking'
  | 'tool_input'
  | 'tool_running'
  | 'sub_agent'
  | 'completed'
  | 'error';

interface StreamProcessorState {
  phase: ProcessingPhase;
  progressMessageTs: string | null;   // Message A の ts
  steps: ToolUseStep[];               // 完了・進行中のツール使用リスト
  currentText: string;                // テキストバッファ
  currentToolUse: {
    id: string;
    name: string;
    inputJson: string;                // 差分蓄積中のJSON文字列
  } | null;
  subAgentSteps: Map<string, ToolUseStep[]>; // parent_tool_use_id → steps
  startTime: number;
  lastThinkingSnippet: string;
}

interface ToolUseStep {
  index: number;
  toolName: string;
  toolUseId: string;
  input: Record<string, unknown>;
  output?: Record<string, unknown>;
  error?: string;
  status: 'running' | 'completed' | 'error';
  startTime: number;
  endTime?: number;
  parentToolUseId: string | null;
}

interface ToolUseSummary {
  toolName: string;
  status: 'running' | 'completed' | 'error';
  oneLiner: string;
  detailBlocks: Block[];
}
```

### 5.4 コマンドパーサー

```typescript
interface ParsedCommand {
  type: 'claude_command' | 'bridge_command' | 'plain_text';
  command?: string;
  args?: string;
  rawText: string;
}
```

### 5.5 プロジェクト・セッション情報

```typescript
interface ProjectInfo {
  id: string;            // ディレクトリ名
  projectPath: string;   // 元のパス (cwdから取得)
  sessionCount: number;
  lastModified: Date;
}

interface SessionInfoLight {
  sessionId: string;
  updatedAt: Date;
  sizeBytes: number;
}

interface SessionInfo {
  sessionId: string;
  projectId: string;
  firstPrompt: string | null;
  lastPrompt: string | null;
  customTitle: string | null;
  createdAt: Date;
  updatedAt: Date;
  fileSizeBytes: number;
}
```

### 5.6 JSONL セッションログ型定義

Claude Code CLI のセッションログ（`.claude/projects/<project>/<uuid>.jsonl`）の型定義。各行は独立したJSONオブジェクト。

```typescript
// ========== 共通フィールド ==========

interface BaseEntry {
  parentUuid: string | null;
  isSidechain: boolean;
  userType: 'external' | 'internal';
  cwd: string;
  sessionId: string;
  version: string;
  uuid: string;
  timestamp: string;           // ISO 8601
  gitBranch?: string;
  isMeta?: boolean;
  agentId?: string;
  isCompactSummary?: boolean;
  logicalParentUuid?: string;
  slug?: string;
}

// ========== Content型 ==========

interface ThinkingContent {
  type: 'thinking';
  thinking: string;
  signature: string;
}

interface TextContent {
  type: 'text';
  text: string;
}

interface ToolUseContent {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
  caller?: string;
}

interface ToolResultContent {
  type: 'tool_result';
  tool_use_id: string;
  content: string | Array<unknown>;
}

interface ImageContent {
  type: 'image';
  source: { type: string; media_type: string; data: string };
}

interface DocumentContent {
  type: 'document';
  source: { type: string; media_type: string; data: string };
}

type AssistantContentBlock = ThinkingContent | TextContent | ToolUseContent;
type UserContentBlock = string | TextContent | ToolResultContent | ImageContent | DocumentContent;

// ========== Token使用量 ==========

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
}

// ========== Message型 ==========

interface AssistantMessage {
  model: string;
  id: string;
  type: 'message';
  role: 'assistant';
  content: AssistantContentBlock[];
  stop_reason: 'end_turn' | 'tool_use' | 'max_tokens' | null;
  stop_sequence: string | null;
  usage: TokenUsage;
}

interface UserMessage {
  role: 'user';
  content: string | UserContentBlock[];
}

// ========== Entry型（各type） ==========

interface UserEntry extends BaseEntry {
  type: 'user';
  message: UserMessage;
}

interface AssistantEntry extends BaseEntry {
  type: 'assistant';
  message: AssistantMessage;
  requestId?: string;
  isApiErrorMessage?: boolean;
}

// --- System subtypes ---

interface TurnDurationEntry extends BaseEntry {
  type: 'system';
  subtype: 'turn_duration';
  durationMs: number;
}

interface CompactBoundaryEntry extends BaseEntry {
  type: 'system';
  subtype: 'compact_boundary';
  content: string;
  level: string;
  compactMetadata?: {
    trigger: 'manual' | 'auto';
    preTokens: number;
  };
}

interface StopHookSummaryEntry extends BaseEntry {
  type: 'system';
  subtype: 'stop_hook_summary';
  hookCount: number;
  hookInfos: unknown[];
  preventedContinuation: boolean;
}

interface LocalCommandEntry extends BaseEntry {
  type: 'system';
  subtype: 'local_command';
  content: string;
  level: string;
}

interface ApiErrorEntry extends BaseEntry {
  type: 'system';
  subtype: 'api_error';
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
  type: 'progress';
  data: {
    type: 'hook_progress' | 'agent_progress' | 'bash_progress' | 'waiting_for_task';
    [key: string]: unknown;
  };
  toolUseID?: string;
  parentToolUseID?: string;
}

// --- その他 ---
// 注意: file-history-snapshot と queue-operation は BaseEntry を継承しない

interface FileHistorySnapshotEntry {
  type: 'file-history-snapshot';
  messageId: string;
  snapshot: {
    messageId: string;
    trackedFileBackups: Record<string, unknown>;
    timestamp: string;
  };
  isSnapshotUpdate: boolean;
}

interface QueueOperationEntry {
  type: 'queue-operation';
  operation: 'enqueue' | 'dequeue' | 'remove' | 'popAll';
  timestamp: string;
  sessionId: string;
  content?: string | unknown[];
}

interface SummaryEntry {
  type: 'summary';
  summary: string;
  leafUuid: string;
}

interface CustomTitleEntry {
  type: 'custom-title';
  customTitle: string;
  sessionId: string;
}

interface AgentNameEntry {
  type: 'agent-name';
  agentName: string;
  sessionId: string;
}

// ========== Union型 ==========

type SessionLogEntry =
  | UserEntry
  | AssistantEntry
  | SystemEntry
  | ProgressEntry
  | FileHistorySnapshotEntry
  | QueueOperationEntry
  | SummaryEntry
  | CustomTitleEntry
  | AgentNameEntry;
```

### 5.7 セッションファイルメタデータ算出型

```typescript
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
```

### 5.8 CLIの `--output-format json` 出力型

```typescript
interface ClaudeResultOutput {
  type: 'result';
  subtype: 'success' | 'error';
  result: string;
  session_id: string;
  total_cost_usd: number;
  duration_ms: number;
  stop_reason: string;
}
```

### 5.9 実行中セッション管理（`~/.claude/sessions/<pid>.json`）

```typescript
interface ActiveSessionFile {
  pid: number;
  sessionId: string;
  cwd: string;
  startedAt: number; // Unix ms
}
```

---

## 6. Block Kit構成

### 6.1 アンカーメッセージ（展開時）

```json
{
  "channel": "<DM channel ID>",
  "text": "セッション: my-webapp — Opus",
  "blocks": [
    {
      "type": "header",
      "text": {
        "type": "plain_text",
        "text": "my-webapp: 認証機能を実装して"
      }
    },
    {
      "type": "section",
      "text": {
        "type": "mrkdwn",
        "text": ":large_green_circle: *アクティブセッション*\n:file_folder: `/Users/user/dev/my-webapp`"
      }
    },
    {
      "type": "context",
      "elements": [
        {
          "type": "mrkdwn",
          "text": "Session: `a1b2c3d4` | 開始: 2026-03-16 14:30 | :moneybag: $0.23\n:bar_chart: 45,000 / 200,000 tokens (22%)"
        }
      ]
    },
    { "type": "divider" },
    {
      "type": "section",
      "text": { "type": "mrkdwn", "text": "*モデル*" },
      "accessory": {
        "type": "static_select",
        "action_id": "set_model",
        "initial_option": {
          "text": { "type": "plain_text", "text": "Opus" },
          "value": "opus"
        },
        "options": [
          { "text": { "type": "plain_text", "text": "Opus" }, "value": "opus" },
          { "text": { "type": "plain_text", "text": "Sonnet" }, "value": "sonnet" },
          { "text": { "type": "plain_text", "text": "Haiku" }, "value": "haiku" }
        ]
      }
    },
    { "type": "divider" },
    {
      "type": "actions",
      "block_id": "session_controls",
      "elements": [
        {
          "type": "button",
          "text": { "type": "plain_text", "text": "コマンド" },
          "action_id": "open_command_modal",
          "value": "a1b2c3d4"
        },
        {
          "type": "button",
          "text": { "type": "plain_text", "text": "セッション終了" },
          "action_id": "end_session",
          "value": "a1b2c3d4",
          "confirm": {
            "title": { "type": "plain_text", "text": "確認" },
            "text": { "type": "mrkdwn", "text": "このセッションを終了しますか？" },
            "confirm": { "type": "plain_text", "text": "終了" },
            "deny": { "type": "plain_text", "text": "キャンセル" }
          }
        }
      ]
    },
    {
      "type": "context",
      "elements": [
        {
          "type": "mrkdwn",
          "text": "スレッド内にメッセージを送信して対話開始 | `cc /help` でコマンド一覧"
        }
      ]
    }
  ]
}
```

### 6.2 アンカーメッセージ（折りたたみ時）

```json
{
  "blocks": [
    {
      "type": "section",
      "text": {
        "type": "mrkdwn",
        "text": ":large_green_circle: *my-webapp: 認証機能を実装して* | Opus | 22% | $0.23"
      },
      "accessory": {
        "type": "button",
        "text": { "type": "plain_text", "text": "▼ 展開" },
        "action_id": "toggle_anchor",
        "value": "expand"
      }
    }
  ]
}
```

### 6.3 Message A: 進捗メッセージ（ツール使用中）

```json
{
  "blocks": [
    {
      "type": "context",
      "elements": [
        {
          "type": "mrkdwn",
          "text": "⏳ *処理中...* (ステップ 3/5) | 経過: 12s"
        }
      ]
    },
    {
      "type": "section",
      "text": {
        "type": "mrkdwn",
        "text": "✅ `Read` src/auth/login.ts (247行)\n✅ `Grep` pattern=`validateToken` → 3件\n🔄 `Edit` src/auth/login.ts ..."
      }
    },
    {
      "type": "context",
      "elements": [
        {
          "type": "mrkdwn",
          "text": "💭 _認証ロジックを修正しています..._"
        }
      ]
    },
    {
      "type": "actions",
      "elements": [
        {
          "type": "button",
          "text": { "type": "plain_text", "text": "🔍 詳細を見る" },
          "action_id": "show_progress_detail",
          "value": "session_a1b2c3_step_3"
        }
      ]
    }
  ]
}
```

### 6.4 Message A: 進捗メッセージ（サブエージェント実行中）

```json
{
  "blocks": [
    {
      "type": "context",
      "elements": [
        {
          "type": "mrkdwn",
          "text": "⏳ *処理中...* (ステップ 4/5) | 経過: 25s"
        }
      ]
    },
    {
      "type": "section",
      "text": {
        "type": "mrkdwn",
        "text": "✅ `Read` src/auth/login.ts (247行)\n✅ `Grep` pattern=`validateToken` → 3件\n✅ `Edit` src/auth/login.ts (+12/-3行)\n🔄 `Agent` code-reviewer: コードレビュー中...\n  ↳ ✅ `Read` src/auth/login.ts\n  ↳ 🔄 `Grep` pattern=`security` ..."
      }
    },
    {
      "type": "actions",
      "elements": [
        {
          "type": "button",
          "text": { "type": "plain_text", "text": "🔍 詳細を見る" },
          "action_id": "show_progress_detail",
          "value": "session_a1b2c3_step_4"
        }
      ]
    }
  ]
}
```

### 6.5 Message A: 進捗メッセージ（完了時）

```json
{
  "blocks": [
    {
      "type": "context",
      "elements": [
        {
          "type": "mrkdwn",
          "text": "✅ *完了* | 5ステップ | 32s | $0.045"
        }
      ]
    },
    {
      "type": "section",
      "text": {
        "type": "mrkdwn",
        "text": "✅ `Read` src/auth/login.ts (247行)\n✅ `Grep` pattern=`validateToken` → 3件\n✅ `Edit` src/auth/login.ts (+12/-3行)\n✅ `Agent` code-reviewer → 完了 (2ツール, 8s)\n✅ `Bash` npm test → 成功"
      }
    },
    {
      "type": "actions",
      "elements": [
        {
          "type": "button",
          "text": { "type": "plain_text", "text": "📋 全ログを見る" },
          "action_id": "show_full_log",
          "value": "session_a1b2c3"
        }
      ]
    }
  ]
}
```

### 6.6 Message B: 結果メッセージ

```json
{
  "blocks": [
    {
      "type": "section",
      "text": {
        "type": "mrkdwn",
        "text": "認証機能を実装しました。以下の変更を行いました:\n\n1. `src/auth/login.ts` にトークン検証ロジックを追加\n2. `src/auth/middleware.ts` に認証ミドルウェアを作成\n3. テストを追加し、全テストがパスすることを確認"
      }
    },
    { "type": "divider" },
    {
      "type": "context",
      "elements": [
        {
          "type": "mrkdwn",
          "text": "📁 変更: `src/auth/login.ts` (+12/-3) · `src/auth/middleware.ts` (+45/new) · `tests/auth.test.ts` (+78/new)"
        }
      ]
    },
    {
      "type": "context",
      "elements": [
        {
          "type": "mrkdwn",
          "text": "⏱ 32s | 💰 $0.045 | 🔄 5ターン | 📊 Model: claude-sonnet-4-6"
        }
      ]
    }
  ]
}
```

### 6.7 コマンドモーダル

```json
{
  "type": "modal",
  "callback_id": "command_modal",
  "title": { "type": "plain_text", "text": "コマンド一覧" },
  "submit": { "type": "plain_text", "text": "実行" },
  "close": { "type": "plain_text", "text": "キャンセル" },
  "private_metadata": "{\"sessionId\":\"a1b2c3d4\"}",
  "blocks": [
    {
      "type": "section",
      "text": { "type": "mrkdwn", "text": "*セッション管理*" }
    },
    {
      "type": "actions",
      "block_id": "session_commands",
      "elements": [
        {
          "type": "static_select",
          "action_id": "select_session_command",
          "placeholder": { "type": "plain_text", "text": "コマンドを選択..." },
          "options": [
            { "text": { "type": "plain_text", "text": "/clear — コンテキストクリア" }, "value": "clear" },
            { "text": { "type": "plain_text", "text": "/compact — コンテキスト圧縮" }, "value": "compact" },
            { "text": { "type": "plain_text", "text": "/rename — セッション名変更" }, "value": "rename" },
            { "text": { "type": "plain_text", "text": "/resume — セッション再開" }, "value": "resume" },
            { "text": { "type": "plain_text", "text": "/context — コンテキスト表示" }, "value": "context" },
            { "text": { "type": "plain_text", "text": "/cost — コスト表示" }, "value": "cost" },
            { "text": { "type": "plain_text", "text": "/status — ステータス表示" }, "value": "status" }
          ]
        }
      ]
    },
    { "type": "divider" },
    {
      "type": "section",
      "text": { "type": "mrkdwn", "text": "*開発*" }
    },
    {
      "type": "actions",
      "block_id": "dev_commands",
      "elements": [
        {
          "type": "static_select",
          "action_id": "select_dev_command",
          "placeholder": { "type": "plain_text", "text": "コマンドを選択..." },
          "options": [
            { "text": { "type": "plain_text", "text": "/diff — 変更差分表示" }, "value": "diff" },
            { "text": { "type": "plain_text", "text": "/plan — 計画モード" }, "value": "plan" },
            { "text": { "type": "plain_text", "text": "/review — コードレビュー" }, "value": "review" },
            { "text": { "type": "plain_text", "text": "/security-review — セキュリティレビュー" }, "value": "security-review" },
            { "text": { "type": "plain_text", "text": "/simplify — コード簡素化" }, "value": "simplify" }
          ]
        }
      ]
    },
    { "type": "divider" },
    {
      "type": "section",
      "text": { "type": "mrkdwn", "text": "*モデル設定*" }
    },
    {
      "type": "actions",
      "block_id": "model_commands",
      "elements": [
        {
          "type": "static_select",
          "action_id": "select_model_command",
          "placeholder": { "type": "plain_text", "text": "コマンドを選択..." },
          "options": [
            { "text": { "type": "plain_text", "text": "/model — モデル変更" }, "value": "model" },
            { "text": { "type": "plain_text", "text": "/effort — 推論努力度変更" }, "value": "effort" },
            { "text": { "type": "plain_text", "text": "/fast — 高速モード" }, "value": "fast" }
          ]
        }
      ]
    },
    { "type": "divider" },
    {
      "type": "section",
      "text": { "type": "mrkdwn", "text": "*その他*" }
    },
    {
      "type": "actions",
      "block_id": "other_commands",
      "elements": [
        {
          "type": "static_select",
          "action_id": "select_other_command",
          "placeholder": { "type": "plain_text", "text": "コマンドを選択..." },
          "options": [
            { "text": { "type": "plain_text", "text": "/help — ヘルプ表示" }, "value": "help" },
            { "text": { "type": "plain_text", "text": "/usage — 使用量表示" }, "value": "usage" },
            { "text": { "type": "plain_text", "text": "/memory — メモリ管理" }, "value": "memory" },
            { "text": { "type": "plain_text", "text": "/skills — スキル一覧" }, "value": "skills" },
            { "text": { "type": "plain_text", "text": "/export — エクスポート" }, "value": "export" }
          ]
        }
      ]
    },
    {
      "type": "input",
      "block_id": "command_args_input",
      "optional": true,
      "element": {
        "type": "plain_text_input",
        "action_id": "command_args",
        "placeholder": { "type": "plain_text", "text": "引数を入力（必要な場合）" }
      },
      "label": { "type": "plain_text", "text": "引数" },
      "hint": { "type": "plain_text", "text": "例: /model の場合 → opus, sonnet, haiku" }
    }
  ]
}
```

### 6.8 エラーメッセージ

```json
{
  "thread_ts": "<session thread>",
  "text": "エラーが発生しました",
  "blocks": [
    {
      "type": "section",
      "text": {
        "type": "mrkdwn",
        "text": ":x: *エラーが発生しました*"
      }
    },
    {
      "type": "section",
      "text": {
        "type": "mrkdwn",
        "text": "```\nError: ENOENT: no such file or directory\n```"
      }
    },
    {
      "type": "context",
      "elements": [
        {
          "type": "mrkdwn",
          "text": "Exit code: 1 | Duration: 3.2s | Session: `a1b2c3d4`"
        }
      ]
    },
    {
      "type": "actions",
      "elements": [
        {
          "type": "button",
          "text": { "type": "plain_text", "text": "🔄 リトライ" },
          "action_id": "retry_prompt",
          "value": "<original_prompt_hash>"
        }
      ]
    }
  ]
}
```

### 6.9 詳細モーダル（Edit ツール例）

```json
{
  "type": "modal",
  "title": { "type": "plain_text", "text": "実行詳細" },
  "blocks": [
    {
      "type": "header",
      "text": { "type": "plain_text", "text": "📋 ステップ 3: Edit src/auth/login.ts" }
    },
    {
      "type": "section",
      "text": {
        "type": "mrkdwn",
        "text": "*ツール:* `Edit`\n*ファイル:* `src/auth/login.ts`\n*変更:* +12行 / -3行"
      }
    },
    {
      "type": "header",
      "text": { "type": "plain_text", "text": "変更内容 (diff)" }
    },
    {
      "type": "section",
      "text": {
        "type": "mrkdwn",
        "text": "```diff\n@@ -45,8 +45,17 @@\n-  const isValid = checkToken(token);\n+  const decoded = jwt.verify(token, publicKey);\n```"
      }
    }
  ]
}
```

### 6.10 詳細モーダル（Bash ツール例）

```json
{
  "type": "modal",
  "title": { "type": "plain_text", "text": "実行詳細" },
  "blocks": [
    {
      "type": "header",
      "text": { "type": "plain_text", "text": "🖥 Bash: npm test" }
    },
    {
      "type": "section",
      "text": {
        "type": "mrkdwn",
        "text": "*コマンド:*\n```\nnpm test\n```"
      }
    },
    {
      "type": "section",
      "text": {
        "type": "mrkdwn",
        "text": "*stdout:*\n```\n> my-project@1.0.0 test\n> vitest run\n\n ✓ tests/auth.test.ts (4 tests) 120ms\n\n Tests  4 passed\n```"
      }
    },
    {
      "type": "context",
      "elements": [
        { "type": "mrkdwn", "text": "Exit code: `0` | Duration: 1.5s" }
      ]
    }
  ]
}
```

### 6.11 セッション名変更モーダル

```json
{
  "type": "modal",
  "callback_id": "rename_session_modal",
  "title": { "type": "plain_text", "text": "セッション名を変更" },
  "submit": { "type": "plain_text", "text": "変更" },
  "close": { "type": "plain_text", "text": "キャンセル" },
  "private_metadata": "{\"sessionId\":\"a1b2c3d4\",\"anchorTs\":\"1710567000.000000\"}",
  "blocks": [
    {
      "type": "input",
      "block_id": "session_name_input",
      "element": {
        "type": "plain_text_input",
        "action_id": "session_name",
        "initial_value": "my-webapp: 認証機能を実装して",
        "max_length": 150,
        "placeholder": { "type": "plain_text", "text": "セッション名を入力" }
      },
      "label": { "type": "plain_text", "text": "新しいセッション名" },
      "hint": { "type": "plain_text", "text": "header ブロックの上限は150文字です" }
    }
  ]
}
```

### 6.12 コマンド引数入力モーダル（/review-pr）

```json
{
  "type": "modal",
  "callback_id": "command_args_modal",
  "title": { "type": "plain_text", "text": "/review-pr" },
  "submit": { "type": "plain_text", "text": "実行" },
  "close": { "type": "plain_text", "text": "キャンセル" },
  "private_metadata": "{\"sessionId\":\"a1b2c3d4\",\"command\":\"review-pr\"}",
  "blocks": [
    {
      "type": "input",
      "block_id": "pr_number_input",
      "element": {
        "type": "plain_text_input",
        "action_id": "pr_number",
        "placeholder": { "type": "plain_text", "text": "PR番号を入力（例: 123）" }
      },
      "label": { "type": "plain_text", "text": "PR番号" }
    }
  ]
}
```

### 6.13 action_id / block_id / callback_id 命名規則

#### action_id

| パターン | 例 | 用途 |
|---------|-----|------|
| `set_<setting>` | `set_model` | 設定変更セレクトメニュー |
| `<verb>_session` | `end_session` | セッション操作 |
| `open_command_modal` | `open_command_modal` | コマンドモーダル表示 |
| `select_<category>_command` | `select_session_command`, `select_dev_command` | コマンドモーダル内カテゴリselect |
| `toggle_anchor` | `toggle_anchor` | アンカー展開/折りたたみ |
| `show_progress_detail` | `show_progress_detail` | 進捗詳細モーダル |
| `show_full_log` | `show_full_log` | 全ログモーダル |
| `retry_prompt` | `retry_prompt` | エラー時リトライ |

#### block_id

| パターン | 例 | 用途 |
|---------|-----|------|
| `session_controls` | `session_controls` | アンカーのactionsブロック |
| `<category>_commands` | `session_commands`, `dev_commands`, `model_commands`, `other_commands` | コマンドモーダル内カテゴリ |
| `<name>_input` | `session_name_input`, `command_args_input` | モーダル入力フィールド |
| `<name>_setting` | `model_setting` | 設定モーダルフィールド |

#### callback_id（モーダル用）

| callback_id | 用途 |
|-------------|------|
| `rename_session_modal` | セッション名変更 |
| `command_modal` | コマンド一覧モーダル |
| `command_args_modal` | コマンド引数入力 |
| `session_settings_modal` | 統合設定 |

---

## 7. セキュリティ

### 7.1 ユーザー認証

環境変数ベースの allowlist。

```typescript
interface SecurityConfig {
  allowedUserIds: string[];    // 空 = 全員許可
  allowedTeamIds: string[];
  adminUserIds: string[];
}
```

### 7.2 ツール制限

`--permission-mode bypassPermissions` 固定のため、全ツールが自動承認される。必要に応じて `--allowedTools` で個別にツールを制限可能。

### 7.3 コスト制限

- `--max-budget-usd` でセッション単位のコスト制限
- 環境変数 `DEFAULT_BUDGET_USD` / `MAX_BUDGET_USD` で上限設定

### 7.4 出力サニタイズ

Slackに返す前に秘密情報をマスク:

```typescript
function sanitizeOutput(output: string): string {
  return output
    .replace(/(sk-[a-zA-Z0-9]{20,})/g, 'sk-***REDACTED***')
    .replace(/(xoxb-[a-zA-Z0-9-]+)/g, 'xoxb-***REDACTED***')
    .replace(/(xapp-[a-zA-Z0-9-]+)/g, 'xapp-***REDACTED***');
}
```

### 7.5 入力サニタイズ

Slackメンション等のフォーマットを正規化:

```typescript
function sanitizeUserInput(input: string): string {
  return input
    .replace(/<@[A-Z0-9]+>/g, '[user-mention]')
    .replace(/<#[A-Z0-9]+\|[^>]+>/g, '[channel]')
    .replace(/<(https?:\/\/[^|>]+)(\|[^>]+)?>/g, '$1');
}
```

### 7.6 レート制限

ユーザーあたり60秒/10リクエストの制限。

### 7.7 環境変数一覧

```bash
# === Slack設定 ===
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...           # Socket Mode用

# === セキュリティ ===
ALLOWED_USER_IDS=U12345,U67890     # カンマ区切り、空=全員許可
ALLOWED_TEAM_IDS=T12345
ADMIN_USER_IDS=U12345

# === Claude Code設定 ===
CLAUDE_EXECUTABLE=claude
CLAUDE_PROJECTS_DIR=~/.claude/projects

# === 実行制限 ===
MAX_CONCURRENT_PER_USER=1
MAX_CONCURRENT_GLOBAL=3
DEFAULT_TIMEOUT_MS=300000          # 5分
MAX_TIMEOUT_MS=1800000             # 30分
DEFAULT_BUDGET_USD=1.0
MAX_BUDGET_USD=10.0

# === ログ ===
LOG_LEVEL=info
```

### 7.8 Slack App OAuth スコープ

```
# Bot Token Scopes
app_mentions:read
chat:write
reactions:write
files:write
files:read
im:write
im:history

# Event Subscriptions
message.im

# Interactivity
Interactivity & Shortcuts → Enable (Socket Mode使用時はRequest URL不要)
```

---

## 8. 実装フェーズ

### 8.1 Phase 0: 基盤セットアップ

| # | タスク | 推定 |
|---|--------|------|
| 0-1 | プロジェクト初期化（TypeScript, Bolt, tsconfig） | 30分 |
| 0-2 | `.env` + `config.ts` | 30分 |
| 0-3 | `types.ts` — 全型定義 | 45分 |
| 0-4 | `logger.ts` + `errors.ts` | 30分 |
| 0-5 | Bolt App 初期化 + Socket Mode接続 | 30分 |
| 0-6 | Auth Middleware + Rate Limiter | 45分 |
| 0-7 | `sanitizer.ts` — 入出力サニタイズ | 30分 |

**Phase 0 合計: 約4時間**

### 8.2 Phase 1: MVP（最小限で動くもの）

| # | タスク | 依存 | 推定 |
|---|--------|------|------|
| 1-1 | `project-store.ts` — `.claude/projects/` スキャン + TTLキャッシュ | 0-3 | 90分 |
| 1-2 | `session-store.ts` — インメモリ + UUID v5決定的生成 | 0-3 | 60分 |
| 1-3 | `session-manager.ts` — セッション作成/再開/終了 | 1-2 | 60分 |
| 1-4 | `process-manager.ts` — spawn + 同時実行制御 + タイムアウト | 0-3 | 90分 |
| 1-5 | `executor.ts` — CLI spawn ベースの実行 (fallback) | 1-4 | 60分 |
| 1-6 | `command-parser.ts` — `cc /xxx` パーサー | 0-3 | 45分 |
| 1-7 | `block-builder.ts` — アンカー + 基本応答ブロック構築 | 0-3 | 90分 |
| 1-8 | `event-handler.ts` — DMメッセージ受信 + ルーティング | 1-3, 1-5, 1-6 | 90分 |
| 1-9 | `response-builder.ts` — 応答構築 + 長文分割 | 1-7 | 90分 |
| 1-10 | Home Tab: プロジェクト一覧 + 新規セッション | 1-1, 1-7 | 90分 |
| 1-11 | リアクション（⏳ → ✅ / ❌） | 1-8 | 30分 |
| 1-12 | エラー表示 + リトライボタン | 1-7 | 60分 |
| 1-13 | `cc /status`, `cc /end`, `cc /help` 実装 | 1-6, 1-7 | 60分 |

**Phase 1 合計: 約15時間（2.5日）**

### 8.3 Phase 2: 実用レベル（コントロールUI + ストリーミング）

| # | タスク | 依存 | 推定 |
|---|--------|------|------|
| 2-1 | アンカーメッセージ完全版（展開/折りたたみ、model select、コマンドボタン） | 1-7 | 120分 |
| 2-2 | モデル選択 `set_model` ハンドラ | 2-1 | 60分 |
| 2-3 | `cc /model` テキストコマンド | 1-6 | 30分 |
| 2-4 | コマンドモーダル（カテゴリ別select + 引数入力） | 2-1 | 120分 |
| 2-5 | `streaming-executor.ts` — Agent SDK `query()` ラッパー | 1-5 | 60分 |
| 2-6 | `stream-processor.ts` — ステートマシン + イベントハンドラ | 2-5 | 90分 |
| 2-7 | `throttler.ts` — SlackUpdateThrottler | 0-5 | 45分 |
| 2-8 | `tool-summarizer.ts` — ツール使用サマリー生成 | 0-3 | 60分 |
| 2-9 | Message A (進捗) + Message B (結果) 分離表示 | 2-6, 2-7, 2-8 | 90分 |
| 2-10 | `modal-handler.ts` — 詳細モーダル表示（ツール別） | 2-8 | 45分 |
| 2-11 | セッション自動命名 + 手動命名 | 1-3, 2-1 | 60分 |
| 2-12 | Home Tab: アクティブセッション + 終了済み履歴 | 1-10 | 60分 |
| 2-13 | トークン数 / コンパクション表示（アンカーcontext更新） | 2-6 | 45分 |
| 2-14 | `files.uploadV2` 対応（39,000文字超） | 1-9 | 60分 |

**Phase 2 合計: 約15時間（2.5日）**

### 8.4 Phase 3: 高度な機能

| # | タスク | 依存 | 推定 |
|---|--------|------|------|
| 3-1 | 統合設定モーダル（セッション情報 + 一括設定変更） | 2-1 | 120分 |
| 3-2 | コスト累積リアルタイム更新（アンカーcontext） | 2-13 | 60分 |
| 3-3 | Graceful shutdown 完全実装 | 1-4 | 60分 |

**Phase 3 合計: 約4時間**

### 8.5 Phase 4: 拡張機能

| # | タスク | 推定 |
|---|--------|------|
| 4-1 | カスタムスキル動的メニュー（`.claude/commands/` スキャン） | 180分 |
| 4-2 | Markdown → mrkdwn 変換改善（テーブル、ネストリスト） | 180分 |
| 4-3 | Home Tab: プロジェクトごとの統計（セッション数、累計コスト） | 120分 |
| 4-4 | Home Tab: 設定セクション（タイムアウト、予算上限変更） | 180分 |

**Phase 4 合計: 約11時間（2日）**

### 8.6 実装チェックリスト

#### Phase 0: 基盤

- [ ] TypeScript + Bolt for JS プロジェクト初期化
- [ ] `.env.example` + `config.ts`（全環境変数の読み込み）
- [ ] `types.ts`（全型定義）
- [ ] Auth Middleware（allowlist）
- [ ] Rate Limiter
- [ ] 入出力サニタイザー

#### Phase 1: MVP

- [ ] ProjectStore（.claude/projects/ スキャン + 30秒TTLキャッシュ）
- [ ] SessionStore（インメモリ + UUID v5 決定的生成）
- [ ] SessionManager（create / resume / end）
- [ ] ProcessManager（spawn + 同時実行制御 + SIGTERM/SIGKILL）
- [ ] CLI Executor（`claude -p --output-format json`）
- [ ] CommandParser（`cc /xxx` パーサー）
- [ ] BlockBuilder（アンカー基本版 + 応答ブロック）
- [ ] EventHandler（DM message → ルーティング）
- [ ] ResponseBuilder（応答構築 + 長文分割 + コードブロック分断防止）
- [ ] Home Tab（プロジェクト一覧 + 新規セッション）
- [ ] リアクション管理（⏳ → ✅ / ❌）
- [ ] エラー表示 + リトライボタン
- [ ] `cc /status`, `cc /end`, `cc /help`

#### Phase 2: 実用レベル

- [ ] アンカー完全版（展開/折りたたみ、model static_select x1、コマンドボタン）
- [ ] モデル切替（`set_model` ハンドラ）
- [ ] `cc /model`, `cc /rename`, `cc /panel` テキストコマンド
- [ ] コマンドモーダル（カテゴリ別select + 引数入力）
- [ ] Agent SDK StreamingExecutor
- [ ] StreamProcessor（ステートマシン + SDKMessage処理）
- [ ] SlackUpdateThrottler（1.2秒間隔、Rate Limit自動調整）
- [ ] ToolSummarizer（ツール別1行サマリー生成）
- [ ] Message A (進捗, chat.update) + Message B (結果, chat.postMessage)
- [ ] 詳細モーダル（ツール別: diff, stdout/stderr, サブエージェント詳細）
- [ ] セッション自動命名（先頭30文字 + `-n` フラグ）
- [ ] セッション手動命名（コマンドモーダル → rename）
- [ ] Home Tab: アクティブセッション + 終了済み履歴
- [ ] トークン数 / コンパクション検知 + アンカー表示
- [ ] `files.uploadV2`（39,000文字超）

#### Phase 3: 高度な機能

- [ ] 統合設定モーダル
- [ ] コスト累積リアルタイム更新
- [ ] Graceful shutdown完全実装（process.on SIGTERM/SIGINT/uncaughtException）

#### Phase 4: 拡張

- [ ] カスタムスキル動的メニュー
- [ ] Markdown → mrkdwn 変換改善
- [ ] Home Tab: プロジェクト統計
- [ ] Home Tab: 設定セクション

### 8.7 SlackUpdateThrottler 仕様

```typescript
class SlackUpdateThrottler {
  private pendingBlocks: Block[] | null = null;
  private timer: NodeJS.Timeout | null = null;
  private lastUpdateAt = 0;
  private defaultMinInterval = 1200; // ms (50回/分 = 1200ms間隔)
  private updateCount = 0;
  private windowStart = Date.now();

  constructor(
    private client: WebClient,
    private channelId: string,
    private threadTs: string,
    private progressMessageTs?: string,
  ) {}

  /**
   * 更新をスケジュール。
   * minInterval 以内に複数回呼ばれた場合、最新の blocks のみ送信。
   */
  scheduleUpdate(blocks: Block[], opts?: { minInterval?: number }): void;

  /**
   * 即時更新を強制（完了時やエラー時）。
   */
  async forceUpdate(blocks: Block[]): Promise<void>;
}
```

Rate Limit 自動調整:
- スライディングウィンドウ（60秒）で更新回数を監視
- 45回/分を超えた場合、間隔を1.5倍に自動拡大（最大5000ms）
- `ratelimited` エラー受信時は `Retry-After` ヘッダーを尊重

### 8.8 CLIフラグ生成ロジック

```typescript
function buildClaudeArgs(session: SessionMetadata, isResume: boolean): string[] {
  const modelMap: Record<ModelChoice, string> = {
    opus: 'opus',
    sonnet: 'sonnet',
    haiku: 'haiku',
  };

  const args = [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--permission-mode', 'bypassPermissions',
    '--model', modelMap[session.model],
    '--max-budget-usd', String(process.env.DEFAULT_BUDGET_USD || '1.0'),
  ];

  // セッションID
  if (isResume) {
    args.push('-r', session.sessionId);
  } else {
    args.push('--session-id', session.sessionId);
  }

  return args;
}
```

### 8.9 ツール使用サマリーフォーマット

| ツール | 実行中 | 完了 |
|--------|--------|------|
| Read | `🔄 \`Read\` src/auth/login.ts ...` | `✅ \`Read\` src/auth/login.ts (247行)` |
| Edit | `🔄 \`Edit\` src/auth/login.ts ...` | `✅ \`Edit\` src/auth/login.ts (+12/-3行)` |
| Write | `🔄 \`Write\` src/auth/middleware.ts ...` | `✅ \`Write\` src/auth/middleware.ts (45行, new)` |
| Bash | `🔄 \`Bash\` npm test ...` | `✅ \`Bash\` npm test → 成功` / `❌ \`Bash\` npm test → 失敗` |
| Grep | `🔄 \`Grep\` pattern=\`validateToken\` ...` | `✅ \`Grep\` pattern=\`validateToken\` → 3件` |
| Glob | `🔄 \`Glob\` pattern=\`**/*.ts\` ...` | `✅ \`Glob\` pattern=\`**/*.ts\` → 12件` |
| Agent | `🔄 \`Agent\` code-reviewer: レビュー中...` | `✅ \`Agent\` code-reviewer → 完了 (2ツール, 8s)` |

### 8.10 長文分割ロジック

```typescript
const MAX_SECTION_TEXT = 2_900;  // section block の 3,000文字制限に安全マージン
const MAX_MESSAGE_TEXT = 3_900;  // section blockの3,000文字制限とは別。chat.postMessageのtext上限は40,000文字だが、Block Kit使用時は1 sectionあたり MAX_SECTION_TEXT = 2,900 で管理する

function splitAtBoundaries(text: string, maxLength: number): string[] {
  // 分割境界の優先順位:
  // 1. Markdown見出し (## , ### )
  // 2. コードブロック終了 (```)
  // 3. 空行（パラグラフ境界）
  // 4. 文末 (. / 。)
  // 5. 強制分割（行末）

  // コードブロック内では絶対に分割しない
  // isInsideCodeBlock() で ``` の開閉を追跡
}
```

### 8.11 モバイル Slack の制約と対策

| 制約 | 対策 |
|------|------|
| `slack://app` ディープリンクが不安定 | テキストで「Appの Home タブを開いてください」と案内 |
| スレッド内のボタンが埋もれる | `cc /xxx` テキストコマンドを全操作の代替手段として維持 |
| モーダル内selectが小さい | テキストコマンド `cc /xxx` を全操作の代替手段として維持 |
| プッシュ通知にBlock Kit内容が含まれない | `text` フォールバックを全メッセージに設定 |
| `context` ブロックの文字が小さい | 重要情報は `section` に配置 |

### 8.12 既知の制限事項

| 制限 | 説明 |
|------|------|
| セッションログ全読みは重い | 実測971MB/2096セッション。`fs.statSync` + 遅延ロードで対処 |
| パス逆変換が非可逆 | `cwd` フィールドで正確なパスを取得 |
| CLIバージョン依存 | パーサーは未知フィールドを無視し、必須フィールドのみに依存 |
