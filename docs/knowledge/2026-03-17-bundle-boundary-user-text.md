# readBundleでユーザーのtextブロックがバンドル境界として誤カウントされるバグ

## 症状

collapsedバンドルメッセージの「詳細を見る」ボタンを押しても何も表示されない。ログに `No bundle entries for {sessionId}:0` と出る。

## 根本原因

`SessionJsonlReader.readBundle()` がJSONL内の **全てのtextブロック** をバンドル境界としてカウントしていた。Claude CLIのJSONLには以下の構造がある:

```
行3: { message: { role: "user", content: [{ type: "text", text: "ユーザーの質問" }] } }
行4: { message: { role: "assistant", content: [{ type: "thinking", ... }] } }
...
行28: { message: { role: "assistant", content: [{ type: "text", text: "回答" }] } }
```

`role=user` の行にもtext blockが含まれるため、ユーザーのメッセージがbundleIndex=0のウィンドウを即座に閉じてしまい、thinking/tool_useが収集されなかった。

## 証拠

1. ログに `No bundle entries for 055a3f4c...:0` が出力
2. Pythonでスキャンしたところ、`textBlockCount` がユーザーメッセージ（行3）で1に増加
3. bundle 0のウィンドウ（textBlockCount=0の期間）にassistantの行が存在しなかった

## 修正内容

`session-jsonl-reader.ts` の `collectBundleEntries` メソッドで:

1. **text blockのカウントを `role === 'assistant'` に限定**
   - `block.type === 'text'` → `block.type === 'text' && role === 'assistant'`
2. **child eventフィルタのフィールド名を修正**
   - JSONL形式は `parentToolUseID`（camelCase）を使用
   - ストリームイベントは `parent_tool_use_id`（snake_case）を使用
   - 両方に対応するようにした

## 教訓

- **CLIのJSONL形式はストリームイベントとフィールド名が異なる**（camelCase vs snake_case）。新しくJSONLを読むコードを書くときは、実際のファイルの構造を必ず確認すること。
- **テストデータと実データの乖離に注意**。テストでは `role=user` の行にtext blockを含めていなかったため、この問題が発見できなかった。
- **バンドル境界の定義は「assistantのtextブロック」であり「任意のtextブロック」ではない**。ユーザーのメッセージ、tool_resultの中のtext等はバンドル境界にならない。
