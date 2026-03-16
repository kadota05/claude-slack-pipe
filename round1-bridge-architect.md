# ブリッジアーキテクチャ設計レポート

## 1. プロセス管理モデルの比較

### モデル1: 都度起動（Stateless）

メッセージを受信するたびに `claude -p --session-id <id>` を新規プロセスとして起動し、応答完了後にプロセスを終了する。

| 観点 | 評価 |
|------|------|
| 実装複雑度 | **低** — spawn して stdout を収集するだけ |
| レイテンシ | **中〜高** — プロセス起動に 1〜3 秒程度のオーバーヘッド |
| リソース効率 | **高** — 未使用時のメモリ・CPU 消費ゼロ |
| セッション継続 | `--session-id` と `-r` フラグで Claude Code 側が会話履歴を復元するため**可能** |
| 障害耐性 | **高** — プロセスが独立しているため、一つの失敗が他に波及しない |
| 並行処理 | **容易** — 各リクエストが独立プロセスなので自然に並行動作 |

### モデル2: 常駐プロセス（Stateful）

作業ディレクトリごとに Claude Code プロセスを起動し続け、stdin/stdout でストリーム通信する。

| 観点 | 評価 |
|------|------|
| 実装複雑度 | **高** — stdin/stdout のフレーミング、プロセス死活監視、再起動ロジックが必要 |
| レイテンシ | **低** — プロセス起動オーバーヘッドなし |
| リソース効率 | **低** — 非アクティブなセッションでもメモリを占有（1プロセスあたり 100〜300MB 程度） |
| セッション継続 | **自然** — プロセス内に状態が保持される |
| 障害耐性 | **低** — プロセスクラッシュ時にセッション状態が失われる可能性 |
| 並行処理 | **困難** — 同一プロセスへの同時書き込みにロック機構が必要 |

**追加リスク:** Claude Code の CLI は対話型シェルとしての利用を想定した設計であり、stdin へのプログラマティックな入力に対する挙動が不安定になる可能性がある。プロンプト待ち状態の検出、出力の終端判定など、パーサーとしての実装難度が高い。

### モデル3: ハイブリッド

アクティブセッションは常駐し、一定時間非アクティブなセッションは終了。再度リクエストが来た場合は都度起動で復帰する。

| 観点 | 評価 |
|------|------|
| 実装複雑度 | **非常に高** — モデル1＋モデル2の両方のロジックに加え、遷移制御が必要 |
| レイテンシ | **低〜中** — アクティブ時は低、復帰時はモデル1相当 |
| リソース効率 | **中** — タイムアウトで適度に解放される |
| セッション継続 | **可能** — ただし常駐→都度起動の遷移が正しく動く保証が必要 |
| 障害耐性 | **中** — 状態遷移のバグがリスク |
| 並行処理 | **モデル2と同じ課題** |

### 総合評価

```
                実装複雑度    レイテンシ    リソース効率    障害耐性    並行処理
モデル1(都度起動)    ★★★★★       ★★★          ★★★★★        ★★★★★      ★★★★★
モデル2(常駐)       ★★           ★★★★★        ★★           ★★         ★★
モデル3(ハイブリッド) ★            ★★★★         ★★★          ★★★        ★★
```

---

## 2. 推奨アーキテクチャ概要

### 推奨: モデル1（都度起動）

**根拠:**

1. **`claude -p --session-id` が十分にセッション継続を担保する** — Claude Code は `~/.claude/projects/` 配下にセッション履歴をファイルとして永続化している。`--session-id` を指定すればプロセスを終了しても会話の継続が可能であり、常駐プロセスの最大のメリットが消失する。

2. **単一ユーザー向け** — 同時並行のリクエスト数が限定的であるため、プロセス起動のオーバーヘッド（1〜3秒）は許容範囲内。

3. **実装の堅牢性** — プロセスが独立しているため、一つの処理の失敗が他に影響しない。デバッグも容易。

4. **MVP として最適** — 最小限の実装で動作検証が可能。必要に応じてモデル3への段階的移行も可能。

### 全体アーキテクチャ

```
┌─────────────┐     HTTPS/WSS      ┌──────────────────────┐
│  Slack API   │◄──────────────────►│   Slack Bot Server   │
│  (Events API)│                    │   (常駐プロセス)       │
└─────────────┘                    └──────────┬───────────┘
                                              │
                                              ▼
                                   ┌──────────────────────┐
                                   │   Bridge Core        │
                                   │                      │
                                   │  ┌────────────────┐  │
                                   │  │ Request Queue   │  │
                                   │  │ (per session)   │  │
                                   │  └───────┬────────┘  │
                                   │          │           │
                                   │  ┌───────▼────────┐  │
                                   │  │ Session Manager │  │
                                   │  │                │  │
                                   │  │ - mapping管理   │  │
                                   │  │ - セッション解決  │  │
                                   │  └───────┬────────┘  │
                                   │          │           │
                                   │  ┌───────▼────────┐  │
                                   │  │Process Executor │  │
                                   │  │                │  │
                                   │  │ claude -p      │  │
                                   │  │ --session-id   │  │
                                   │  │ -r (継続時)     │  │
                                   │  └────────────────┘  │
                                   └──────────┬───────────┘
                                              │
                                   ┌──────────▼───────────┐
                                   │   State Store        │
                                   │   (SQLite)           │
                                   └──────────────────────┘
```

### リクエストフロー

```
1. Slack メッセージ受信
2. 即座に Slack へ ack（200 OK）返却
3. Bridge Core がメッセージを処理:
   a. Slack スレッド → セッション ID を解決
   b. なければ新規セッション作成
   c. 同一セッション向けキューに投入
4. キューから取り出し、claude -p を実行
5. stdout を収集
6. Slack へ返信を投稿
```

---

## 3. セッションライフサイクル管理

### 3.1 セッション作成（新規）

**トリガー条件:**
- マッピングされていない Slack スレッドからのメッセージ
- ユーザーによる明示的な新規セッション作成コマンド（例: `/claude new /path/to/project`）

**処理フロー:**
```
1. UUIDv4 でセッション ID を生成
2. 作業ディレクトリを決定（デフォルト or ユーザー指定）
3. SQLite にマッピングを保存:
   - slack_thread_ts → session_id
   - session_id → working_directory
4. claude -p --session-id <id> -w <dir> でプロンプトを実行
```

### 3.2 セッション継続

**トリガー条件:**
- 既にマッピングが存在する Slack スレッドからのメッセージ

**処理フロー:**
```
1. slack_thread_ts からセッション ID を検索
2. claude -p --session-id <id> -r -w <dir> で継続実行
   （-r フラグにより前回のセッション履歴を復元）
3. マッピングの last_active_at を更新
```

### 3.3 セッション一覧取得

`~/.claude/projects/` 配下のディレクトリ構造を走査し、既存セッションの一覧を取得する。

```
~/.claude/projects/
└── <path-encoded-project-dir>/
    └── sessions/
        └── <session-id>.json
```

Slack コマンド `/claude sessions` で一覧を表示。SQLite に保存されたマッピング情報と突合し、Slack スレッドとの紐付け状態も表示する。

### 3.4 セッション削除・クリーンアップ

- `last_active_at` が一定期間（例: 30日）を超えたマッピングを自動削除
- Claude Code 側のセッションファイルは触らない（Claude Code 自身の管理に委ねる）

---

## 4. 状態管理データモデル

### 4.1 ストレージ選定: SQLite

| 選択肢 | 評価 |
|--------|------|
| **SQLite** | **推奨** — ファイルベースで運用不要、ACID準拠、単一ユーザーの同時アクセスに十分なパフォーマンス |
| JSON ファイル | 同時書き込みの競合リスク、スキーマバリデーションなし |
| In-memory | プロセス再起動で消失、永続化のために結局ファイル I/O が必要 |

### 4.2 テーブル設計

```sql
-- 作業ディレクトリとSlackチャンネルのマッピング
-- 一つのチャンネルに一つのデフォルト作業ディレクトリを紐付ける
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

-- 実行中プロセスの追跡（プロセスが異常終了した場合の検出用）
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

### 4.3 エンティティ関連図

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

---

## 5. 非同期処理とキューイング

### 5.1 Slack 3秒応答制限への対処

Slack Events API はイベント受信後 3 秒以内に HTTP 200 を返さないとリトライが発生する。Claude Code の実行には数秒〜数分かかるため、以下の 2 段階レスポンスパターンを採用する。

```
[Phase 1: 即時応答]
  Slack Event → HTTP 200（即座に ack）
              → 「処理中...」リアクション（:hourglass: emoji）をスレッドに追加

[Phase 2: 非同期処理]
  キューからタスクを取り出し
  → claude -p を実行
  → 完了後、Slackスレッドに返信を投稿
  → :hourglass: リアクションを除去、:white_check_mark: を追加
```

### 5.2 セッション単位のキューイング

同一セッションへの複数メッセージが同時に来た場合、Claude Code の実行を直列化する必要がある（同一セッション ID に対する並行実行はセッションファイルの競合を引き起こす可能性がある）。

```typescript
// 概念モデル: セッションごとの直列キュー
class SessionQueue {
    private queues: Map<string, Array<Task>>;
    private processing: Set<string>;

    async enqueue(sessionId: string, task: Task): Promise<void> {
        this.queues.get(sessionId).push(task);
        if (!this.processing.has(sessionId)) {
            this.processNext(sessionId);
        }
    }

    private async processNext(sessionId: string): Promise<void> {
        this.processing.add(sessionId);
        while (this.queues.get(sessionId).length > 0) {
            const task = this.queues.get(sessionId).shift();
            await this.execute(task);
        }
        this.processing.delete(sessionId);
    }
}
```

**異なるセッション間は並行実行を許可する。** 単一ユーザー前提であるため、同時に 2〜3 セッションが並行動作しても問題ない。

### 5.3 タイムアウト処理

```
- デフォルトタイムアウト: 5 分
- タイムアウト発生時:
  1. claude -p プロセスに SIGTERM を送信
  2. 5秒後に応答がなければ SIGKILL
  3. Slack に「タイムアウトしました」と通知
  4. active_process テーブルの status を 'timeout' に更新
```

### 5.4 長い応答の分割

Slack メッセージの上限は約 40,000 文字（4,000 文字を超えると見づらくなる）。長い応答は以下のルールで分割する。

- 4,000 文字以下: そのまま投稿
- 4,000 文字超: コードブロック境界またはパラグラフ境界で分割し、複数メッセージとして投稿
- 40,000 文字超: ファイルとしてアップロード（Slack Files API）

---

## 6. エラーハンドリング戦略

### 6.1 エラー分類と対処

| エラー種別 | 検出方法 | 対処 | ユーザー通知 |
|-----------|---------|------|-------------|
| **プロセスクラッシュ** | exit code ≠ 0 | active_process を 'failed' に更新、ログ記録 | Slack にエラーメッセージ投稿、リトライ提案 |
| **タイムアウト** | 設定時間超過 | SIGTERM → SIGKILL | 「処理がタイムアウトしました」と通知 |
| **セッション不整合** | セッション ID が Claude Code 側に存在しない | 新規セッションとして再作成、旧マッピング削除 | 「セッションをリセットしました」と通知 |
| **ディスク容量不足** | ENOSPC エラー | 処理を中断 | 「ディスク容量が不足しています」と通知 |
| **権限エラー** | EACCES エラー | 処理を中断 | 「作業ディレクトリへのアクセス権限がありません」と通知 |
| **Slack API エラー** | HTTP 4xx/5xx | 指数バックオフでリトライ（最大3回） | リトライ失敗時はログのみ |
| **ネットワーク切断** | WebSocket 切断 | 自動再接続（Bolt 標準機能） | 再接続時に未処理メッセージを確認 |

### 6.2 リカバリー戦略

```
起動時チェック:
1. active_process テーブルから status = 'running' のレコードを検索
2. 該当 PID が実際に動作しているか確認（kill -0）
3. 動作していなければ status を 'failed' に更新
4. 対応する Slack スレッドに「前回の処理が異常終了しました」と通知
```

### 6.3 ログ戦略

```
ログレベル:
- ERROR: プロセスクラッシュ、API エラー
- WARN:  タイムアウト、リトライ
- INFO:  セッション作成・終了、コマンド実行
- DEBUG: プロセスの stdin/stdout 内容（開発時のみ）

出力先:
- ファイル: ./logs/bridge-YYYY-MM-DD.log（ローテーション: 7日保持）
- コンソール: 開発時のみ
```

---

## 7. 技術スタック提案

### 7.1 言語選定: TypeScript (Node.js)

| 言語 | Slack SDK | プロセス管理 | 非同期処理 | 総合評価 |
|------|----------|-------------|-----------|---------|
| **TypeScript/Node.js** | **Bolt for JS（公式・最も成熟）** | child_process（十分） | async/await がネイティブ | **推奨** |
| Python | Bolt for Python（公式） | subprocess（十分） | asyncio（やや煩雑） | 次点 |
| Go | slack-go（非公式） | os/exec（十分） | goroutine（優秀） | Slack SDK の成熟度が劣る |

**TypeScript を推奨する理由:**

1. **Slack Bolt for JS が最も成熟** — ドキュメント・サンプルが豊富で、Socket Mode のサポートも安定している
2. **Claude Code CLI 自体が TypeScript** — 内部構造の理解やデバッグ時に言語の統一がメリットになる
3. **async/await とイベント駆動** — Node.js のイベントループモデルは、Slack イベント受信 → 非同期プロセス実行 → 結果返信というフローに適合する
4. **型安全性** — TypeScript による型チェックで実行時エラーを予防

### 7.2 依存ライブラリ

```json
{
  "dependencies": {
    "@slack/bolt": "^4.1.0",        // Slack Bot フレームワーク（Socket Mode 対応）
    "better-sqlite3": "^11.0.0",    // SQLite ドライバ（同期 API で扱いやすい）
    "uuid": "^10.0.0",              // セッション ID 生成
    "winston": "^3.14.0",           // ロギング
    "zod": "^3.23.0"                // 入力バリデーション
  },
  "devDependencies": {
    "typescript": "^5.6.0",
    "@types/better-sqlite3": "^7.6.0",
    "@types/node": "^22.0.0",
    "tsx": "^4.19.0",               // 開発時の実行
    "vitest": "^2.1.0"              // テスト
  }
}
```

**Socket Mode を採用する理由:**

- ローカル PC での実行が前提 → パブリック URL の公開が不要
- WebSocket ベースでファイアウォール内からでも動作
- ngrok 等のトンネリングツールが不要

### 7.3 ディレクトリ構造

```
claude-slack-bridge/
├── src/
│   ├── index.ts                  # エントリポイント（Bolt アプリ初期化）
│   ├── config.ts                 # 環境変数・設定読み込み
│   │
│   ├── slack/
│   │   ├── handlers.ts           # Slack イベントハンドラ（message, command）
│   │   ├── formatter.ts          # Claude 出力 → Slack mrkdwn 変換
│   │   └── commands.ts           # スラッシュコマンド定義
│   │
│   ├── bridge/
│   │   ├── executor.ts           # claude -p プロセスの起動・管理
│   │   ├── session-manager.ts    # セッション解決・作成・一覧
│   │   └── queue.ts              # セッション単位の直列キュー
│   │
│   ├── store/
│   │   ├── database.ts           # SQLite 接続・マイグレーション
│   │   ├── thread-session.ts     # thread_session テーブル操作
│   │   ├── channel-workdir.ts    # channel_workdir テーブル操作
│   │   └── active-process.ts     # active_process テーブル操作
│   │
│   └── utils/
│       ├── logger.ts             # Winston ロガー設定
│       └── errors.ts             # カスタムエラー定義
│
├── data/
│   └── bridge.db                 # SQLite データベースファイル
│
├── logs/                         # ログファイル出力先
│
├── tests/
│   ├── executor.test.ts
│   ├── session-manager.test.ts
│   └── queue.test.ts
│
├── .env.example                  # 環境変数テンプレート
├── package.json
├── tsconfig.json
└── vitest.config.ts
```

---

## 8. コンポーネント図

### 8.1 コンポーネント間の依存関係

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

### 8.2 メッセージシーケンス（正常系）

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

---

## 9. MVP実装スコープ

### Phase 1: 最小動作可能版（MVP）— 推定 2〜3 日

**目標:** Slack でメッセージを送ったら Claude Code が応答を返す。

**スコープ:**
- [x] Slack Bolt (Socket Mode) のセットアップ
- [x] 単一の作業ディレクトリ（環境変数で固定）
- [x] メッセージ受信 → `claude -p` 実行 → 返信投稿
- [x] スレッド単位でのセッション継続（`--session-id` + `-r`）
- [x] SQLite によるスレッド-セッションマッピング
- [x] 基本的なエラーハンドリング（プロセス異常終了、タイムアウト）
- [x] 処理中インジケーター（`:hourglass:` リアクション）

**スコープ外:**
- 複数作業ディレクトリの切り替え
- スラッシュコマンド
- セッション一覧
- 長いメッセージの分割

### Phase 2: 実用拡張 — 推定 2〜3 日

- [ ] `/claude new <dir>` — 作業ディレクトリを指定して新規セッション
- [ ] `/claude sessions` — セッション一覧
- [ ] チャンネルごとのデフォルト作業ディレクトリ設定
- [ ] 長い応答の分割投稿
- [ ] セッション単位のキューイング（同一セッションへの複数メッセージ直列化）
- [ ] Claude 出力の Markdown → Slack mrkdwn 変換

### Phase 3: 安定化・運用改善 — 推定 2〜3 日

- [ ] 起動時のリカバリーチェック（異常終了プロセスの検出）
- [ ] ログローテーション
- [ ] セッション自動クリーンアップ（古いマッピングの削除）
- [ ] ヘルスチェックエンドポイント
- [ ] 設定のホットリロード

### MVP の Executor コア実装イメージ

```typescript
import { spawn } from 'child_process';

interface ExecuteOptions {
    prompt: string;
    sessionId: string;
    workingDirectory: string;
    isResume: boolean;
    timeoutMs?: number;
}

interface ExecuteResult {
    stdout: string;
    stderr: string;
    exitCode: number;
    timedOut: boolean;
}

export async function execute(options: ExecuteOptions): Promise<ExecuteResult> {
    const {
        prompt,
        sessionId,
        workingDirectory,
        isResume,
        timeoutMs = 5 * 60 * 1000,
    } = options;

    const args = [
        '-p', prompt,
        '--session-id', sessionId,
    ];

    if (isResume) {
        args.push('-r');
    }

    return new Promise((resolve) => {
        const proc = spawn('claude', args, {
            cwd: workingDirectory,
            env: { ...process.env },
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
            }, 5000);
        }, timeoutMs);

        proc.stdout.on('data', (data) => { stdout += data.toString(); });
        proc.stderr.on('data', (data) => { stderr += data.toString(); });

        proc.on('close', (code) => {
            clearTimeout(timer);
            resolve({
                stdout,
                stderr,
                exitCode: code ?? 1,
                timedOut,
            });
        });
    });
}
```

### 必要な環境変数（.env）

```bash
# Slack
SLACK_BOT_TOKEN=xoxb-...          # Bot User OAuth Token
SLACK_APP_TOKEN=xapp-...          # Socket Mode 用 App-Level Token
SLACK_SIGNING_SECRET=...          # リクエスト署名検証用

# Bridge
DEFAULT_WORKING_DIRECTORY=/path/to/project  # MVP ではこの一つだけ
COMMAND_TIMEOUT_MS=300000                    # 5分
MAX_CONCURRENT_SESSIONS=3                   # 同時実行セッション数上限

# Database
DATABASE_PATH=./data/bridge.db

# Logging
LOG_LEVEL=info
LOG_DIR=./logs
```
