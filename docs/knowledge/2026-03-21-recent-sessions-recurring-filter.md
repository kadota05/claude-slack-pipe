# Recent Sessions: 繰り返しセッション除外とSlack Bridge Context除去

## 症状

ホームタブのRecent Sessionsに、cron定期実行のnewsdigestセッションが毎回表示される。また、Slack Bridge経由のセッションは先頭に`[Slack Bridge Context]`の長いシステムプロンプトが付くため、プレビューで本文が見えない。

## 根本原因

### 繰り返し除外の失敗
`filterRecurring`が`firstPrompt`の**完全一致**で重複判定していた。newsdigestのプロンプトは先頭（テンプレート部分）は同じだが、後半に日付・ファイルパス等の可変部分があるため完全一致せず、除外されなかった。

### Bridge Contextによるプレビュー汚染
`readFirstUserMessage`で取得したテキストをそのままプレビュー生成に使っていたため、`[Slack Bridge Context]...`（約300文字）が先頭を占有し、PREVIEW_LENGTH=50では本文に到達しなかった。

## 証拠

newsdigestセッション（9件）の最初のユーザーメッセージを抽出:
- Stage 1: `# AI News Digest - 記事処理プロンプト (Stage 1)\n\nあなたは...`
- Stage 2: `# AI News Digest - デイリーサマリー生成プロンプト (Stage 2)\n\nあなたは...`

先頭50文字は全セッションで同一だが、後半の日付・パスが異なるため完全一致しなかった。

## 修正内容

`src/store/recent-session-scanner.ts` を変更:

1. **`stripSlackContext()`を追加**: `[Slack Bridge Context]`で始まるテキストから`SLACK_CONTEXT_PREFIX`を除去。`stripCommandTags`の前に適用。
2. **`filterRecurring`をプレフィックス一致に変更**: `firstPrompt`の先頭50文字(`RECURRING_PREFIX_LENGTH`)でグルーピングし、2回以上出現するものを除外。

処理順序: stripSlackContext → stripCommandTags → プレビュー生成 → filterRecurring（先頭50文字）

## 教訓

- **テンプレートプロンプトの重複判定は完全一致では不十分**。cron/自動実行系は同じテンプレートに可変パラメータを埋め込むため、先頭N文字のプレフィックス一致が有効。
- **プレビュー生成の前にシステムプロンプト的なプレフィックスを除去する**。ユーザーが書いた本文を表示するのが目的なので、機械的に付与されるコンテキストは除去すべき。
- newsdigestはSlack Bridge経由ではなく、cron + スクリプトで直接Claude CLIを起動している。`~/.claude/projects/-Users-archeco055-dev-Cowork-news-digest/`にセッションが溜まる。
