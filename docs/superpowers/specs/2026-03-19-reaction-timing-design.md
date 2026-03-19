# リアクションタイミング同期設計

## 概要

Slackリアクション（⏳🧠✅）の付与タイミングを、Claude CLIの実際の処理状態と正確に同期させる。

## 課題

### 1. 🧠が早すぎる
idleセッションではプロンプト送信と同時に🧠が付くが、CLIがまだ何も返していない段階。ユーザーは「まだ考えてないだろ」と感じる。

### 2. 処理中に🧠が消える
長いbash実行等の途中で🧠が消え、リアクション無しの状態になることがある。原因はCLI内部のターン分割（message_stop→次ターン開始）による空白期間と推定。

### 3. ✅が勝手に消える
自分がメッセージを送っていないのに✅が消える。原因は`lastDone`がReactionManagerのインスタンス変数1つで管理されており、別スレッド/別セッションの処理開始が他セッションの✅を巻き込んで消すため。

## 設計

### リアクション状態遷移

#### 変更前

```
[idle session] → メッセージ受信 → 即座に🧠 → プロンプト送信
[new session]  → メッセージ受信 → ⏳ → stateChange('processing') → 🧠
```

#### 変更後

```
[idle session] → メッセージ受信 → ⏳ → 最初のコンテンツ受信 → 🧠
[new session]  → メッセージ受信 → ⏳ → 最初のコンテンツ受信 → 🧠
```

両ケースで⏳→🧠の遷移タイミングが「CLIから最初のコンテンツが届いた瞬間」に統一される。

### stream-processorでのfirstContentイベント

stream-processorに`firstContentReceived`フラグを追加し、最初のコンテンツイベント（`thinking`/`text`/`tool_use`/`result`）受信時にイベントを発火する。

```typescript
// stream-processorがイベントを発火
this.emit('firstContent', { channel, messageTs });

// index.tsでリスナー登録
streamProcessor.on('firstContent', ({ channel, messageTs }) => {
  reactionManager.replaceWithProcessing(channel, messageTs);
});
```

- `message_stop`でフラグをリセット（次のターンに備える）
- stream-processorはSlack APIの知識を持たず、コールバックで通知のみ行う
- リアクション管理の責務はindex.ts（オーケストレーション層）に留まる

### lastDoneのセッション別管理

`lastDone`をセッションIDをキーとしたMapに変更し、同一セッション内でのみ✅のクリーンアップを行う。

```typescript
// 変更前
private lastDone: { channel: string; ts: string } | null = null;

// 変更後
private lastDoneBySession: Map<string, { channel: string; ts: string }> = new Map();
```

`replaceWithProcessing`と`replaceWithDone`にsessionId引数を追加。

### 連続ターン時の挙動

CLIが長いbash実行等でターンを分割する場合（message_stop→次ターン開始）：

1. ターン完了 → 🧠消去、✅付与
2. 次ターン開始 → firstContentで✅消去、🧠付与

一瞬✅→🧠のチラつきが発生するが、これは正確な状態表現として許容する。

## 変更対象ファイル

| ファイル | 変更内容 |
|---|---|
| `src/slack/reaction-manager.ts` | `lastDone`をセッション別Mapに変更、`replaceWithProcessing`/`replaceWithDone`にsessionId引数追加 |
| `src/streaming/stream-processor.ts` | `firstContentReceived`フラグ追加、最初のコンテンツで`firstContent`イベントを発火、`message_stop`でリセット |
| `src/index.ts` | idleセッションで即🧠→⏳に変更、`stateChange('processing')`リスナー廃止、`firstContent`リスナー追加、reactionManager呼び出しにsessionId追加 |
| `tests/slack/reaction-manager.test.ts` | sessionId引数追加に伴うテスト更新、セッション別✅管理のテスト追加 |

## 変更しないもの

- `notification-text.ts` — メッセージ本文内のデコレーションアイコンはスコープ外
- `group-tracker.ts` — リアクション管理に関与しない
- `slack-action-executor.ts` — 実行層はそのまま
