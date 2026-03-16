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
Slack入力欄: /compact (どのチャンネルからでも可)
    │
    ▼
Slack API (Socket Mode)
    │
    ▼
app.command('/compact') ─── ack("Sent /compact to session") ephemeral
    │
    ▼
SlashCommandRouter (新モジュール)
    ├── Auth check (AuthMiddleware)
    ├── Rate limit check (RateLimiter)
    ├── user_id からアクティブセッション特定 (SessionIndexStore)
    ├── セッションなし → ephemeralで通知
    ├── セッションdead/ended → ephemeralで通知
    ├── セッションprocessing → ephemeralで「処理中のため待ってください」
    └── セッションidle → session.sendPrompt("/compact") で転送
                            │
                            ▼
                      CLIが処理 → 結果は既存のストリーミング経由で
                      セッション元のDMスレッドに表示される
```

**注意: 結果の表示先はセッションが開始されたDMスレッドであり、スラッシュコマンドを打った場所ではない。**

## セッション特定ロジック

1. `SessionIndexStore.getActive()` から `userId` が一致するエントリを検索
2. 複数該当時: `lastActiveAt` が最新のものを選択
3. `SessionCoordinator.getSession(entry.cliSessionId)` でセッション実体を取得
4. 該当なし or セッション実体がない: ephemeralメッセージで通知

**`user_id` のみで検索する理由**: セッションは全てDMスレッドに紐づいており、スラッシュコマンドの `channel_id` はコマンドを打ったチャンネル（DM以外の可能性あり）を指すため、`channel_id` でのフィルタリングは不適切。

## 実装詳細

### 新規ファイル

`src/slack/slash-command-router.ts`

```typescript
import type { App } from '@slack/bolt';
import type { SessionCoordinator } from '../bridge/session-coordinator.js';
import type { SessionIndexStore } from '../store/session-index-store.js';
import type { AuthMiddleware } from '../middleware/auth.js';
import type { RateLimiter } from '../middleware/rate-limiter.js';

const SLASH_COMMANDS = [
  'compact', 'memory', 'cost', 'permissions',
  'review', 'config', 'mcp', 'status',
] as const;

export function registerSlashCommands(
  app: App,
  coordinator: SessionCoordinator,
  sessionIndex: SessionIndexStore,
  auth: AuthMiddleware,
  rateLimiter: RateLimiter,
): void {
  for (const cmd of SLASH_COMMANDS) {
    app.command(`/${cmd}`, async ({ command, ack }) => {
      // Auth check
      if (!auth.isAllowed(command.user_id, command.team_id)) {
        await ack({ text: 'You are not authorized.' });
        return;
      }

      // Rate limit check
      if (!rateLimiter.check(command.user_id)) {
        await ack({ text: 'Rate limit exceeded. Please wait.' });
        return;
      }

      // Find active session for this user
      const activeEntries = sessionIndex.getActive()
        .filter(e => e.userId === command.user_id);

      if (activeEntries.length === 0) {
        await ack({ text: 'No active session found.' });
        return;
      }

      const entry = activeEntries[0]; // Already sorted by lastActiveAt desc
      const session = coordinator.getSession(entry.cliSessionId);

      if (!session || session.state === 'dead') {
        await ack({ text: 'Session has ended.' });
        return;
      }

      if (session.state !== 'idle') {
        await ack({ text: 'Session is busy. Please wait and try again.' });
        return;
      }

      const cliCommand = `/${cmd}${command.text ? ' ' + command.text : ''}`;
      session.sendPrompt(cliCommand);
      await ack({ text: `Sent ${cliCommand} to your active session.` });
    });
  }
}
```

### 既存ファイル変更

**`src/index.ts`** — import追加 + 登録呼び出し1行:

```typescript
import { registerSlashCommands } from './slack/slash-command-router.js';
// ... 既存の初期化コードの後に:
registerSlashCommands(app, coordinator, sessionIndexStore, auth, rateLimiter);
```

### ack() の応答方針

全てephemeralメッセージで応答する（ユーザーのみに表示）。

| ケース | ack() の内容 |
|--------|-------------|
| 成功 | `"Sent /compact to your active session."` |
| セッションなし | `"No active session found."` |
| セッションdead | `"Session has ended."` |
| セッションbusy | `"Session is busy. Please wait and try again."` |
| 認証失敗 | `"You are not authorized."` |
| レートリミット | `"Rate limit exceeded. Please wait."` |

### 既存機能との共存

- `command-parser.ts` のメッセージ経由コマンド (`cc /status` 等) は引き続き動作
- スラッシュコマンドとメッセージ経由は独立したパスで処理
- 既存コードへの影響は `index.ts` の登録呼び出し追加のみ

## エラーハンドリング

| ケース | 対応 |
|--------|------|
| セッションなし | ephemeralで通知 |
| セッションbusy (processing) | ephemeralで「待ってください」 |
| セッションdead | ephemeralで通知 |
| 認証失敗 | ephemeralで通知 |
| レートリミット超過 | ephemeralで通知 |
| `commands` scope未設定 | Slack APIレベルでエラー (管理画面で設定) |

## 手動セットアップ手順

Slack App管理画面 (api.slack.com/apps) で:

1. 対象Appを選択
2. 「Slash Commands」セクションへ移動
3. 8コマンドをそれぞれ「Create New Command」で登録
   - Command: `/compact` 等
   - Short Description: 上記テーブルのdescription列を参照
   - Usage Hint: (任意) コマンドの引数例
4. OAuthスコープに `commands` が含まれていることを確認
5. Socket Modeが有効であればRequest URLは不要
6. Appを再インストール (スコープ変更時)

**注意**: `/review` や `/status` など汎用的なコマンド名は、ワークスペース内の他Appと衝突する可能性がある。衝突した場合は後からインストールした方が優先される。
