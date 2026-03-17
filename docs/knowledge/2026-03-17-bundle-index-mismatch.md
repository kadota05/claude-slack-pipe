# Bundle Index Mismatch Between Streaming and JSONL Reader

## 症状

特定のセッションで「詳細を見る」ボタンを押してもモーダルが開けない。ログに `No bundle entries for <sessionId>:<bundleIndex>` と表示される。テキストのみの応答（ツール実行なし）が途中に挟まるセッションで発生。

## 根本原因

ストリーミング側（GroupTracker）とJSONL読み取り側（SessionJsonlReader）でbundleのカウント方法が異なっていた。

- **ストリーミング側**: `ensureBundle()` は thinking/tool_use/subagent が来た時のみ `bundleCounter++` する。テキストのみの応答はbundleを生成しない。
- **JSONL読み取り側**: すべての assistant text ブロックで無条件に `textBlockCount++` していた。

テキストのみの応答が間に入ると、JSONL reader側のインデックスがストリーミング側より大きくなり、ボタンに埋め込まれた `bundleIndex` で正しいエントリを取得できなくなる。

## 証拠

セッション `13eb4876-55bd-4a91-9949-1a646d668183` のJSONL構造:
- L29: text (bundle 0 終了) — ツール活動あり ✓
- L33: text ("はい") — ツール活動なし ✗ ← ここでJSONL readerだけカウントがズレる
- L41: text — ツール活動あり ✓

ストリーミング側: bundle 0, bundle 1 (計2つ)
JSONL reader側: bundle 0, bundle 1(空), bundle 2 (計3つ) → インデックス不一致

## 修正内容

`session-jsonl-reader.ts` の `collectBundleEntries()` に `hasActivityInCurrentSegment` フラグを追加。assistant text ブロック到達時に、その前区間に thinking/tool_use があった場合のみ `textBlockCount` をインクリメントするよう変更。

## 教訓

bundleの境界定義が2箇所（ストリーミング側・読み取り側）に分散している。片方だけ変更するとインデックスがズレる。bundleカウントのロジックは「テキスト出現 = 境界」ではなく「ツール活動を含む区間の終了 = 境界」という意味論であることを忘れないこと。
