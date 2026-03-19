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

### stream-processorでのfirstContentコールバック

stream-processorに`firstContentReceived`フラグを追加し、最初のコンテンツイベント（`thinking`/`text`/`tool_use`）受信時にコールバックを呼ぶ。

**注意:** `result`イベントは処理完了を意味するため、firstContentのトリガーには含めない。

**パターン:** StreamProcessorはEventEmitterを継承していないため、コンストラクタのconfig引数に`onFirstContent`コールバックを追加する方式を採用する。EventEmitterより型安全でシンプル。

```typescript
// stream-processor.ts — config型にコールバック追加
interface StreamProcessorConfig {
  // ... existing fields
  onFirstContent?: () => void;
}

// stream-processor内部
private firstContentReceived = false;

processEvent(event: StreamEvent): void {
  if (!this.firstContentReceived && isContentEvent(event)) {
    this.firstContentReceived = true;
    this.config.onFirstContent?.();
  }
  // ... existing processing
}

// message_stop時にフラグをリセット
// handleEvent内のassistant turnのstop処理（既存のmessage_stop検出箇所）でリセット

// index.ts — wireSessionOutput内でStreamProcessor生成時にコールバック注入
const streamProcessor = new StreamProcessor({
  // ... existing config
  onFirstContent: () => {
    reactionManager.replaceWithProcessing(sessionId, channelId, messageTs);
  },
});
```

- stream-processorはSlack APIの知識を持たず、コールバックで通知のみ行う
- リアクション管理の責務はindex.ts（オーケストレーション層）に留まる
- コールバックはwireSessionOutput内で登録されるため、new session / idle session両方で同じパスを通る

### lastDoneのセッション別管理

`lastDone`をセッションIDをキーとしたMapに変更し、同一セッション内でのみ✅のクリーンアップを行う。

```typescript
// 変更前
private lastDone: { channel: string; ts: string } | null = null;

// 変更後
private lastDoneBySession: Map<string, { channel: string; ts: string }> = new Map();
```

`replaceWithProcessing`と`replaceWithDone`にsessionId引数を追加。

**クリーンアップ:** セッションが`dead`状態になった時にMapからエントリを削除する`cleanupSession(sessionId)`メソッドを追加し、メモリリークを防ぐ。

### 連続ターン時の挙動

CLIが長いbash実行等でターンを分割する場合（message_stop→次ターン開始）：

1. ターン完了 → 🧠消去、✅付与
2. 次ターン開始 → firstContentで✅消去、🧠付与

一瞬✅→🧠のチラつきが発生するが、これは正確な状態表現として許容する。

### エラーパス

以下のエラーケースでは既存の`removeProcessing`メソッドで⏳と🧠の両方をクリーンアップする（現状と同じ）：
- `firstContent`が一度も発火せずにセッションが死んだ場合 → `removeProcessing`で⏳を除去
- `sendPrompt`後にエラーが発生した場合 → 既存のcatch節で`removeProcessing`を呼ぶ

エラーパスのリアクション管理の包括的な見直しは今回のスコープ外とする。

### idle sessionでの⏳使用について

idle sessionは既にCLIプロセスが起動済みで、new sessionのCLI起動待ちとは本質的に異なる。しかしidle→processing間の待ち時間は通常数百ms〜1秒程度で十分短く、ユーザーが⏳を「CLI起動中」と誤解するリスクは低い。また、両パスで同じアイコンを使うことで状態遷移ロジックがシンプルになるメリットを優先する。

## 変更対象ファイル

| ファイル | 変更内容 |
|---|---|
| `src/slack/reaction-manager.ts` | `lastDone`をセッション別Mapに変更、`replaceWithProcessing`/`replaceWithDone`にsessionId引数追加 |
| `src/streaming/stream-processor.ts` | `firstContentReceived`フラグ追加、最初のコンテンツで`onFirstContent`コールバック呼び出し、`message_stop`でリセット |
| `src/index.ts` | idleセッションで即🧠→⏳に変更、`stateChange('processing')`リスナー廃止、wireSessionOutput内で`onFirstContent`コールバック注入、reactionManager呼び出しにsessionId追加 |
| `tests/slack/reaction-manager.test.ts` | sessionId引数追加に伴うテスト更新、セッション別✅管理のテスト追加 |

## 変更しないもの

- `notification-text.ts` — メッセージ本文内のデコレーションアイコンはスコープ外
- `group-tracker.ts` — リアクション管理に関与しない
- `slack-action-executor.ts` — 実行層はそのまま
