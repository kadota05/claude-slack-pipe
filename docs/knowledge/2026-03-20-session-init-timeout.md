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

## 未修正の関連リスク（今後の対応候補）

### permission-prompt.ts がデッドコード
`buildPermissionPromptBlocks()` と `parsePermissionAction()` は定義済みだが、**一度も呼ばれていない**。`index.ts` に `permission_approve`/`permission_deny` の action ハンドラはあるが、CLIからの `control_request` イベントを受けてUIを表示するコードが存在しない。`--permission-mode bypassPermissions` を指定したので当面は発火しないが、将来 permission mode を変更する場合はこのギャップを埋める必要がある。

### EventEmitter リスナー蓄積の可能性
修正前の `waitForIdle` は `session.on('stateChange', ...)` でリスナーを追加していたが、timeout/reject 時に `removeListener` していなかった。修正後は `removeListener` を入れたが、他の箇所で同じパターンがないか横断的に確認すべき。

### stdin バックプレッシャー未チェック
`persistent-session.ts:206` の `writeStdin` は `process.stdin.write()` の戻り値（false = buffer full）をチェックしていない。巨大なプロンプトや高速連続書き込み時にデータが届かない可能性がある。

### macOS スリープによるタイマー即発火
`setTimeout` は壁時計ベース。Mac がスリープすると全プロセスが一時停止するが、復帰時にタイマーが残り時間なしで即発火する。`caffeinate` によるスリープ防止は検討段階（`docs/knowledge/2026-03-19-sleep-policy-and-setup-config.md`）で未実装。

### resume 時の履歴リプレイ遅延
`--replay-user-messages` が常に有効。長い会話の resume（`-r`）では履歴リプレイで CLI 起動が遅くなる可能性がある。現在の 30秒タイムアウトなら問題にならないはずだが、非常に長い会話では注意。

## 教訓

- Phase 1 と Phase 2 で CLI 起動引数が異なる場合、差分を意識的にレビューする。片方にだけ設定があるのは実装漏れの可能性が高い。
- 「初期化待ち」と「処理完了待ち」は明確に分離する。1つの関数に両方の責務を持たせると、タイムアウトの意味が曖昧になる。
- タイムアウト後のリソースクリーンアップ（プロセスkill、リスナー除去）を忘れない。
- systematic-debugging スキルの Phase 1（根本原因調査）で複数サブエージェントを並行投入するアプローチが有効だった。permission-mode 未指定という構造的バグは、コード全体を横断的に調べなければ発見できなかった。
- 「長い処理の時に起こる」というユーザー報告は、複数原因の複合を示唆する。1つの原因に飛びつかず、全候補を列挙してから絞り込むべき。
