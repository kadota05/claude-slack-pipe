# バンドルグルーピングが途切れるバグ

## 症状

Slackのストリーミング表示で、一連のツール活動（thinking → ToolSearch → MCP tool）が
本来1つのバンドル（折りたたみメッセージ）にまとまるべきところ、複数のバンドルに分割されていた。
また、サブエージェント実行中にバンドルが早期に崩壊し、後続のサブエージェントステップが失われた。

## 根本原因

2つの独立したバグ:

1. **子イベントのフィルタリング漏れ**: `StreamProcessor.handleAssistant()` で
   `tool_use` ブロックのみ `parentToolUseId` をチェックしていた。
   子 `text`/`thinking` イベントは親レベルのハンドラに到達し、
   `handleTextStart()` によるバンドル崩壊や `handleThinking()` によるグループ切り替えを引き起こした。

2. **短文テキストのバンドル崩壊**: `handleText()` で `handleTextStart()`（バンドル崩壊）が
   短文バッファリングチェック（100文字未満は投稿しない）の**前**に実行されていた。
   投稿されない短いナレーションテキストでもバンドルが崩壊した。

## 証拠

- JSOLNデータ分析: セッション `b8ca68fa` で ToolSearch 後の短文テキスト
  `"ブレインストーミングを始めます。"` がバンドル境界を作成していることを確認
- コードトレース: `handleAssistant()` L74-85 で `thinking`/`text` に
  `parentToolUseId` チェックがないことを特定
- `handleText()` L113-126 で `handleTextStart()` がバッファチェック前に呼ばれていることを確認

## 修正内容

1. `handleAssistant()`: `parentToolUseId` がある場合、`text`/`thinking` ブロックを `continue` でスキップ
2. `handleText()`: `handleTextStart()` をテキストバッファの100文字閾値チェック後に移動
3. `session-jsonl-reader.ts`: `collectBundleEntries()` にテキスト長の累積チェックを追加し、
   100文字未満の短文テキストではバンドル境界を作らないように変更

## 教訓

- ストリームイベントの `parentToolUseId` チェックは全ブロックタイプに一貫して適用すべき。
  新しいブロックタイプを追加する際も同様。
- ストリーミング側とJSONLリーダー側でバンドル境界のロジックが一致していないと、
  バンドルインデックスのズレが発生し、詳細モーダルの表示が壊れる。
  変更時は必ず両側を揃えること。
