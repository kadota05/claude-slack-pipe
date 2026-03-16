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
