# Claude Code Slack Bridge

SlackのDMからClaude Codeを操作するブリッジ。Node.jsプロセスがSlack BoltとClaude CLI子プロセスをstdin/stdoutで接続し、ターミナルのClaude Code体験をそのままSlack上で再現します。

DMを送るだけでセッションが始まり、ツール実行や思考過程がリアルタイムにスレッドへストリーミングされます。

```
You: このバグを調査して
  💭×2 🔧×3 (1.2s)
  💬 「調査結果です。原因は...」
  💭×1 🔧×5 (3.4s)
  💬 「修正しました」
  📊 Tokens: 12,345 | $0.15 | 45s

You: テストも書いて    ← 同じスレッドで文脈を保持
```

---

## 使い方

### ホームタブで準備する

ボットのホームタブを開くと、モデル（Opus / Sonnet / Haiku）と作業ディレクトリの選択ができます。ディレクトリはClaude Codeのプロジェクト一覧から自動取得されます。直近のセッション履歴もここに表示されるので、過去の作業をすぐに確認できます。

### メッセージタブで対話する

設定が終わったら、ボットにDMを送るだけ。返信はスレッドに届きます。**1スレッド＝1セッション**の設計なので、同じスレッドでやりとりを続ければ文脈が保持されます。新しいDMを送れば、新しいセッションが始まります。

Claudeがツールを使うと `💭×2 🔧×3 (1.2s)` のようにバンドル表示されます。「ツール実行詳細」ボタンから、各ツールの入出力や思考内容をモーダルで確認できます。

### リアクションで状態を知る

処理中はメッセージにリアクションがつき、今何が起きているかが一目でわかります。

⏳ 起動中 → 🧠 処理中 → ✅ 完了

前の3つはシステムが自動でつけるものです。**中断したいときは**、🧠がついている自分のメッセージに 🔴 をつけてください。Claudeに SIGINT が送られ、処理が中断されます。

### コマンド

`cc /コマンド` または `/コマンド` で実行できます。

| コマンド | 説明 |
|----------|------|
| `/status` | セッション情報（モデル、コスト、ターン数）を表示 |
| `/end` | セッションを終了 |
| `/restart` | セッションを再起動 |

上記以外のスラッシュコマンド（`/commit`, `/help` など）はClaude CLIにそのまま転送されます。

---

## セットアップ

### 自動セットアップ（推奨）

Claude Codeでこのプロジェクトを開き、「**セットアップして**」と言ってください。対話形式で全セットアップが完了します。

### 手動セットアップ

#### 前提条件

- **Node.js 20+**
- **Claude Code CLI** — `claude` コマンドがPATHに通っている状態

#### 1. Slack Appの作成

1. https://api.slack.com/apps → **Create New App** → **From an app manifest**
2. Workspaceを選択 → **JSON** タブに切り替え
3. `docs/tips/slack-app-manifest.json` の内容を貼り付け → **Create**

> Slack Appをワークスペースにインストールすると、メンバー全員のサイドバーに表示されます。個人用ワークスペースでの導入を推奨します。

#### 2. トークンの取得

- **App-Level Token** — Settings → Basic Information → App-Level Tokens → Generate（`connections:write` スコープ）
- **Bot Token** — Features → OAuth & Permissions → Install to Workspace → Bot User OAuth Token

#### 3. インストールと起動

```bash
git clone <repo-url> && cd claude-slack-pipe
npm install
cp .env.example .env
# .env を編集してトークンを設定（次のセクション参照）
npm run dev
```

`Claude Code Slack Bridge is running` と表示されれば成功です。

#### 環境変数

| 変数名 | 必須 | 説明 | デフォルト |
|--------|------|------|-----------|
| `SLACK_BOT_TOKEN` | ✅ | Bot User OAuth Token (`xoxb-`) | — |
| `SLACK_APP_TOKEN` | ✅ | App-Level Token (`xapp-`) | — |
| `ALLOWED_USER_IDS` | | 許可ユーザーID（カンマ区切り） | 空（全員許可） |
| `ALLOWED_TEAM_IDS` | | 許可チームID（カンマ区切り） | 空 |
| `ADMIN_USER_IDS` | | 管理者ユーザーID | 空 |
| `CLAUDE_EXECUTABLE` | | Claude CLIのパス | `claude` |
| `CLAUDE_PROJECTS_DIR` | | Claudeプロジェクトのディレクトリ | `~/.claude/projects` |
| `DATA_DIR` | | データ保存ディレクトリ | `~/.claude-slack-pipe/` |
| `MAX_CONCURRENT_PER_USER` | | ユーザーごと同時実行数 | `1` |
| `MAX_CONCURRENT_GLOBAL` | | 全体同時実行数 | `3` |
| `LOG_LEVEL` | | ログレベル | `info` |

---

## アーキテクチャ

全体は3層構造です。

```
Slack ←― WebSocket ―→ Node.js (Bolt) ←― stdin/stdout ―→ claude -p (子プロセス)
```

Node.jsプロセスがSlack Boltでイベントを受信し、Claude CLIの子プロセスにJSON形式でプロンプトを転送します。CLIの出力はJSONLストリームとしてstdoutに流れ、それをリアルタイムに解析してSlackメッセージとして投稿・更新します。

セッションはスレッドごとに1つのCLI子プロセスに対応します。ユーザーがスレッドにメッセージを送るたびに、同じプロセスのstdinに書き込むことで文脈が保持されます。アイドル状態が10分続くと自動終了し、次のメッセージ時に新しいプロセスが起動します。

### モジュール構成

| ディレクトリ | 役割 |
|-------------|------|
| `src/bridge/` | CLIプロセス管理。セッション調整、メッセージキュー |
| `src/streaming/` | ストリーミング処理。JSONL解析、バンドルグループ化、Slack API実行 |
| `src/slack/` | Slack UI。ホームタブ、リアクション、モーダル、コマンド |
| `src/store/` | データ永続化。セッション、ユーザー設定、プロジェクト一覧 |
| `src/middleware/` | 認証、レートリミッター |
| `src/utils/` | ロガー、エラー型、サニタイズ、PIDロック |

---

## トラブルシューティング

| 症状 | 確認事項 |
|------|---------|
| 接続できない | Socket Modeが有効か、`SLACK_APP_TOKEN` (`xapp-`) が正しいか |
| メッセージに反応しない | Event Subscriptionsで `message.im` を購読しているか |
| 権限エラー | `ALLOWED_USER_IDS` に自分のUser IDが含まれているか |
| Claude CLIが見つからない | `claude --version` が実行できるか |
| 起動直後にENOENTエラー | Claude CLIのバージョン不一致の可能性 |

---

## 開発

```bash
npm test           # テスト実行
npm run test:watch # テスト（watchモード）
npm run lint       # 型チェック
npm run build      # ビルド
```

**技術スタック:** TypeScript, Slack Bolt (Socket Mode), Claude Code CLI, Winston, Zod, Vitest
