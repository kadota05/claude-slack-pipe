# スレッド返信で新セッションが立つバグ

## 日付
2026-03-16

## 症状
Slack DMのスレッド内で「返信を追加する」から返信すると、既存セッションを再利用せずに新しいセッションが立ち上がる。

## 調査結果

### 根本原因: 2つのボットプロセスが同時稼働していた

```
PID 60454/60455 - 20:12起動 (tsx src/index.ts)
PID 51691/51692 - 23:41起動 (tsx watch src/index.ts)
```

同じSlackアプリに対して2プロセスがSocket Modeでイベントをリッスンしていた。

### 発生メカニズム

1. ユーザーがDMを送信
2. **両方のインスタンス**がSlackイベントを受信・処理
3. インスタンスA: セッション `63f5a673`（haiku）を作成
4. インスタンスB: セッション `95cdd627`（sonnet）を作成
5. 両方が `session-index.json` に書き込み → **後勝ちで片方のエントリが消失**
6. ユーザーがスレッド内で返信 → 片方のインスタンスで `findByThreadTs()` が失敗 → 新セッション作成

### 証拠

- `session-index.json` に `63f5a673`（haiku）が存在しない（上書きされた）
- `95cdd627`（sonnet）は存在する
- 返信 "1" が `a163ae4e` という全く新しいセッションIDで登録されている
- threadTs値が異なる: 元スレッド `1773671817.751099` vs 返信 `1773672115.091299`

## 修正内容

### PIDファイルによるシングルインスタンスロック

**新規ファイル**: `src/utils/pid-lock.ts`

- 起動時に `~/.claude-slack-pipe/claude-slack-pipe.pid` にPIDを書き込み
- 既存PIDファイルがある場合、`process.kill(pid, 0)` でプロセス生存を確認
  - 生存中 → エラーメッセージを出して起動拒否
  - 死んでいる → staleファイルとして削除し、新規ロック取得
- graceful shutdown時に `pidLock.release()` でPIDファイルを削除

**変更ファイル**: `src/index.ts`

- `main()` 冒頭で `acquirePidLock(config.dataDir)` を呼び出し
- shutdown ハンドラに `pidLock.release()` を追加

## 教訓

1. **Socket Modeは複数接続を許す** — Slack Socket Modeは同じApp Tokenで複数プロセスが接続可能。Slack側で重複排除されない。
2. **共有ファイルへの書き込み競合** — 複数プロセスが同じ `session-index.json` を読み書きすると、後勝ちでデータが消失する。
3. **`tsx watch` と `tsx` の混在に注意** — 開発中に `tsx watch` で自動再起動しつつ、別ターミナルで `tsx` を直接実行するとインスタンスが重複する。
4. **再現困難なバグの調査法** — session-index.jsonの実データ（threadTs、セッションID）と `ps aux` のプロセス一覧を突き合わせることで原因特定できた。
