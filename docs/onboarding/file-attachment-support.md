# ファイル・画像添付の対応状況

## 現状（2026-03-17時点）

**Slackからの画像・ファイル添付には未対応。テキストメッセージのみ処理される。**

## 挙動の詳細

| ケース | 結果 |
|--------|------|
| ファイルのみ送信（テキストなし） | メッセージが無視される（`event.text` が空のため） |
| テキスト＋ファイルの混在送信 | テキスト部分のみClaudeに送られ、ファイルは無視される |

## 技術的な理由

### 1. メッセージイベントの定義が `text` のみ

`src/slack/event-handler.ts` の `SlackMessageEvent` インターフェースに `files` フィールドが含まれていない。

```typescript
export interface SlackMessageEvent {
  text?: string;
  user?: string;
  channel?: string;
  ts?: string;
  thread_ts?: string;
  bot_id?: string;
  subtype?: string;
}
```

### 2. テキストなしメッセージの無視

`classifyMessage()` で `event.text` が空の場合は `'ignore'` を返すため、ファイルのみのメッセージは処理されない。

### 3. Claude CLIへの送信がテキスト限定

`src/bridge/persistent-session.ts` の `sendPrompt()` は `type: 'text'` のコンテンツのみ送信する。

```typescript
content: [{ type: 'text', text: prompt }]
```

### 4. 未使用の型定義が存在

`src/types.ts` に `ImageContent` や `DocumentContent` の型定義はあるが、実際のメッセージフローでは使われていない。

## 対応に必要な実装（概要）

ファイル添付を対応するには、以下の実装が必要：

1. **`SlackMessageEvent` に `files` フィールドを追加** — Slackのファイルメタデータを受け取る
2. **ファイルダウンロード処理** — Slack APIの `url_private_download` からファイルを取得（Bot Tokenで認証）
3. **base64エンコード** — ダウンロードしたファイルをbase64に変換
4. **Claude CLIへの送信形式を拡張** — `ImageContent` / `DocumentContent` として `content` 配列に含める
5. **対応形式の制限** — Claude APIがサポートする形式（PNG, JPEG, GIF, WebP, PDF等）のみ処理し、非対応形式はユーザーに通知する
