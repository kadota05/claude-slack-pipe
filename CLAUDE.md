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

**⚠️ 絶対禁止: Claude CLI（あなた自身）からBridgeを再起動してはならない。** Bashツールで `kill`, `pkill`, `launchctl kickstart` 等を実行すると、自分自身（Bridge）を殺すことになり、Slack応答が途切れてフリーズする。再起動はユーザーに依頼すること。

ユーザーへの再起動依頼メッセージ:
> コードを変更しました。Slackで `cc /restart-bridge` と送信して再起動してください。

- 起動後、ログに `Claude Code Slack Bridge is running` が出ることを確認する
- **起動直後に `ENOENT` エラーで落ちた場合**: Claude CLIのバージョン不一致が原因の可能性が高い。`.claude/skills/fix-claude-cli-version.md` をReadツールで読み取り、その指示に従って対処すること

## セットアップ

ユーザーが「セットアップして」「setup」「セットアップ」等のセットアップ要求をした場合、`.claude/skills/setup.md` をReadツールで読み取り、その指示に従うこと。
