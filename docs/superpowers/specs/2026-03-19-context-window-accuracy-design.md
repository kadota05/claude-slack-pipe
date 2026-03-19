# コンテキストウィンドウ表示の正確化

## 背景

フッターの `ctx` 表示がコンテキストウィンドウの実使用量を正しく反映していない。

### 現在の問題

1. **ctx計算が間違い**: `result`イベントの累計input_tokensをAPI呼び出し回数で割って平均化している。平均値はどのステップの実態も反映しない
2. **tokens in/outが冗長**: output tokensは次ターンのcontextに含まれるため、ctxだけで十分
3. **inにキャッシュ分が含まれていない**: `input_tokens`のみ表示し、`cache_read_input_tokens` + `cache_creation_input_tokens`を無視

### あるべき姿

- **ctx**: 最終APIステップ時点のコンテキストウィンドウ使用量（input + cache_read + cache_creation）
- `tokens in:X out:Y` は削除してctxに一本化

## 設計

### 変更1: StreamProcessorにステップ単位のusage追跡を追加

**ファイル**: `src/streaming/stream-processor.ts`

新しいインスタンス変数:
```typescript
private lastMainUsage: TokenUsage | null = null;
```

`processEvent()` で `assistant` イベント処理時にusageを保持:
```typescript
if (event.type === 'assistant' && event.message?.content) {
  if (!parentToolUseId && event.message.usage) {
    this.lastMainUsage = event.message.usage;
  }
  this.handleAssistant(event.message.content, parentToolUseId, result);
}
```

`reset()` でリセット:
```typescript
this.lastMainUsage = null;
```

`handleResult()` で返却:
```typescript
result.lastMainUsage = this.lastMainUsage;
```

### 根拠

公式ドキュメント（Agent SDK TypeScript Reference）より:
> `SDKAssistantMessage` の `message` フィールドは Anthropic SDK の `BetaMessage` で、`usage` を含む

各assistantメッセージの `usage.input_tokens` はそのステップでAPIに送った全トークン量（会話履歴 + ツール結果）。ツールを使うほど膨らむため、最終ステップの値が現在のコンテキストウィンドウ使用量に最も近い。

最終assistantステップはユーザーへのテキスト応答であり、その時点で会話履歴全体（過去のツール結果含む）がinputに含まれるため、通常はターン内で最大の`input_tokens`になる。

> **要検証**: stream-jsonモードの`assistant`イベントに`message.usage`が実際に含まれるかは、実装前にログ出力で確認すること。Agent SDKのドキュメントでは`BetaMessage`に`usage`があると記載されているが、CLIの出力形式に依存する可能性がある。

### 変更2: index.tsのフッター計算を差し替え

**ファイル**: `src/index.ts`

Before:
```typescript
const inputTotal = (usage.input_tokens || 0)
  + (usage.cache_read_input_tokens || 0)
  + (usage.cache_creation_input_tokens || 0);
const contextUsed = Math.round(inputTotal / apiCalls);
```

After:
```typescript
const lastUsage = lastMainUsage || usage;
const contextUsed = (lastUsage.input_tokens || 0)
  + (lastUsage.cache_read_input_tokens || 0)
  + (lastUsage.cache_creation_input_tokens || 0);
```

- `lastMainUsage` が取れない場合（古いCLIバージョン等）は `result.usage` にフォールバック
- `mainApiCallCount` による除算を削除

フッター呼び出し側の変更:
```typescript
const footerBlocks = buildResponseFooter({
  contextUsed,
  contextWindow,
  model: sessionModel || 'unknown',
  durationMs: resultEvent.duration_ms || 0,
});
```

ログ出力の変更:
```typescript
logger.info(`[${session.sessionId}] ctx: ${contextUsed} / ${contextWindow} (${(contextUsed / contextWindow * 100).toFixed(1)}%)`);
```

### 変更3: フッター表示のシンプル化

**ファイル**: `src/slack/block-builder.ts`

Before:
```
tokens in:3.2k out:1.5k | ctx 19.9k/1M(2.0%) | opus-4-6 | 45.2s
```

After:
```
ctx 28.2k/1M(2.8%) | opus-4-6 | 45.2s
```

- `tokens in:X out:Y` を削除
- `buildResponseFooter` の新しいシグネチャ:

```typescript
export function buildResponseFooter(params: {
  contextUsed: number;
  contextWindow: number;
  model: string;
  durationMs: number;
}): any[]
```

表示文字列:
```typescript
const text = `ctx ${formatTokens(params.contextUsed)}/${ctxWindowLabel}(${ctxPct.toFixed(1)}%) | ${params.model} | ${formatDuration(params.durationMs)}`;
```

### 変更4: ProcessedActions型の拡張

**ファイル**: `src/streaming/types.ts`

```typescript
export interface ProcessedActions {
  bundleActions: BundleAction[];
  textAction?: SlackAction;
  resultEvent?: any;
  lastMainUsage?: TokenUsage | null;  // ← 追加
  // mainApiCallCount は削除（使わなくなる）
}
```

## リスク

- **`message.usage`が存在しない場合**: フォールバックで`result.usage`を使う。ただし`result.usage`は累計値のため、ツール多用時にctxが100%を超える可能性がある → `Math.min(contextUsed, contextWindow)` でキャップする
- **サブエージェントのusageを拾う**: `!parentToolUseId` でフィルタ済み
- **フォールバック時の表示**: フォールバック中は値が不正確であることを `~` プレフィックスで示す（例: `ctx ~512k/1M(51.2%)`）
