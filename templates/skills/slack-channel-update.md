---
name: Slackチャネル投稿の管理
description: 既存のSlackチャネル投稿の修正・改善・削除・状態確認を行う。slack-memoryから対象システムを選択し、適切なsuperpowersスキルで対応する。
---

# Slackチャネル投稿の管理

## 前提

- slack-memory: `~/.claude-slack-pipe/slack-memory.json` に登録済みシステム一覧がある
- このスキルは既にslack-channel-createで作られたシステムに対して使う

## 全体フロー

### Step 1: 対象システムの選択

`~/.claude-slack-pipe/slack-memory.json` を読み込み、登録済みシステムの一覧を表示する。

表示例:
```
1. AI News Digest → #ai-news-digest
   /Users/.../news-digest
2. System Monitor → #ops-alerts
   /Users/.../system-monitor
```

ユーザーに対象を選んでもらう。

### Step 2: 何をしたいか確認

ユーザーに以下の選択肢を提示する:

1. **修正/改善** — バグ修正、機能追加、フォーマット変更など
2. **状態確認** — 最終投稿日時、スケジュール、チャネル情報の確認
3. **削除** — 投稿の停止とクリーンアップ

### Step 3: 各操作の実行

#### 修正/改善の場合

対象システムのフォルダに移動（`cd` 相当の作業ディレクトリ切替）し、内容を把握した上で:

- **バグ修正**: `superpowers:systematic-debugging` で対応
- **機能追加/変更**:
  1. `superpowers:brainstorming` で要件探索
  2. `superpowers:writing-plans` で計画作成
  3. `superpowers:executing-plans` または `superpowers:subagent-driven-development` で実装

AIが絡む変更の場合は `~/.claude-slack-pipe/skills/claude-p-automation-patterns.md` を参照する。

修正後、必要に応じてslack-memoryの `description` を更新する。

#### 状態確認の場合

以下の情報を収集して表示する:

1. **slack-memoryの登録情報**: folder, description, channel
2. **チャネル状態**: `conversations.info` APIでチャネルの存在・アーカイブ状態を確認
3. **最終投稿**: `conversations.history` APIで直近の投稿を取得し、日時と内容のプレビューを表示
4. **スケジュール状態**: cron/launchd の設定を確認（該当があれば）

#### 削除の場合

1. **ユーザーに最終確認する**（必ず確認を取ること）
2. 定期実行が設定されている場合:
   - cron/launchd のスケジュールを停止
   - 既存ジョブへの組み込みがあれば該当行を削除
3. チャネルのアーカイブを提案（`conversations.archive`）
   - ユーザーが望まない場合はスキップ
4. `slack-memory.json` から該当エントリを削除
5. 投稿スクリプト自体の削除はユーザーに確認してから行う（システム本体は残す）
