---
name: setup
description: プロジェクトの初回セットアップを対話的にガイドする。前提条件チェック、Slack App作成、トークン設定、Bridge起動まで。
---

# Setup Skill

このスキルはClaude Code Slack Bridgeの初回セットアップを対話的にガイドします。

## 起動時にやること

TaskCreateで以下の6つのタスクを作成する。各タスクに入るときにTaskUpdate(status: in_progress)、完了時にTaskUpdate(status: completed)を必ず行う。

1. 前提条件チェック (Node.js 20+, Claude CLI)
2. npm install
3. Slack Workspace作成ガイド
4. Slack App作成（マニフェスト使用）
5. トークン取得・.env生成
6. Bridge起動・動作確認

タスクは必ず順番に実行し、前のタスクが完了するまで次に進まないこと。

---

## タスク1: 前提条件チェック

以下のコマンドを実行して確認する：

### Node.js
```bash
node --version
```
- v20以上であればOK
- 未インストールまたはバージョンが古い場合：
  - 「Node.js 20以上が必要です。以下からインストールしてください: https://nodejs.org」と案内
  - ユーザーがインストール後に「続けてください」と言うのを待つ

### Claude CLI
```bash
claude --version
```
- インストールされていればOK
- 未インストールの場合：
  - 「Claude CLIがインストールされていません。インストールしてよいですか？」と**必ず許可を求める**
  - 許可されたら実行: `npm install -g @anthropic-ai/claude-code`
  - **許可なしに自動実行しないこと。環境構築に関わるインストールは必ずユーザーの許可を得る。**

### cloudflared (Cloudflare Tunnel CLI)
```bash
cloudflared --version
```
- インストールされていればOK
- 未インストールの場合：
  - 「cloudflaredがインストールされていません。localhostトンネル機能に必要です。インストールしてよいですか？」と**必ず許可を求める**
  - 許可されたら実行: `brew install cloudflared`
  - アカウント登録不要
  - **許可なしに自動実行しないこと。**

### 成功条件
すべてのバージョンが要件を満たしていること。

---

## タスク2: npm install

以下を実行する：
```bash
npm install
```

- `node_modules/` が生成されたことを確認する
- エラーが出た場合はエラー内容を表示して対処を案内する

---

## タスク3: Slack Workspace作成ガイド

まず以下の理由を説明する：

> Slack Appをワークスペースにインストールすると、そのワークスペースのメンバー全員のサイドバーにあなたのAppが表示されます。このBridgeは個人利用を想定しているため、個人用のワークスペース、もしくは必要最低限のメンバーだけが参加するワークスペースでの導入を推奨しています。
>
> 今回は個人利用のセットアップなので、あなた専用のワークスペースを作成しましょう。

次に手順を案内する：

1. https://slack.com/create にアクセスしてください
2. Workspace名は自由に決めてください（例: `My Claude Code`）
3. 既に専用のWorkspaceをお持ちの場合はそれを使っていただいてもOKです

「Workspaceが作成できたら（または既存のWorkspaceを使う場合はその旨を）教えてください」と待つ。

---

## タスク4: Slack App作成（マニフェスト使用）

3ステップで案内する。各ステップの後にユーザーの確認を待つ。

### ステップ1: APIコンソールでApp作成を開始

以下の手順で進めてください：

1. https://api.slack.com/apps を開く
2. 右上の「**Create New App**」ボタンをクリック
3. 「**From an app manifest**」を選択
4. 先ほど作成（または選択）したWorkspaceを選ぶ
5. 「**Next**」をクリック

ここまでできたら教えてください。

### ステップ2: マニフェストを貼り付け

`slack-app-manifest.json` の内容をReadツールで読み取り、ユーザーに表示する。

1. 上部の「**JSON**」タブをクリックしてください
2. 既存の内容を全て削除し、以下のJSONを貼り付けてください：

（ここにslack-app-manifest.jsonの内容を表示する）

3. 「**Next**」をクリック
4. 内容を確認して「**Create**」をクリック

### ステップ3: 作成完了の確認

Appが作成できたら教えてください。

---

## タスク5: トークン取得・.env生成

### 既存.envの確認

まずプロジェクトルートに `.env` ファイルが既に存在するか確認する。
存在する場合は「既存の.envがあります。上書きしますか？既存の設定を使いますか？」と確認する。
「既存の設定を使う」が選ばれた場合はこのタスクをスキップしてタスク6に進む。

### 1. App-Level Token（SLACK_APP_TOKEN）

以下の手順でApp-Level Tokenを取得してください：

1. Slack Appの設定画面で「**Settings → Basic Information**」を開く
2. 「**App-Level Tokens**」セクションまでスクロール
3. 「**Generate Token and Scopes**」をクリック
4. Token Name に `socket-token`（任意の名前）と入力
5. 「**Add Scope**」をクリックして `connections:write` を追加
6. 「**Generate**」をクリック
7. 生成されたトークンをコピーしてここに貼り付けてください

ユーザーがトークンを貼ったら：
- `xapp-` で始まるか検証する
- 始まらない場合：「App-Level Tokenは `xapp-` で始まる文字列です。正しい値を貼り直してください」と案内する

### 2. Bot Token（SLACK_BOT_TOKEN）

以下の手順でBot Tokenを取得してください：

1. 左メニューの「**Features → OAuth & Permissions**」を開く
2. 「**Install to Workspace**」ボタンをクリック
3. 権限確認画面で「**Allow**」をクリック
4. 表示された **Bot User OAuth Token** をコピーしてここに貼り付けてください

ユーザーがトークンを貼ったら：
- `xoxb-` で始まるか検証する
- 始まらない場合：「Bot Tokenは `xoxb-` で始まる文字列です。正しい値を貼り直してください」と案内する

### 3. ALLOWED_USER_IDS

以下のように案内する：

> **推奨:** Slack User IDを設定することで、あなただけがこのBotを使えるようにできます。
>
> 確認方法：
> 1. Slackでプロフィールアイコンをクリック
> 2. 「プロフィール」を開く
> 3. 名前の横の「...」（その他）メニューをクリック
> 4. 「メンバーIDをコピー」を選択
> 5. `U` で始まる文字列を貼り付けてください
>
> **代替:** 専用Workspaceで自分しかいない場合は、空のまま（制限なし）でもOKです。どちらにしますか？

### 4. .env生成

収集した値でWriteツールを使って `.env` ファイルを生成する。内容は以下のテンプレートに従う：

```env
# Slack credentials
SLACK_BOT_TOKEN=<収集したBot Token>
SLACK_APP_TOKEN=<収集したApp-Level Token>

# Access control
ALLOWED_USER_IDS=<収集したUser ID or 空>
ALLOWED_TEAM_IDS=
ADMIN_USER_IDS=

# Claude CLI
CLAUDE_EXECUTABLE=claude
CLAUDE_PROJECTS_DIR=~/.claude/projects

# Concurrency limits
MAX_CONCURRENT_PER_USER=1
MAX_CONCURRENT_GLOBAL=3

# Timeout settings (ms)
DEFAULT_TIMEOUT_MS=300000
MAX_TIMEOUT_MS=1800000

# Logging
LOG_LEVEL=info
```

生成後「.envファイルを作成しました」と案内する。

---

## タスク6: Bridge起動・動作確認

### 推奨: launchdで起動

以下のコマンドを順番に実行する：

1. テンプレートからplistを生成：
```bash
NODE_PATH=$(realpath $(which node)) && NODE_BIN_DIR=$(dirname "$NODE_PATH") && PROJECT_DIR=$(pwd) && DATA_DIR="$HOME/.claude-slack-pipe" && mkdir -p ~/Library/LaunchAgents && sed -e "s|{{NODE_PATH}}|$NODE_PATH|g" -e "s|{{NODE_BIN_DIR}}|$NODE_BIN_DIR|g" -e "s|{{PROJECT_DIR}}|$PROJECT_DIR|g" -e "s|{{DATA_DIR}}|$DATA_DIR|g" launchd/com.user.claude-slack-pipe.plist.template > ~/Library/LaunchAgents/com.user.claude-slack-pipe.plist && echo "✅ plist generated"
```

2. launchdに登録して起動：
```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.user.claude-slack-pipe.plist && echo "✅ registered"
```

3. 起動確認（数秒待ってからログを確認）：
```bash
sleep 3 && tail -20 ~/.claude-slack-pipe/bridge.stdout.log
```
- ログに「Claude Code Slack Bridge is running」が出ることを確認する

### 代替: 手動起動

launchdを使わない場合は、以下のコマンドを `run_in_background: true` で実行する：

```bash
caffeinate -i npx tsx src/index.ts
```

### 起動失敗時の切り分け

- `Invalid token` 系エラー → 「トークンが正しくない可能性があります。以下を確認してください：」と案内し、タスク5のトークン取得をやり直す
- `ENOENT` エラー → 「Claude CLIのバージョン不一致の可能性があります」と案内。CLAUDE.mdの `.claude/skills/fix-claude-cli-version.md` を参照するよう案内する
- その他のエラー → エラー内容を表示して対処を案内する

### 完了案内

すべて正常に起動したら：

> セットアップ完了！Slackから話しかけてみてください。
>
> Bridgeの再起動はSlackで `cc /restart-bridge` と送信するだけです。
