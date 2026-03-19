# Claude Code プロジェクト規約

## 言語
- コード内のコメント・ログは英語
- ドキュメント・知見ファイルは日本語

## バグ修正時の知見記録（必須）

バグを修正したら、必ず `docs/knowledge/` に知見ファイルを作成する。これは省略不可。

### ファイル名
`YYYY-MM-DD-<slug>.md`（例: `2026-03-16-duplicate-session-bug.md`）

### 必須セクション
1. **症状** — 何が起きたか（ユーザー視点）
2. **根本原因** — なぜ起きたか（技術的な原因）
3. **証拠** — どうやって特定したか（ログ、データ、コマンド出力など）
4. **修正内容** — 何をどう変えたか
5. **教訓** — 今後同じ種類のバグを防ぐために知っておくべきこと

### 目的
- 同じミスを二度と起こさない
- 調査手法を蓄積して将来のデバッグを高速化する
- プロジェクト固有の落とし穴を文書化する

## プロジェクト構成

- `src/` — TypeScriptソースコード
- `docs/knowledge/` — バグ修正・調査の知見
- `docs/superpowers/` — 設計ドキュメント
- データディレクトリ: `~/.claude-slack-pipe/`

## 技術スタック
- TypeScript + tsx
- Slack Bolt (Socket Mode)
- Claude CLI (`claude -p --input-format stream-json --output-format stream-json`)

## Bridgeプロセスの再起動（必須）

`src/` 配下のコードを変更したら、必ずBridgeプロセスを再起動すること。

### launchd管理下の場合（推奨）

Slackで以下を送信するだけで再起動される（admin権限が必要）：

```
cc /restart-bridge
```

またはターミナルから：
```bash
launchctl kickstart -k gui/$(id -u)/com.user.claude-slack-pipe
```

### 手動起動の場合（launchd未設定時）

```bash
# 実行中のBridgeを終了
pkill -f 'tsx src/index.ts'
# 少し待ってから再起動
sleep 2 && caffeinate -i npx tsx src/index.ts
```

- **必ず `run_in_background: true` で起動すること。** Bashツールのtimeoutは最大10分のため、フォアグラウンドで起動するとプロセスが強制killされる。

**重要:** Bashで `kill` コマンドを使ってBridgeプロセスを直接killしないこと。Bridge自身が処理中のSlack応答が途切れる原因になる。必ず `cc /restart-bridge` か `launchctl kickstart` を使うこと。

- `caffeinate -i` によりアイドルスリープを防止する（AC電源・バッテリー両方で有効。リッドクローズ時のスリープは防げないため、別途 `sudo pmset -a disablesleep 1` が必要）
- 起動後、ログに `Claude Code Slack Bridge is running` が出ることを確認する
- **起動直後に `ENOENT` エラーで落ちた場合**: Claude CLIのバージョン不一致が原因の可能性が高い。`.claude/skills/fix-claude-cli-version.md` をReadツールで読み取り、その指示に従って対処すること

## セットアップ

ユーザーが「セットアップして」「setup」「セットアップ」等のセットアップ要求をした場合、`.claude/skills/setup.md` をReadツールで読み取り、その指示に従うこと。
