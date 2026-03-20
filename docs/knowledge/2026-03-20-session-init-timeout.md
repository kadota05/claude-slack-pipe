# Session init timeout の2つの原因と修正

## 症状

Slackで「Failed to start session: Session init timeout」が表示される。特に長い処理を依頼した時に発生しやすい。途中まで結果が見えているのに突然エラーになるケースもある。

## 根本原因

### 原因1: persistent-session に --permission-mode が未指定

`executor.ts`（Phase 1）には `--permission-mode bypassPermissions` があるが、`persistent-session.ts`（Phase 2）には指定がなかった。CLIのデフォルトは `default` モード（ツール実行前に承認を求める）。

CLIが承認待ちで stdin を読み続ける → Bridgeにはハンドラがない → session が `processing` のままハング → 5分後にタイムアウト。

長い処理ほどツール呼び出しが多く、permission prompt に当たる確率が高い。

### 原因2: waitForIdle が初回処理の完了まで待っていた

`waitForIdle` は session が `idle` になるまで5分タイマーで待つ設計だった。しかし新規セッションでは `starting → processing → (処理完了) → idle` という遷移をするため、初回タスクの全処理完了まで待つことになっていた。

長いタスク（サブエージェント起動、大量ファイル検索等）は5分を超えうるため、正当な処理でもタイムアウトが発生。

さらに、timeout 後に session.end() を呼んでいなかったため、CLIプロセスが放置される問題もあった。

## 証拠

- `src/bridge/persistent-session.ts` の `buildArgs()` に `--permission-mode` がなかった
- `src/bridge/executor.ts:36` には `--permission-mode bypassPermissions` がある
- `src/index.ts:36` の `waitForIdle` が `to === 'idle'` だけを resolve 条件にしていた
- `README.md` には「Permission modeは最強設定」と記載があるが Phase 2 には未適用だった

## 修正内容

1. **`persistent-session.ts` の `buildArgs()`** に `'--permission-mode', 'bypassPermissions'` を追加
2. **`waitForIdle` → `waitForInit` にリネーム・改修**:
   - `idle` ではなく `processing` または `idle` への遷移で resolve（CLI起動確認だけが責務）
   - タイムアウトを 300秒 → 30秒に短縮（CLI起動に30秒以上は異常）
   - timeout/resolve 後にリスナーを removeListener で除去（リスナーリーク防止）
3. **timeout 時の catch 内に `session.end()` を追加**（CLIプロセスの放置を防止）

## 教訓

- Phase 1 と Phase 2 で CLI 起動引数が異なる場合、差分を意識的にレビューする。片方にだけ設定があるのは実装漏れの可能性が高い。
- 「初期化待ち」と「処理完了待ち」は明確に分離する。1つの関数に両方の責務を持たせると、タイムアウトの意味が曖昧になる。
- タイムアウト後のリソースクリーンアップ（プロセスkill、リスナー除去）を忘れない。
