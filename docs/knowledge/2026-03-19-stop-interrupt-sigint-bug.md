# ストップ(🔴)が機能しない — persistent session の interrupt 戦略

## 症状

ユーザーが処理中のメッセージに🔴リアクションを付けても、CLIの処理が止まらない。
- UIフィードバック（🧠除去、⏹️メッセージ）は表示される
- しかしCLIは処理を続行し、最後まで出力が投稿される

## 根本原因

3つの問題が重なっていた:

### 問題1: `control_request` プロトコルを使っていなかった
元のコードは `{ type: 'control', subtype: 'interrupt' }` を stdin に送っていたが、CLI に無視された。

公式 Claude Agent SDK（Python）のソースを調査した結果、正しい interrupt プロトコルは **`control_request` ラッパー** を使う形式:
```json
{
  "type": "control_request",
  "request_id": "req_1_abc123",
  "request": { "subtype": "interrupt" }
}
```
`request_id` による応答追跡が必要で、CLI は `control_response` で返す。

参照: `anthropics/claude-agent-sdk-python` の `_internal/query.py` → `_send_control_request()`

### 問題2: `_interrupted` suppress が `result` イベントも弾いていた
`_interrupted=true` の間、`system` 以外の全イベントを suppress するロジックがあった。control_request が実は効いていて `result` イベントが返ってきていたが、suppress されて `killTimer` がクリアされず、5秒後に SIGTERM が発火してプロセスが死亡した。

### 問題3: auto-dequeue 時の `activeMessageTs` 未登録
キューから dequeue されたメッセージの `activeMessageTs` が登録されず、🔴リアクションの session lookup が失敗していた。

## 証拠

### 修正前（SIGTERM フォールバック発火）
```
20:37:36.098  Sending control_request interrupt
20:37:36.100  event: type=control_response       ← CLIは応答した
20:37:36.104  event: type=result                  ← suppressされてkillTimerクリアされず
20:37:41.099  Control interrupt timed out, SIGTERM ← 不要なkill
20:37:41.477  Process exited: code=143            ← プロセス死亡
```

### 修正後（クリーンな interrupt）
```
20:41:39.767  Sending control_request interrupt
20:41:39.769  event: type=control_response        ← CLIが応答
20:41:39.772  event: type=result                  ← 正常に処理、killTimerクリア
20:41:39.773  stateChange: processing → idle      ← プロセス生存、即座に次のメッセージ対応可能
```

## 修正内容

### Fix 1: `control_request` プロトコルで interrupt
`sendControlRequest()` メソッドを追加。公式プロトコル形式 `{ type: 'control_request', request_id, request }` で stdin に送信。SIGTERM は `KILL_GRACE_MS` 後のフォールバックとして残存。

### Fix 2: suppress の例外に `result` を追加
`_interrupted=true` の suppress 条件を `event.type !== 'system'` から `event.type !== 'system' && event.type !== 'result'` に変更。result イベントが通過することで killTimer クリアと idle 遷移が正常に動作。

### Fix 3: result 受信時に killTimer クリア + `_interrupted` リセット
result イベント処理で killTimer を clearTimeout し、`_interrupted` フラグをリセット。

### Fix 4: auto-dequeue 時の `activeMessageTs` 登録
`SessionCoordinator` に `onDequeueCallback` を追加。

## 教訓

- **公式 SDK のソースを読め**: 型定義だけでは不十分。`claude-agent-sdk-python` の `_internal/query.py` にプロトコルの実装がある。`control_request` ラッパー + `request_id` が必須。
- **suppress ロジックは副作用を全て追跡**: 「output を抑制する」つもりで書いた suppress が、状態遷移に必要な `result` イベントまで弾いていた。suppress 対象を明示的にホワイトリストで管理する。
- **ログは嘘をつかない**: `control_response` が返ってきている時点で CLI は interrupt を受理していた。問題は自分のコードの suppress ロジックにあった。
