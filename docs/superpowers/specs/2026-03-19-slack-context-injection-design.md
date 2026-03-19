# Slack環境コンテキスト注入 設計書

## 概要

Bridge（Node.js）から Claude CLI へ送信するユーザーメッセージに、Slack環境のコンテキスト情報とフォーマット制約を毎回 prepend する。

## 背景・動機

- Claude の生成する図（テーブル、ASCII ボックス図、ツリー図など）が Slack mobile の狭い画面で崩れる
- Claude は自分が Slack 経由で応答していることを知らないため、PC前提の出力をしてしまう
- ユーザーは起動PCの前にいないため、ログ確認やシステム許可など PC ローカルの操作ができない

## 設計

### 新規ファイル: `src/bridge/slack-context.ts`

Slack 環境コンテキストのプロンプト文字列を定義する。

```typescript
export const SLACK_CONTEXT_PREFIX = `\
[Slack Bridge Context]
You are responding via Slack. Keep these constraints in mind:

- The user is NOT at the host PC. They cannot check logs,
  approve system prompts, or perform local-only operations.
  Ask them to run slash commands instead when needed.
- Diagrams, tables, and ASCII art must fit within 45
  characters wide. Slack mobile will break wider content.
- localhost URLs are accessible — use them freely.
`;
```

### 変更ファイル: `src/bridge/persistent-session.ts`

`sendPrompt()` と `sendInitialPrompt()` の両方で、ユーザーのプロンプトの前に `SLACK_CONTEXT_PREFIX` を結合する。

#### 変更箇所

1. `import { SLACK_CONTEXT_PREFIX } from './slack-context.js';` を追加
2. `sendPrompt(prompt)` 内の `text: prompt` → `text: SLACK_CONTEXT_PREFIX + '\n' + prompt`
3. `sendInitialPrompt(prompt)` 内の `text: prompt` → `text: SLACK_CONTEXT_PREFIX + '\n' + prompt`

注入は `sendPrompt()` / `sendInitialPrompt()` メソッド内部で行う。呼び出し元（`session-coordinator.ts` のキューデキュー等）の変更は不要。

### 適用範囲

- **全メッセージに常時適用**: セッション初回・継続ターンの両方で prepend する
- **CLI 直接利用には影響しない**: CLAUDE.md ではなく Bridge コード内で注入するため

### トークン消費

`SLACK_CONTEXT_PREFIX` は約60トークン。毎ターン付加されるが、コンテキストウィンドウ（1M tokens）に対して無視できるレベル。将来拡張する場合も100トークン以内に収めること。

### スコープ外

- 変換側（`markdown-converter.ts`）での後処理は行わない
- ON/OFF 切り替え機能は設けない
- 外部設定ファイルからの読み込みは行わない

## テスト方針

- Slack から実際にメッセージを送信し、図を含む応答が45文字幅に収まることを手動確認
- `SLACK_CONTEXT_PREFIX` の内容が意図通りであることは目視確認で十分（単純な定数エクスポート）

## ファイル一覧

| ファイル | 変更種別 |
|---------|---------|
| `src/bridge/slack-context.ts` | 新規 |
| `src/bridge/persistent-session.ts` | 修正 |
