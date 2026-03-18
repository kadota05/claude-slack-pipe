---
name: fix-claude-cli-version
description: Bridgeプロセスが ENOENT で落ちたときの Claude CLI バージョン不一致の修正手順
---

# Claude CLI バージョン不一致の修正

Bridgeプロセスが以下のようなエラーで落ちた場合に使う:

```
Error: spawn /Users/.../claude-code/<old-version>/claude ENOENT
```

## 原因

`.env` の `CLAUDE_EXECUTABLE` にバージョン番号入りのフルパスがハードコードされており、
Claude Code がアップデートされると古いパスが存在しなくなる。

## 修正手順

### 1. 現在のCLIバージョンを確認

```bash
which claude && claude --version
```

### 2. `.env` の `CLAUDE_EXECUTABLE` を修正

バージョン依存のフルパスではなく、PATHから解決させる:

```
CLAUDE_EXECUTABLE=claude
```

> **注意**: フルパス（`/Users/.../claude-code/X.Y.Z/claude`）は絶対に設定しないこと。
> Claude Code はアップデートのたびにバージョン付きディレクトリが変わるため、必ず壊れる。

### 3. Bridgeプロセスを再起動

```bash
kill $(cat ~/.claude-slack-pipe/claude-slack-pipe.pid) 2>/dev/null
sleep 2 && npx tsx src/index.ts
```

`run_in_background: true` で起動し、ログに `Claude Code Slack Bridge is running` が出ることを確認する。
