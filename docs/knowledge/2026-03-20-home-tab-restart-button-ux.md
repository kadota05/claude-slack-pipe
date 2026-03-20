# ホームタブ再起動ボタンの実装知見

## 症状

ホームタブにBridge再起動ボタンを追加した際、以下のUX問題が発生した：

1. 再起動後にボタンが「再起動中...」のまま固まる
2. Slackの「なかなか接続できません」バナーが表示される
3. ボタンの配置・色の選択でモバイル表示が崩れる

## 根本原因

### Socket Mode の再接続タイムラグ

Bridge再起動 = プロセス終了 = Socket Mode接続が切れる。この間：

- `views.publish()` はHTTP APIなので成功するが、Slackクライアントが切断状態だと表示が更新されない
- `app_home_opened` イベントはSocket Mode経由なので、再接続完了まで届かない
- Slackクライアントは接続断を検知して「なかなか接続できません」バナーを出す（プラットフォーム側の挙動で制御不可）

### バナーが出る/出ないは運次第

Socket Modeの再接続が速ければバナーは出ない。遅ければ出る。再現性がないため、両方のケースに対応する必要がある。

### `cc /restart-bridge` と ホームタブボタンの違い

- DMからの `cc /restart-bridge`: restart-pending.json に `{ channel, ts }` を書く → ホームタブは更新されない
- ホームタブボタン: restart-pending.json に `{ homeTabUserId }` を書く → ホームタブが更新される

## 証拠

- ログで `app_home_opened` が再起動後に発火していないことを確認
- ユーザーが「再接続」ボタンを押すと `app_home_opened` が発火して正常表示に戻ることを確認
- 複数回テストでバナーが出たり出なかったりすることを確認

## 修正内容

### 1. タイマー + フラグによる確実な状態遷移

```typescript
// 起動時: フラグ設定 + completed publish + 5秒後に再publish
restartCompletePendingUser = userId;
await homeTabHandler.publishHomeTab(userId, 'completed');
setTimeout(() => {
  if (restartCompletePendingUser === pendingUser) {
    restartCompletePendingUser = null;
    await homeTabHandler.publishHomeTab(pendingUser, 'completed');
  }
}, 5000);

// app_home_opened: フラグがあれば completed を表示してクリア
if (restartCompletePendingUser === event.user) {
  restartCompletePendingUser = null;
  await homeTabHandler.publishHomeTab(event.user, 'completed');
} else {
  await homeTabHandler.publishHomeTab(event.user);
}
```

これにより：
- Socket再接続が速い場合: 即座に completed が届く
- Socket再接続が遅い場合: 5秒後のタイマーで確実に届く
- ユーザーがタブを開いた場合: フラグチェックで completed を表示

### 2. UXの配置決定

**最終配置（一番下）:**
```
Model セレクタ
Directory セレクタ
────────────
Recent Sessions
────────────
⚡ システム再起動（グレーボタン）
（restarting/completed時のみ説明文）
```

**却下した配置と理由:**
- 一番上: 設定系と性質が違うため違和感
- 設定とSessionsの間: 赤ボタンにすると日常的に目に入り邪魔
- section accessory: モバイルで崩れる

### 3. ボタンの色

- 赤（danger）は却下: 「目立たないようにしたい」要望と矛盾。緊急操作は普段目に入らない場所にグレーで置くのがUXの定石
- グレー（デフォルト）を採用

### 4. 説明文

- idle時: 説明文なし（普段は目立たせない）
- restarting/completed時: 「Slackになかなか接続できません」と表示されることがありますが正常です

## 教訓

1. **Socket Modeアプリで再起動UI作る場合、`views.publish` が確実にクライアントに届く保証はない。** タイマーによるリトライが必要。
2. **Slackの「接続できません」バナーはプラットフォーム側の挙動で制御不可。** 出ることを前提にUXを設計すべき。
3. **モバイルでのSlack Block Kit表示はデスクトップと異なる。** section + accessory はモバイルで縦に崩れる。actions ブロックのボタンが安全。
4. **緊急操作のUI配置は「消火器の法則」。** 普段目に入らないが、探せば見つかる場所に置く。一番下が最適。
5. **DMからの再起動とホームタブからの再起動は別経路。** restart-pending.json のフォーマットで区別する必要がある。
