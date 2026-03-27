# ファイル入力対応 設計書

## 概要

Slack DMに添付されたファイル（画像・PDF・テキスト系）をClaude CLIに送信できるようにする。現在はテキストメッセージのみ対応しているが、`event.files` を処理してstream-jsonのcontentブロックとして送信する。

## 背景

- READMEに「ファイル・画像の添付は未対応」と明記されている
- Claude CLIのstream-json stdinは `image`, `document` コンテンツブロックに対応済み（実テストで確認）
- モバイルからスクショや写真を送って質問するユースケースが主な動機

## 技術調査結果

### Claude CLI (stream-json) 対応状況

| 種別 | 対応 | 形式 | 制限 |
|------|------|------|------|
| 画像 | OK | `image` ブロック (base64) | JPEG/PNG/GIF/WebP, 5MB/枚, 8000px |
| PDF | OK | `document` ブロック (base64) | 600ページ, 32MB/リクエスト |
| テキスト系 | OK | `text` ブロック (中身を文字列) | - |
| 動画/音声 | NG | - | API非対応 |
| Office系 | NG | - | 直接は非対応 |

### Slack 側

- ファイルアップロードは `subtype: "file_share"` で `message.im` イベントとして届く
- `event.files` 配列に1つ以上のファイルオブジェクトが含まれる
- ダウンロードは `url_private` に `Authorization: Bearer <bot_token>` ヘッダーでHTTP GET
- モバイル/デスクトップでAPI構造に差異なし
- **必要スコープ: `files:read`（現在未設定）**

## 設計

### ファイル分類マッピング

| カテゴリ | mimetype | Claude送信形式 |
|----------|----------|---------------|
| 画像 | image/jpeg, image/png, image/gif, image/webp | `{ type: "image", source: { type: "base64", media_type, data } }` |
| PDF | application/pdf | `{ type: "document", source: { type: "base64", media_type: "application/pdf", data } }` |
| テキスト系 | text/* (text/plain, text/html, text/css, text/csv, text/markdown, text/xml), application/json, application/xml, application/javascript, application/typescript | `{ type: "text", text: "<filename>:\n<内容>" }` |
| 非対応 | 上記以外 (動画, 音声, Office, zip等) | ユーザーにエラー通知 |

### メッセージ処理フロー

```
event受信
  → subtype="file_share" → ファイル処理へ
  → subtypeなし → 従来通りtext処理
  → その他subtype → 無視（従来通り）

ファイル処理:
  1. event.files をループ
  2. 各ファイルをmimetypeでカテゴリ分類
  3. url_private からダウンロード (Bot Token認証)
  4. カテゴリ別にcontentブロック生成
  5. event.text があればtextブロックも追加（なければファイルのみ）
  6. base64合計サイズが32MBを超えていないかチェック
  7. content配列をまとめてsendPrompt()へ
```

### sendPrompt の拡張

現在: `sendPrompt(prompt: string)` → textブロック1つに変換

新: `sendPrompt(prompt: string | ContentBlock[])` → ContentBlock[]の場合はそのままcontentに設定

### エラーハンドリング

| ケース | 挙動 |
|--------|------|
| ダウンロード失敗 | 「ファイル取得に失敗」通知、テキスト部分のみ処理続行 |
| 非対応ファイルのみ | 「対応していない形式です（対応: 画像/PDF/テキスト系）」通知、処理中止 |
| 非対応+対応混在 | 対応分だけ処理、非対応分は通知 |
| 32MB超過 | 「ファイルサイズが上限を超えています」通知、処理中止 |
| テキスト系の文字コード不明 | UTF-8として読み、失敗したらバイナリ扱い→非対応 |

通知は既存の `ErrorDisplayHandler` を使ってスレッド内にメッセージ投稿。

## 変更箇所

### 1. Slack App設定（手動）
- Bot Scopeに `files:read` を追加

### 2. slack-app-manifest.json
- `bot_scopes` に `files:read` を追加

### 3. .claude/skills/setup.md
- セットアップ手順内のBot Scopeリストに `files:read` を追加

### 4. src/slack/event-handler.ts
- `file_share` subtypeを無視せず通過させる

### 5. src/index.ts (handleMessage)
- `event.files` が存在する場合のブランチ追加
- ファイル処理関数を呼び出し

### 6. 新規: src/slack/file-processor.ts
- ファイル分類ロジック（mimetype → カテゴリ）
- Slackからのダウンロード（fetch + Bot Token認証ヘッダー）
- base64エンコード / テキスト読み出し
- contentブロック配列の組み立て
- サイズチェック（32MB上限）

### 7. src/bridge/persistent-session.ts
- `sendPrompt()` を拡張: `string | ContentBlock[]` を受け取れるように

### 8. src/types.ts
- `StdinUserMessage` の content 型を拡張（既存の `ImageContent`, `DocumentContent` 型を活用）

### 9. README更新
- 「ファイル・画像の添付は未対応」の記述を更新
- 対応フォーマット一覧を記載

## 変更しないもの

- StreamProcessor（出力側）
- SessionCoordinator
- MessageQueue
- SlackActionExecutor

入力パイプラインだけの変更で完結する。
