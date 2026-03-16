# Claude Code Slack Bridge — 詳細分析書

作成日: 2026-03-13
ソース: Round 1 (CLI Specialist, Slack Architect, Bridge Architect, Synthesis) + Round 2 (E2E Validator, UX Validator, Synthesis)
CLIバージョン: 2.1.74

---

## 1. プロジェクト概要

### 目的

ローカルPCで動作する Claude Code CLI (`claude`) を、Slack インターフェースから操作可能にするブリッジサーバーを構築する。ユーザーは Slack チャンネルにメッセージを投稿するだけで、Claude Code がコード生成・編集・レビュー・コミットなどのタスクを実行し、結果をスレッド内に返信する。

> 出典: round1-bridge-architect.md §2「推奨アーキテクチャ概要」、round1-slack-architect.md §6「推奨アーキテクチャ」

### スコープ

| 範囲 | 内容 |
|------|------|
| MVP | 単一チャンネル・単一作業ディレクトリでの Slack ↔ Claude Code 双方向通信 |
| Phase 2 | 複数チャンネル、`cc /xxx` コマンド、mrkdwn変換、長文分割 |
| Phase 3 | Home Tab、確認ダイアログ、リッチUI |
| Phase 4 | DM管理レイヤー、AI Streaming、ファイル添付、MCP統合 |

### 制約条件

| 制約 | 詳細 | 出典 |
|------|------|------|
| ローカルPC実行 | サーバーレスやクラウドデプロイではなく、ローカルマシンで常時起動 | round1-slack-architect.md §1.2 |
| 単一ユーザー前提 | 同時並行リクエスト数は限定的（2-3セッション） | round1-bridge-architect.md §2 |
| Marketplace配布不要 | 個人利用のため、Socket Mode で十分 | round1-slack-architect.md §1.2 |
| Claude Code CLI依存 | `claude -p` コマンドの仕様に全面依存。CLIのアップデートで挙動が変わるリスクあり | round1-cli-specialist.md §9 |
| Slack API制限 | メッセージ4,000文字推奨、40,000文字上限、ブロック50個上限 | round1-slack-architect.md §3.1 |

---

## 2. 技術選定の根拠

### 2.1 言語・フレームワーク選定

| 項目 | TypeScript + Bolt for JS | Python + Bolt for Python | Go + slack-go |
|------|--------------------------|--------------------------|---------------|
| メンテナ | Slack公式 | Slack公式 | コミュニティ |
| 成熟度 | 最も成熟 | 十分成熟 | 限定的 |
| Socket Mode | ネイティブ対応 | ネイティブ対応 | 部分的 |
| Block Kit型定義 | TypeScript完全型安全 | 辞書ベース | 構造体定義 |
| ドキュメント量 | 最多 | 豊富 | 限定的 |
| AI/Streaming対応 | chat_stream対応 | chat_stream対応 | 未対応 |
| Claude Code親和性 | **高（Claude Code自体がTS製）** | 中 | 低 |

**決定: TypeScript + Bolt for JS** (V1: 全エージェント一致)

> 出典: round1-slack-architect.md §1.1、round1-bridge-architect.md §7.1

**選定理由:**
1. Claude Code CLI 自体が TypeScript で実装されており、言語統一によるデバッグ・理解のメリットが大きい
2. Bolt for JS が Socket Mode、Block Kit、インタラクティブ機能すべてにおいて最も安定
3. 2025年10月に追加されたAI向け機能（chat streaming等）が JS SDK で最初にサポート
4. async/await + イベントループモデルが Slack イベント受信 → 非同期実行 → 結果返信のフローに最適

### 2.2 接続モード選定

| 観点 | Socket Mode (WebSocket) | HTTP Mode (Events API) |
|------|------------------------|----------------------|
| パブリックURL | **不要** | 必要（ngrok等） |
| ファイアウォール | 内側から接続可能 | ポート開放 or トンネリング必要 |
| レイテンシ | 低（常時接続） | 中（HTTPハンドシェイク） |
| Marketplace配布 | 不可 | 可能 |
| スケーラビリティ | 単一インスタンス向き | 複数インスタンス可能 |
| セットアップ難度 | **低** | 中～高 |

**決定: Socket Mode** (V1: 全エージェント一致)

> 出典: round1-slack-architect.md §1.2

### 2.3 プロセス管理モデル選定

| 観点 | モデル1: 都度起動 | モデル2: 常駐プロセス | モデル3: ハイブリッド |
|------|-----------------|-------------------|-------------------|
| 実装複雑度 | **低** | 高 | 非常に高 |
| レイテンシ | 中～高（1-3秒） | **低** | 低～中 |
| リソース効率 | **高（未使用時ゼロ）** | 低（100-300MB/プロセス） | 中 |
| セッション継続 | `--session-id` + `-r` で可能 | プロセス内保持 | 可能 |
| 障害耐性 | **高（プロセス独立）** | 低（クラッシュで状態喪失） | 中 |
| 並行処理 | **容易（自然に並行）** | 困難（ロック必要） | 困難 |

```
                実装複雑度    レイテンシ    リソース効率    障害耐性    並行処理
モデル1(都度起動)    ★★★★★       ★★★          ★★★★★        ★★★★★      ★★★★★
モデル2(常駐)       ★★           ★★★★★        ★★           ★★         ★★
モデル3(ハイブリッド) ★            ★★★★         ★★★          ★★★        ★★
```

**決定: モデル1（都度起動）** (V2: Bridge提案、CLI裏付け)

> 出典: round1-bridge-architect.md §1、round1-synthesis.md V2

**選定理由:**
1. `claude -p --session-id` がセッション履歴をファイル永続化するため、常駐プロセスの最大メリット（状態保持）が不要
2. 単一ユーザー前提のため、プロセス起動オーバーヘッド（1-3秒）は許容範囲
3. プロセス独立による障害耐性の高さ
4. MVPとして最適な実装シンプルさ

### 2.4 状態管理ストレージ選定

| 選択肢 | 評価 |
|--------|------|
| **SQLite** | **推奨** — ファイルベースで運用不要、ACID準拠、単一ユーザーの同時アクセスに十分 |
| JSONファイル | 同時書き込みの競合リスク、スキーマバリデーションなし |
| In-memory | プロセス再起動で消失 |

**決定: SQLite（3テーブル構成）** (V3: Bridge, Slack一致)

> 出典: round1-bridge-architect.md §4.1

### 2.5 チャンネル戦略選定

```
              実装複雑度    UX      同時並行    拡張性    MVP適性
パターン1(DM)    ★★★★      ★★★      ★★        ★★       ★★★★★
パターン2(自動CH) ★★★       ★★★★     ★★★★★     ★★★★     ★★★★
パターン3(ハイブリ) ★★        ★★★★★    ★★★★★     ★★★★★    ★★
```

**決定: パターン2（自動チャンネル作成）、MVP段階では単一チャンネル固定** (V7)

> 出典: round1-slack-architect.md §2、round1-synthesis.md V7

---

## 3. アーキテクチャ詳細

### 3.1 統合アーキテクチャ図

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

> 出典: round2-ux-validator.md §1.1

### 3.2 コンポーネント間インターフェース

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

> 出典: round2-ux-validator.md §1.2

### 3.3 コンポーネント間依存関係

```
┌─────────────────────────────────────────────────────────┐
│                      index.ts                            │
│                  (Bolt App Init)                          │
└──────────┬───────────────────────────────┬───────────────┘
           │                               │
           ▼                               ▼
┌─────────────────────┐         ┌─────────────────────────┐
│   slack/handlers.ts  │         │   slack/commands.ts      │
│                     │         │                          │
│ - onMessage()       │         │ - /claude new <dir>      │
│ - onAppMention()    │         │ - /claude sessions       │
│ - onReaction()      │         │ - /claude switch <dir>   │
└──────────┬──────────┘         └──────────┬──────────────┘
           │                               │
           └───────────┬───────────────────┘
                       ▼
           ┌───────────────────────┐
           │ bridge/session-mgr.ts │
           │                       │
           │ resolveSession()      │──────► store/thread-session.ts
           │ createSession()       │──────► store/channel-workdir.ts
           │ listSessions()        │
           └───────────┬───────────┘
                       │
                       ▼
           ┌───────────────────────┐
           │   bridge/queue.ts     │
           │                       │
           │ enqueue(session, task)│
           │ processNext()        │
           └───────────┬───────────┘
                       │
                       ▼
           ┌───────────────────────┐
           │  bridge/executor.ts   │
           │                       │         ┌──────────────────┐
           │ execute(prompt,       │────────►│ child_process    │
           │   sessionId,          │         │ claude -p        │
           │   workDir)            │         │ --session-id ... │
           │                       │◄────────│ (stdout/stderr)  │
           └───────────┬───────────┘         └──────────────────┘
                       │
                       ▼
           ┌───────────────────────┐
           │ store/active-process  │
           │                       │
           │ track PID, status     │──────► data/bridge.db
           └───────────────────────┘
```

> 出典: round1-bridge-architect.md §8.1

### 3.4 メッセージシーケンス（正常系）

```
User        Slack API      Bot Server     Session Mgr     Queue        Executor      Claude CLI
 │              │              │              │              │              │              │
 │  message     │              │              │              │              │              │
 ├─────────────►│  event       │              │              │              │              │
 │              ├─────────────►│              │              │              │              │
 │              │  200 OK      │              │              │              │              │
 │              │◄─────────────┤              │              │              │              │
 │              │              │              │              │              │              │
 │              │  ⏳ reaction │              │              │              │              │
 │              │◄─────────────┤              │              │              │              │
 │              │              │              │              │              │              │
 │              │              │ resolve()    │              │              │              │
 │              │              ├─────────────►│              │              │              │
 │              │              │  session_id  │              │              │              │
 │              │              │◄─────────────┤              │              │              │
 │              │              │              │              │              │              │
 │              │              │       enqueue(task)         │              │              │
 │              │              ├────────────────────────────►│              │              │
 │              │              │              │              │  execute()   │              │
 │              │              │              │              ├─────────────►│              │
 │              │              │              │              │              │ claude -p    │
 │              │              │              │              │              ├─────────────►│
 │              │              │              │              │              │   stdout     │
 │              │              │              │              │              │◄─────────────┤
 │              │              │              │              │  result      │              │
 │              │              │              │              │◄─────────────┤              │
 │              │              │              │              │              │              │
 │              │  reply msg   │              │              │              │              │
 │              │◄─────────────┤              │              │              │              │
 │  reply       │              │              │              │              │              │
 │◄─────────────┤              │              │              │              │              │
 │              │  ✅ reaction │              │              │              │              │
 │              │◄─────────────┤              │              │              │              │
```

> 出典: round1-bridge-architect.md §8.2

### 3.5 設計原則

| 原則 | 説明 | 根拠 |
|------|------|------|
| 都度起動モデル (V2) | メッセージごとに `claude -p` を spawn。セッション永続化は Claude Code 側に委任 | round1-synthesis.md V2 |
| スレッド=セッション (V4) | チャンネル直下メッセージ→新規セッション、スレッド返信→継続 | round1-synthesis.md V4 |
| 2段階レスポンス (V5) | 即時ack + リアクション → 非同期実行 → 結果投稿 | round1-synthesis.md V5 |
| セッション直列化 | 同一セッション内のリクエストはキューで直列処理。異なるセッション間は並行可 | round1-bridge-architect.md §5.2 |

---

## 4. CLI仕様リファレンス

### 4.1 `claude -p` の全オプション

> 出典: round1-cli-specialist.md §1-§2

#### 入出力制御

| オプション | 説明 |
|---|---|
| `-p, --print` | 非対話モード。応答を出力して終了 |
| `--output-format <format>` | `text`(デフォルト), `json`(単一結果), `stream-json`(ストリーミング)。`--print`必須 |
| `--input-format <format>` | `text`(デフォルト), `stream-json`。`--print`必須 |
| `--include-partial-messages` | 部分メッセージチャンクを含める（`stream-json`必須） |
| `--replay-user-messages` | stdinからのユーザーメッセージをstdoutに再出力 |
| `--json-schema <schema>` | 構造化出力のJSONスキーマ指定 |
| `--verbose` | 冗長モード。**`stream-json`使用時に必須**（P0-4で発見） |

#### セッション管理

| オプション | 説明 |
|---|---|
| `-c, --continue` | 現在ディレクトリの最新セッション継続 |
| `-r, --resume [value]` | セッションIDで会話再開 |
| `--session-id <uuid>` | 新規セッションに特定UUIDを割り当て |
| `--fork-session` | 再開時に新セッションIDで分岐 |
| `--no-session-persistence` | セッション永続化を無効化（`-p`のみ） |
| `--from-pr [value]` | PRリンクセッションを再開 |

#### モデル・予算

| オプション | 説明 |
|---|---|
| `--model <model>` | モデル指定（エイリアスまたはフルネーム） |
| `--fallback-model <model>` | 過負荷時の自動フォールバック（`-p`のみ） |
| `--max-budget-usd <amount>` | API呼び出しの最大予算（`-p`のみ） |
| `--effort <level>` | 思考深度: `low`, `medium`, `high`, `max` |

#### プロンプト制御

| オプション | 説明 |
|---|---|
| `--system-prompt <prompt>` | システムプロンプト置換 |
| `--append-system-prompt <prompt>` | システムプロンプトに追記 |

#### ツール・権限

| オプション | 説明 |
|---|---|
| `--allowedTools <tools...>` | 許可ツール名リスト（例: `"Bash(git:*) Edit"`） |
| `--disallowedTools <tools...>` | 禁止ツール名リスト |
| `--tools <tools...>` | 使用可能ツール指定 |
| `--permission-mode <mode>` | `default`, `plan`, `auto`, `acceptEdits`, `bypassPermissions`, `dontAsk` |
| `--dangerously-skip-permissions` | 全権限チェックをバイパス |

#### ディレクトリ・ファイル

| オプション | 説明 |
|---|---|
| `--add-dir <directories...>` | ツールアクセスを許可する追加ディレクトリ |
| `--file <specs...>` | 起動時にダウンロードするファイルリソース |

#### MCP設定

| オプション | 説明 |
|---|---|
| `--mcp-config <configs...>` | MCPサーバー設定のロード |
| `--strict-mcp-config` | 指定MCPサーバーのみ使用 |

### 4.2 セッション管理の仕組み

> 出典: round1-cli-specialist.md §3、round2-e2e-validator.md §1

#### セッションの保存場所

```
~/.claude/projects/<encoded-path>/<session-id>.jsonl
```

- `<encoded-path>`: 作業ディレクトリの絶対パスをハイフン区切りに変換
  - 例: `/Users/archeco055/dev/Discussion` → `-Users-archeco055-dev-Discussion`
- `<session-id>`: UUID v4形式
- ファイル形式: JSONL（1行1JSONオブジェクト）

#### セッション操作コマンド（実機検証済み）

| 操作 | コマンド | 検証結果 |
|------|---------|---------|
| 新規セッション（ID指定） | `claude -p --session-id <uuid> "prompt"` | 成功（round2-e2e-validator.md §1） |
| セッション再開 | `claude -p -r <uuid> "prompt"` | 成功（round2-e2e-validator.md §1） |
| 直前セッション継続 | `claude -p -c "prompt"` | 成功（CWD依存） |
| セッション分岐 | `claude -p -c --fork-session "prompt"` | 未検証 |

**重要: `--session-id` と `-r` は排他的に使用する。**

- `--session-id`: 新規セッションに事前にUUIDを割り当てる用途
- `-r`: 既存セッションIDを指定して再開する用途

> 出典: round1-synthesis.md C1、round2-e2e-validator.md §1

### 4.3 出力形式と JSON 構造

#### `--output-format json` の構造（実機確認済み）

> 出典: round2-e2e-validator.md §3

```json
{
  "type": "result",
  "subtype": "success",
  "is_error": false,
  "duration_ms": 2377,
  "duration_api_ms": 2365,
  "num_turns": 1,
  "result": "Hello!",
  "stop_reason": "end_turn",
  "session_id": "79c2a6a5-2f2a-4db8-b2bc-bf886b0f1911",
  "total_cost_usd": 0.0354405,
  "usage": {
    "input_tokens": 3,
    "cache_creation_input_tokens": 4468,
    "cache_read_input_tokens": 14751,
    "output_tokens": 5,
    "server_tool_use": {
      "web_search_requests": 0,
      "web_fetch_requests": 0
    },
    "service_tier": "standard"
  },
  "modelUsage": {
    "claude-opus-4-6": {
      "inputTokens": 3,
      "outputTokens": 5,
      "cacheReadInputTokens": 14751,
      "cacheCreationInputTokens": 4468,
      "costUSD": 0.0354405,
      "contextWindow": 200000,
      "maxOutputTokens": 32000
    }
  },
  "permission_denials": [],
  "uuid": "495d1e64-5a5b-4b4b-8232-083b496f0333"
}
```

#### Bridge実装で重要なフィールド

| フィールド | 型 | 用途 |
|-----------|---|------|
| `result` | string | Slackに投稿する応答テキスト |
| `is_error` | boolean | エラー判定 |
| `session_id` | string (UUID) | DB保存用 |
| `total_cost_usd` | number | コスト追跡 |
| `duration_ms` | number | 実行時間監視 |
| `stop_reason` | string | `"end_turn"` = 正常終了 |
| `num_turns` | number | ツール呼び出し回数を含むターン数 |
| `permission_denials` | array | 権限拒否されたツール操作リスト |

#### `--output-format stream-json` のイベント構造（実機確認済み）

> 出典: round2-e2e-validator.md §4

**必須条件: `--verbose` フラグが必須。** なしではエラーが発生する。

イベント出現順序:
```
system(hook_started) → system(hook_response) → system(init) → assistant → rate_limit_event → result
```

| イベントtype | 用途 |
|-------------|------|
| `system(init)` | セッション初期化確認、CWD・モデル情報取得 |
| `assistant` | リアルタイム応答表示（`message.content[].text`抽出） |
| `result` | 最終結果取得、コスト・実行時間記録 |
| `rate_limit_event` | レートリミット監視 |

---

## 5. セッション管理設計

### 5.1 ライフサイクル

> 出典: round1-bridge-architect.md §3、round2-ux-validator.md §4

#### セッション作成（新規）

**トリガー:** マッピングされていない Slack スレッドからのメッセージ

```
1. UUIDv4 でセッションID生成 (crypto.randomUUID())
2. 作業ディレクトリを決定（チャンネルに紐づくデフォルト or ユーザー指定）
3. SQLite にマッピング保存:
   - slack_thread_ts → session_id
   - session_id → working_directory
4. claude -p --session-id <id> --permission-mode auto "prompt" を実行
   (spawn の cwd オプションで作業ディレクトリを指定)
```

#### セッション継続

**トリガー:** 既にマッピングが存在する Slack スレッドからのメッセージ

```
1. slack_thread_ts からセッションIDを検索
2. claude -p -r <session-id> --permission-mode auto "prompt" を実行
   (-r フラグにより前回のセッション履歴を復元)
3. マッピングの last_active_at を更新
```

#### セッション削除・クリーンアップ

- `last_active_at` が30日超のマッピングを自動削除
- Claude Code 側のセッションファイルは触らない（Claude Code 自身の管理に委ねる）

### 5.2 データモデル（SQLiteスキーマ）

> 出典: round1-bridge-architect.md §4.2

```sql
-- 作業ディレクトリとSlackチャンネルのマッピング
CREATE TABLE channel_workdir (
    channel_id       TEXT PRIMARY KEY,
    working_directory TEXT NOT NULL,
    created_at       TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Slackスレッドと Claude Code セッションのマッピング
CREATE TABLE thread_session (
    thread_ts        TEXT NOT NULL,
    channel_id       TEXT NOT NULL,
    session_id       TEXT NOT NULL,
    working_directory TEXT NOT NULL,
    status           TEXT NOT NULL DEFAULT 'active',  -- active / completed / error
    created_at       TEXT NOT NULL DEFAULT (datetime('now')),
    last_active_at   TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (channel_id, thread_ts)
);

-- 実行中プロセスの追跡
CREATE TABLE active_process (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id       TEXT NOT NULL,
    pid              INTEGER NOT NULL,
    started_at       TEXT NOT NULL DEFAULT (datetime('now')),
    status           TEXT NOT NULL DEFAULT 'running',  -- running / completed / failed / timeout
    slack_channel_id TEXT NOT NULL,
    slack_thread_ts  TEXT NOT NULL,
    prompt_text      TEXT,
    completed_at     TEXT
);

-- インデックス
CREATE INDEX idx_thread_session_session ON thread_session(session_id);
CREATE INDEX idx_active_process_session ON active_process(session_id);
CREATE INDEX idx_active_process_status ON active_process(status);
```

### 5.3 エンティティ関連図

```
┌─────────────────┐        ┌──────────────────┐        ┌─────────────────┐
│ Slack Channel   │ 1    N │ Slack Thread     │ 1    1 │ Claude Session  │
│                 ├────────┤                  ├────────┤                 │
│ channel_id (PK) │        │ thread_ts        │        │ session_id      │
│ working_dir     │        │ channel_id       │        │ working_dir     │
└─────────────────┘        │ session_id (FK)  │        │ status          │
                           └────────┬─────────┘        └─────────────────┘
                                    │
                                    │ 1    N
                                    ▼
                           ┌──────────────────┐
                           │ Active Process   │
                           │                  │
                           │ pid              │
                           │ status           │
                           │ started_at       │
                           └──────────────────┘
```

> 出典: round1-bridge-architect.md §4.3

### 5.4 コマンド構築ルール

> 出典: round2-e2e-validator.md §8、round2-ux-validator.md §3

#### 新規セッション開始

```typescript
const sessionId = crypto.randomUUID(); // UUID v4（小文字）
const args = [
  '-p',
  '--session-id', sessionId,
  '--output-format', 'json',
  '--permission-mode', 'auto',
  '--max-budget-usd', String(maxBudget),
  prompt
];
// spawn('claude', args, { cwd: projectDirectory })
```

#### セッション継続

```typescript
const args = [
  '-p',
  '-r', existingSessionId,
  '--output-format', 'json',
  '--permission-mode', 'auto',
  '--max-budget-usd', String(maxBudget),
  prompt
];
// spawn('claude', args, { cwd: projectDirectory })
```

#### リアルタイムストリーミング（Phase 2以降）

```typescript
const args = [
  '-p',
  '--session-id', sessionId,
  '--output-format', 'stream-json',
  '--verbose',  // 必須！（P0-4）
  '--permission-mode', 'auto',
  prompt
];
```

---

## 6. Slack Bot設計

### 6.1 チャンネル戦略

> 出典: round1-slack-architect.md §2

**MVP:** 環境変数 `SLACK_CHANNEL_ID` で固定した1チャンネルのみ

**将来（Phase 2以降）:** パターン2「自動チャンネル作成」

```
ユーザー ──コマンド──► Bot: /cc new /path/to/project
                        │
                        ├─ #claude-project-name チャンネルを自動作成
                        ├─ チャンネルトピックに作業ディレクトリを設定
                        └─ チャンネル内のメッセージ → そのディレクトリの Claude Code へ

チャンネル内:
  メッセージ → 新規セッション開始
  スレッド内返信 → セッション継続
```

### 6.2 OAuth スコープ一覧

> 出典: round1-slack-architect.md §1.3

#### Bot Token Scopes (xoxb)

| スコープ | 用途 | 必須度 |
|---------|------|--------|
| `app_mentions:read` | @メンション受信 | MVP |
| `chat:write` | メッセージ投稿 | MVP |
| `channels:history` | パブリックチャンネルメッセージ読み取り | MVP |
| `channels:read` | チャンネル情報取得 | MVP |
| `reactions:write` | リアクション絵文字の追加・削除 | MVP |
| `files:write` | ファイルアップロード（長文出力用） | MVP |
| `files:read` | ファイル読み取り | MVP |
| `channels:manage` | チャンネル作成・管理 | Phase 2 |
| `groups:history` | プライベートチャンネルメッセージ読み取り | Phase 2 |
| `groups:read` | プライベートチャンネル情報取得 | Phase 2 |
| `commands` | スラッシュコマンド受信 | Phase 2 |
| `users:read` | ユーザー情報取得 | Phase 2 |

#### App-Level Token Scopes

| スコープ | 用途 |
|---------|------|
| `connections:write` | Socket Mode接続用（必須） |

### 6.3 メッセージハンドリング

> 出典: round1-slack-architect.md §3

#### Slackのメッセージ制限

| 制限 | 値 | 対処 |
|------|-----|------|
| メッセージテキスト推奨長 | 4,000文字 | 超過時は分割 |
| メッセージテキスト上限 | 40,000文字 | 超過時はファイルアップロード |
| Block Kit textオブジェクト | 3,000文字 | セクションブロックの分割 |
| ブロック数上限（メッセージ） | 50ブロック | 超過時はファイルアップロード |
| ファイルアップロード（スニペット） | 1 MB | 通常十分 |

#### 長文レスポンスの分割戦略

```typescript
function splitResponse(text: string): SlackOutput {
    const MAX_MESSAGE_LENGTH = 3900;  // 安全マージン込み
    const MAX_FILE_THRESHOLD = 39000; // ファイルアップロード閾値

    // 40,000文字超 → ファイルアップロード
    if (text.length > MAX_FILE_THRESHOLD) {
        return { type: 'file', content: text, filename: 'response.md' };
    }

    // 4,000文字以下 → そのまま投稿
    if (text.length <= MAX_MESSAGE_LENGTH) {
        return { type: 'single', text };
    }

    // 4,000〜40,000文字 → 分割投稿
    return { type: 'multi', messages: splitAtBoundaries(text, MAX_MESSAGE_LENGTH) };
}
```

**分割の優先境界（上から優先）:**

1. Markdown の見出し境界 (`## `, `### `)
2. コードブロック境界 (` ``` ` の開始/終了)
3. 空行（パラグラフ境界）
4. 文末（`. ` の後）
5. 強制分割（上記すべてで分割できない場合）

**重要ルール:** コードブロックの途中で分割しない。

#### Claude Code 出力 → Slack mrkdwn 変換

> 出典: round1-slack-architect.md §3.3

| Markdown | Slack mrkdwn | 変換要否 |
|----------|-------------|---------|
| `**bold**` | `*bold*` | 要変換 |
| `*italic*` | `_italic_` | 要変換 |
| `~~strike~~` | `~strike~` | 要変換 |
| `` `code` `` | `` `code` `` | 変換不要 |
| ` ```code block``` ` | ` ```code block``` ` | 変換不要 |
| `[text](url)` | `<url\|text>` | 要変換 |
| `# Heading` | `*Heading*` (太字で代用) | 要変換 |
| `- item` | `• item` | 要変換 |
| `> quote` | `> quote` | 変換不要 |
| `---` | `═══════════════════` | 要変換 |

```typescript
function markdownToMrkdwn(md: string): string {
    let result = md;

    // 見出しを太字に変換（コードブロック外のみ）
    result = convertOutsideCodeBlocks(result, (text) => {
        text = text.replace(/^### (.+)$/gm, '*$1*');
        text = text.replace(/^## (.+)$/gm, '*$1*');
        text = text.replace(/^# (.+)$/gm, '*$1*');
        return text;
    });

    // 太字: **text** → *text*
    result = convertOutsideCodeBlocks(result, (text) =>
        text.replace(/\*\*(.+?)\*\*/g, '*$1*')
    );

    // イタリック: *text* → _text_ (太字変換後に実行)
    result = convertOutsideCodeBlocks(result, (text) =>
        text.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '_$1_')
    );

    // 取り消し線: ~~text~~ → ~text~
    result = convertOutsideCodeBlocks(result, (text) =>
        text.replace(/~~(.+?)~~/g, '~$1~')
    );

    // リンク: [text](url) → <url|text>
    result = convertOutsideCodeBlocks(result, (text) =>
        text.replace(/\[(.+?)\]\((.+?)\)/g, '<$2|$1>')
    );

    // リスト: - item → • item
    result = convertOutsideCodeBlocks(result, (text) =>
        text.replace(/^(\s*)- /gm, '$1• ')
    );

    // 水平線
    result = convertOutsideCodeBlocks(result, (text) =>
        text.replace(/^---+$/gm, '═══════════════════')
    );

    return result;
}
```

### 6.4 スラッシュコマンド

> 出典: round1-slack-architect.md §4、round1-synthesis.md V6

**問題:** Claude Code の `/commit` 等と Slack の `/` コマンドが記法衝突する。

**解決策:** `cc /xxx` テキストベースコマンド（MVP）

```
cc /commit          → Claude Code の /commit を転送
cc /review-pr 123   → Claude Code の /review-pr を転送
cc /help            → 利用可能なコマンド一覧表示
```

実装:
```typescript
app.message(/^cc\s+\/(\S+)(.*)$/i, async ({ message, context, say }) => {
    const command = context.matches[1];   // "commit"
    const args = context.matches[2].trim(); // "-m 'fix bug'"
    const prompt = `/${command} ${args}`;
    await executeClaudeCommand(message, prompt);
});
```

**Phase 2:** 管理系コマンドのみ Slack スラッシュコマンドとして登録

| Slack コマンド | 用途 |
|--------------|------|
| `/cc new <dir>` | 新規プロジェクトチャンネル作成 |
| `/cc sessions` | セッション一覧 |
| `/cc status` | Botステータス確認 |
| `/cc help` | ヘルプ表示 |

### 6.5 Block Kit UI

> 出典: round1-slack-architect.md §5

#### 処理中インジケーター

```typescript
// Phase 1: リアクション（MVP）
await client.reactions.add({
    channel: channelId,
    timestamp: messageTs,
    name: 'hourglass_flowing_sand',  // ⏳
});

// 完了後
await client.reactions.remove({ channel: channelId, timestamp: messageTs, name: 'hourglass_flowing_sand' });
await client.reactions.add({ channel: channelId, timestamp: messageTs, name: 'white_check_mark' });
```

#### 確認ダイアログ（Phase 3: destructive operations用）

`cc /commit` や破壊的操作の実行前に確認を挟む:

```json
{
    "blocks": [
        {
            "type": "section",
            "text": {
                "type": "mrkdwn",
                "text": "以下の変更をコミットしますか？\n```\nM  src/auth.ts\nA  src/middleware/jwt.ts\n```"
            }
        },
        {
            "type": "actions",
            "elements": [
                {
                    "type": "button",
                    "text": { "type": "plain_text", "text": "コミットする" },
                    "style": "primary",
                    "action_id": "confirm_commit"
                },
                {
                    "type": "button",
                    "text": { "type": "plain_text", "text": "キャンセル" },
                    "style": "danger",
                    "action_id": "cancel_commit"
                }
            ]
        }
    ]
}
```

#### Home Tab（Phase 3）

> 出典: round1-slack-architect.md §5.3

Home Tab に表示する情報:
- Bot のステータス（稼働中/停止中）
- 登録プロジェクト一覧（チャンネルへのリンク付き）
- アクティブセッション数
- 最近のアクティビティ
- 「新規プロジェクト登録」ボタン

### 6.6 スレッドの活用方法

> 出典: round1-slack-architect.md §3.6

```
チャンネル（#claude-project-a）
│
├─ [メッセージ] 「認証機能を実装して」        ← セッション1 開始
│  ├─ [Bot] ⏳ 処理中...
│  ├─ [Bot] 認証機能を実装しました。...       ← セッション1 応答
│  ├─ [ユーザー] テストも追加して             ← セッション1 継続
│  └─ [Bot] テストを追加しました。...         ← セッション1 応答
│
├─ [メッセージ] 「README を更新して」         ← セッション2 開始（別スレッド）
│  └─ [Bot] README を更新しました。...        ← セッション2 応答
│
└─ [メッセージ] 「現在の git status は？」    ← セッション3 開始
   └─ [Bot] ...
```

**ルール:**
- チャンネル直下のメッセージ = 新規セッション開始
- スレッド内の返信 = 既存セッション継続
- Bot の応答は常にスレッド内に投稿（`reply_broadcast: false`）
- 重要な結果のみ `reply_broadcast: true` でチャンネルにも表示（ユーザー要求時）

---

## 7. 実装仕様

### 7.1 TypeScript型定義

> 出典: round2-ux-validator.md §2

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
  prompt: string;
  sessionId: string;
  workingDirectory: string;
  isResume: boolean;
  timeoutMs?: number;
  maxBudgetUsd?: number;
}

export interface ExecuteResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
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
  resolveOrCreate(channelId: string, threadTs: string): Promise<SessionResolution>;
  listActive(): Promise<SessionInfo[]>;
  updateStatus(sessionId: string, status: SessionInfo['status']): Promise<void>;
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
  enqueue(task: QueueTask): Promise<void>;
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
  markdownToMrkdwn(md: string): string;
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

// ============================================================
// Claude JSON Result（実機確認済み）
// ============================================================

export interface ClaudeJsonResult {
  type: 'result';
  subtype: 'success' | 'error';
  is_error: boolean;
  result: string;
  session_id: string;
  total_cost_usd: number;
  duration_ms: number;
  stop_reason: string;
  num_turns: number;
  permission_denials: string[];
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens: number;
    cache_creation_input_tokens: number;
  };
}
```

### 7.2 修正済みExecutor実装

> 出典: round2-ux-validator.md §3（P0-1, P0-2, P1-2 修正反映）

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

    const args = this.buildArgs({ prompt, sessionId, isResume, maxBudgetUsd });
    const startTime = Date.now();

    return new Promise<ExecuteResult>((resolve) => {
      const proc: ChildProcess = spawn('claude', args, {
        cwd: workingDirectory,
        env: {
          ...process.env,
          CLAUDECODE: undefined,  // ネスト防止チェック回避
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        proc.kill('SIGTERM');
        setTimeout(() => {
          if (!proc.killed) proc.kill('SIGKILL');
        }, 5_000);
      }, timeoutMs);

      proc.stdout?.on('data', (data: Buffer) => { stdout += data.toString(); });
      proc.stderr?.on('data', (data: Buffer) => { stderr += data.toString(); });

      proc.on('close', (code: number | null) => {
        clearTimeout(timer);
        resolve({ stdout, stderr, exitCode: code ?? 1, timedOut, durationMs: Date.now() - startTime });
      });

      proc.on('error', (err: Error) => {
        clearTimeout(timer);
        resolve({ stdout, stderr: stderr + '\n' + err.message, exitCode: 1, timedOut: false, durationMs: Date.now() - startTime });
      });
    });
  }

  /**
   * コマンド引数構築。--session-id と -r は排他的。
   *
   * 新規: claude -p --session-id <uuid> --permission-mode auto [--max-budget-usd N] "prompt"
   * 継続: claude -p -r <session-id> --permission-mode auto [--max-budget-usd N] "prompt"
   */
  private buildArgs(params: {
    prompt: string;
    sessionId: string;
    isResume: boolean;
    maxBudgetUsd?: number;
  }): string[] {
    const args: string[] = ['-p'];

    if (params.isResume) {
      args.push('-r', params.sessionId);
    } else {
      args.push('--session-id', params.sessionId);
    }

    args.push('--permission-mode', this.config.bridge.permissionMode || 'auto');

    if (params.maxBudgetUsd !== undefined && params.maxBudgetUsd > 0) {
      args.push('--max-budget-usd', params.maxBudgetUsd.toString());
    }

    args.push(params.prompt);
    return args;
  }
}
```

### 7.3 設定ファイル

> 出典: round2-ux-validator.md §5

#### .env.example

```bash
# ============================================================
# Slack 設定
# ============================================================
SLACK_BOT_TOKEN=xoxb-your-bot-token        # Bot User OAuth Token
SLACK_APP_TOKEN=xapp-your-app-token        # Socket Mode用 App-Level Token
SLACK_SIGNING_SECRET=your-signing-secret   # リクエスト署名検証用
SLACK_CHANNEL_ID=C01ABCDEFGH              # MVP: 単一チャンネルID

# ============================================================
# Bridge 設定
# ============================================================
DEFAULT_WORKING_DIRECTORY=/Users/you/dev/your-project  # 作業ディレクトリ
COMMAND_TIMEOUT_MS=300000                  # タイムアウト (5分)
MAX_CONCURRENT_SESSIONS=3                 # 同時実行セッション数上限
MAX_BUDGET_PER_SESSION=2.00               # セッションあたり最大コスト (USD)
PERMISSION_MODE=auto                       # 権限モード

# ============================================================
# データベース設定
# ============================================================
DATABASE_PATH=./data/bridge.db

# ============================================================
# ログ設定
# ============================================================
LOG_LEVEL=info
LOG_DIR=./logs
```

#### package.json

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

#### tsconfig.json

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

### 7.4 ディレクトリ構造

> 出典: round2-ux-validator.md §6

```
claude-slack-bridge/
├── src/
│   ├── index.ts                    # エントリポイント: Bolt App 初期化・起動
│   ├── config.ts                   # 環境変数 → BridgeConfig 変換 (zod バリデーション)
│   ├── types.ts                    # 共通型定義
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
│   ├── executor.test.ts
│   ├── session-manager.test.ts
│   ├── queue.test.ts
│   ├── command-parser.test.ts
│   └── response-builder.test.ts
│
├── .env.example
├── .gitignore
├── package.json
├── tsconfig.json
├── vitest.config.ts
└── README.md
```

---

## 8. データフロー（5シナリオ）

### 8.1 新規セッション

> 出典: round2-ux-validator.md §4.1

```
User → Slack: チャンネル直下にメッセージ投稿
  │
  ▼
EventHandler: message event 受信 → 即時 ack
  │
  ├─ reactions.add (⏳ hourglass)
  │
  ▼
SessionManager.resolveOrCreate(channelId, message.ts)
  │  thread_session にマッピングなし → UUID v4 生成
  │  INSERT thread_session
  │  → { sessionId: "new-uuid", workDir: "/project", isResume: false }
  │
  ▼
SessionQueue.enqueue(task)
  │
  ▼
ClaudeExecutor.execute({
  prompt: "認証機能を実装して",
  sessionId: "new-uuid",
  workingDirectory: "/Users/user/dev/my-project",
  isResume: false,
})
  │
  │  コマンド:
  │  claude -p --session-id new-uuid --permission-mode auto --max-budget-usd 2.00 "認証機能を実装して"
  │  cwd: /Users/user/dev/my-project
  │
  ▼
INSERT active_process → 実行 → UPDATE active_process (status='completed')
  │
  ▼
ResponseBuilder.format(output) → chat.postMessage (thread reply)
  │
  ▼
reactions.remove (⏳) → reactions.add (✅)
```

### 8.2 セッション継続

> 出典: round2-ux-validator.md §4.2

```
User → Slack: スレッド内に返信
  │
  ▼
EventHandler: message event 受信 → 即時 ack + ⏳
  │
  ▼
SessionManager.resolveOrCreate(channelId, threadTs)
  │  thread_session テーブル検索 → マッピングあり
  │  → { sessionId: "existing-uuid", workDir: "/project", isResume: true }
  │
  ▼
SessionQueue.enqueue(task) → 同一sessionIdは直列化
  │
  ▼
ClaudeExecutor.execute({
  prompt: "テストも追加して",
  sessionId: "existing-uuid",
  isResume: true,                     // ← ここが true
})
  │
  │  コマンド:
  │  claude -p -r existing-uuid --permission-mode auto "テストも追加して"
  │           ^^^^^^^^^^^^^^^^^^^
  │           -r で既存セッションを再開（--session-id ではなく -r）
  │
  ▼
結果を Slack スレッドに投稿 → ⏳ を ✅ に置換
```

### 8.3 `cc /commit` コマンド実行

> 出典: round2-ux-validator.md §4.3

```
User → Slack: スレッド内に "cc /commit -m 'fix auth bug'" と投稿
  │
  ▼
EventHandler → 即時 ack + ⏳
  │
  ▼
CommandParser: テキスト解析
  │  正規表現: /^cc\s+\/(\S+)(.*)$/i
  │  マッチ: command = "commit", args = "-m 'fix auth bug'"
  │  → prompt: "/commit -m 'fix auth bug'"
  │
  ▼
SessionManager → isResume: true（スレッド内）
  │
  ▼
ClaudeExecutor.execute({
  prompt: "/commit -m 'fix auth bug'",
  sessionId: "existing-uuid",
  isResume: true,
})
  │
  │  コマンド:
  │  claude -p -r existing-uuid --permission-mode auto "/commit -m 'fix auth bug'"
  │
  ▼
結果を Slack スレッドに投稿 → ⏳ を ✅ に置換
```

### 8.4 長文応答

> 出典: round2-ux-validator.md §4.4

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
  │      2. コードブロック境界で分割
  │      3. 空行で分割
  │      4. 文末で分割
  │      5. 強制分割
  │    → 各chunk: chat.postMessage (thread reply, 連続投稿)
  │
  └─ stdout.length > 39,000 文字
       → { type: 'file', content: stdout, filename: 'response.md' }
       → files.uploadV2 でファイルアップロード
```

### 8.5 エラー処理

> 出典: round2-ux-validator.md §4.5

```
■ パターン A: プロセスクラッシュ (exitCode ≠ 0, timedOut = false)
  → active_process.status = 'failed'
  → Slack: ":x: エラーが発生しました\n```\n{stderrの先頭500文字}\n```"
  → リアクション: ⏳ → :x:

■ パターン B: タイムアウト (timedOut = true)
  → SIGTERM → 5秒待ち → SIGKILL
  → active_process.status = 'timeout'
  → Slack: ":warning: 処理がタイムアウトしました (制限: 5分)"
  → リアクション: ⏳ → :warning:

■ パターン C: セッション不整合
  → thread_sessionから旧マッピング削除
  → 新規セッションとして再作成 (isResume=false で再実行)
  → Slack: ":arrows_counterclockwise: セッションをリセットしました"

■ パターン D: Slack APIエラー
  → 指数バックオフでリトライ (1秒→2秒→4秒, 最大3回)
  → リトライ失敗: ログにERROR記録
```

---

## 9. MVP実装チェックリスト

> 出典: round2-ux-validator.md §7

### Phase 0: プロジェクト基盤 (0.5日)

| # | タスク | 依存 | 推定 |
|---|--------|------|------|
| 0-1 | `npm init` + package.json 作成 + 依存インストール | なし | 15分 |
| 0-2 | tsconfig.json / vitest.config.ts 作成 | 0-1 | 10分 |
| 0-3 | .env.example 作成 + dotenv 設定 | 0-1 | 10分 |
| 0-4 | `src/config.ts` — zod で環境変数バリデーション → BridgeConfig | 0-3 | 30分 |
| 0-5 | `src/utils/logger.ts` — Winston ロガー初期化 | 0-1 | 20分 |
| 0-6 | `src/utils/errors.ts` — カスタムエラークラス | 0-1 | 15分 |
| 0-7 | `src/types.ts` — 全インターフェース定義 | 0-2 | 20分 |
| 0-8 | .gitignore 作成 | なし | 5分 |

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
| 2-1 | `src/bridge/executor.ts` — ClaudeExecutor（修正済み実装） | 0-4, 0-5, 0-6 | 45分 |
| 2-2 | executor.test.ts — mock spawn テスト | 2-1 | 30分 |
| 2-3 | `src/bridge/session-manager.ts` — resolveOrCreate / listActive / updateStatus | 1-2, 1-3 | 45分 |
| 2-4 | session-manager.test.ts | 2-3 | 30分 |
| 2-5 | `src/bridge/queue.ts` — SessionQueue（セッション単位直列、セッション間並行） | 2-1, 1-4 | 45分 |
| 2-6 | queue.test.ts | 2-5 | 30分 |

### Phase 3: Slack レイヤー (0.5日)

| # | タスク | 依存 | 推定 |
|---|--------|------|------|
| 3-1 | `src/slack/command-parser.ts` — "cc /xxx" パターン検出 | 0-7 | 20分 |
| 3-2 | command-parser.test.ts | 3-1 | 15分 |
| 3-3 | `src/slack/response-builder.ts` — mrkdwn変換 + splitResponse | 0-7 | 45分 |
| 3-4 | response-builder.test.ts | 3-3 | 30分 |
| 3-5 | `src/slack/event-handler.ts` — onMessage / onAppMention | 2-3, 2-5, 3-1, 3-3 | 60分 |

### Phase 4: 統合・エントリポイント (0.5日)

| # | タスク | 依存 | 推定 |
|---|--------|------|------|
| 4-1 | `src/index.ts` — Bolt App 初期化、Socket Mode 接続、ハンドラ登録 | 3-5 | 30分 |
| 4-2 | Slack App 作成 (api.slack.com) + OAuth スコープ + Socket Mode | なし | 20分 |
| 4-3 | .env に実際のトークンを設定 | 4-2 | 5分 |
| 4-4 | `npm run dev` で起動 → 手動 E2E テスト | 4-1, 4-3 | 30分 |
| 4-5 | エラーハンドリング調整 | 4-4 | 30分 |
| 4-6 | 起動時リカバリーチェック（orphanプロセス検出） | 4-1, 1-4 | 20分 |

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

**合計推定: 約3日**

### MVP 完了判定基準

- [ ] Slack チャンネルにメッセージ投稿 → Claude Code が応答 → スレッド内に返信
- [ ] スレッド内に追加メッセージ → 同一セッション継続 → コンテキスト保持した応答
- [ ] `cc /commit` → Claude Code の /commit が実行される
- [ ] 処理中に ⏳ リアクション表示 → 完了後に ✅ に置換
- [ ] タイムアウト時にユーザーに通知
- [ ] プロセスクラッシュ時にエラーメッセージ表示

---

## 10. E2E検証結果

> 出典: round2-e2e-validator.md

### 検証環境

| 項目 | 値 |
|------|---|
| 検証日 | 2026-03-13 |
| CLI バージョン | 2.1.74 |
| OS | macOS (Darwin 25.3.0) |

### 検証1: セッション継続

**パターンA: `--session-id` → `-r`**

```bash
SESSION_ID=$(uuidgen | tr '[:upper:]' '[:lower:]')
claude -p --session-id "$SESSION_ID" "hello, remember the word 'banana'"
claude -p -r "$SESSION_ID" "what word did I ask you to remember?"
```

**結果: 成功** — 前回の文脈（"banana"）を正しく想起。

**パターンB: `-c` で直前セッション継続**

```bash
claude -p "hello, remember the word 'apple'"
claude -p -c "what word did I ask you to remember?"
```

**結果: 成功** — CWD依存（同一ディレクトリから実行する必要あり）。

**重要な発見:**
- セッションIDはUUID v4（小文字）が必要。`uuidgen` の出力は大文字の場合があるため `tr '[:upper:]' '[:lower:]'` で変換推奨
- `CLAUDECODE` 環境変数がセットされているとネスト禁止チェックでブロックされる

### 検証2: permission-mode

**テスト1: `--permission-mode auto`**

```bash
claude -p --permission-mode auto "Read the file ... and tell me how many sections it has"
```

**結果: 成功** — 対話的権限確認ダイアログなしで正常動作。

**テスト2: `--allowedTools` + `--permission-mode dontAsk`**

```bash
claude -p --allowedTools "Read" "Grep" "Glob" --permission-mode dontAsk "List the files in ..."
```

**結果: 成功** — 指定3ツールのみ使用可能。

**推奨設定:**

| ユースケース | 推奨設定 |
|-------------|---------|
| 読み取り専用タスク | `--allowedTools "Read" "Grep" "Glob" --permission-mode dontAsk` |
| 編集を含むタスク | `--permission-mode auto` |
| コマンド実行を含むタスク | `--permission-mode auto --allowedTools "Bash(git:*)" "Read" "Grep" "Glob" "Edit" "Write"` |
| サンドボックス環境 | `--dangerously-skip-permissions` |

### 検証3: JSON出力構造

`claude -p --output-format json "say hello in one word"` の出力構造を完全記録（§4.3参照）。

### 検証4: stream-json出力

**重要な発見:** `--output-format stream-json` には `--verbose` フラグが必須。なしではエラー:
```
Error: When using --print, --output-format=stream-json requires --verbose
```

### 検証5: CWD制御

```bash
cd /tmp && claude -p "what is the current working directory?"
```

**結果: 成功** — `/private/tmp` と応答（macOSではシンボリックリンク）。`--cwd` オプションは存在しない。

### 検証6: max-budget-usd

```bash
claude -p --max-budget-usd 0.01 "say hello in one word"
```

**結果:** `Error: Exceeded USD budget (0.01)` — 予算超過時は即座にエラーで終了。

**実用的な予算設定の目安:**

| タスク種別 | 推奨予算 |
|-----------|---------|
| 単純な質問応答 | $0.10 |
| ファイル読み取り+分析 | $0.50 |
| コード編集タスク | $1.00 |
| 複雑なマルチターンタスク | $5.00 |

**注意:** 単純な1ワード応答でも `total_cost_usd` は約 $0.035（キャッシュ状況で変動）。

### 検証結果サマリー

| ID | 問題 | 状態 |
|----|------|------|
| P0-1 | セッション継続コマンドの形式 | **解消**: `--session-id` で新規、`-r` で再開 |
| P0-2 | permission-mode未設定 | **解消**: `auto` を推奨デフォルトに |
| P0-3 | CLAUDECODE環境変数（新規発見） | **解消**: spawn時に `undefined` で回避 |
| P0-4 | stream-jsonに--verbose必須（新規発見） | **解消**: 設計書に記録 |

| Gap ID | Gap | 状態 |
|--------|-----|------|
| G1 | permission-mode推奨設定 | **解消** |
| G4 | JSON出力のレスポンス構造 | **解消** |

---

## 11. 将来拡張ロードマップ

> 出典: round1-slack-architect.md §7、round2-ux-validator.md §8.8

### Phase 2: 実用拡張（推定 3-4日）

| 機能 | 対応するCLIオプション | 詳細 |
|------|---------------------|------|
| `cc /xxx` テキストコマンド | — | メッセージパターンマッチでコマンド検出・転送 |
| Markdown → mrkdwn変換 | — | `markdownToMrkdwn()` 関数 |
| 長文分割・ファイルアップロード | — | 4,000文字超分割、40,000文字超ファイル化 |
| `/cc` Slackスラッシュコマンド | — | `/cc new`, `/cc sessions`, `/cc status` |
| 複数チャンネル対応 | — | `channels:manage` でチャンネル自動作成 |
| リアルタイムストリーミング | `--output-format stream-json --verbose --include-partial-messages` | `assistant` イベントからテキスト抽出し `chat.update` で逐次表示 |

### Phase 3: リッチUI（推定 2-3日）

| 機能 | 対応するCLIオプション | 詳細 |
|------|---------------------|------|
| Home Tab | — | ダッシュボード表示（プロジェクト一覧、アクティビティ） |
| 確認ダイアログ | — | 破壊的操作の実行前確認 |
| 処理中プログレス | — | 経過時間表示の定期更新 |
| モーダル | — | プロジェクト登録フォーム |
| セッション分岐 | `--fork-session` | スレッドから新スレッドを分岐 |

### Phase 4: 高度な機能（推定 3-5日）

| 機能 | 対応するCLIオプション | 詳細 |
|------|---------------------|------|
| DM管理レイヤー | — | DM でプロジェクト管理、チャンネルで実行（パターン3化） |
| MCPサーバーモード | `claude mcp serve` | `-p`モードの代替。構造化インターフェース提供 |
| 双方向ストリーミング | `--input-format stream-json --output-format stream-json` | 常時接続型プロセス間通信 |
| カスタムエージェント | `--agent` / `--agents` | タスク特化エージェントの利用 |
| Slack AI Streaming | Slack chat streaming API (2025/10) | ネイティブAIアプリのような応答体験 |
| ファイル添付対応 | `--add-dir` | Slackアップロードファイルを一時ディレクトリ経由で参照 |
| リアクション操作 | — | 特定絵文字でアクション実行 |

### Phase間の依存関係

```
Phase 1 (MVP)
    │
    ├── Phase 2 (実用拡張)
    │       │
    │       ├── Phase 3 (リッチ UI)
    │       │       │
    │       │       └── Phase 4 (高度な機能)
    │       │
    │       └── Phase 4 の一部（ファイル添付等）は Phase 2 完了後に着手可能
    │
    └── Phase 2 の一部（mrkdwn 変換等）は Phase 1 完了後すぐに着手可能
```

---

## 12. 技術的注意事項・既知の制約

### 12.1 P0問題の解消状況

> 出典: round2-synthesis.md

| ID | 問題 | 状態 | 検証結果 |
|----|------|------|---------|
| P0-1 | セッション継続コマンドの形式 | **解消** | `--session-id <uuid>` で新規、`-r <uuid>` で再開。実機確認済み |
| P0-2 | `--permission-mode` 未設定 | **解消** | `--permission-mode auto` で対話的確認なしに動作。実機確認済み |
| P0-3 | `CLAUDECODE` 環境変数（新規発見） | **解消** | spawn時に `CLAUDECODE: undefined` で回避。設計書反映済み |
| P0-4 | `stream-json` に `--verbose` 必須（新規発見） | **解消** | 設計書の将来拡張ポイントに記録済み |

### 12.2 環境変数

> 出典: round1-cli-specialist.md §7、round2-e2e-validator.md §8.2

| 変数 | 説明 | 注意点 |
|------|------|--------|
| `CLAUDECODE` | `1` に設定される（Claude Codeセッション内を示す） | Bridge spawn 時に `undefined` にすること。設定されたままだとネスト禁止チェックが発動 |
| `CLAUDE_CODE_ENTRYPOINT` | エントリポイント情報 | Bridge には影響なし |

**環境変数の制御:**
```typescript
const env = { ...process.env };
delete env.CLAUDECODE; // ネスト禁止チェック回避
```

### 12.3 コスト制御

> 出典: round1-synthesis.md Emergent Insight #3、round2-e2e-validator.md §6

- `--max-budget-usd` はセッション単位のコスト上限
- 環境変数 `MAX_BUDGET_PER_SESSION` から設定（推奨: $2.00）
- 単純応答でも約 $0.035、最低 $0.10 以上を設定すること
- 予算超過エラー形式: `Error: Exceeded USD budget (X.XX)`
- キャッシュ利用状況によりコストは大幅に変動

### 12.4 並行実行の制約

> 出典: round1-bridge-architect.md §5.2、round2-ux-validator.md §8.6

- **同一セッション内:** 直列実行のみ。Claude Code のセッションファイルへの並行書き込みは競合を起こす
- **異なるセッション間:** 並行実行可。`MAX_CONCURRENT_SESSIONS` で上限を制御
- **セマフォの実装:** SessionQueue 内で同時実行セッション数をカウントし、上限に達した場合は待機キューに入れる

### 12.5 セッション管理の注意

> 出典: round1-cli-specialist.md §9、round2-ux-validator.md §8.1-8.2

- セッションIDはUUID v4形式（小文字）でなければならない
- セッションは作業ディレクトリに紐づく（異なるCWDからは `-c` で継続不可）
- `-r` でセッションIDを指定すれば異なるCWDからでもセッション再開可能
- `--session-id` と `-r` は排他的使用。同時指定時の挙動は未定義
- Claude Code CLI に `--cwd` オプションは存在しない。spawn の `cwd` オプションで制御

### 12.6 Slack API の注意

> 出典: round1-bridge-architect.md §5.1、round2-ux-validator.md §8.4

- Socket Mode では `ack()` コールバックで即時応答（3秒制限対策）
- `files_upload_v2` を使用（旧 `files.upload` は 2025年3月に廃止済み）
- `--strict-mcp-config` を使わない場合、ユーザーのグローバル/プロジェクトMCP設定も読み込まれる

### 12.7 設定ファイルの優先順位

> 出典: round1-cli-specialist.md §9

1. コマンドラインオプション（最優先）
2. `--settings` で指定した追加設定
3. `~/.claude/settings.local.json`（ローカル設定）
4. `~/.claude/settings.json`（ユーザー設定）
5. プロジェクトの `.claude/settings.json`

### 12.8 Slack App 作成手順（MVP最小構成）

> 出典: round2-ux-validator.md §8.9

1. https://api.slack.com/apps → Create New App → From scratch
2. App Name: "Claude Code Bridge"
3. **Socket Mode を有効化:** Settings → Socket Mode → Enable → App-Level Token 生成 (`connections:write`) → `SLACK_APP_TOKEN`
4. **Bot Token Scopes:** `app_mentions:read`, `chat:write`, `channels:history`, `channels:read`, `reactions:write`, `files:write`, `files:read`
5. **Event Subscriptions:** `message.channels`, `app_mention`
6. **ワークスペースにインストール** → `SLACK_BOT_TOKEN` (xoxb-...) を取得
7. **Signing Secret** → `SLACK_SIGNING_SECRET`
8. **チャンネルに Bot を招待:** `/invite @Claude Code Bridge`

### 12.9 未解決の Gap（P1/P2）

> 出典: round1-synthesis.md Gaps

| ID | Gap | 優先度 | 対応方針 |
|----|-----|--------|---------|
| G2 | `CLAUDECODE=1` 環境変数の影響 | P1 | spawn時にunsetで対応済み。開発・テスト時に注意 |
| G3 | Slackからのファイル入力 | P1 | Phase 4で対応。Slack Files API → 一時ディレクトリ → `--add-dir` |
| G5 | セッションファイルの容量増大 | P2 | Claude Code自体の管理に委ねる。Bridge側は古いマッピングのクリーンアップのみ |

### 12.10 Emergent Insights（Round 1で発見された将来的な可能性）

> 出典: round1-synthesis.md Emergent Insights

1. **stream-jsonモードによるリアルタイムUI:** `--output-format stream-json` + `--include-partial-messages` + Slack `chat.update` でリアルタイム応答表示。さらにSlack chat streaming API (2025/10) でネイティブAIアプリ体験が実現可能
2. **`--fork-session` のSlack UIマッピング:** スレッドから新スレッドを分岐。会話の途中で別方向を試す場合に有用
3. **`--max-budget-usd` による安全弁:** Slack経由の誤操作リスクに対する防護。環境変数で設定可能にすべき（実装済み）
4. **双方向ストリーミングの可能性:** `--input-format stream-json` で常駐プロセス1つに複数メッセージをストリーミング送信可能。Model 1とModel 2のハイブリッドの可能性

---

*本文書は round1-cli-specialist.md, round1-slack-architect.md, round1-bridge-architect.md, round1-synthesis.md, round2-e2e-validator.md, round2-ux-validator.md, round2-synthesis.md の7文書を統合・分析して作成されました。すべての技術的判断はエビデンスベース（実機検証結果および仕様調査結果）に基づいています。*
