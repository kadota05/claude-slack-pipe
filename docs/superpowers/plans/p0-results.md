# P0 Verification Results

Date: 2026-03-16
CLI Version: claude 2.1.76

## P0-1: parent_tool_use_id の存在確認

**結果: 仮説A — フィールド存在**

`parent_tool_use_id` はすべてのassistantイベントおよびstream_eventのトップレベルに存在する。
- 非subagentコンテキストでは `null`
- Agentツール内のツール実行では非null値が期待される（本テストではCLIがAgent不使用でGrepを直接使用したためnullのみ確認）

**採用方針:** StreamProcessorで `parent_tool_use_id` を直接参照してsubagentネストを追跡。ToolStack実装は不要（フォールバックとして残す可能性あり）。

### 生データ（assistant イベント例）
```json
{
  "type": "assistant",
  "parent_tool_use_id": null,
  "message": {
    "content": [{"type": "tool_use", "id": "toolu_xxx", "name": "Grep", ...}],
    "stop_reason": "tool_use"
  }
}
```

## P0-2: --include-partial-messages のイベント構造

**結果: パターンD — content_block_delta 形式**

`--include-partial-messages` フラグにより、Anthropic APIのストリーミングイベントが `stream_event` タイプとしてそのまま公開される。

### イベント形式
```
type: "stream_event"
event:
  type: "message_start" | "content_block_start" | "content_block_delta" | "content_block_stop" | "message_delta" | "message_stop"
```

### テキストdelta
- `content_block_delta` イベント内に `delta.type = "text_delta"`, `delta.text = "文字"` で1〜数文字ずつ到着
- テスト結果: 13個のtext_deltaイベントで20文字の俳句を構成
- 蓄積方式: delta.textを順次結合してフルテキストを構築

### ベースライン比較
- **フラグなし**: 6行（hook, init, assistant(完了), rate_limit, result）
- **フラグあり**: 35行（hook, init, stream_events×27, assistant×2, rate_limit, result）

**採用方針:**
1. `--include-partial-messages` を有効にしてstream_eventを受信
2. `content_block_delta` + `text_delta` でテキストを蓄積
3. 2秒間隔で蓄積テキストをchat.updateで表示
4. `content_block_stop` で最終テキスト確定

### 重要: StreamProcessorの設計変更
既存のassistantイベント（完了時のみ）に加え、`stream_event` タイプを新たに処理する必要がある。
StreamEvent型定義に `type: 'stream_event'` を追加。

## P0-3: set_model 制御メッセージの動作

**結果: 仮説B — 無視される（モデル変更なし）**

Named pipe経由で `set_model` を送信したところ：
- `system.init` イベントが再発火された（内部リスタートの可能性）
- しかしモデルは **変更されなかった**（両方の応答で `claude-opus-4-6`）

### テストシーケンス
1. 初期プロンプト → 応答: "Claude Opus 4.6" (model=claude-opus-4-6) ✅
2. `set_model` to claude-sonnet-4-20250514 送信
3. 2番目のプロンプト → 応答: "Claude Opus 4.6" (model=claude-opus-4-6) ❌ 変更なし

**採用方針:** 既存のkill+respawn方式を維持。set_modelは使用しない。

## 設計への影響まとめ

| 項目 | P0結果 | 設計への影響 |
|------|--------|------------|
| subagent追跡 | parent_tool_use_id あり | 直接参照方式を採用 |
| テキストストリーミング | stream_event + content_block_delta | delta蓄積 + 2秒interval update |
| モデル変更 | set_model無効 | kill+respawn維持（変更なし） |
| CLIフラグ | `--include-partial-messages` 必要 | buildArgs()に追加 |
