# コンテキストウィンドウ使用量の正確な計算方法

## 症状

フッターの `ctx` 表示が実際のコンテキストウィンドウ使用量と大きく乖離していた。ツールを多用するとctxが不自然に小さくなる（例: 実際は95kなのに19kと表示）。

## 根本原因

3つの問題が重なっていた：

1. **累計トークンをAPI呼び出し回数で割って平均化していた**。`result`イベントの`usage`はターン全体の累計値。ツールを5回使えば6回のAPI呼び出しが発生し、各呼び出しでコンテキストは膨らんでいくため、累計÷回数の平均値はどのステップの実態も反映しない

2. **`in`表示にキャッシュ分を含めていなかった**。`input_tokens`のみ使用し、`cache_read_input_tokens` + `cache_creation_input_tokens`を無視していた。コンテキストウィンドウの観点ではキャッシュヒットしたトークンも「使用量」

3. **`tokens in/out`とctxが別々の元データから計算されていた**。`in`は`input_tokens`のみ、`ctx`はキャッシュ込みで、数値の一貫性がなかった

## 証拠

- ログ: `ctx: 1526073 / 16 calls = 95380 (9.5%)` — 累計1.5Mを16回で割っている
- Claude Agent SDK公式ドキュメント（https://platform.claude.com/docs/en/agent-sdk/cost-tracking）:
  - `result`の`usage`は「ターン全体の累計」
  - 各`assistant`メッセージの`message.usage`は「そのステップの値」
- GitHub Issue #13783: `context_window`のJSONが累計トークンを含んでいるというバグ報告

## 修正内容

### アプローチ: 最終ステップのusageを追跡

stream-jsonの各`assistant`イベントには`message.usage`がある（Agent SDKの`BetaMessage`由来）。メインエージェント（`!parentToolUseId`）の最後の`assistant`イベントのusageが、現在のコンテキストウィンドウ使用量に最も近い。

### 変更点

1. **`StreamProcessor`に`lastMainUsage`を追加**: `assistant`イベント受信時に上書き保持。`reset()`でリセット
2. **`index.ts`のctx計算**: `lastMainUsage`の`input_tokens + cache_read + cache_creation`。取れない場合は`result.usage`にフォールバック（`~`プレフィックス付き、`Math.min`でキャップ）
3. **フッター簡素化**: `tokens in:X out:Y`を削除し`ctx`に一本化。output tokensは次ターンのcontextに含まれるため別表示は不要

### フッター形式

Before: `tokens in:3.2k out:1.5k | ctx 19.9k/1M(2.0%) | opus-4-6 | 45.2s`
After: `ctx 20.4k/1M(2.0%) | opus-4-6 | 45.2s`

## 教訓

1. **Claude CLIのstream-jsonにおけるトークン集計の仕組み**: `result`イベントの`usage`はターン累計、各`assistant`イベントの`message.usage`はステップ単位。コンテキストウィンドウの「現在の使用量」を知りたい場合は後者の最終値を使う

2. **output tokensの扱い**: あるターンのoutput tokensは次ターンのinput（コンテキスト）に含まれる。フッターでinとoutを別々に表示するよりctxだけ見る方が実用的

3. **公式ドキュメントの確認が必須**: CLI固有の仕様はGitHub Issuesに散らばっており、Agent SDKのドキュメント（cost-tracking）が最も信頼できるソース
