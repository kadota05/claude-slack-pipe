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

```bash
# 1. 既存プロセスを停止
kill $(cat ~/.claude-slack-pipe/claude-slack-pipe.pid) 2>/dev/null
# 2. 少し待ってから再起動
sleep 2 && npx tsx src/index.ts
```

- **必ず `run_in_background: true` で起動すること。** Bashツールのtimeoutは最大10分のため、フォアグラウンドで起動するとプロセスが強制killされる。
- 起動後、ログに `Claude Code Slack Bridge is running` が出ることを確認する
- **起動直後に `ENOENT` エラーで落ちた場合**: Claude CLIのバージョン不一致が原因の可能性が高い。`.claude/skills/fix-claude-cli-version.md` をReadツールで読み取り、その指示に従って対処すること

## セットアップ

ユーザーが「セットアップして」「setup」「セットアップ」等のセットアップ要求をした場合、`.claude/skills/setup.md` をReadツールで読み取り、その指示に従うこと。
