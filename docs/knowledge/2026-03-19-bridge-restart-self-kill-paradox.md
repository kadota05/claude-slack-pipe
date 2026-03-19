# Bridge再起動時の自殺パラドックスとlaunchdデーモン化

## 症状

Slackから「bridgeを再起動して」と送ると、以下のいずれかで固まる：
- `:brain:` リアクションのまま無反応になる
- 「Bashを使っている」という応答を最後に応答中のまま固まる
- 数分後に話しかけると反応する（バックグラウンドでは再起動が完了していた）

## 根本原因

**自分自身を殺すパラドックス** — BridgeがClaude CLIに「再起動して」と伝え、Claude CLIがCLAUDE.mdの手順に従って `kill $(cat ...pid)` を実行する。これはBridge自身のPIDであり、Bridge自身が自分を殺す指示を自分経由で実行している。

### データフロー詳細

```
1. ユーザー → Slack DM: 「bridgeを再起動して」
2. Bridge (PID=X) → Claude CLIセッションにプロンプト送信 → :brain: 追加
3. Claude CLI → CLAUDE.mdを読む → `kill $(cat ...pid)` を実行
4. ★ Bridge (PID=X) が死亡
   - Slack Bolt WebSocket切断
   - :brain: → :white_check_mark: の置換: 不可
   - ストリーミング更新: 不可
   - エラーメッセージ投稿: 不可
5. Claude CLI はorphanプロセスとして続行
   → sleep 2 && caffeinate -i npx tsx src/index.ts
   → 新Bridge (PID=Y) が起動
6. 新Bridge: in-memoryステート (wiredSessions, activeMessageTs等) はリセット済み
   → 古いスレッドの :brain: を除去する術なし
```

### 「Bashを使っている」で止まるパターン

StreamProcessorがClaude CLIの `tool_use` イベントを受信して「Bashツール使用中」をSlackに投稿した**直後**に `kill` が実行される。タイミング次第で：
- ツール表示前に死ぬ → `:brain:` のまま
- ツール表示後に死ぬ → 「Bash使用中」で止まる

### 「数分後に反応する」理由

SessionIndexStoreはディスク永続化されているため、新Bridgeが起動後：
- 新メッセージ受信 → `sessionIndexStore.findByThreadTs` → 古いエントリ発見
- `coordinator.getOrCreateSession({ isResume: true })` → `-r` でCLIセッション再開
- 正常に応答再開

ただし数分かかるのはClaude CLIの `sleep 2 && caffeinate -i npx tsx ...` の実行待ちのため。

## 検討したアプローチ

### 案A: Bridge側で自然言語インターセプト

「再起動」系メッセージをBridge側で検出し、Claude CLIに渡さない。
- **却下理由**: 自然言語マッチングの精度問題（「再起動」「restart」「リスタート」等の多パターン）

### 案B: Claude CLIに `/restart-bridge` テキストを出力させ、Bridgeが検出

Claude CLIが `kill` の代わりに `/restart-bridge` と応答し、Bridgeが検出して自己再起動。
- **却下理由**: Claude CLIが単に説明文中で `/restart-bridge` と言及しただけで誤発火するリスク

### 案C: ゼロダウンタイムリスタート（プロセス入れ替え）

新プロセスを起動 → ソケット移譲 → 旧プロセス終了。NginxやUnicornのパターン。
- **却下理由**: Slack Socket Modeではソケット移譲が不可能。インメモリ状態（wiredSessions等）の引き継ぎも複雑

### 案D: launchdデーモン化 + `/restart-bridge` botコマンド ← **採用**

## 修正内容

### 1. launchdデーモン化

- `launchd/com.user.claude-slack-pipe.plist.template` を作成
- `KeepAlive: true` でプロセス終了時に自動再起動（1秒以内）
- `RunAtLoad: true` でログイン時に自動起動
- `caffeinate -i` をProgramArguments経由で引き継ぎ（スリープ防止）
- `StandardOutPath` / `StandardErrorPath` でログ出力
- `ThrottleInterval: 5` で最低5秒間隔の再起動（クラッシュループ防止）

### 2. `/restart-bridge` botコマンド

- `command-parser.ts`: `BOT_COMMANDS` に `restart-bridge` 追加
- `index.ts`: admin権限チェック → Slackに「🔄 再起動します」投稿 → graceful shutdown → `process.exit(0)` → launchdが自動再起動
- Slackでは `/` スラッシュコマンドが送信できないため、`cc /restart-bridge` プレフィックスで送信

### 3. 再起動完了通知

- shutdown前に再起動メッセージの `channel` と `ts` を `~/.claude-slack-pipe/restart-pending.json` に保存
- 新Bridge起動時にこのファイルを読み取り、`chat.update` で「✅ Bridgeの再起動が完了しました」に更新
- ユーザーに再起動完了のタイミングが明確に伝わる

### 4. PIDファイル廃止

- Claude CLIが `kill $(cat ...pid)` で自殺する経路を物理的に断つ
- launchdがシングルトン管理するのでPIDロック不要
- CLAUDE.mdから `kill` 手順を削除

### 5. クラッシュループブレーカー

- `crash-history.json` に直近の起動時刻を記録
- 5分以内に3回以上クラッシュした場合、`process.exit(0)` で停止（launchdに再起動させない）
- `/restart-bridge` による意図的な再起動時はクラッシュ履歴をクリア

### 6. fnmパス問題

- `which node` が fnm の一時的なシェルセッションパス（`fnm_multishells/XXXXX/bin/node`）を返す
- PC再起動後にこのパスは無効になる
- `realpath $(which node)` で永続的な実体パスを解決する必要がある

## 教訓

1. **プロセスが自分自身を殺す構造は必ず問題を起こす** — 特にSlackのようなステートフルな接続を持つプロセスでは、終了前にクリーンアップ（リアクション除去、メッセージ投稿等）が必要。外部のプロセスマネージャ（launchd）に管理を委譲し、プロセス自身は `process.exit(0)` するだけにすべき

2. **Claude CLIにBashで `kill` させるのは危険** — LLMの判断に依存する形でプロセスのライフサイクルを管理してはならない。botコマンドで明示的に制御する

3. **fnm/nvm等のバージョンマネージャは一時パスを生成する** — launchdやsystemdのようにシェルセッション外で起動するプロセスでは、`which` ではなく `realpath` で実体パスを解決する

4. **ゼロダウンタイムは常に最善策ではない** — 複雑さとのトレードオフ。launchdの `KeepAlive` + `ThrottleInterval: 5` で実質5秒のダウンタイムで済むなら、ソケット移譲の複雑さは不要

5. **再起動コマンドの誤発火防止** — 自然言語マッチングやテキスト検出ではなく、完全一致のbotコマンド（`cc /restart-bridge`）が最も安全
