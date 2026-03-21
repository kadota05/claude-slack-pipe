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
// 擬似コード（実際はstream-json形式のオブジェクトをwriteStdinに渡す）
spawn('claude', ['-p', '--input-format', 'stream-json', ...])

sendInitialPrompt(prompt):
  writeStdin({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: SLACK_CONTEXT_PREFIX + '\n' + prompt }] } })
```

### 変更後

```
// 擬似コード
const bridgeContext = await buildBridgeContext(dataDir)

spawn('claude', [
  '-p', '--input-format', 'stream-json',
  '--append-system-prompt', bridgeContext,  // ← CLIのシステムプロンプトに追加
  ...
])

sendInitialPrompt(prompt):
  writeStdin({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: prompt }] } })
  // プロンプトのみ、prefix付加なし
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

#### frontmatterパース仕様

外部ライブラリを使わず自前パース。以下のルールに従う:

- ファイル先頭が `---` で始まること（先頭以外の `---` は無視）
- 2つ目の `---` までをfrontmatter領域とする
- `name:` と `description:` の行を正規表現で抽出
- 値のクォート（`"` / `'`）は除去する
- 複数行descriptionは非対応（1行のみ）

パース例:
```markdown
---
name: Slackチャネル投稿セットアップ
description: 新規Slack投稿の仕組みを一式セットアップする
---
```
→ `{ name: "Slackチャネル投稿セットアップ", description: "新規Slack投稿の仕組みを一式セットアップする" }`

```markdown
---
name: "Quoted Name"
description: 'Single quoted desc'
---
```
→ `{ name: "Quoted Name", description: "Single quoted desc" }`

```markdown
This file has no frontmatter
```
→ スキップ

### `templates/CLAUDE.md`

現在の `SLACK_CONTEXT_PREFIX` の内容を移植。セットアップ時およびマイグレーション時に `~/.claude-slack-pipe/CLAUDE.md` にコピーされる。

### `templates/skills/`

Bridge専用スキルファイルを同梱。セットアップ時およびマイグレーション時に `~/.claude-slack-pipe/skills/` にコピーされる。

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
- import: `SLACK_CONTEXT_PREFIX` の import を削除
- bridgeContextは `SessionStartParams` 経由で文字列として受け取る（`buildBridgeContext` のimportは不要）

### `src/bridge/slack-context.ts`

廃止（ファイル削除）。

### `src/store/recent-session-scanner.ts`

`SLACK_CONTEXT_PREFIX` をimportして `stripSlackContext()` で使用している。`--append-system-prompt` 方式ではプロンプト本文にprefixが付加されなくなるため、`stripSlackContext()` 自体が不要になる。この関数とimportを削除し、呼び出し元も修正する。

### `.claude/skills/setup.md`

セットアップ手順に以下を追加:
- `templates/CLAUDE.md` → `~/.claude-slack-pipe/CLAUDE.md` にコピー
- `templates/skills/*.md` → `~/.claude-slack-pipe/skills/` に全てコピー

### `src/index.ts`

- Bridge起動時に `buildBridgeContext()` と `migrateTemplates()` を呼び出す
- 生成した bridgeContext 文字列を全ての `coordinator.getOrCreateSession()` 呼び出しに渡す

### `src/types.ts`

- `SessionStartParams` に `bridgeContext?: string` を追加

## 変更しないファイル

- `executor.ts` — `SLACK_CONTEXT_PREFIX` を参照していないことを確認
- `session-coordinator.ts` — `SessionStartParams` をそのまま `PersistentSession` に透過的に渡すため変更不要
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
| bridgeContextがARG_MAX超過 | 警告ログ、注入スキップ。macOSのARG_MAXは約262,144バイト。現実的には問題にならないが、CLAUDE.mdが巨大な場合に備える |

## 後方互換とマイグレーション

### 新規ユーザー

セットアップ時に `templates/` から自動コピーされるため、対応不要。

### 既存ユーザー

Bridge起動時に `~/.claude-slack-pipe/CLAUDE.md` が存在しない場合、プロジェクトディレクトリ内の `templates/CLAUDE.md` から自動コピーするマイグレーションを実行する。`skills/` ディレクトリについても同様。

これにより、既存ユーザーもアップデート後の初回起動で自動的にBridge Contextが有効になる。

マイグレーションロジックの配置場所: `src/bridge/bridge-context.ts` 内の `buildBridgeContext()` の先頭、またはBridge初期化フロー内。

### マイグレーションルール

- `CLAUDE.md` が存在しない → テンプレからコピー
- `CLAUDE.md` が既に存在する → 上書きしない（ユーザーのカスタマイズを尊重）
- `skills/` ディレクトリが存在しない → テンプレから全ファイルをコピー
- `skills/` が存在するが一部ファイルが欠けている → 欠けているファイルのみコピー（既存ファイルは上書きしない）

## テンプレートとセットアップ

セットアップ時のコピー対象:

```
templates/CLAUDE.md           → ~/.claude-slack-pipe/CLAUDE.md
templates/skills/*.md         → ~/.claude-slack-pipe/skills/
```

新規ユーザーはセットアップするだけでBridgeスキルが使える。既存ユーザーは初回起動時の自動マイグレーションで対応。
