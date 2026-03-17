# Auto-Setup Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable team members to clone the repo and complete full setup by saying "セットアップして" in Claude Code.

**Architecture:** Three static files — a Claude Code skill (`skills/setup.md`), a Slack app manifest (`tips/slack-app-manifest.json`), and a CLAUDE.md addition. No runtime code changes. The skill orchestrates an interactive setup flow using TaskCreate/TaskUpdate for progress tracking.

**Tech Stack:** Claude Code skills (Markdown), Slack App Manifest (JSON)

**Spec:** `docs/superpowers/specs/2026-03-17-auto-setup-design.md`

---

### Task 1: Create Slack App Manifest

**Files:**
- Create: `tips/slack-app-manifest.json`

- [ ] **Step 1: Create the `tips/` directory**

Run: `mkdir -p tips && echo "✅ created"`

- [ ] **Step 2: Write the manifest file**

Create `tips/slack-app-manifest.json` with the following content. This manifest reflects the current Slack App configuration as documented in `README.md` (scopes, events, interactivity, socket mode):

```json
{
  "display_information": {
    "name": "Claude Code Bridge",
    "description": "Claude Code CLIをSlackのDMから操作するブリッジアプリケーション",
    "background_color": "#4a154b"
  },
  "features": {
    "app_home": {
      "home_tab_enabled": true,
      "messages_tab_enabled": true,
      "messages_tab_read_only_enabled": false
    },
    "bot_user": {
      "display_name": "Claude Code Bridge",
      "always_online": true
    }
  },
  "oauth_config": {
    "scopes": {
      "bot": [
        "app_mentions:read",
        "chat:write",
        "files:read",
        "files:write",
        "im:history",
        "im:read",
        "im:write",
        "reactions:read",
        "reactions:write"
      ]
    }
  },
  "settings": {
    "event_subscriptions": {
      "bot_events": [
        "app_home_opened",
        "message.im",
        "reaction_added"
      ]
    },
    "interactivity": {
      "is_enabled": true
    },
    "org_deploy_enabled": false,
    "socket_mode_enabled": true,
    "token_rotation_enabled": false
  }
}
```

- [ ] **Step 3: Verify JSON is valid**

Run: `cat tips/slack-app-manifest.json | node -e "process.stdin.resume(); let d=''; process.stdin.on('data',c=>d+=c); process.stdin.on('end',()=>{JSON.parse(d);console.log('✅ valid JSON')})" `

- [ ] **Step 4: Commit**

```bash
git add tips/slack-app-manifest.json
git commit -m "feat: add Slack app manifest for one-click app creation"
```

---

### Task 2: Create Setup Skill

**Files:**
- Create: `skills/setup.md`

- [ ] **Step 1: Create the `skills/` directory**

Run: `mkdir -p skills && echo "✅ created"`

- [ ] **Step 2: Write the setup skill**

Create `skills/setup.md` with the following content:

````markdown
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

### 成功条件
両方のバージョンが要件を満たしていること。

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

`tips/slack-app-manifest.json` の内容をReadツールで読み取り、ユーザーに表示する。

1. 上部の「**JSON**」タブをクリックしてください
2. 既存の内容を全て削除し、以下のJSONを貼り付けてください：

（ここにtips/slack-app-manifest.jsonの内容を表示する）

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

以下のコマンドを `run_in_background: true` で実行する：

```bash
npx tsx src/index.ts
```

起動後の確認：
- ログに「Claude Code Slack Bridge is running」が出ることを確認する
- エラーログが出ていないことを確認する（特にSocket Mode接続エラー）

### 起動失敗時の切り分け

- `Invalid token` 系エラー → 「トークンが正しくない可能性があります。以下を確認してください：」と案内し、タスク5のトークン取得をやり直す
- `ENOENT` エラー → 「Claude CLIのバージョン不一致の可能性があります」と案内。CLAUDE.mdの `/fix-claude-cli-version` を参照するよう案内する
- その他のエラー → エラー内容を表示して対処を案内する

### 完了案内

すべて正常に起動したら：

> セットアップ完了！Slackから話しかけてみてください。
````

- [ ] **Step 3: Verify the skill file exists and is well-formed**

Run: `wc -l skills/setup.md && head -5 skills/setup.md && echo "✅ skill file created"`

- [ ] **Step 4: Commit**

```bash
git add skills/setup.md
git commit -m "feat: add /setup skill for interactive project setup"
```

---

### Task 3: Add Setup Trigger to CLAUDE.md

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Append setup section to CLAUDE.md**

Add the following section at the end of `CLAUDE.md`:

```markdown

## セットアップ

ユーザーが「セットアップして」「setup」「セットアップ」等のセットアップ要求をした場合、`/setup` スキルを呼び出すこと。
```

- [ ] **Step 2: Verify the addition**

Run: `tail -5 CLAUDE.md`

Expected: The last lines should contain the new セットアップ section.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "feat: add setup skill trigger to CLAUDE.md"
```

---

### Task 4: End-to-End Verification

- [ ] **Step 1: Verify all three files exist**

Run:
```bash
ls -la skills/setup.md tips/slack-app-manifest.json CLAUDE.md && echo "✅ all files present"
```

- [ ] **Step 2: Verify manifest JSON is valid**

Run:
```bash
node -e "const m = require('./tips/slack-app-manifest.json'); console.log('App name:', m.display_information.name); console.log('Scopes:', m.oauth_config.scopes.bot.join(', ')); console.log('Events:', m.settings.event_subscriptions.bot_events.join(', ')); console.log('Socket mode:', m.settings.socket_mode_enabled); console.log('Interactivity:', m.settings.interactivity.is_enabled); console.log('✅ manifest verified')"
```

Expected output:
```
App name: Claude Code Bridge
Scopes: app_mentions:read, chat:write, files:read, files:write, im:history, im:read, im:write, reactions:read, reactions:write
Events: app_home_opened, message.im, reaction_added
Socket mode: true
Interactivity: true
✅ manifest verified
```

- [ ] **Step 3: Verify CLAUDE.md contains the trigger**

Run:
```bash
grep -q "セットアップ" CLAUDE.md && grep -q "/setup" CLAUDE.md && echo "✅ CLAUDE.md trigger verified"
```

- [ ] **Step 4: Verify skill contains all 6 task sections**

Run:
```bash
grep -c "^## タスク" skills/setup.md
```

Expected: `6`

- [ ] **Step 5: Cross-check manifest scopes/events against source code**

Verify all events used in `src/index.ts` are in the manifest:
```bash
node -e "
const m = require('./tips/slack-app-manifest.json');
const events = m.settings.event_subscriptions.bot_events;
const scopes = m.oauth_config.scopes.bot;
const required_events = ['message.im', 'app_home_opened', 'reaction_added'];
const required_scopes = ['chat:write', 'reactions:write', 'reactions:read', 'files:write', 'files:read', 'im:write', 'im:history', 'im:read', 'app_mentions:read'];
const missing_events = required_events.filter(e => !events.includes(e));
const missing_scopes = required_scopes.filter(s => !scopes.includes(s));
if (missing_events.length) console.error('❌ Missing events:', missing_events);
if (missing_scopes.length) console.error('❌ Missing scopes:', missing_scopes);
if (!missing_events.length && !missing_scopes.length) console.log('✅ All required scopes and events present');
"
```

Expected: `✅ All required scopes and events present`

- [ ] **Step 6: Verify .env is in .gitignore**

Run:
```bash
grep -q "^\.env$" .gitignore && echo "✅ .env is in .gitignore" || echo "❌ .env NOT in .gitignore — add it!"
```

Expected: `✅ .env is in .gitignore`
