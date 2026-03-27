# Skill Updates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Update bridge skills (slack-channel-create, slack-channel-update) to enforce independent project pattern, standard handler interface, and TodoWrite-driven execution

**Architecture:** Markdown skill file updates in `~/.claude-slack-pipe/skills/`. No code changes.

**Tech Stack:** Markdown

**Branch:** `feat/skill-updates`

**Note:** This branch targets `~/.claude-slack-pipe/skills/` files (user data directory, not the git repo). These changes should be committed in the claude-slack-pipe repo's `templates/skills/` if such a directory exists, or applied directly to the data directory.

---

### Task 1: Update slack-channel-create.md

**Files:**
- Modify: `~/.claude-slack-pipe/skills/slack-channel-create.md`

- [ ] **Step 1: Read current skill**

Read the current content of `~/.claude-slack-pipe/skills/slack-channel-create.md`.

- [ ] **Step 2: Write updated skill**

Replace the entire content with:

```markdown
---
name: Slackチャネル投稿セットアップ
description: 「○○をSlackに投稿したい」要望に対し、独立プロジェクトとしてシステム構築からチャネル作成・定期投稿まで一式セットアップする。
---

## 前提
- Bot Token: claude-slack-pipeの `.env` → `SLACK_BOT_TOKEN`
  (場所不明なら `find ~ -maxdepth 4 -path "*/claude-slack-pipe/.env"` で探す)
- 必要スコープ: `chat:write`, `channels:join`, `channels:manage`, `channels:read`
  （不足時はユーザーにSlack App設定でスコープ追加→再インストールを依頼）
- slack-memory: `~/.claude-slack-pipe/slack-memory.json`

## 必須: TodoWriteで進捗管理

このスキルの全ステップをTodoWriteで管理すること。各ステップを開始前にin_progress、完了後にcompletedに更新する。

## フロー

1. **ヒアリング**: 投稿内容・頻度・既存システムの有無を把握し、推定できるパラメータはまとめて提示して確認を取る（1往復で済ませる）

2. **システム構築**: 独立プロジェクトとして構築する（claude-slack-pipeには組み込まない）。フォルダの場所はslack-memoryの既存エントリやcwdから推定して提案し、ユーザーに確認する。時間がかかる旨を伝え、自律的に進める。**設計書・実装計画・ドキュメントは対象プロジェクト自身のリポジトリに保存する（作業ディレクトリではなく）。superpowersスキルのデフォルト保存先を対象プロジェクトの `docs/` に上書きすること。** AIが絡む場合、実行方法を確認:
   - **claude -p（推奨）**: 追加課金不要。モデル選択: opus/sonnet/haiku。各モデルのコスト・速度・性能のトレードオフをユーザーに説明して選んでもらう。`claude -p 自動化パターン知見` スキルを参照
   - **API**: 任意のLLM APIを使用。APIキーと従量課金が必要
   superpowersで設計・実装

3. **標準ハンドラーインターフェース準拠**: Bridgeからチャネルメッセージを受け取る場合、以下のCLI引数を受け付けるエントリポイントを作成すること:
   ```bash
   tsx {handler} \
     --text "テキスト" \
     --files '/tmp/img1.jpg,/tmp/img2.png' \
     --user-id "U..." \
     --channel-id "C..." \
     --thread-ts "1711..." \
     --timestamp "1711..."
   ```
   - ハンドラー自身がSlack APIで応答を投稿する（Bot Tokenはプロジェクトの.envから取得）
   - Bridgeはメッセージ+ファイルを渡すだけ、応答には関与しない

4. **Slack投稿セットアップ**: Bot Token取得 → チャネル作成 → 投稿スクリプトをシステムディレクトリ内に作成

5. **定期実行**（希望時）: cron/launchdまたは既存ジョブへの組み込みで設定

6. **slack-memory登録**:
   ```json
   {
     "folder": "~/dev/project-name",
     "description": "プロジェクト説明",
     "channel": "#channel-name",
     "channelId": "C...",
     "handler": "src/process-message.ts",
     "createdAt": "YYYY-MM-DD"
   }
   ```
   - `handler` フィールドは必須。Bridgeのチャネルルーターがこのフィールドを使ってメッセージをルーティングする
   - `handler` がないエントリはルーティング対象外（投稿専用プロジェクト）

7. **テスト投稿**: 自分でスクリプトを実行し、結果をユーザーに報告する

8. **Bridge再起動依頼**: チャネルルーティングを有効にするため、ユーザーにBridge再起動を依頼する:
   > コードを変更しました。Slackで `cc /restart-bridge` と送信して再起動してください。
```

- [ ] **Step 3: Verify the skill renders correctly**

Read the file back and verify frontmatter and structure are correct.

- [ ] **Step 4: Commit**

If templates/ directory exists in the repo:
```bash
# Copy to templates for version control
cp ~/.claude-slack-pipe/skills/slack-channel-create.md templates/skills/slack-channel-create.md
git add templates/skills/slack-channel-create.md
git commit -m "docs: update slack-channel-create skill — enforce independent project + handler IF"
```

If no templates/ directory, just record the change:
```bash
git commit --allow-empty -m "docs: updated slack-channel-create.md skill in data directory"
```

---

### Task 2: Update slack-channel-update.md

**Files:**
- Modify: `~/.claude-slack-pipe/skills/slack-channel-update.md`

- [ ] **Step 1: Read current skill**

Read the current content of `~/.claude-slack-pipe/skills/slack-channel-update.md`.

- [ ] **Step 2: Write updated skill**

Replace the entire content with:

```markdown
---
name: Slackチャネル投稿の管理
description: 既存Slack投稿システムの修正・状態確認・削除を行う。
---

## 前提
- slack-memory: `~/.claude-slack-pipe/slack-memory.json`
- 登録がなければ Slackチャネル投稿セットアップ スキルへ誘導

## 必須: TodoWriteで進捗管理

このスキルの全ステップをTodoWriteで管理すること。各ステップを開始前にin_progress、完了後にcompletedに更新する。

## フロー

1. **対象特定**: slack-memoryから該当システムを特定。ユーザーの発話から推定できない場合のみ一覧表示

2. **操作判断**: 修正/状態確認/削除/ハンドラー管理のいずれか

3. **実行**:
   - **修正**: 対象フォルダの内容を把握しsuperpowersで対応。AIが絡む場合は `claude -p 自動化パターン知見` を参照。修正後slack-memoryのdescriptionを必要に応じ更新
   - **状態確認**: チャネル情報・直近投稿・スケジュール設定を収集して報告。slack-memoryの登録内容（folder, handler, channel等）も表示する
   - **削除**: ユーザーに最終確認 → スケジュール停止 → チャネルアーカイブ提案 → slack-memoryから削除
   - **ハンドラー管理**:
     - **ハンドラー追加**: 既存プロジェクトにBridgeチャネルルーター用のハンドラーを追加。標準ハンドラーIF準拠:
       ```bash
       tsx {handler} --text "..." --files '...' --user-id "U..." --channel-id "C..." --thread-ts "..." --timestamp "..."
       ```
       slack-memoryの `handler` フィールドを更新
     - **ハンドラー変更**: handler パスの変更。slack-memory更新後、Bridge再起動を依頼
     - **ハンドラー削除**: slack-memoryから `handler` フィールドを削除（投稿専用に戻す）
```

- [ ] **Step 3: Verify the skill renders correctly**

Read the file back and verify.

- [ ] **Step 4: Commit**

Same pattern as Task 1:
```bash
# If templates/ exists
cp ~/.claude-slack-pipe/skills/slack-channel-update.md templates/skills/slack-channel-update.md
git add templates/skills/slack-channel-update.md
git commit -m "docs: update slack-channel-update skill — add handler management + TodoWrite"
```
