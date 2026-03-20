# Slackモバイル ビュー遷移中のインタラクション競合

## 症状

ホームタブでディレクトリを変更した直後（1-2秒以内）にスターボタンを押すと「Slackになかなか接続できません」エラーが表示される。1-2秒待てば正常に動作する。

## 根本原因

Slackモバイルクライアントがビュー再描画中にユーザーインタラクションを正しく処理できない。

`static_select`でディレクトリを変更すると`views.publish`が呼ばれ、新しいビューがクライアントに配信される。クライアントが新しいビューを受信→再描画する間（約1-2秒）にボタンを押すと、遷移中の状態でアクションを送信しようとしてクライアント側エラーになる。

## 証拠

### 検証した仮説と結果

| 仮説 | 判定 | 根拠 |
|---|---|---|
| H1: 同時views.publish競合 | △補助的 | キューで直列化しても改善せず |
| H2: クライアント再描画中操作 | **主因** | 1-2秒の遅延=再描画完了時間と一致 |
| H3: Socket Mode ack遅延 | × | ack()はawait前に即送信 |
| H4: 同期I/Oブロック | △寄与 | collectCandidates()のreaddirSync/statSync |
| H5: Rate limiting | × | 2回/秒は制限内 |

### キーポイント

- エラーメッセージ「Slackになかなか接続できません」はサーバー側エラーではなく**クライアント側**のメッセージ
- `ack()`は各ハンドラの先頭で即座に送信されており、Socket Modeのタイムアウトではない
- `views.publish`のキュー直列化だけでは解決しなかった→問題はAPI側ではなくクライアント側

## 修正内容

### 1. 2段階publish（`action-handler.ts`）

ディレクトリ変更時にスターボタンを一時的に非表示にし、1.5秒後に再表示する。

```typescript
async handleSetDirectory(userId, directoryId) {
  this.userPrefStore.setDirectory(userId, directoryId);
  // Phase 1: スターボタン非表示
  await this.homeTab.publishHomeTab(userId, undefined, { hideStarButton: true });
  // Phase 2: 1.5秒後に再表示
  setTimeout(() => {
    this.homeTab.publishHomeTab(userId);
  }, 1500);
}
```

### 2. hideStarButtonパラメータ（`block-builder.ts`）

`HomeTabParams`に`hideStarButton`フラグを追加。trueのときスターボタンのactionsブロックを出力しない。

### 3. views.publishキュー（`home-tab.ts`）

同一ユーザーの`views.publish`を直列化するPromiseチェーン。競合は主因ではなかったが、防御的に残す。

### 4. activeDirectoryIdの参照元変更（`index.ts`）

`toggle_star_directory`アクションで、ボタンの`value`（古いビューの値の可能性あり）ではなく`userPrefStore.get(userId).activeDirectoryId`を使用。

## 教訓

1. **「接続できません」はクライアント側エラー**: サーバーログに異常がなくても、モバイルクライアントの再描画タイミングが原因で接続エラーが表示されることがある
2. **Slackモバイルのビュー遷移は1-2秒かかる**: `views.publish`のHTTP応答が成功しても、クライアントへの配信→再描画にはさらに時間がかかる
3. **遷移中の操作防止はUXで対処**: APIレベルのキュー・直列化だけでは解決できない問題がある。ボタンの一時非表示のようなUX手法が有効
4. **ボタンのvalueはビュー描画時の静的スナップショット**: ビュー更新前のボタンvalueが送信される可能性があるため、サーバー側のstoreから最新値を取得するほうが安全
