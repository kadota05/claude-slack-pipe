# Context Window Accuracy Fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** フッターのコンテキストウィンドウ表示を、最終APIステップの実使用量に基づく正確な値に修正し、表示をシンプル化する

**Architecture:** StreamProcessorが各assistantイベントの`message.usage`を追跡し、最終ステップの値をresultとして返す。index.tsはその値でctxを計算し、block-builder.tsがシンプル化されたフッターを描画する。

**Tech Stack:** TypeScript, tsx

**Spec:** `docs/superpowers/specs/2026-03-19-context-window-accuracy-design.md`

---

## File Map

| Action | File | Responsibility |
|--------|------|---------------|
| Modify | `src/streaming/types.ts:173-178` | ProcessedActions型にlastMainUsage追加、mainApiCallCount削除 |
| Modify | `src/streaming/stream-processor.ts:24-92,319-320` | lastMainUsage追跡、reset、handleResult |
| Modify | `src/slack/block-builder.ts:204-221` | buildResponseFooterシンプル化 |
| Modify | `src/index.ts:558-593` | ctx計算ロジック差し替え、フッター呼び出し変更 |
| Modify | `src/streaming/notification-text.ts:37-38` | footer通知テキスト更新 |

---

### Task 1: ProcessedActions型の更新

**Files:**
- Modify: `src/streaming/types.ts:173-178`

- [ ] **Step 1: `lastMainUsage`フィールド追加、`mainApiCallCount`削除**

```typescript
// src/streaming/types.ts L173-178
// Before:
export interface ProcessedActions {
  bundleActions: BundleAction[];
  textAction?: SlackAction;
  resultEvent?: any;
  mainApiCallCount?: number;
}

// After:
export interface ProcessedActions {
  bundleActions: BundleAction[];
  textAction?: SlackAction;
  resultEvent?: any;
  lastMainUsage?: TokenUsage | null;
}
```

Note: `src/streaming/types.ts` の先頭に以下のimportを追加:
```typescript
import type { TokenUsage } from '../types.js';

```

- [ ] **Step 2: コンパイル確認**

Run: `npx tsc --noEmit 2>&1 | head -20`
Expected: `mainApiCallCount`参照箇所でエラー（stream-processor.ts, index.ts）。これは後続タスクで修正。

- [ ] **Step 3: Commit**

```bash
git add src/streaming/types.ts
git commit -m "refactor: replace mainApiCallCount with lastMainUsage in ProcessedActions"
```

---

### Task 2: StreamProcessorにusage追跡を追加

**Files:**
- Modify: `src/streaming/stream-processor.ts:1-14,24-31,87-92,56-57,319-320`

- [ ] **Step 1: TokenUsage importを追加**

```typescript
// src/streaming/stream-processor.ts L9 の import に追加
import type { TokenUsage } from '../types.js';
```

- [ ] **Step 2: インスタンス変数を追加**

```typescript
// src/streaming/stream-processor.ts L30 の後に追加（mainToolUseCountの行を削除）
// Before (L28-31):
  private textBuffer = '';
  private textMessageTs: string | null = null;
  private mainToolUseCount = 0;
  private firstContentReceived = false;

// After:
  private textBuffer = '';
  private textMessageTs: string | null = null;
  private lastMainUsage: TokenUsage | null = null;
  private firstContentReceived = false;
```

Note: `mainToolUseCount`は`mainApiCallCount`計算にのみ使われていたので削除。ただし`handleToolUse()`内の`this.mainToolUseCount++`も削除が必要（Step 4参照）。

- [ ] **Step 3: processEvent内でusageを保持**

```typescript
// src/streaming/stream-processor.ts L56-57
// Before:
    if (event.type === 'assistant' && event.message?.content) {
      this.handleAssistant(event.message.content, parentToolUseId, result);

// After:
    if (event.type === 'assistant' && event.message?.content) {
      // Track last main-agent usage for context window calculation
      if (!parentToolUseId && event.message.usage) {
        this.lastMainUsage = event.message.usage;
      }
      this.handleAssistant(event.message.content, parentToolUseId, result);
```

- [ ] **Step 4: mainToolUseCount関連コードを削除**

```typescript
// src/streaming/stream-processor.ts handleToolUse内
// L141: this.mainToolUseCount++; を削除
// L149: this.mainToolUseCount++; を削除
```

- [ ] **Step 5: reset()にlastMainUsageリセットを追加**

```typescript
// src/streaming/stream-processor.ts L87-92
// Before:
  reset(): void {
    this.textBuffer = '';
    this.textMessageTs = null;
    this.mainToolUseCount = 0;
    this.firstContentReceived = false;
  }

// After:
  reset(): void {
    this.textBuffer = '';
    this.textMessageTs = null;
    this.lastMainUsage = null;
    this.firstContentReceived = false;
  }
```

- [ ] **Step 6: handleResult()でlastMainUsageを返す**

```typescript
// src/streaming/stream-processor.ts L319-320
// Before:
    result.resultEvent = event;
    result.mainApiCallCount = this.mainToolUseCount + 1;

// After:
    result.resultEvent = event;
    result.lastMainUsage = this.lastMainUsage;
```

- [ ] **Step 7: コンパイル確認**

Run: `npx tsc --noEmit 2>&1 | head -20`
Expected: block-builder.tsとindex.tsでのみエラー（後続タスクで修正）。

- [ ] **Step 8: Commit**

```bash
git add src/streaming/stream-processor.ts
git commit -m "refactor: track last main-agent usage in StreamProcessor for accurate context"
```

---

### Task 3: buildResponseFooterのシンプル化

**Files:**
- Modify: `src/slack/block-builder.ts:204-221`

- [ ] **Step 1: buildResponseFooterを更新**

```typescript
// src/slack/block-builder.ts L204-221
// Before:
export function buildResponseFooter(params: {
  inputTokens: number;
  outputTokens: number;
  contextUsed: number;
  contextWindow: number;
  model: string;
  durationMs: number;
}): any[] {
  const ctxPct = (params.contextUsed / params.contextWindow) * 100;
  const ctxWindowLabel = params.contextWindow >= 1_000_000
    ? `${(params.contextWindow / 1_000_000).toFixed(0)}M`
    : `${(params.contextWindow / 1_000).toFixed(0)}k`;
  const text = `tokens in:${formatTokens(params.inputTokens)} out:${formatTokens(params.outputTokens)} | ctx ${formatTokens(params.contextUsed)}/${ctxWindowLabel}(${ctxPct.toFixed(1)}%) | ${params.model} | ${formatDuration(params.durationMs)}`;
  return [{
    type: 'context',
    elements: [{ type: 'mrkdwn', text }],
  }];
}

// After:
export function buildResponseFooter(params: {
  contextUsed: number;
  contextWindow: number;
  model: string;
  durationMs: number;
  isApproximate?: boolean;
}): any[] {
  const capped = Math.min(params.contextUsed, params.contextWindow);
  const ctxPct = (capped / params.contextWindow) * 100;
  const ctxWindowLabel = params.contextWindow >= 1_000_000
    ? `${(params.contextWindow / 1_000_000).toFixed(0)}M`
    : `${(params.contextWindow / 1_000).toFixed(0)}k`;
  const approx = params.isApproximate ? '~' : '';
  const text = `ctx ${approx}${formatTokens(capped)}/${ctxWindowLabel}(${ctxPct.toFixed(1)}%) | ${params.model} | ${formatDuration(params.durationMs)}`;
  return [{
    type: 'context',
    elements: [{ type: 'mrkdwn', text }],
  }];
}
```

- [ ] **Step 2: Commit**

```bash
git add src/slack/block-builder.ts
git commit -m "refactor: simplify buildResponseFooter to show only context window usage"
```

---

### Task 4: index.tsのフッター計算を差し替え

**Files:**
- Modify: `src/index.ts:542,565-593`
- Modify: `src/streaming/notification-text.ts:37-38`

- [ ] **Step 1: processEvent destructuringからmainApiCallCountを削除、lastMainUsage追加**

```typescript
// src/index.ts L542
// Before:
          const { bundleActions, textAction, resultEvent, mainApiCallCount } = await streamProcessor.processEvent(event);

// After:
          const { bundleActions, textAction, resultEvent, lastMainUsage } = await streamProcessor.processEvent(event);
```

- [ ] **Step 2: ctx計算ロジックを差し替え**

```typescript
// src/index.ts L565-575
// Before:
            const usage = resultEvent.usage || {};
            const apiCalls = mainApiCallCount || 1;
            const inputTotal = (usage.input_tokens || 0)
              + (usage.cache_read_input_tokens || 0)
              + (usage.cache_creation_input_tokens || 0);
            const contextUsed = Math.round(inputTotal / apiCalls);

            const sessionModel = indexStore.findByThreadTs(threadTs)?.model || '';
            const contextWindow = sessionModel.includes('haiku') ? 200_000 : 1_000_000;

            logger.info(`[${session.sessionId}] ctx: ${inputTotal} / ${apiCalls} calls = ${contextUsed} (${(contextUsed / contextWindow * 100).toFixed(1)}%)`);

// After:
            const usage = resultEvent.usage || {};
            const isApproximate = !lastMainUsage;
            const effectiveUsage = lastMainUsage || usage;
            const contextUsed = (effectiveUsage.input_tokens || 0)
              + (effectiveUsage.cache_read_input_tokens || 0)
              + (effectiveUsage.cache_creation_input_tokens || 0);

            const sessionModel = indexStore.findByThreadTs(threadTs)?.model || '';
            const contextWindow = sessionModel.includes('haiku') ? 200_000 : 1_000_000;

            logger.info(`[${session.sessionId}] ctx: ${contextUsed} / ${contextWindow} (${(contextUsed / contextWindow * 100).toFixed(1)}%)${isApproximate ? ' [approx]' : ''}`);
```

- [ ] **Step 3: buildResponseFooter呼び出しを更新**

```typescript
// src/index.ts L577-584
// Before:
            const footerBlocks = buildResponseFooter({
              inputTokens: usage.input_tokens || 0,
              outputTokens: usage.output_tokens || 0,
              contextUsed,
              contextWindow,
              model: sessionModel || 'unknown',
              durationMs: resultEvent.duration_ms || 0,
            });

// After:
            const footerBlocks = buildResponseFooter({
              contextUsed,
              contextWindow,
              model: sessionModel || 'unknown',
              durationMs: resultEvent.duration_ms || 0,
              isApproximate,
            });
```

- [ ] **Step 4: notification-text.tsのfooterを更新**

```typescript
// src/streaming/notification-text.ts L37-38
// Before:
  footer(model: string, totalTokens: number, durationMs: number): string {
    return `${model} | ${formatTokens(totalTokens)} tokens | ${formatDuration(durationMs)}`;
  },

// After:
  footer(model: string, durationMs: number): string {
    return `${model} | ${formatDuration(durationMs)}`;
  },
```

- [ ] **Step 5: footer呼び出し側を更新**

```typescript
// src/index.ts L590-593
// Before:
              text: notifyText.footer(
                sessionModel || 'unknown',
                (usage.input_tokens || 0) + (usage.output_tokens || 0),
                resultEvent.duration_ms || 0,
              ),

// After:
              text: notifyText.footer(
                sessionModel || 'unknown',
                resultEvent.duration_ms || 0,
              ),
```

- [ ] **Step 6: コンパイル確認**

Run: `npx tsc --noEmit 2>&1 | head -20`
Expected: No errors

- [ ] **Step 7: Commit**

```bash
git add src/index.ts src/streaming/notification-text.ts
git commit -m "fix: use last-step usage for accurate context window display"
```

---

### Task 5: 実データ検証

**Files:** None (ログ確認のみ)

- [ ] **Step 1: Bridgeを再起動してもらう**

> コードを変更しました。Slackで `cc /restart-bridge` と送信して再起動してください。

- [ ] **Step 2: テストメッセージを送って検証**

Slackでツールを使うクエリ（例: ファイル読み取り）を送り、フッターが以下の形式で表示されることを確認:

```
ctx 28.2k/1M(2.8%) | opus-4-6 | 45.2s
```

ログで以下を確認:
- `ctx: XXXXX / 1000000 (X.X%)` が出力されていること
- `[approx]`が付いていない（= lastMainUsageが取れている）こと

- [ ] **Step 3: フォールバック確認（optional）**

`message.usage`が取れない場合の`~`プレフィックス表示が正しく動くかは、実データでusageが常にある場合はスキップ可。ログに`[approx]`が出た場合のみ確認。
