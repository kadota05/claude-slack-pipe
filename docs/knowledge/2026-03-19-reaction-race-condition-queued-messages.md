# キュー済みメッセージのリアクション競合バグ

## 症状

処理中（🧠）のスレッドにユーザーが追加メッセージを送信すると、最初のメッセージのリアクションが🧠のまま残り、✅に遷移しない。追加メッセージは🧠を経由せず直接✅が付くか、リアクションが不整合になる。

## 根本原因

`persistent-session.ts` の `handleEvent` で、`result` イベント受信時に以下が同期的に連続実行される：

```typescript
this.emit('message', resultEvent);  // serialQueueにenqueue（非同期）
this.transition('idle');             // 同期的に即座に実行
```

`transition('idle')` が `stateChange` イベントを発火し、`session-coordinator` のハンドラがキューから次のメッセージをdequeueして `activeMessageTs` を上書きする。この上書きは、serialQueue内のresultハンドラが `activeMessageTs.get()` を呼ぶ**前**に起きるため、replaceWithDoneが間違ったメッセージ（次のキュー済みメッセージ）に対して実行される。

さらに、resultハンドラ内の `activeMessageTs.delete()` が次のメッセージの参照を消してしまい、onFirstContentが機能しなくなる。

## 証拠

コードの静的解析による特定。`emit('message')` → `transition('idle')` の同期実行順序と、serialQueueの非同期処理のタイミング差が原因。

- `persistent-session.ts:253,275` — emit と transition の連続実行
- `session-coordinator.ts:124-131` — stateChange での auto-dequeue
- `index.ts:590-592` — resultハンドラ内の activeMessageTs 読み取りと削除

## 修正内容

1. `session.on('message')` リスナー内で、serialQueueにenqueueする**前に** `activeMessageTs.get()` を同期的にキャプチャ
2. resultハンドラ内ではキャプチャした値を使用（`activeMessageTs.get()` の再読み取りを廃止）
3. `activeMessageTs.delete()` を除去（次のメッセージのonFirstContentが参照できるようにする）

## 教訓

- EventEmitterの `emit()` でリスナーに非同期キュー（serialQueue等）を使っている場合、`emit()` 直後の同期処理が、キュー内のハンドラより先に実行される。共有ステートの読み取りはenqueue前の同期時点でキャプチャすべき。
- 「同期的な状態遷移」と「非同期なイベント処理」が共有する可変状態は、タイミング競合の温床になる。
