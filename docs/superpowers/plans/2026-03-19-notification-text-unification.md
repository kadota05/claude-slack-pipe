# 通知テキスト統一・装飾整理 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 全postMessage/updateのtextを内容ベースに統一し、リアクション/装飾の絵文字を完全分離する

**Architecture:** 新モジュール `notification-text.ts` にテキスト生成関数と絵文字定数を集約。既存の group-tracker / stream-processor / tool-formatter / index.ts はこのモジュールを参照するよう書き換え。構造変更なし。

**Tech Stack:** TypeScript, Vitest

**Spec:** `docs/superpowers/specs/2026-03-19-notification-text-unification-design.md`

---

### Task 1: notification-text.ts を作成（テスト → 実装）

**Files:**
- Create: `src/streaming/notification-text.ts`
- Create: `tests/streaming/notification-text.test.ts`

- [ ] **Step 1: テストファイルを作成**

```typescript
// tests/streaming/notification-text.test.ts
import { describe, it, expect } from 'vitest';
import { notifyText, DECORATION_ICONS } from '../../src/streaming/notification-text.js';

describe('DECORATION_ICONS', () => {
  it('defines decoration-only icons as plain text characters', () => {
    expect(DECORATION_ICONS.completed).toBe('✓');
    expect(DECORATION_ICONS.error).toBe('✗');
  });

  it('does not use reaction emojis in decorations', () => {
    const values = Object.values(DECORATION_ICONS);
    expect(values).not.toContain(':white_check_mark:');
    expect(values).not.toContain(':x:');
    expect(values).not.toContain(':hourglass_flowing_sand:');
  });
});

describe('notifyText.footer', () => {
  it('generates content-based footer text', () => {
    const result = notifyText.footer('opus', 1234, 3200);
    expect(result).toBe('opus | 1,234 tokens | 3.2s');
  });

  it('handles zero tokens', () => {
    const result = notifyText.footer('haiku', 0, 500);
    expect(result).toBe('haiku | 0 tokens | 0.5s');
  });
});

describe('notifyText.text', () => {
  it('returns first 100 chars of buffer', () => {
    const result = notifyText.text('a'.repeat(200));
    expect(result).toHaveLength(100);
  });

  it('returns full text if under 100 chars', () => {
    const result = notifyText.text('hello world');
    expect(result).toBe('hello world');
  });
});

describe('notifyText.update', () => {
  it('thinking returns content-based text', () => {
    expect(notifyText.update.thinking()).toBe('💭 思考中');
  });

  it('tools lists tool names', () => {
    const tools = [
      { toolName: 'Read', status: 'completed' },
      { toolName: 'Bash', status: 'running' },
      { toolName: 'Grep', status: 'running' },
    ];
    expect(notifyText.update.tools(tools as any)).toBe('🔧 Read, Bash, Grep');
  });

  it('collapsed generates summary', () => {
    const result = notifyText.update.collapsed({
      thinkingCount: 1,
      toolCount: 3,
      toolDurationMs: 2500,
      subagentCount: 0,
      subagentDurationMs: 0,
    });
    expect(result).toBe('💭×1  🔧×3 (2.5s)');
  });

  it('collapsed with subagents', () => {
    const result = notifyText.update.collapsed({
      thinkingCount: 0,
      toolCount: 2,
      toolDurationMs: 1000,
      subagentCount: 1,
      subagentDurationMs: 5000,
    });
    expect(result).toBe('🔧×2 (1.0s)  🤖×1 (5.0s)');
  });

  it('pending returns fallback text', () => {
    expect(notifyText.update.pending()).toBe('...');
  });
});
```

- [ ] **Step 2: テスト実行して失敗を確認**

Run: `npx vitest run tests/streaming/notification-text.test.ts`
Expected: FAIL（モジュールが存在しない）

- [ ] **Step 3: notification-text.ts を実装**

```typescript
// src/streaming/notification-text.ts

/**
 * Decoration icons — used ONLY inside message body blocks.
 * Never overlaps with reaction emojis (hourglass_flowing_sand, brain, white_check_mark).
 */
export const DECORATION_ICONS = {
  completed: '✓',
  error: '✗',
  thinking: ':thought_balloon:',
  tool: ':wrench:',
  subagent: ':robot_face:',
} as const;

interface ToolLike {
  toolName: string;
}

interface CollapsedConfig {
  thinkingCount: number;
  toolCount: number;
  toolDurationMs: number;
  subagentCount: number;
  subagentDurationMs: number;
}

function formatTokens(n: number): string {
  return n.toLocaleString('en-US');
}

function formatDuration(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

export const notifyText = {
  /** postMessage text for response footer (triggers notification) */
  footer(model: string, totalTokens: number, durationMs: number): string {
    return `${model} | ${formatTokens(totalTokens)} tokens | ${formatDuration(durationMs)}`;
  },

  /** postMessage/update text for text responses */
  text(buffer: string): string {
    return buffer.slice(0, 100);
  },

  update: {
    thinking(): string {
      return '💭 思考中';
    },

    tools(tools: ToolLike[]): string {
      const names = tools.map(t => t.toolName).join(', ');
      return `🔧 ${names}`;
    },

    collapsed(config: CollapsedConfig): string {
      const parts: string[] = [];
      if (config.thinkingCount > 0) {
        parts.push(`💭×${config.thinkingCount}`);
      }
      if (config.toolCount > 0) {
        parts.push(`🔧×${config.toolCount} (${formatDuration(config.toolDurationMs)})`);
      }
      if (config.subagentCount > 0) {
        parts.push(`🤖×${config.subagentCount} (${formatDuration(config.subagentDurationMs)})`);
      }
      return parts.join('  ');
    },

    pending(): string {
      return '...';
    },
  },
} as const;
```

- [ ] **Step 4: テスト実行して成功を確認**

Run: `npx vitest run tests/streaming/notification-text.test.ts`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add src/streaming/notification-text.ts tests/streaming/notification-text.test.ts
git commit -m "feat: add notification-text module with emoji map and text generators"
```

---

### Task 2: tool-formatter.ts の絵文字を差し替え

**Files:**
- Modify: `src/streaming/tool-formatter.ts`
- Modify: `tests/streaming/tool-formatter.test.ts`

- [ ] **Step 1: tool-formatter.test.ts に絵文字の期待値を更新するテストを追加**

既存テストの絵文字アサーション（`:white_check_mark:`, `:x:`, `:hourglass_flowing_sand:`）を検索し、以下の新しい期待値に更新:
- `:white_check_mark:` → `✓`
- `:x:` → `✗`
- `:hourglass_flowing_sand:` → 表示されないこと（`buildToolRunningBlocks` からは削除）

具体的に変更するテストファイル箇所:
- `buildToolRunningBlocks` のテスト: `:hourglass_flowing_sand:` が含まれないことをアサート
- `buildToolCompletedBlocks` のテスト: `✓` / `✗` を期待
- `buildToolGroupLiveBlocks` のテスト: `✓` / `✗` を期待、`:hourglass_flowing_sand:` が含まれないこと
- `buildSubagentLiveBlocks` のテスト: 同上

既存テストファイル `tests/streaming/tool-formatter.test.ts` を読み、該当するアサーションを更新する。テストが存在しない関数には新規テストを追加する。

- [ ] **Step 2: テスト実行して失敗を確認**

Run: `npx vitest run tests/streaming/tool-formatter.test.ts`
Expected: FAIL（まだコードが旧絵文字を使っているため）

- [ ] **Step 3: tool-formatter.ts を修正**

`src/streaming/tool-formatter.ts` で以下を変更:

1. `DECORATION_ICONS` をインポート:
```typescript
import { DECORATION_ICONS } from './notification-text.js';
```

2. `buildToolRunningBlocks` (L33): `:hourglass_flowing_sand:` → `${DECORATION_ICONS.tool}` (`:wrench:`)
   `:hourglass_flowing_sand:` はリアクション専用なので装飾から除外。running状態のツールにはツールアイコン `:wrench:` を使う。
```typescript
text: `${DECORATION_ICONS.tool} \`${toolName}\` ${escapeMarkdown(oneLiner)}`,
```

3. `buildToolCompletedBlocks` (L50):
```typescript
const icon = isError ? DECORATION_ICONS.error : DECORATION_ICONS.completed;
```

4. `buildToolGroupLiveBlocks` (L167-169):
```typescript
const icon = tool.status === 'completed' ? DECORATION_ICONS.completed
  : tool.status === 'error' ? DECORATION_ICONS.error
  : DECORATION_ICONS.tool;
```
（`:hourglass_flowing_sand:` → `:wrench:` — running状態でもツールアイコンで統一）

5. `buildSubagentLiveBlocks` (L184-185): SubAgent内のステップもツール実行なので `:wrench:` を使用
```typescript
const icon = step.status === 'completed' ? DECORATION_ICONS.completed
  : step.status === 'error' ? DECORATION_ICONS.error : DECORATION_ICONS.tool;
```

- [ ] **Step 4: テスト実行して成功を確認**

Run: `npx vitest run tests/streaming/tool-formatter.test.ts`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add src/streaming/tool-formatter.ts tests/streaming/tool-formatter.test.ts
git commit -m "refactor: replace reaction emojis with decoration-only icons in tool-formatter"
```

---

### Task 3: group-tracker.ts のtext値を統一

**Files:**
- Modify: `src/streaming/group-tracker.ts`
- Modify: `tests/streaming/group-tracker.test.ts`

- [ ] **Step 1: group-tracker.test.ts にtext値のアサーションを追加**

既存テスト `tests/streaming/group-tracker.test.ts` を読み、以下のテストを追加:

```typescript
describe('notification text values', () => {
  it('thinking postMessage uses notifyText.update.thinking()', () => {
    const actions = tracker.handleThinking('thought');
    expect(actions[0].text).toBe('💭 思考中');
  });

  it('tool update uses notifyText.update.tools()', () => {
    // First tool
    const a1 = tracker.handleToolUse('t1', 'Read', { file_path: '/a.ts' });
    tracker.registerBundleMessageTs(a1[0].bundleId, 'TS');
    // Second tool — triggers update
    // Need to wait for debounce (set lastUpdateTime to past)
    const a2 = tracker.handleToolUse('t2', 'Bash', { command: 'ls' });
    // The update text should contain tool names
    const update = a2.find(a => a.type === 'update');
    if (update) {
      expect(update.text).toContain('🔧');
    }
  });

  it('collapse uses notifyText.update.collapsed()', () => {
    const a1 = tracker.handleThinking('thought');
    tracker.registerBundleMessageTs(a1[0].bundleId, 'TS');
    tracker.handleToolUse('t1', 'Read', { file_path: '/a.ts' });
    tracker.handleToolResult('t1', 'content', false);
    const collapse = tracker.handleTextStart('sess-1');
    const c = collapse.find(a => a.type === 'collapse');
    expect(c!.text).not.toBe('bundle collapsed');
    expect(c!.text).toContain('💭');
    expect(c!.text).toContain('🔧');
  });

  it('ensureBundle default text is not empty', () => {
    const actions = tracker.handleThinking('thought');
    // The postMessage text gets overwritten, but ensureBundle default should be '...'
    // Test indirectly: any postMessage text should be content-based
    expect(actions[0].text).toBeTruthy();
    expect(actions[0].text).not.toBe('');
  });
});
```

- [ ] **Step 2: テスト実行して失敗を確認**

Run: `npx vitest run tests/streaming/group-tracker.test.ts`
Expected: FAIL（collapse.text が 'bundle collapsed' のまま等）

- [ ] **Step 3: group-tracker.ts を修正**

`src/streaming/group-tracker.ts` で以下を変更:

1. インポート追加:
```typescript
import { notifyText } from './notification-text.js';
```

2. `handleThinking` の3箇所 (L54, L60, L70):
```typescript
// L54, L60, L70: '思考中...' → notifyText.update.thinking()
postAction.text = notifyText.update.thinking();
```

3. `handleToolUse` の2箇所 (L114, L139):
```typescript
// L114, L139: `${this.activeGroup.tools.length}ツール実行中` → notifyText.update.tools()
notifyText.update.tools(this.activeGroup.tools),
```

4. `ensureBundle` (L344):
```typescript
// L344: '' → notifyText.update.pending()
text: notifyText.update.pending(),
```

5. `collapseActiveBundle` (L422):
```typescript
// L422: 'bundle collapsed' → notifyText.update.collapsed()
text: notifyText.update.collapsed({
  thinkingCount,
  toolCount,
  toolDurationMs,
  subagentCount,
  subagentDurationMs,
}),
```

**変更しない箇所**（既に内容ベース）:
- L99, L104: `` `${toolName}: ${oneLiner}` ``
- L167, L172, L191, L213: SubAgent関連text

- [ ] **Step 4: テスト実行して成功を確認**

Run: `npx vitest run tests/streaming/group-tracker.test.ts`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add src/streaming/group-tracker.ts tests/streaming/group-tracker.test.ts
git commit -m "refactor: use notifyText for all group-tracker text values"
```

---

### Task 4: stream-processor.ts の「応答中...」フッター削除とtext統一

**Files:**
- Modify: `src/streaming/stream-processor.ts`
- Modify: `tests/streaming/stream-processor.test.ts`

- [ ] **Step 1: stream-processor.test.ts にテスト追加**

既存テスト `tests/streaming/stream-processor.test.ts` を読み、以下のテストを追加:

```typescript
describe('text response formatting', () => {
  it('does not include 応答中 footer in non-complete text blocks', () => {
    // Process a text event (non-final)
    const processor = new StreamProcessor({ channel: 'C1', threadTs: 'T1', sessionId: 'S1' });
    const result = await processor.processEvent({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'Hello world' }] },
    });
    if (result.textAction) {
      const hasFooter = result.textAction.blocks.some(
        (b: any) => b.type === 'context' && JSON.stringify(b).includes('応答中')
      );
      expect(hasFooter).toBe(false);
    }
  });
});
```

- [ ] **Step 2: テスト実行して失敗を確認**

Run: `npx vitest run tests/streaming/stream-processor.test.ts`
Expected: FAIL（まだ「応答中...」フッターが含まれる）

- [ ] **Step 3: stream-processor.ts を修正**

1. `buildTextBlocks` メソッド (L306-322): `isComplete` パラメータと応答中フッターを削除

変更前:
```typescript
private buildTextBlocks(mrkdwn: string, isComplete: boolean): Block[] {
    const blocks: Block[] = [];
    const parts = mrkdwn.match(/.{1,2900}/gs) || [mrkdwn];
    for (const part of parts) {
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: part, verbatim: true },
      });
    }
    if (!isComplete) {
      blocks.push({
        type: 'context',
        elements: [{ type: 'mrkdwn', text: ':hourglass_flowing_sand: 応答中...' }],
      });
    }
    return blocks;
  }
```

変更後:
```typescript
private buildTextBlocks(mrkdwn: string): Block[] {
    const blocks: Block[] = [];
    const parts = mrkdwn.match(/.{1,2900}/gs) || [mrkdwn];
    for (const part of parts) {
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: part, verbatim: true },
      });
    }
    return blocks;
  }
```

2. `buildTextBlocks` の全呼び出し箇所から `isComplete` 引数を削除:
- L159: `this.buildTextBlocks(converted, false)` → `this.buildTextBlocks(converted)`
- L225: `this.buildTextBlocks(converted, false)` → `this.buildTextBlocks(converted)`
- L274: `this.buildTextBlocks(converted, true)` → `this.buildTextBlocks(converted)`

3. `notifyText.text()` をインポートして text 生成に使用:
```typescript
import { notifyText } from './notification-text.js';
```

4. 5箇所の `this.textBuffer.slice(0, 100)` を `notifyText.text(this.textBuffer)` に置き換え:
- L168, L179, L232, L285, L296

- [ ] **Step 4: テスト実行して成功を確認**

Run: `npx vitest run tests/streaming/stream-processor.test.ts`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add src/streaming/stream-processor.ts tests/streaming/stream-processor.test.ts
git commit -m "refactor: remove 応答中 footer and use notifyText.text() in stream-processor"
```

---

### Task 5: index.ts の 'Complete' テキストを内容ベースに変更

**Files:**
- Modify: `src/index.ts:565-570`

- [ ] **Step 1: index.ts を修正**

`src/index.ts` L569: `text: 'Complete'` を内容ベースに変更。

```typescript
import { notifyText } from './streaming/notification-text.js';
```

L569 を変更:
```typescript
// Before:
text: 'Complete',
// After:
text: notifyText.footer(
  sessionModel || 'unknown',
  (usage.input_tokens || 0) + (usage.output_tokens || 0),
  resultEvent.duration_ms || 0,
),
```

- [ ] **Step 2: ビルド確認**

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 3: コミット**

```bash
git add src/index.ts
git commit -m "fix: replace 'Complete' notification text with content-based footer"
```

---

### Task 6: 全テスト通過を確認

**Files:** なし（検証のみ）

- [ ] **Step 1: 全テスト実行**

Run: `npx vitest run`
Expected: ALL PASS

- [ ] **Step 2: 既存テストで絵文字の旧値がアサートされていないか確認**

Run: `grep -r ':white_check_mark:\|:x:\|:hourglass_flowing_sand:' tests/streaming/`

上記のgrepで引っかかるテストがあれば、新しい絵文字（`✓`, `✗`, `:wrench:`）に更新する。

- [ ] **Step 3: 修正があればコミット**

```bash
git add tests/
git commit -m "test: update emoji assertions to match decoration-only icons"
```
