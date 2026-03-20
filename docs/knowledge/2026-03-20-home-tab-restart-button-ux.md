# ホームタブ再起動ボタンの設計・実装知見

## 概要

ホームタブに Bridge 再起動ボタンを追加する機能を、brainstorming → spec → plan → subagent実装 → デバッグ → UX反復の全サイクルで実施。実装自体は速く完了したが、UXの調整に大半の時間を使った。

## 1. Socket Mode再接続とUI更新の構造的制約

### 症状

- 再起動後にボタンが「再起動中...」のまま固まる
- Slackの「なかなか接続できません」バナーが表示される

### 根本原因

Bridge再起動 = プロセス終了 = Socket Mode接続が切れる。この間：

- `views.publish()` はHTTP APIなので成功するが、Slackクライアントが切断状態だと表示が更新されない
- `app_home_opened` イベントはSocket Mode経由なので、再接続完了まで届かない
- Slackクライアントは接続断を検知して「なかなか接続できません」バナーを出す（プラットフォーム側の挙動で制御不可）
- バナーが出る/出ないはSocket再接続速度次第で運。再現性がない

### 証拠

- ログで `app_home_opened` が再起動後に発火していないことを確認
- ユーザーが「再接続」ボタンを押すと `app_home_opened` が発火して正常表示に戻ることを確認
- 複数回テストでバナーが出たり出なかったりすることを確認

### 対策: タイマー + フラグパターン

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

これにより全パターンをカバー：
- Socket再接続が速い → 即座に completed が届く
- Socket再接続が遅い → 5秒後のタイマーで確実に届く
- ユーザーがタブを開いた → フラグチェックで completed を表示
- ユーザーが放置して後で開いた → フラグはタイマーでクリア済み、idle 表示

### 教訓

- **Socket Modeアプリで `views.publish` が確実にクライアントに届く保証はない。** タイマーによるリトライが必須。
- **Slackの「接続できません」バナーは制御不可。** 出ることを前提にUXを設計する。

## 2. DMコマンドとホームタブボタンの経路差異

- `cc /restart-bridge`（DM）: `restart-pending.json` に `{ channel, ts }` → ホームタブは更新されない
- ホームタブボタン: `restart-pending.json` に `{ homeTabUserId }` → ホームタブが更新される
- テスト時はボタンを直接押す必要がある（DMコマンドではホームタブの動作確認不可）

## 3. モバイルでのSlack Block Kit制約

- `section` + `accessory`（ボタン）はモバイルで縦に崩れて表示が壊れる
- `actions` ブロックのボタンがモバイルで最も安全
- レイアウト変更時は必ずモバイル実機で確認すべき

## 4. UX設計: 緊急操作の配置「消火器の法則」

緊急操作（再起動ボタン）は「普段目に入らないが、探せば見つかる場所」に置く。消火器が廊下の隅にあるのと同じ理屈。

**最終配置（一番下、グレーボタン）:**
```
Model セレクタ
Directory セレクタ
────────────
Recent Sessions
────────────
⚡ システム再起動（グレー）
（restarting/completed時のみ説明文）
```

**却下した配置と理由:**
- 一番上: 設定系（Model/Directory）と性質が違うため違和感
- 設定とSessionsの間: 日常的に目に入り邪魔。赤ボタンだと「目立たせたくない」要望と矛盾
- section accessory（右寄せ）: モバイルで崩れる

**ボタンの色:** グレー（デフォルト）を採用。赤（danger）は目を引きすぎて「目立たないようにしたい」と矛盾。

**説明文:**
- idle時: なし（普段は目立たせない）
- restarting/completed時: 「Slackになかなか接続できません」と表示されることがありますが正常です

## 5. UX設計プロセスの教訓

- **実装よりUX反復に時間がかかる。** コードは数十分で書けるが、配置・色・テキスト・エッジケースの議論が本質。
- **「ユーザーの体験」を全パターン言語化してから実装する。** バナー出る/出ない、タブ開く/開かない、タイマーとの競合、放置して戻った場合など全ケースを潰す。
- **技術的に正しくてもUXが悪ければ意味がない。** 例: タイマーで状態を戻す仕組みは技術的に正しいが、「再起動完了を見れない」UX問題を生む。フラグとの組み合わせで解決。
- **ユーザーの視点で「これは何に見えるか」を常に考える。** 「接続エラー」バナーはエンジニアには理解できるが、ユーザーには「壊れた」に見える。
