# Bridge専用コンテキスト注入機能 設計書

## 概要

Bridge経由（Slack）のセッションでのみ有効な `CLAUDE.md` と `skills/` を、Claude CLIの `--append-system-prompt` オプションで注入する機能。CLI/デスクトップからは見えない、Bridge専用のコンテキストを実現する。

## 背景

現在、`SLACK_CONTEXT_PREFIX` が `src/bridge/slack-context.ts` にハードコードされており、`sendInitialPrompt()` でプロンプト本文の前に付加される。この方式には以下の問題がある：

1. Bridge固有の指示を変更するにはコード変更が必要
2. ユーザーがカスタマイズできない
3. Bridge専用のスキルを注入する仕組みがない

## 方針

Claude CLIの `--append-system-prompt` オプションを使い、プロセスspawn時にBridge専用コンテキストをシステムプロンプトに追加する。検証済み: このオプションは `stream-json` モードでも動作する。

## アーキテクチャ

### 変更前

```
spawn('claude', ['-p', '--input-format', 'stream-json', ...])

sendInitialPrompt(prompt):
  writeStdin(SLACK_CONTEXT_PREFIX + '\n' + prompt)
```

### 変更後

```
const bridgeContext = await buildBridgeContext(dataDir)

spawn('claude', [
  '-p', '--input-format', 'stream-json',
  '--append-system-prompt', bridgeContext,  // ← CLIのシステムプロンプトに追加
  ...
])

sendInitialPrompt(prompt):
  writeStdin(prompt)  // プロンプトのみ、prefix付加なし
```

### bridgeContextの構造

```
[Bridge CLAUDE.mdの全文]

[Bridge Skills]
The following bridge skills are available for use with the Skill tool:

- skill-name: description
- skill-name: description
```

## 新規ファイル

### `src/bridge/bridge-context.ts`

責務:
1. `~/.claude-slack-pipe/CLAUDE.md` を読み込む（なければ空文字）
2. `~/.claude-slack-pipe/skills/*.md` のfrontmatterから `name` と `description` を抽出してスキル一覧を生成
3. 両方を結合して1つの文字列として返す

```typescript
export async function buildBridgeContext(dataDir: string): Promise<string>
```

#### frontmatterパース

外部ライブラリを使わず自前パース。`---` で囲まれたYAML部分から `name` と `description` を正規表現で抽出する。

### `templates/CLAUDE.md`

現在の `SLACK_CONTEXT_PREFIX` の内容を移植。セットアップ時に `~/.claude-slack-pipe/CLAUDE.md` にコピーされる。

### `templates/skills/`

Bridge専用スキルファイルを同梱。セットアップ時に `~/.claude-slack-pipe/skills/` にコピーされる。

```
templates/
├── CLAUDE.md
└── skills/
    ├── slack-channel-create.md
    ├── slack-channel-update.md
    └── claude-p-automation-patterns.md
```

## 変更するファイル

### `src/bridge/persistent-session.ts`

- `spawn()` メソッド: args配列に `--append-system-prompt` と bridgeContext文字列を追加。bridgeContextが空の場合はargsに含めない
- `sendInitialPrompt()`: `SLACK_CONTEXT_PREFIX + '\n' +` を削除。promptだけ送信
- import: `SLACK_CONTEXT_PREFIX` の import を削除、`buildBridgeContext` を追加

### `src/bridge/slack-context.ts`

廃止（ファイル削除）。他に参照箇所がないことを確認の上で削除。

### `.claude/skills/setup.md`

セットアップ手順に以下を追加:
- `templates/CLAUDE.md` → `~/.claude-slack-pipe/CLAUDE.md` にコピー
- `templates/skills/*.md` → `~/.claude-slack-pipe/skills/` に全てコピー

## 変更しないファイル

- `executor.ts` — `SLACK_CONTEXT_PREFIX` を参照していないことを確認
- `index.ts` — 変更不要
- `config.ts` — `dataDir` は既存のものを使う

## エラーハンドリング

いずれもBridge起動を妨げない。ログだけ残して続行する方針。

| ケース | 対応 |
|--------|------|
| CLAUDE.md読み込みエラー | 警告ログ、注入スキップ |
| skills/*.mdのパースエラー | 該当スキルをスキップ、他は正常に一覧化 |
| skillsディレクトリ読み込みエラー | 警告ログ、スキル一覧なし |
| bridgeContextが空 | `--append-system-prompt` をargsに含めない |
| frontmatterに `---` がない | スキップ |
| name または description がない | スキップ |

## 後方互換

- `~/.claude-slack-pipe/CLAUDE.md` が存在しない → 注入スキップ
- `~/.claude-slack-pipe/skills/` が存在しない → スキル一覧なし
- 両方存在しない → `--append-system-prompt` 自体をargsに含めない（現状のハードコードも無くなるため、セットアップ未実行のユーザーはBridge Contextなしで動作する）

## テンプレートとセットアップ

セットアップ時のコピー対象:

```
templates/CLAUDE.md           → ~/.claude-slack-pipe/CLAUDE.md
templates/skills/*.md         → ~/.claude-slack-pipe/skills/
```

新規ユーザーはセットアップするだけでBridgeスキルが使える。既存ユーザーは再セットアップまたは手動コピーで対応。
