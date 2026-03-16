# Slackカスタムスラッシュコマンド設計

## 概要

Claude Codeのスラッシュコマンドを、Slack公式のカスタムスラッシュコマンドとして登録し、Slackの入力欄から補完付きで使えるようにする。

## 背景と動機

現在、Slackのメッセージ本文に `/compact` 等と入力すると、Slackが未登録のスラッシュコマンドとして解釈し「有効なコマンドではありません」エラーで送信できない。`cc /compact` のようなプレフィックス付き入力は可能だが、Claude Code本来の体験と異なる。

Slack Appにカスタムスラッシュコマンドを登録することで、この問題を解決する。

## 登録コマンド一覧

| コマンド | 用途 | description (Slack表示用) |
|---------|------|--------------------------|
| `/compact` | 会話圧縮 | Compress conversation context |
| `/memory` | メモリ管理 | Manage Claude Code memory |
| `/cost` | コスト表示 | Show session cost |
| `/permissions` | 権限管理 | Manage tool permissions |
| `/review` | コードレビュー | Request code review |
| `/config` | 設定確認 | Show current configuration |
| `/mcp` | MCPサーバー管理 | Manage MCP servers |
| `/status` | ステータス確認 | Show session status |

除外したコマンド: `/clear` (新規セッション立ち上げが容易なため不要), `/model` (ホームタブと機能重複), `/login`, `/logout`, `/doctor`, `/init`, `/terminal-setup`, `/vim`, `/bug`, `/help` (CLI環境専用)

## アーキテクチャ

```
Slack入力欄: /compact
    │
    ▼
Slack API (Socket Mode)
    │
    ▼
app.command('/compact') ─── ack() を即座に返す
    │
    ▼
SlashCommandRouter (新モジュール)
    ├── user_id + channel_id からセッション特定 (SessionCoordinator)
    ├── セッションなし → ephemeralメッセージで通知
    ├── セッションdead → ephemeralメッセージで通知
    └── セッションactive → session.stdin に "/compact" を書き込み
                              │
                              ▼
                        CLIが処理 → 結果は既存のストリーミング経由で
                        スレッドに表示される
```

## セッション特定ロジック

1. ペイロードの `user_id` + `channel_id` でアクティブセッションを検索
2. `channel_id` を使う理由: 同一ユーザーが複数チャンネルで別セッションを持つ可能性があるため
3. 複数セッション該当時: 最新のアクティブセッション (state: `idle` or `busy`) を選択
4. 該当なし: ephemeralメッセージで通知

## 実装詳細

### 新規ファイル

`src/slack/slash-command-router.ts` — 1ファイルのみ

```typescript
const SLASH_COMMANDS = [
  'compact', 'memory', 'cost', 'permissions',
  'review', 'config', 'mcp', 'status',
] as const;

export function registerSlashCommands(app, coordinator, auth) {
  for (const cmd of SLASH_COMMANDS) {
    app.command(`/${cmd}`, async ({ command, ack, client }) => {
      // Auth check
      if (!auth.isAllowed(command.user_id)) {
        await ack({ text: 'You are not authorized.' });
        return;
      }

      // Find active session
      const session = coordinator.findActiveSession(command.user_id, command.channel_id);

      if (!session || session.state === 'dead') {
        await ack({ text: 'No active session in this channel.' });
        return;
      }

      await ack(); // Empty ack — results appear in thread via streaming

      const cliCommand = `/${cmd}${command.text ? ' ' + command.text : ''}`;
      session.sendInput(cliCommand);
    });
  }
}
```

### 既存ファイル変更

`src/index.ts` — 登録呼び出しを1行追加:

```typescript
import { registerSlashCommands } from './slack/slash-command-router.js';
// ... 既存の初期化コードの後に:
registerSlashCommands(app, coordinator, auth);
```

### ack() の応答方針

| ケース | ack() の内容 |
|--------|-------------|
| セッションあり | 空ack (結果は既存ストリーミングでスレッドに表示) |
| セッションなし | `ack({ text: "No active session in this channel." })` (ephemeral) |
| セッションdead | `ack({ text: "Session has ended." })` (ephemeral) |
| 認証失敗 | `ack({ text: "You are not authorized." })` (ephemeral) |

### 既存機能との共存

- `command-parser.ts` のメッセージ経由コマンド (`cc /status` 等) は引き続き動作
- スラッシュコマンドとメッセージ経由は独立したパスで処理
- 既存コードへの変更は `index.ts` の1行追加のみ

## エラーハンドリング

| ケース | 対応 |
|--------|------|
| セッションなし | ephemeralで通知 |
| セッションbusy (処理中) | そのまま送る。CLIの責任 |
| セッションdead | ephemeralで通知 |
| `commands` scope未設定 | Slack APIレベルでエラー (管理画面で設定) |

## 手動セットアップ手順

Slack App管理画面 (api.slack.com/apps) で:

1. 対象Appを選択
2. 「Slash Commands」セクションへ移動
3. 8コマンドをそれぞれ「Create New Command」で登録
4. OAuthスコープに `commands` が含まれていることを確認
5. Socket Modeが有効であればRequest URLは不要
6. Appを再インストール (スコープ変更時)
