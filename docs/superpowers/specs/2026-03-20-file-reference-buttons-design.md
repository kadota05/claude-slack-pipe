# ファイル参照ボタン機能 設計書

## 概要

Claude CLIの最終テキスト応答に含まれるファイルパスを検出し、実在するファイルのみをSlack上でクリック可能なボタンとして表示する。ボタン押下でモーダルが開き、ファイル内容を閲覧できる。

## スコープ

- **対象**: `result`イベント時点の`textBuffer`（最終テキスト断片）のみ
- **対象外**: 途中テキスト（ツール実行前にpost済み・バッファクリア済み）、ツールサマリー内のパス（既に「詳細」ボタンあり）

### スコープ限定の理由

`stream-processor.ts`の`finalizeCurrentText()`がツール実行・thinking開始時にtextBufferをクリアするため、`result`時点では最後のテキスト断片しか残らない。途中テキストのパス検出は別途バッファ管理が必要になり、初期スコープとしては過剰。

## パス検出ロジック

2段階で検出し、実在チェックで絞り込む:

1. **バッククォート内のパス**: `` `src/foo/bar.ts` `` — 正規表現: `` /`([^`]+)`/g `` からスラッシュを含むものを抽出
2. **スラッシュ区切りの裸パス**: `src/foo/bar.ts` — 正規表現: `/(?:^|\s)((?:[\w.-]+\/)+[\w.-]+)(?:\s|$|[,.:;)])/gm`
3. **実在チェック**: `fs.existsSync(path)` で絞り込み。相対パスはプロジェクトルート（`cwd`）基準で解決

### コードブロック内の除外

テキスト中の ``` で囲まれたコードブロック内のパスは検出対象外とする。CLIの出力にはコード例が含まれることが多く、誤検出を防ぐため。

### 絶対パスの扱い

絶対パスは `cwd` 配下のもののみ許可する。`/etc/passwd` 等のシステムファイルが表示されることを防ぐため、`path.resolve()` 後に `resolvedPath.startsWith(cwd)` で検証する。

### バイナリファイルの除外

画像・実行ファイル等のバイナリファイルは拡張子ベースで除外する（`.png`, `.jpg`, `.wasm`, `.exe` 等）。

### ファイルサイズ上限

1MBを超えるファイルはボタン表示対象から除外する（`fs.statSync(path).size`で確認）。モーダル表示のレスポンス時間を保証するため。

### 重複排除

同一パスがバッククォートと裸パスの両方で検出された場合、1つにまとめる。

## Slack表示

### テキストメッセージ末尾にsectionブロックを追加

`handleResult`内で`buildTextBlocks()`が返すブロック配列の末尾に、ファイルごとのsectionブロックを追加する。

```json
{
  "type": "section",
  "text": {
    "type": "mrkdwn",
    "text": ":page_facing_up: `src/index.ts`"
  },
  "accessory": {
    "type": "button",
    "text": { "type": "plain_text", "text": "表示" },
    "action_id": "view_file_content",
    "value": "src/index.ts"
  }
}
```

action_idは固定文字列（255文字制限対策）。ファイルパスは`value`フィールド（2000文字制限）で受け渡す。

### ブロック数制限

Slackメッセージは50ブロック上限。テキストブロック + ファイルボタンが50を超える場合、ファイルボタンを切り詰める。

## モーダル表示

### 短いファイル（Slackモーダル100ブロック以内に収まる場合）

直接コードブロックとしてファイル内容を表示:

```json
{
  "type": "section",
  "text": {
    "type": "mrkdwn",
    "text": "```\nファイル内容...\n```"
  }
}
```

mrkdwnのsection textは3000文字制限があるため、内容を約2900文字ごとに分割してsectionブロックを並べる。100ブロック × 2900文字 ≈ 290KB まで表示可能。

### 長いファイル（100ブロックに収まらない場合）

親モーダルに分割ボタンを表示:

```json
[
  {
    "type": "section",
    "text": { "type": "mrkdwn", "text": ":page_facing_up: `src/index.ts` (642行)" },
  },
  { "type": "divider" },
  {
    "type": "actions",
    "elements": [
      {
        "type": "button",
        "text": { "type": "plain_text", "text": "1-100行" },
        "action_id": "view_file_chunk:0",
        "value": "src/index.ts:1:100"
      },
      {
        "type": "button",
        "text": { "type": "plain_text", "text": "101-200行" },
        "action_id": "view_file_chunk:1",
        "value": "src/index.ts:101:200"
      }
    ]
  }
]
```

子モーダルは`views.push`で開き、該当範囲のファイル内容をコードブロックで表示する。

チャンク分割の`action_id`は `view_file_chunk:{index}` とし、インデックスでユニーク性を担保する。1つの親モーダル内でのみ使われるため、ファイルパス情報は`value`フィールド（`path:startLine:endLine`形式）で受け渡す。actionsブロックは1ブロック最大25要素のため、25ボタンごとにactionsブロックを分割する。

## 実装箇所

### 新規ファイル

- `src/streaming/file-path-extractor.ts` — パス検出・実在チェックロジック

### 変更ファイル

- `src/streaming/stream-processor.ts` — `handleResult`内でパス検出、テキストブロック末尾にファイルボタン追加
- `src/slack/modal-builder.ts` — `buildFileContentModal`（直接表示）、`buildFileChunksModal`（分割親）、`buildFileChunkModal`（分割子）追加
- `src/index.ts` — `view_file_content:` と `view_file_chunk:` のアクションハンドラ追加

### データフロー

```
handleResult()
  ↓
extractFilePaths(textBuffer, cwd)
  → パス検出 + fs.existsSync
  → FilePath[] (実在するパスのリスト)
  ↓
buildTextBlocks(converted) の末尾に
buildFileReferenceBlocks(filePaths) を追加
  ↓
ボタンクリック時:
  value からパスを取得
  → パストラバーサル検証（cwd配下チェック）
  → fs.readFileSync(path) でファイル読み込み
  → 長さに応じて直接表示 or 分割モーダル
  → views.open / views.push
```

## 既存パターンとの整合性

- **アクションID**: 既存の `view_tool_detail:`, `view_bundle:` パターンに合わせて `view_file_content:`, `view_file_chunk:` を使用
- **モーダル構築**: 既存の `modal-builder.ts` のコードブロック表示パターンを再利用
- **mrkdwn変換後処理**: localhost URL書き換えと同じレイヤー（mrkdwn変換後）でパス検出を行う（知見: `docs/knowledge/2026-03-19-slack-mrkdwn-link-rendering.md` Bug1回避）

## セキュリティ考慮

- `value`に含まれるパスでファイルを読むため、パストラバーサル対策が必要
- `path.resolve(cwd, filePath)` の結果が `cwd` 配下であることを検証
- シンボリックリンクの解決後にも検証する（`fs.realpathSync`）

## 制約・トレードオフ

- 途中テキスト（ツール実行前にpostされたもの）に含まれるパスは検出できない
- Slackメッセージ50ブロック制限により、大量のファイルパスがある場合は一部のみ表示
- モーダル100ブロック制限により、非常に大きなファイルは分割数が多くなる
- ボタン作成後にファイルが削除された場合、クリック時に「ファイルが見つかりません」エラーをモーダルで表示する
