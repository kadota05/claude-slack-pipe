# チャンネルからのbundleボタンが反応しないバグ

## 症状

チャンネルメッセージのbundleボタン（詳細表示）をクリックしても反応しない。DMからは正常に動作する。ログに `No bundle entries for <sessionId>:<toolUseId>` と表示される。

## 根本原因

`SessionJsonlReader.toProjectDirName()` がClaude CLIの内部パス正規化と一致していなかった。

- **コードの実装**: `projectPath.replace(/\//g, '-')` — スラッシュをダッシュに置換するだけ
- **CLIの実際の動作**: ドット(`.`)をダッシュに置換してから、スラッシュをダッシュに置換

チャンネルプロジェクトのパスが `~/.claude-slack-pipe/channels/C0AQ9JQAMKJ` のように `.` を含むため、DMのパス（`~/dev/claude-slack-pipe` — ドットなし）では問題が顕在化しなかった。

## 証拠

```
# コードが生成するディレクトリ名:
-Users-archeco055-.claude-slack-pipe-channels-C0AQ9JQAMKJ

# CLIが実際に作成するディレクトリ名:
-Users-archeco055--claude-slack-pipe-channels-C0AQ9JQAMKJ

# ls ~/.claude/projects/ で確認
```

JONLファイルはCLI側のディレクトリに正常に存在していたが、コード側が間違ったディレクトリ名で探していたため見つからなかった。

## 修正内容

`SessionJsonlReader.toProjectDirName()` を修正:

```typescript
// Before
return projectPath.replace(/\//g, '-');

// After (Claude CLI normalizes: dots → dashes, then slashes → dashes)
return projectPath.replace(/\./g, '-').replace(/\//g, '-');
```

## 教訓

- Claude CLIの内部パス正規化は単純なスラッシュ置換ではない。ドットも置換される
- DMのパスにドットが含まれないケースではバグが顕在化しないため、ドットを含むパスでのテストが必要
- 外部ツールのファイルシステム規約に依存するコードは、実際のディレクトリ構造と照合して検証すべき
