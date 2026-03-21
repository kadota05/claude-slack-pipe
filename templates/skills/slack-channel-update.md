---
name: Slackチャネル投稿の管理
description: 既存Slack投稿システムの修正・状態確認・削除を行う。
---

## 前提
- slack-memory: `~/.claude-slack-pipe/slack-memory.json`
- 登録がなければ Slackチャネル投稿セットアップ スキルへ誘導

## フロー

1. **対象特定**: slack-memoryから該当システムを特定。ユーザーの発話から推定できない場合のみ一覧表示
2. **操作判断**: 修正/状態確認/削除のいずれか
3. **実行**:
   - **修正**: 対象フォルダの内容を把握しsuperpowersで対応。AIが絡む場合は `claude -p 自動化パターン知見` を参照。修正後slack-memoryのdescriptionを必要に応じ更新
   - **状態確認**: チャネル情報・直近投稿・スケジュール設定を収集して報告
   - **削除**: ユーザーに最終確認 → スケジュール停止 → チャネルアーカイブ提案 → slack-memoryから削除
