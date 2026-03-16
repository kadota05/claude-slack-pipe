# Claude Code Slack Bridge

Claude Code CLIをSlackのDMから操作するブリッジアプリケーションです。

Slackでボットにメッセージを送ると、バックエンドで `claude` CLIが実行され、結果がスレッドに返信されます。1つのスレッドが1つのセッション（会話）に対応し、スレッド内でやりとりを続けることで文脈を保った対話が可能です。

**現在MVP段階（Phase 1）です。** 基本的なDMでの対話、セッション管理、App Homeでのプロジェクト一覧表示に対応しています。

---

## 前提条件

- **Node.js 20+**
- **Claude Code CLI** がインストール済みで、`claude` コマンドがPATHに通っている状態
- **Slack Workspace の管理者権限**（Slack Appの作成・インストールに必要）

---

## Slack App の作成手順

### 1. Appの新規作成

1. [Slack APIコンソール](https://api.slack.com/apps) にアクセスする
2. 右上の **「Create New App」** ボタンをクリック
3. **「From scratch」** を選択
4. App Name に `Claude Code Bridge` と入力
5. インストール先の Workspace を選択
6. **「Create App」** をクリック

### 2. Socket Mode の有効化

Socket Modeを使うことで、公開URLなしでイベントを受信できます。

1. 左メニューの **Settings → Socket Mode** をクリック
2. **「Enable Socket Mode」** のトグルをオンにする
3. App-Level Token の作成ダイアログが表示される
   - Token Name: `socket-token`（任意の名前）
   - Scope: **`connections:write`** を追加
   - **「Generate」** をクリック
4. 生成されたトークン（`xapp-` で始まる文字列）をコピーして控えておく
   - **これが `.env` の `SLACK_APP_TOKEN` になります**

### 3. OAuth & Permissions の設定

1. 左メニューの **Features → OAuth & Permissions** をクリック
2. **Scopes** セクションまでスクロールし、**Bot Token Scopes** に以下を追加する
   - `app_mentions:read` — メンションの読み取り
   - `chat:write` — メッセージの送信
   - `reactions:write` — リアクションの追加・削除
   - `files:write` — ファイルのアップロード
   - `files:read` — ファイルの読み取り
   - `im:write` — DMの送信
   - `im:history` — DMの履歴読み取り
   - `im:read` — DMチャンネル情報の読み取り
3. ページ上部の **「Install to Workspace」**（または「Reinstall to Workspace」）をクリック
4. 権限確認画面で **「Allow」** をクリック
5. インストール後に表示される **Bot User OAuth Token**（`xoxb-` で始まる文字列）をコピーして控えておく
   - **これが `.env` の `SLACK_BOT_TOKEN` になります**

### 4. Event Subscriptions の設定

1. 左メニューの **Features → Event Subscriptions** をクリック
2. **「Enable Events」** のトグルをオンにする（Socket Modeが有効なので Request URL は自動設定されます）
3. **Subscribe to bot events** セクションで以下のイベントを追加する
   - `message.im` — DMメッセージの受信
   - `app_home_opened` — App Homeタブが開かれた時
4. 右下の **「Save Changes」** をクリック

### 5. Interactivity & Shortcuts の有効化

1. 左メニューの **Features → Interactivity & Shortcuts** をクリック
2. **「Interactivity」** のトグルをオンにする
   - Socket Modeを使用しているため、Request URL の入力は不要です
3. **「Save Changes」** をクリック

> **注意:** Scopeやイベントを変更した場合は、OAuth & Permissions ページで **「Reinstall to Workspace」** を実行してください。

---

## プロジェクトのセットアップ

```bash
cd claude-slack-bridge
npm install
cp .env.example .env
# .env を編集してトークンを設定（次のセクション参照）
```

---

## 環境変数の設定

`.env` ファイルを編集して以下の値を設定します。

### 必須項目

| 変数名 | 説明 | 例 |
|--------|------|-----|
| `SLACK_BOT_TOKEN` | Bot User OAuth Token（上記手順3で取得） | `xoxb-1234-5678-abcdef` |
| `SLACK_APP_TOKEN` | App-Level Token（上記手順2で取得） | `xapp-1-A1234-5678-abcdef` |
| `ALLOWED_USER_IDS` | ボットの使用を許可するユーザーID（カンマ区切り） | `U12345678,U87654321` |

### オプション項目

| 変数名 | 説明 | デフォルト |
|--------|------|-----------|
| `ALLOWED_TEAM_IDS` | 許可するチームID（カンマ区切り） | なし |
| `ADMIN_USER_IDS` | 管理者ユーザーID（カンマ区切り） | なし |
| `CLAUDE_EXECUTABLE` | Claude CLIの実行ファイルパス | `claude` |
| `CLAUDE_PROJECTS_DIR` | Claudeプロジェクトのディレクトリ | `~/.claude/projects` |
| `MAX_CONCURRENT_PER_USER` | ユーザーごとの同時実行数上限 | `1` |
| `MAX_CONCURRENT_GLOBAL` | 全体の同時実行数上限 | `3` |
| `DEFAULT_TIMEOUT_MS` | デフォルトのタイムアウト（ミリ秒） | `300000`（5分） |
| `MAX_TIMEOUT_MS` | 最大タイムアウト（ミリ秒） | `1800000`（30分） |
| `DEFAULT_BUDGET_USD` | デフォルトの予算上限（USD） | `1.0` |
| `MAX_BUDGET_USD` | 最大予算上限（USD） | `10.0` |
| `LOG_LEVEL` | ログレベル（`error` / `warn` / `info` / `debug`） | `info` |

### Slack User ID の調べ方

1. Slackデスクトップアプリまたはブラウザで、自分のプロフィールアイコンをクリック
2. **「プロフィール」** を開く
3. 名前の横の **「...」（その他）** メニューをクリック
4. **「メンバーIDをコピー」** を選択
5. コピーされた `U` で始まる文字列が User ID です

---

## 起動方法

```bash
# 開発モード（tsx watch によるホットリロード）
npm run dev

# ビルドして本番実行
npm run build
npm start
```

起動に成功すると、ログに `Claude Code Slack Bridge is running` と表示されます。

---

## 使い方

### 基本操作

1. Slackで **Claude Code Bridge** ボットにDMを送る
2. ボットが処理中はメッセージにリアクション（処理中アイコン）が付く
3. 結果がスレッドに返信される
4. 同じスレッド内でメッセージを続けると、文脈を保った対話が可能

### ブリッジコマンド

`cc` プレフィックスを付けてコマンドを実行できます。

| コマンド | 説明 |
|----------|------|
| `cc /help` | コマンド一覧を表示 |
| `cc /status` | 現在のセッション情報を表示 |
| `cc /end` | セッションを終了 |

### Claude Code コマンド

`cc /commit` のように、Claude Codeのスラッシュコマンドもそのまま転送できます。

### App Home Tab

Slackの「ホーム」タブを開くと、プロジェクト一覧とセッション管理が表示されます。

---

## トラブルシューティング

### 「接続できない」

- Socket Modeが有効になっているか確認する（Settings → Socket Mode）
- `SLACK_APP_TOKEN`（`xapp-` で始まるトークン）が正しいか確認する
- App-Level Tokenのスコープに `connections:write` が含まれているか確認する

### 「メッセージに反応しない」

- Event Subscriptionsで **`message.im`** を購読しているか確認する
- Event Subscriptions が有効（Enableトグルがオン）になっているか確認する
- Scopeを変更した場合は Workspace への再インストールが必要

### 「権限エラー」

- `.env` の `ALLOWED_USER_IDS` に自分の Slack User ID が含まれているか確認する
- 複数ユーザーはカンマ区切りで指定する（スペースは不要）

### 「Claude Code が見つからない」

- ターミナルで `claude --version` が実行できるか確認する
- PATHが通っていない場合は `.env` の `CLAUDE_EXECUTABLE` にフルパスを指定する
  - 例: `CLAUDE_EXECUTABLE=/usr/local/bin/claude`

---

## 現在の制限事項（MVP）

- 応答は最終結果テキストのみ（途中経過のストリーミングは見えない）
- モデル選択UIは未実装（デフォルトで `sonnet` を使用）
- コマンドモーダルは未実装（テキストコマンドのみ対応）
- ファイルアップロードは未実装（長文はメッセージ分割で対応）

---

## 開発

```bash
# テスト実行
npm test

# テスト（watchモード）
npm run test:watch

# 型チェック
npm run lint

# ビルド
npm run build
```
