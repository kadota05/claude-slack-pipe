# Bundle境界検出: textPostedフラグ不一致バグ

## 症状

Slackで表示されたツールバンドルのグルーピングと、「詳細を見る」ボタンで表示される内容が一致しない。

具体例:
- 4回のツールユースが 🔧×1 と 🔧×3 に分かれて表示される
- 🔧×1 の「詳細を見る」を押すと4つ全てが表示される
- 🔧×3 の「詳細を見る」は反応しない（空のentriesで早期リターン）

## 根本原因

`StreamProcessor.handleText()` と `SessionJsonlReader.collectBundleEntries()` のbundle境界検出ロジックが不一致。

### ストリーミング側 (`stream-processor.ts:128`)
```typescript
if (!this.textMessageTs && this.textBuffer.length < 100) {
  return; // バッファ、折りたたまない
}
// textMessageTsがセット済みなら、ANY textでcollapse
```

- `textMessageTs` は一度セットされたら永続
- テキストが一度投稿されたら（textBuffer >= 100で初回投稿）、以降のテキストは文字数に関係なくbundle collapseをトリガー

### JSONLリーダー側 (修正前)
```typescript
if (hasActivityInCurrentSegment && textBufferLength >= 100) {
  textBlockCount++;
  textBufferLength = 0; // リセットして毎回100文字を要求
}
```

- 境界ごとに `textBufferLength` をリセット
- 毎回100文字以上を要求
- ストリーミング側の「一度投稿したら何文字でもcollapse」を再現できていなかった

### 具体的な発生条件

ツール間に100文字未満のテキストが挿入された場合：
- ストリーミング側: textMessageTsがセット済みなので93文字でもcollapse → 1+3に分割
- JSONLリーダー: 93 < 100 → 境界カウントせず → 4ツールが全てbundle 1に入る

## 証拠

セッション `199bda80-7e65-4833-a0b7-f59eb61f84a4` のJSONLイベント順序:
```
Line 16: text len=455 → textBuffer初回100超え、textMessageTsセット
Line 17: tool_use Bash (ツール1) → bundle開始
Line 18: tool_result
Line 19: text len=93  ← ★ ストリーミング側はcollapse、JSONLリーダーはスキップ
Line 20: tool_use Bash (ツール2)
Line 22: tool_use Bash (ツール3)
Line 24: tool_use Bash (ツール4)
Line 26: text len=83
```

## 修正内容

`session-jsonl-reader.ts` の `collectBundleEntries()` に `textPosted` フラグを追加:

```typescript
let textPosted = false; // mirrors streaming side's textMessageTs

// 境界判定ロジック
const shouldCollapse = textPosted || textBufferLength >= 100;

if (hasActivityInCurrentSegment && shouldCollapse) {
  textBlockCount++;
  hasActivityInCurrentSegment = false;
  textPosted = true;
  textBufferLength = 0;
} else if (!textPosted && textBufferLength >= 100) {
  // アクティビティなしでもテキスト投稿状態を記録
  textPosted = true;
}
```

## 教訓

- ストリーミング側とJSONLリーダー側の境界検出ロジックは**全ての状態遷移**を一致させる必要がある
- 単純な閾値チェック（>= 100）だけでなく、状態フラグ（textMessageTs / textPosted）も含めて再現すること
- 前回の修正（`c0eed6f`）ではtextBufferLengthの閾値を合わせたが、状態フラグの不一致は見落としていた
