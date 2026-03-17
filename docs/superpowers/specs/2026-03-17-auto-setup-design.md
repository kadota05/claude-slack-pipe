# 自動セットアップ設計: clone → 「セットアップして」で完了

## 概要

チームメンバーがリポジトリをクローンし、Claude Codeでプロジェクトを開いて「セットアップして」と言うだけで、Bridgeの起動まで完了する仕組みを作る。

### ゴール

```
git clone <repo> && cd claude-slack-pipe
# Claude Codeを開く
> セットアップして
# → 対話的にセットアップが進み、Bridgeが起動する
```

### 対象ユーザー

エンジニアから非エンジニアまで混在。手順は丁寧に案内する。

---

## 成果物

| ファイル | 役割 |
|----------|------|
| `skills/setup.md` | セットアップスキル本体 |
| `tips/slack-app-manifest.json` | Slack App作成用マニフェストJSON |
| `CLAUDE.md` への追記 | セットアップ要求時にスキルを呼び出す指示 |

コードの変更は不要。`src/` には手を入れない。

**注意：** CLAUDE.mdへの追記は実装時（スキルファイル作成と同時）に一度だけ行う。スキル実行時には追記しない。

---

## スキル起動フロー

1. ユーザーが「セットアップして」「setup」等と発言
2. CLAUDE.mdの指示により `/setup` スキルが起動
3. スキルがTaskCreateで6つのタスクを作成
4. タスクを順番に実行（各タスクで `in_progress` → `completed` を管理）

---

## タスク定義

スキル起動時に以下のタスクを作成する：

| # | タスク | 内容 |
|---|--------|------|
| 1 | 前提条件チェック | Node.js 20+, Claude CLIの確認・インストール |
| 2 | npm install | 依存パッケージのインストール |
| 3 | Slack Workspace作成ガイド | 専用Workspace作成の案内 |
| 4 | Slack App作成 | マニフェストを使ったApp作成ガイド |
| 5 | トークン取得・.env生成 | 対話形式でトークンを収集し.envを生成 |
| 6 | Bridge起動・動作確認 | プロセス起動と成功確認 |

---

## 各タスクの詳細

### タスク1: 前提条件チェック

**自動実行：**
- `node --version` で Node.js 20+ を確認
- `claude --version` で Claude CLI を確認

**未達の場合：**
- Node.js → OS依存のためインストール方法をURL付きで案内（https://nodejs.org）。ユーザーにインストール後「続けてください」と言ってもらう
- Claude CLI → ユーザーに「Claude CLIをインストールしてよいですか？」と許可を求め、許可されたら `npm install -g @anthropic-ai/claude-code` を実行

**重要：** 環境構築に関わるインストールは必ずユーザーの許可を得てから実行する。

**成功条件：** 両方のバージョンが要件を満たしていること。

### タスク2: npm install

**自動実行：**
- プロジェクトディレクトリで `npm install` を実行
- `node_modules/` が生成されたことを確認

**エラー時：** エラー内容を表示して対処を案内。

### タスク3: Slack Workspace作成ガイド

**ユーザーへの案内：**

まず以下の理由を説明する：

> Slack Appをワークスペースにインストールすると、そのワークスペースのメンバー全員のサイドバーにあなたのAppが表示されます。このBridgeは個人利用を想定しているため、個人用のワークスペース、もしくは必要最低限のメンバーだけが参加するワークスペースでの導入を推奨しています。
>
> 今回は個人利用のセットアップなので、あなた専用のワークスペースを作成しましょう。

**手順：**
- https://slack.com/create へのアクセスを指示
- Workspace名の例を提示（例: `My Claude Code`）
- 既に専用のWorkspaceがある場合はそれを使ってもOKと案内

**待ち：** 「Workspaceが作成できたら教えてください」

### タスク4: Slack App作成（マニフェスト使用）

3ステップで案内：

**ステップ1: APIコンソールでApp作成を開始**
- https://api.slack.com/apps を開く
- 「Create New App」をクリック
- 「From an app manifest」を選択
- 先ほど作成したWorkspaceを選択

**ステップ2: マニフェストを貼り付け**
- `tips/slack-app-manifest.json` の内容を表示する
- 「JSONタブに切り替えて、以下の内容を貼り付けてください」と案内
- 「Next」→ 内容を確認 → 「Create」をクリック

**ステップ3: 作成完了の確認**
- 「Appが作成できたら教えてください」と待つ

### タスク5: トークン取得・.env生成

対話形式で順番に収集：

**1. App-Level Token（SLACK_APP_TOKEN）**
- 「Settings → Basic Information → App-Level Tokens」を案内
- 「Generate Token and Scopes」をクリック
- Token Name: `socket-token`（任意）
- Scope: `connections:write` を追加
- 「Generate」をクリック
- `xapp-` で始まるトークンを貼ってもらう
- **検証：** `xapp-` で始まらない場合は即座に指摘し、正しい値を再入力してもらう

**2. Bot Token（SLACK_BOT_TOKEN）**
- 「Features → OAuth & Permissions」を案内
- 「Install to Workspace」をクリック → 権限を「Allow」
- Bot User OAuth Token（`xoxb-` で始まる）を貼ってもらう
- **検証：** `xoxb-` で始まらない場合は即座に指摘し、正しい値を再入力してもらう

**3. ALLOWED_USER_IDS**
- **推奨：** SlackプロフィールからUser IDを確認する方法を案内
  - プロフィールアイコンをクリック → 「プロフィール」→ 「...」→ 「メンバーIDをコピー」
  - `U` で始まるIDを貼ってもらう
- **代替：** 専用Workspaceで自分しかいない場合は空（制限なし）でもOKと提示

**4. 既存.envの確認**
- `.env` が既に存在する場合は「既存の.envがあります。上書きしますか？既存の設定を使いますか？」と確認する
- 上書きする場合のみ続行

**5. .env生成**
- 収集した値で `.env` ファイルを生成
- 生成する `.env` の完全な内容：

```env
# Slack credentials (user input)
SLACK_BOT_TOKEN=<収集した値>
SLACK_APP_TOKEN=<収集した値>

# Access control
ALLOWED_USER_IDS=<収集した値 or 空>
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

### タスク6: Bridge起動・動作確認

**自動実行：**
- `npx tsx src/index.ts` を `run_in_background: true` で実行
- ログに「Claude Code Slack Bridge is running」が出ることを確認
- エラーログが出ていないことを確認（特にSocket Mode接続エラー）

**起動失敗時の切り分け：**
- `Invalid token` 系エラー → トークンの再確認を案内（タスク5に戻る）
- `ENOENT` エラー → Claude CLIバージョン不一致の可能性。CLAUDE.mdの `/fix-claude-cli-version` を参照
- その他のエラー → エラー内容を表示して対処を案内

**完了案内：**
> セットアップ完了！Slackから話しかけてみてください。

---

## CLAUDE.mdへの追記内容

```markdown
## セットアップ

ユーザーが「セットアップして」「setup」「セットアップ」等のセットアップ要求をした場合、`/setup` スキルを呼び出すこと。
```

---

## tips/slack-app-manifest.json

現在のSlack App設定を反映したマニフェストJSONを作成する。含む設定：

- Socket Mode: 有効
- Bot Token Scopes: `app_mentions:read`, `chat:write`, `reactions:write`, `files:write`, `files:read`, `im:write`, `im:history`, `im:read`
- Event Subscriptions: `message.im`, `app_home_opened`
- Interactivity: 有効
- App名: `Claude Code Bridge`

**注意：** 実装時に既存の動作するSlack Appのscopes/eventsと照合し、マニフェストに過不足がないことを検証すること。
