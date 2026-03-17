# Claude Code Slack Bridge

Claude Code CLIをSlackのDMから操作するブリッジアプリケーションです。

SlackでボットにDMを送ると、バックエンドで `claude` CLIが長期プロセスとして起動し、リアルタイムにストリーミング表示されます。ツール実行や思考過程も可視化され、Claude Codeの体験をそのままSlack上で再現します。

```
┌──────────────────────────────────────────────────────┐
│  Slack DM                                            │
│                                                      │
│  You: このバグを調査して                               │
│                                                      │
│  ├─ 💭×2 🔧×3 (1.2s)  [ツール実行詳細]               │
│  ├─ 💬 「調査結果です。原因は...」                     │
│  ├─ 💭×1 🔧×5 (3.4s)  [ツール実行詳細]               │
│  ├─ 💬 「修正しました。変更内容は...」                 │
│  └─ 📊 Tokens: 12,345 / 8,901 | $0.15 | 45s         │
│                                                      │
│  You: ありがとう。テストも書いて                       │
│  (同じスレッドで会話を継続 → 文脈を保持)               │
└──────────────────────────────────────────────────────┘
```

---

## 使い方

### 1. Home Tabで設定

Slack左サイドバーからボットの「ホーム」タブを開きます。

```
┌─ Home Tab ────────────────────────────┐
│                                       │
│  Model:     [Sonnet ▾]               │
│  Directory: [dev/my-project ▾]       │
│                                       │
│  ── Recent Sessions ──                │
│  「このバグを調査して」  5m ago       │
│   📁 /Users/me/dev/my-project        │
│  ────────────────────                 │
│  「READMEを更新して」   2h ago        │
│   📁 /Users/me/dev/other-project     │
└───────────────────────────────────────┘
```

- **Model** — Claude のモデルを選択（Opus / Sonnet / Haiku）
- **Directory** — 作業ディレクトリを選択（Claude Codeのプロジェクト一覧から取得）

### 2. メッセージタブで対話

ボットにDMを送ると、**スレッド**に返信が来ます。

```
┌─ DM ──────────────────────────────────────────────────┐
│                                                       │
│  You: このプロジェクトのテストカバレッジを上げて         │
│       ⏳ (セッション起動中...)                         │
│       🧠 (Claude が考え中...)                         │
│       ✅ (完了!)                                      │
│                                                       │
│  ┌─ Thread ────────────────────────────────────────┐  │
│  │  💭×1 🔧×2 (0.8s)  [ツール実行詳細]            │  │
│  │  💬 「テストファイルを確認しました...」          │  │
│  │  💭×1 🔧×4 (2.1s)  [ツール実行詳細]            │  │
│  │  💬 「以下のテストを追加しました...」            │  │
│  │  📊 Tokens: 8,234 / 6,102 | $0.08 | 32s        │  │
│  │                                                 │  │
│  │  You: auth.tsのエッジケースも追加して            │  │
│  │  (同じセッションで継続)                          │  │
│  └─────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────┘
```

**1スレッド = 1セッション** の設計です。スレッド内でメッセージを続けると、Claude Codeのセッションがそのまま継続され、文脈を保った対話ができます。新しいDMを送ると新しいセッション（スレッド）が作成されます。

### 3. リアクションの意味

メッセージにつくリアクション絵文字で、セッションの状態がわかります。

```
⏳ → 🧠 → ✅
起動中  処理中  完了

🧠 + 🔴 → ⏹️ 中断
```

| リアクション | 意味 | 誰がつける |
|-------------|------|-----------|
| ⏳ 砂時計 | セッション起動中（CLIプロセスの生成待ち） | システム |
| 🧠 脳みそ | Claude が考え中・ツール実行中 | システム |
| ✅ チェックマーク | 処理完了 | システム |
| 🔴 赤丸 | **中断リクエスト** — 🧠がついているメッセージにこれをつけると、処理を中断します | **ユーザー** |

> **中断のやり方:** 🧠（脳みそ）リアクションがついている自分のメッセージに 🔴 リアクションをつけてください。Claudeに SIGINT が送信され、現在の処理が中断されます。

### 4. ブリッジコマンド

`cc` プレフィックスでBridge固有のコマンドを実行できます。

| コマンド | 説明 |
|----------|------|
| `cc /status` | 現在のセッション情報（モデル、コスト、ターン数など）を表示 |
| `cc /end` | セッションを終了 |
| `cc /restart` | セッションを再起動 |

Claude Codeのスラッシュコマンド（`cc /commit` など）もそのまま転送されます。

### 5. ツール実行の詳細表示

Claudeがツール（ファイル読み書き、Bash実行など）を使うと、バンドルとしてまとめて表示されます。

```
💭×2 🔧×3 (1.2s)  [ツール実行詳細]
```

「ツール実行詳細」ボタンをクリックすると、モーダルが開きます：

```
┌─ ツール実行詳細 ─────────────────────┐
│                                      │
│  💭 思考 (クリックで詳細)            │
│  🔧 Read src/config.ts (0.1s)       │
│  🔧 Grep "loadConfig" (0.3s)        │
│  🔧 Edit src/config.ts (0.2s)       │
│                                      │
│  各項目をクリック → さらに詳細モーダル │
└──────────────────────────────────────┘
```

---

## アーキテクチャ

```
┌─────────────┐     Socket Mode      ┌──────────────────┐
│  Slack API  │◄────────────────────►│  Bolt App        │
│  (DM/Home)  │     WebSocket        │  (event handlers)│
└─────────────┘                      └────────┬─────────┘
                                              │
                              ┌───────────────┼───────────────┐
                              │               │               │
                    ┌─────────▼──┐  ┌─────────▼──┐  ┌────────▼───┐
                    │  Middleware │  │   Slack    │  │   Store    │
                    │  - Auth    │  │  - HomeTab │  │  - Session │
                    │  - Rate    │  │  - Reaction│  │  - UserPref│
                    │    Limit   │  │  - Modal   │  │  - Project │
                    └────────────┘  └────────────┘  └────────────┘
                                              │
                                    ┌─────────▼─────────┐
                                    │ Session Coordinator│
                                    │ - Concurrency mgmt │
                                    │ - Session lifecycle│
                                    └─────────┬─────────┘
                                              │
                                    ┌─────────▼─────────┐
                                    │ PersistentSession  │
                                    │ (1 per thread)     │
                                    │                    │
                                    │ stdin ──► claude   │
                                    │ stdout ◄── CLI     │
                                    └─────────┬─────────┘
                                              │
                                    ┌─────────▼─────────┐
                                    │ StreamProcessor    │
                                    │ - Parse JSONL      │
                                    │ - Group into       │
                                    │   bundles          │
                                    └─────────┬─────────┘
                                              │
                                    ┌─────────▼─────────┐
                                    │ SlackActionExecutor│
                                    │ - Post messages    │
                                    │ - Update bundles   │
                                    │ - Rate limit aware │
                                    └───────────────────┘
```

### データフロー

```
1. ユーザーがSlack DMに投稿
   │
2. Bolt event handler が受信 (Socket Mode)
   │
3. Auth チェック (ALLOWED_USER_IDS) + Rate Limit チェック
   │
4. Session Coordinator がスレッドに対応するセッションを検索/作成
   │  ┌─ 新規スレッド: claude CLI を spawn して PersistentSession を作成
   │  └─ 既存スレッド: 既存の PersistentSession を再利用
   │
5. プロンプトを JSON で Claude CLI の stdin に送信
   │  { "type": "user", "message": { "role": "user", "content": [...] } }
   │
6. Claude CLI が stdout に JSONL でストリーム出力
   │  thinking → tool_use → tool_result → text → result
   │
7. StreamProcessor が JSONL をパースし、バンドルにグループ化
   │  (thinking + tools をまとめて1メッセージに)
   │
8. SlackActionExecutor がリアルタイムでSlackメッセージを投稿/更新
   │  ツール実行中はライブ更新 (500ms間隔)
   │
9. result イベントでフッター（トークン数、コスト、時間）を投稿
```

### モジュール構成

| ディレクトリ | 役割 |
|-------------|------|
| `src/bridge/` | Claude CLIプロセス管理。PersistentSession（長期プロセス）、セッション調整、メッセージキュー |
| `src/streaming/` | ストリーミング出力処理。JSONL解析、バンドルグループ化、Slack API実行、レート制限対策 |
| `src/slack/` | Slack UI。Home Tab、リアクション管理、モーダル、コマンド、権限プロンプト |
| `src/store/` | データ永続化。セッションインデックス、ユーザー設定、プロジェクト一覧 |
| `src/middleware/` | 認証（ユーザーID/チームID）、レートリミッター |
| `src/utils/` | ロガー、エラー型、入出力サニタイズ、PIDロック |

### セッションのライフサイクル

```
not_started → starting → processing ⇄ idle → ending → dead
                              │
                         [🔴 中断] → idle
                              │
                         [クラッシュ] → dead → auto-respawn (最大3回)
```

- **idle** — ユーザー入力待ち。5分ごとにKeep-Alive ping、10分で自動終了
- **processing** — Claude実行中。ユーザーが追加メッセージを送るとキュー（最大5件）に入る
- **auto-respawn** — 処理中にクラッシュした場合、指数バックオフ(1s, 2s, 4s)で自動再起動

---

## セットアップ

### 自動セットアップ（推奨）

Claude Codeでこのプロジェクトを開き、「**セットアップして**」と言ってください。対話形式で全セットアップが完了します。

### 手動セットアップ

#### 前提条件

- **Node.js 20+**
- **Claude Code CLI** (`claude` コマンドがPATHに通っている状態)

#### 1. Slack Appの作成

1. https://api.slack.com/apps → **Create New App** → **From an app manifest**
2. Workspaceを選択 → **JSON** タブに切り替え
3. `docs/tips/slack-app-manifest.json` の内容を貼り付け → **Create**

> **注意:** Slack Appをワークスペースにインストールすると、メンバー全員のサイドバーに表示されます。個人用ワークスペースでの導入を推奨します。

#### 2. トークンの取得

- **App-Level Token**: Settings → Basic Information → App-Level Tokens → Generate (`connections:write` スコープ)
- **Bot Token**: Features → OAuth & Permissions → Install to Workspace → Bot User OAuth Token

#### 3. プロジェクトのセットアップ

```bash
git clone <repo-url> && cd claude-slack-pipe
npm install
cp .env.example .env
# .env を編集してトークンを設定
```

#### 4. 環境変数

`.env` に以下を設定：

| 変数名 | 必須 | 説明 | デフォルト |
|--------|------|------|-----------|
| `SLACK_BOT_TOKEN` | ✅ | Bot User OAuth Token (`xoxb-`) | — |
| `SLACK_APP_TOKEN` | ✅ | App-Level Token (`xapp-`) | — |
| `ALLOWED_USER_IDS` | | 許可ユーザーID（カンマ区切り） | 空（全員許可） |
| `ALLOWED_TEAM_IDS` | | 許可チームID（カンマ区切り） | 空 |
| `ADMIN_USER_IDS` | | 管理者ユーザーID | 空 |
| `CLAUDE_EXECUTABLE` | | Claude CLIのパス | `claude` |
| `MAX_CONCURRENT_PER_USER` | | ユーザーごと同時実行数 | `1` |
| `MAX_CONCURRENT_GLOBAL` | | 全体同時実行数 | `3` |
| `LOG_LEVEL` | | ログレベル | `info` |

#### 5. 起動

```bash
# 開発モード
npm run dev

# 本番
npm run build && npm start
```

`Claude Code Slack Bridge is running` と表示されれば成功です。

---

## トラブルシューティング

| 症状 | 確認事項 |
|------|---------|
| 接続できない | Socket Modeが有効か、`SLACK_APP_TOKEN` (`xapp-`) が正しいか |
| メッセージに反応しない | Event Subscriptionsで `message.im` を購読しているか、Workspace再インストールが必要か |
| 権限エラー | `ALLOWED_USER_IDS` に自分のUser IDが含まれているか |
| Claude CLIが見つからない | `claude --version` が実行できるか、`CLAUDE_EXECUTABLE` にフルパスを指定 |
| 起動直後にENOENTエラー | Claude CLIのバージョン不一致の可能性 |

---

## 開発

```bash
npm test           # テスト実行
npm run test:watch # テスト（watchモード）
npm run lint       # 型チェック
npm run build      # ビルド
```

---

## 技術スタック

- **TypeScript** + tsx
- **Slack Bolt** (Socket Mode)
- **Claude Code CLI** (`claude -p --input-format stream-json --output-format stream-json`)
- **Winston** (ロギング)
- **Zod** (設定バリデーション)
- **Vitest** (テスト)
