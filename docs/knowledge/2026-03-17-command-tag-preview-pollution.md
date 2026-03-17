# Recent SessionsプレビューがXMLタグで埋まる問題

## 症状

ホームタブのRecent Sessionsで、スラッシュコマンド（Superpowersスキル等）を使ったセッションのプレビューが `<command-message>superpowers:systematic-d...` のようにXMLタグで埋まり、実際のプロンプト内容が全く見えない。特にモバイルでは表示領域が狭いため深刻。

## 根本原因

Claude CLIはスラッシュコマンド使用時、ユーザーメッセージをXMLタグで包んでJSONLに記録する：

```
<command-message>superpowers:systematic-debugging</command-message>
<command-name>/superpowers:systematic-debugging</command-name>
<command-args>実際のプロンプト内容</command-args>
```

`RecentSessionScanner.readFirstUserMessage()` はこのテキストをそのまま返し、50文字で切り詰めてプレビューにしていた。XMLタグだけで50文字を超えるため、本文が一切表示されなかった。

## 証拠

実際のJSONLファイルの先頭ユーザーメッセージを確認：
```bash
head -3 ~/.claude/projects/-Users-archeco055-dev-claude-slack-pipe/<session>.jsonl | python3 -c "..."
```
→ `<command-message>superpowers:systematic-debugging</command-message>...` が返される。

## 修正内容

`src/store/recent-session-scanner.ts` に `stripCommandTags()` 関数を追加：

1. `<command-args>` から実際のプロンプト本文を抽出
2. `<command-name>` からコマンド名を抽出し、namespace（`superpowers:`等）を除去
3. プレビューを `[skill-name] 本文...` 形式で生成
4. `firstPrompt`（filterRecurring用）にもタグ除去済みテキストを使用

Before: `/superpowers:systematic-debugging: 新規スレッド...`（prefix 37文字、本文13文字）
After: `[systematic-debugging] 新規スレッドを立ち上げて最初に...`（prefix 23文字、本文27文字）

## 教訓

- Claude CLIがJSONLに書き込む生データには、UIフレームワーク由来のメタデータ（XMLタグ等）が混入する場合がある
- ユーザー入力を表示用に加工する際は、こうしたメタデータのサニタイズを考慮すべき
- モバイル表示は文字数制約が厳しいため、プレフィックスの長さに注意する
