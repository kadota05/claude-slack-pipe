---
name: Slackチャネル投稿セットアップ
description: 「○○をSlackに投稿したい」要望に対し、システム構築からチャネル作成・定期投稿まで一式セットアップする。
---

## 前提
- Bot Token: claude-slack-pipeの `.env` → `SLACK_BOT_TOKEN`
  (場所不明なら `find ~ -maxdepth 4 -path "*/claude-slack-pipe/.env"` で探す)
- 必要スコープ: `chat:write`, `channels:join`, `channels:manage`, `channels:read`
  （不足時はユーザーにSlack App設定でスコープ追加→再インストールを依頼）
- slack-memory: `~/.claude-slack-pipe/slack-memory.json`

## フロー

1. **ヒアリング**: 投稿内容・頻度・既存システムの有無を把握し、推定できるパラメータはまとめて提示して確認を取る（1往復で済ませる）
2. **システム構築**（無い場合）: 独立プロジェクトとして構築する（claude-slack-pipeには組み込まない）。フォルダの場所はslack-memoryの既存エントリやcwdから推定して提案し、ユーザーに確認する。時間がかかる旨を伝え、自律的に進める。AIが絡む場合、実行方法を確認:
   - **claude -p（推奨）**: 追加課金不要。モデル選択: opus/sonnet/haiku。各モデルのコスト・速度・性能のトレードオフをユーザーに説明して選んでもらう。`claude -p 自動化パターン知見` スキルを参照
   - **API**: 任意のLLM APIを使用。APIキーと従量課金が必要
   superpowersで設計・実装
3. **Slack投稿セットアップ**: Bot Token取得 → チャネル作成 → 投稿スクリプトをシステムディレクトリ内に作成
4. **定期実行**（希望時）: cron/launchdまたは既存ジョブへの組み込みで設定
5. **slack-memory登録**:
   ```json
   {"folder":"...","description":"...","channel":"#...","channelId":"C...","createdAt":"YYYY-MM-DD"}
   ```
6. **テスト投稿**: 実行して結果を報告
