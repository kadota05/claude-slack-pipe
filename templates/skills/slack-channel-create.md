---
name: Slackチャネル投稿セットアップ
description: 「○○をSlackに投稿したい」という要望に対し、コンテンツ生成システムの有無を判断し、無ければsuperpowersで構築、チャネル作成・投稿スクリプト・定期実行までを一式セットアップするオーケストレータースキル。
---

# Slackチャネル投稿セットアップ

## 前提

- Slack App (Claude Code Bridge) のBot Tokenを使用する
- Bot Tokenの場所: claude-slack-pipeプロジェクト内の `.env` → `SLACK_BOT_TOKEN`
- claude-slack-pipeの場所が不明な場合: `package.json` に `"name": "claude-slack-pipe"` を含むディレクトリをファイル検索して自動発見する
- slack-memory: `~/.claude-slack-pipe/slack-memory.json` に登録済みシステム一覧がある（なければ新規作成）
- ユーザーのSlack User ID: slack-memoryまたは `.env` の `ALLOWED_USER_IDS` から取得

## 全体フロー

### Step 1: 要望のヒアリング

ユーザーに「何をSlackに投稿したいか」を確認する。

### Step 2: 投稿したいものを生成するシステムがあるか判断

ユーザーに確認する:
- **ある** → Step 4へ
- **ない** → Step 3へ

### Step 3: システムをゼロから構築

#### 3-1: フォルダ選択（必須）

**必ずユーザーに聞くこと。** 以下の選択肢を提示する:

1. **推奨**: claude-slack-pipeのBridgeディレクトリ選択欄に出る場所と同階層にプロジェクトフォルダを作成（例: `~/dev/新プロジェクト名/`）
   - 推奨場所の特定方法: claude-slack-pipeの `.env` や設定から作業ディレクトリの親を推定する。または既存のslack-memory登録済みフォルダの親ディレクトリを参考にする
2. **カレントディレクトリ直下**: 現在の作業ディレクトリの下にフォルダを作成
3. **任意入力**: ユーザーが指定するパス

#### 3-2: superpowersでシステム構築

**AIが絡むシステムの場合:**
構築の前に `~/.claude-slack-pipe/skills/claude-p-automation-patterns.md` を読み込み、原本ファイルをReadツールで参照する。この知見をbrainstormingの設計判断に活かす。

**構築の進め方:**
- 新規作成/新機能追加:
  1. `superpowers:brainstorming` で要件・設計を探索
  2. `superpowers:writing-plans` で実装計画を作成
  3. `superpowers:executing-plans` または `superpowers:subagent-driven-development` で実装
- バグや修正が発生した場合:
  - `superpowers:systematic-debugging` で対応

構築完了後、Step 4へ進む。

### Step 4: 出力ファイル/形式の特定

システムの出力を確認する:
- 出力ファイルのパス
- 出力形式（Markdown, JSON, プレーンテキスト等）
- 出力タイミング（いつ生成されるか）

### Step 5: Slack投稿セットアップ

#### 5-1: Bot Tokenの取得

claude-slack-pipeプロジェクトを検索して `.env` から `SLACK_BOT_TOKEN` を取得する。

検索方法:
```bash
find ~/dev -maxdepth 3 -name "package.json" -exec grep -l "claude-slack-pipe" {} \; 2>/dev/null
```

#### 5-2: チャネルの作成 or 既存取得

1. `conversations.list` で既存チャネルを確認
2. 適切なチャネルがなければ `conversations.create` で新規作成
   - チャネル名はプロジェクト名ベースで提案する（例: `#ai-news-digest`）
3. `conversations.join` でBotをチャネルに参加させる
4. ユーザーのSlack User IDを特定し、`conversations.invite` でユーザーを招待する

#### 5-3: 投稿スクリプトの作成

システムのディレクトリ内に投稿スクリプトを作成する。

スクリプトに含めるべき処理:
- Bot Tokenの読み込み（claude-slack-pipeの `.env` から）
- 出力ファイルの読み込みとSlack mrkdwn形式への変換
- `chat.postMessage` APIでの投稿
- エラーハンドリング（ファイル未生成、API失敗等）

### Step 6: 定期実行の設定

ユーザーに定期実行の方法を確認する:

1. **既存ジョブの後に実行**: システムの実行スクリプト末尾に投稿スクリプトの呼び出しを追加
2. **独立スケジュール**: cron/launchd で定期実行を設定
3. **手動のみ**: スクリプトを手動で実行する運用

### Step 7: slack-memoryに登録

`~/.claude-slack-pipe/slack-memory.json` に以下を追記する:

```json
{
  "folder": "/path/to/system",
  "description": "システムの概要説明",
  "channel": "#channel-name",
  "channelId": "C0XXXXXXXX",
  "createdAt": "YYYY-MM-DD"
}
```

ファイルが存在しない場合は配列 `[]` で新規作成してから追記する。

### Step 8: テスト投稿

実際に投稿を実行し、チャネルで表示を確認するようユーザーに依頼する。
