# Streaming Display V2 Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ストリーミング表示を再設計し、順序保証 + 折りたたみ表示 + モーダル詳細を実現する

**Architecture:** SerialActionQueueでイベント処理をエンドツーエンドでシリアル化。GroupTrackerが時系列グループ（thinking/tool/subagent）を管理し、ライブ表示→折りたたみ遷移を制御。StreamProcessorはGroupAction[]を返り値として返し、呼び出し側がSlack API実行を順番にawaitする。

**Tech Stack:** TypeScript, Slack Bolt SDK (@slack/bolt), Vitest, Node.js EventEmitter

**Spec:** `docs/superpowers/specs/2026-03-17-streaming-display-v2-design.md`

---

## File Structure Overview

### New Files
| File | Responsibility |
|------|---------------|
| `src/streaming/serial-action-queue.ts` | イベント処理のシリアル化。enqueue → 1つずつawait |
| `src/streaming/group-tracker.ts` | 時系列グループ管理。ライブ表示→折りたたみ遷移制御 |
| `src/streaming/subagent-jsonl-reader.ts` | SubAgent JSONLファイルの読み込み・整形 |

### Modified Files
| File | Changes |
|------|---------|
| `src/streaming/types.ts` | GroupAction, GroupCategory, ProcessedActions 型追加 |
| `src/streaming/tool-formatter.ts` | ライブ表示ブロック + 折りたたみブロック追加 |
| `src/streaming/tool-result-cache.ts` | グループデータキャッシュ追加 |
| `src/streaming/stream-processor.ts` | GroupTrackerベースに全面改修。返り値方式に変更 |
| `src/slack/modal-builder.ts` | 思考/ツールグループ/SubAgentモーダル追加 |
| `src/index.ts` | SerialActionQueue統合、モーダルハンドラ拡張 |

### Deleted Files
| File | Reason |
|------|--------|
| `src/streaming/batch-aggregator.ts` | GroupTrackerに置き換え |
| `src/streaming/subagent-tracker.ts` | GroupTrackerに統合 |
| `src/streaming/priority-queue.ts` | 未使用 |
| `src/streaming/text-stream-updater.ts` | 未使用 |

### Test Files
| File | Scope |
|------|-------|
| `tests/streaming/serial-action-queue.test.ts` | 新規 |
| `tests/streaming/group-tracker.test.ts` | 新規 |
| `tests/streaming/subagent-jsonl-reader.test.ts` | 新規 |
| `tests/streaming/tool-formatter.test.ts` | 既存を更新 |
| `tests/streaming/stream-processor.test.ts` | 既存を全面書き換え |
| `tests/slack/modal-builder.test.ts` | 既存を全面書き換え |

---

## Chunk 1: 基盤 — 型定義 + SerialActionQueue

### Task 1.1: 型定義の拡張

**Files:**
- Modify: `src/streaming/types.ts`

- [ ] **Step 1: GroupAction, GroupCategory, ProcessedActions 型を追加**

`src/streaming/types.ts` の末尾に以下を追加する：

```typescript
// --- Group Tracking ---

export type GroupCategory = 'thinking' | 'tool' | 'subagent';

export interface GroupToolInfo {
  toolUseId: string;
  toolName: string;
  input: Record<string, unknown>;
  oneLiner: string;
  status: 'running' | 'completed' | 'error';
  startTime: number;   // Date.now() when tool_use received
  durationMs?: number;
  result?: string;
  isError?: boolean;
}

export interface GroupStepInfo {
  toolName: string;
  toolUseId: string;
  oneLiner: string;
  status: 'running' | 'completed' | 'error';
}

export interface ActiveGroup {
  id: string;
  category: GroupCategory;
  messageTs: string | null;
  startTime: number;
  lastUpdateTime: number;

  // thinking
  thinkingTexts: string[];

  // tool
  tools: GroupToolInfo[];

  // subagent
  agentToolUseId?: string;
  agentDescription?: string;
  agentId?: string; // extracted from tool_result for JSONL lookup
  agentSteps: GroupStepInfo[];
}

export type GroupAction =
  | { type: 'postMessage'; groupId: string; blocks: Block[]; text: string; category: GroupCategory }
  | { type: 'update'; groupId: string; messageTs: string; blocks: Block[]; text: string; category: GroupCategory }
  | { type: 'collapse'; groupId: string; messageTs: string; blocks: Block[]; text: string; category: GroupCategory };

export interface ProcessedActions {
  groupActions: GroupAction[];
  textAction?: SlackAction;
  resultEvent?: any;
}

// Reusable block type
export type Block = Record<string, unknown>;
```

- [ ] **Step 2: 型チェック確認**

```bash
npx tsc --noEmit && echo "✅ types pass"
```

- [ ] **Step 3: コミット**

```bash
git add src/streaming/types.ts
git commit -m "feat(streaming-v2): add GroupAction, GroupCategory, ProcessedActions types"
```

### Task 1.2: SerialActionQueue

**Files:**
- Create: `src/streaming/serial-action-queue.ts`
- Test: `tests/streaming/serial-action-queue.test.ts`

- [ ] **Step 1: テストを書く**

```typescript
// tests/streaming/serial-action-queue.test.ts
import { describe, it, expect, vi } from 'vitest';
import { SerialActionQueue } from '../../src/streaming/serial-action-queue.js';

describe('SerialActionQueue', () => {
  it('executes tasks in order', async () => {
    const queue = new SerialActionQueue();
    const order: number[] = [];

    queue.enqueue(async () => {
      await new Promise(r => setTimeout(r, 50));
      order.push(1);
    });
    queue.enqueue(async () => {
      await new Promise(r => setTimeout(r, 10));
      order.push(2);
    });
    queue.enqueue(async () => {
      order.push(3);
    });

    // Wait for all to complete
    await queue.drain();

    expect(order).toEqual([1, 2, 3]);
  });

  it('continues processing after task error', async () => {
    const queue = new SerialActionQueue();
    const order: number[] = [];
    const errorHandler = vi.fn();

    queue.onError(errorHandler);

    queue.enqueue(async () => { order.push(1); });
    queue.enqueue(async () => { throw new Error('task failed'); });
    queue.enqueue(async () => { order.push(3); });

    await queue.drain();

    expect(order).toEqual([1, 3]);
    expect(errorHandler).toHaveBeenCalledOnce();
  });

  it('handles concurrent enqueue correctly', async () => {
    const queue = new SerialActionQueue();
    const order: number[] = [];

    // Enqueue multiple tasks rapidly
    for (let i = 0; i < 10; i++) {
      queue.enqueue(async () => {
        await new Promise(r => setTimeout(r, 5));
        order.push(i);
      });
    }

    await queue.drain();

    expect(order).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('drain resolves immediately when empty', async () => {
    const queue = new SerialActionQueue();
    await queue.drain(); // should not hang
  });
});
```

- [ ] **Step 2: テストが失敗することを確認**

```bash
npx vitest run tests/streaming/serial-action-queue.test.ts 2>&1 | tail -5
```

Expected: FAIL — module not found

- [ ] **Step 3: 実装**

```typescript
// src/streaming/serial-action-queue.ts
import { logger } from '../utils/logger.js';

type ErrorHandler = (error: Error) => void;

export class SerialActionQueue {
  private queue: Array<() => Promise<void>> = [];
  private processing = false;
  private drainResolvers: Array<() => void> = [];
  private errorHandler: ErrorHandler | null = null;

  onError(handler: ErrorHandler): void {
    this.errorHandler = handler;
  }

  enqueue(task: () => Promise<void>): void {
    this.queue.push(task);
    if (!this.processing) {
      this.processNext();
    }
  }

  async drain(): Promise<void> {
    if (this.queue.length === 0 && !this.processing) return;
    return new Promise<void>((resolve) => {
      this.drainResolvers.push(resolve);
    });
  }

  private async processNext(): Promise<void> {
    if (this.queue.length === 0) {
      this.processing = false;
      for (const resolve of this.drainResolvers) resolve();
      this.drainResolvers = [];
      return;
    }

    this.processing = true;
    const task = this.queue.shift()!;

    try {
      await task();
    } catch (err) {
      logger.error('SerialActionQueue task error', { error: (err as Error).message });
      if (this.errorHandler) {
        this.errorHandler(err as Error);
      }
    }

    await this.processNext();
  }
}
```

- [ ] **Step 4: テストがパスすることを確認**

```bash
npx vitest run tests/streaming/serial-action-queue.test.ts && echo "✅ PASS"
```

- [ ] **Step 5: コミット**

```bash
git add src/streaming/serial-action-queue.ts tests/streaming/serial-action-queue.test.ts
git commit -m "feat(streaming-v2): add SerialActionQueue for ordered event processing"
```

---

## Chunk 2: ToolFormatter — ライブ表示 + 折りたたみブロック

### Task 2.1: ToolFormatter ライブ表示関数

**Files:**
- Modify: `src/streaming/tool-formatter.ts`
- Modify: `tests/streaming/tool-formatter.test.ts`

- [ ] **Step 1: テストを追加**

`tests/streaming/tool-formatter.test.ts` に以下を追加する：

```typescript
import {
  // 既存のimport...
  buildThinkingLiveBlocks,
  buildToolGroupLiveBlocks,
  buildSubagentLiveBlocks,
} from '../../src/streaming/tool-formatter.js';

describe('buildThinkingLiveBlocks', () => {
  it('builds context blocks with italic text', () => {
    const blocks = buildThinkingLiveBlocks(['考えています...']);
    expect(blocks.length).toBeGreaterThanOrEqual(1);
    // All blocks should be context type (thin/grey display)
    for (const b of blocks) {
      expect(b.type).toBe('context');
    }
    // Should contain thinking emoji
    const allText = JSON.stringify(blocks);
    expect(allText).toContain('thought_balloon');
    expect(allText).toContain('思考中');
  });

  it('includes all thinking texts for multiple thoughts', () => {
    const blocks = buildThinkingLiveBlocks(['First thought', 'Second thought']);
    const allText = JSON.stringify(blocks);
    expect(allText).toContain('First thought');
    expect(allText).toContain('Second thought');
  });

  it('truncates long thinking text', () => {
    const blocks = buildThinkingLiveBlocks(['a'.repeat(500)]);
    // The thinking text should be truncated to ~200 chars
    const textBlock = blocks.find(b => JSON.stringify(b).includes('aaa'));
    const textContent = JSON.stringify(textBlock);
    expect(textContent).toContain('...');
    expect(textContent.length).toBeLessThan(500);
  });
});

describe('buildToolGroupLiveBlocks', () => {
  it('builds context blocks for running tools', () => {
    const blocks = buildToolGroupLiveBlocks([
      { toolName: 'Read', oneLiner: 'src/auth.ts', status: 'running' },
    ]);
    for (const b of blocks) {
      expect(b.type).toBe('context');
    }
    const allText = JSON.stringify(blocks);
    expect(allText).toContain('Read');
    expect(allText).toContain('src/auth.ts');
    expect(allText).toContain('hourglass');
  });

  it('shows completed tools with checkmark', () => {
    const blocks = buildToolGroupLiveBlocks([
      { toolName: 'Read', oneLiner: 'src/auth.ts', status: 'completed', durationMs: 300 },
      { toolName: 'Bash', oneLiner: 'npm test', status: 'running' },
    ]);
    const allText = JSON.stringify(blocks);
    expect(allText).toContain('white_check_mark');
    expect(allText).toContain('hourglass');
  });

  it('handles 10+ tools with single context block', () => {
    const tools = Array.from({ length: 12 }, (_, i) => ({
      toolName: 'Read',
      oneLiner: `file${i}.ts`,
      status: 'completed' as const,
      durationMs: 100,
    }));
    const blocks = buildToolGroupLiveBlocks(tools);
    // context block has max 10 elements, should not exceed
    for (const b of blocks) {
      if (b.type === 'context') {
        expect((b.elements as any[]).length).toBeLessThanOrEqual(10);
      }
    }
  });
});

describe('buildSubagentLiveBlocks', () => {
  it('builds context blocks for subagent', () => {
    const blocks = buildSubagentLiveBlocks('コード探索', [
      { toolName: 'Grep', oneLiner: 'handleAuth', status: 'completed' },
      { toolName: 'Read', oneLiner: 'src/auth.ts', status: 'running' },
    ]);
    for (const b of blocks) {
      expect(b.type).toBe('context');
    }
    const allText = JSON.stringify(blocks);
    expect(allText).toContain('SubAgent');
    expect(allText).toContain('コード探索');
  });
});
```

- [ ] **Step 2: テストが失敗することを確認**

```bash
npx vitest run tests/streaming/tool-formatter.test.ts 2>&1 | tail -5
```

Expected: FAIL — functions not exported

- [ ] **Step 3: ライブ表示関数を実装**

まず `src/streaming/tool-formatter.ts` 先頭のローカル `type Block = Record<string, unknown>;` を削除し、`import type { Block } from './types.js';` に置き換える。

次に以下を追加する：

```typescript
// --- Live display blocks (context blocks for thin/grey appearance) ---

interface LiveToolInfo {
  toolName: string;
  oneLiner: string;
  status: 'running' | 'completed' | 'error';
  durationMs?: number;
}

interface LiveStepInfo {
  toolName: string;
  oneLiner: string;
  status: 'running' | 'completed' | 'error';
}

export function buildThinkingLiveBlocks(texts: string[]): Block[] {
  const blocks: Block[] = [
    {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: ':thought_balloon: _思考中..._' }],
    },
  ];

  for (const text of texts) {
    const snippet = truncate(text.trim(), 200);
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `_${escapeMarkdown(snippet)}_` }],
    });
  }

  return blocks;
}

export function buildToolGroupLiveBlocks(tools: LiveToolInfo[]): Block[] {
  const lines: string[] = [];
  for (const tool of tools) {
    const icon = tool.status === 'completed' ? ':white_check_mark:'
      : tool.status === 'error' ? ':x:'
      : ':hourglass_flowing_sand:';
    const duration = tool.durationMs != null ? ` (${(tool.durationMs / 1000).toFixed(1)}s)` : '';
    const suffix = tool.status === 'running' ? ' — 実行中...' : duration;
    lines.push(`${icon} \`${tool.toolName}\` ${escapeMarkdown(tool.oneLiner)}${suffix}`);
  }

  // Slack context block allows max 10 elements.
  // Concatenate into mrkdwn strings, max 10 per context block.
  return buildContextBlocksFromLines(lines);
}

export function buildSubagentLiveBlocks(description: string, steps: LiveStepInfo[]): Block[] {
  const headerBlock: Block = {
    type: 'context',
    elements: [{ type: 'mrkdwn', text: `:robot_face: *SubAgent:* _${escapeMarkdown(truncate(description, 60))}_ — 実行中...` }],
  };

  const stepLines: string[] = [];
  for (const step of steps) {
    const icon = step.status === 'completed' ? ':white_check_mark:'
      : step.status === 'error' ? ':x:'
      : ':hourglass_flowing_sand:';
    stepLines.push(`  ${icon} \`${step.toolName}\` ${escapeMarkdown(step.oneLiner)}`);
  }

  const stepBlocks = buildContextBlocksFromLines(stepLines);

  return [headerBlock, ...stepBlocks];
}

function buildContextBlocksFromLines(lines: string[]): Block[] {
  // Each context block can have max 10 elements.
  // Use 1 mrkdwn element per line, up to 10 per block.
  const blocks: Block[] = [];
  for (let i = 0; i < lines.length; i += 10) {
    const chunk = lines.slice(i, i + 10);
    blocks.push({
      type: 'context',
      elements: chunk.map(line => ({ type: 'mrkdwn', text: line })),
    });
  }
  if (blocks.length === 0) {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: '実行中...' }],
    });
  }
  return blocks;
}
```

- [ ] **Step 4: テストがパスすることを確認**

```bash
npx vitest run tests/streaming/tool-formatter.test.ts && echo "✅ PASS"
```

- [ ] **Step 5: コミット**

```bash
git add src/streaming/tool-formatter.ts tests/streaming/tool-formatter.test.ts
git commit -m "feat(streaming-v2): add live display block builders (context blocks)"
```

### Task 2.2: ToolFormatter 折りたたみ表示関数

**Files:**
- Modify: `src/streaming/tool-formatter.ts`
- Modify: `tests/streaming/tool-formatter.test.ts`

- [ ] **Step 1: テストを追加**

`tests/streaming/tool-formatter.test.ts` に以下を追加する：

```typescript
import {
  // 既存のimport + Task 2.1のimport...
  buildThinkingCollapsedBlocks,
  buildToolGroupCollapsedBlocks,
  buildSubagentCollapsedBlocks,
} from '../../src/streaming/tool-formatter.js';

describe('buildThinkingCollapsedBlocks', () => {
  it('builds collapsed thinking with detail button', () => {
    const blocks = buildThinkingCollapsedBlocks(2, 'group-123');
    const allText = JSON.stringify(blocks);
    expect(allText).toContain('思考完了');
    expect(allText).toContain('2回');
    expect(allText).toContain('view_group_detail:group-123');
    expect(allText).toContain('詳細を見る');
  });

  it('omits count when 1', () => {
    const blocks = buildThinkingCollapsedBlocks(1, 'group-1');
    const allText = JSON.stringify(blocks);
    expect(allText).toContain('思考完了');
    expect(allText).not.toContain('1回');
  });
});

describe('buildToolGroupCollapsedBlocks', () => {
  it('builds collapsed tool group with counts', () => {
    const blocks = buildToolGroupCollapsedBlocks(
      [
        { toolName: 'Read', count: 2 },
        { toolName: 'Bash', count: 1 },
      ],
      1500,
      'group-456',
    );
    const allText = JSON.stringify(blocks);
    expect(allText).toContain('Read × 2');
    expect(allText).toContain('Bash × 1');
    expect(allText).toContain('完了');
    expect(allText).toContain('1.5s');
    expect(allText).toContain('view_group_detail:group-456');
  });
});

describe('buildSubagentCollapsedBlocks', () => {
  it('builds collapsed subagent with description', () => {
    const blocks = buildSubagentCollapsedBlocks('コード探索', 5200, 'group-789');
    const allText = JSON.stringify(blocks);
    expect(allText).toContain('SubAgent');
    expect(allText).toContain('コード探索');
    expect(allText).toContain('完了');
    expect(allText).toContain('5.2s');
    expect(allText).toContain('view_group_detail:group-789');
  });
});
```

- [ ] **Step 2: テストが失敗することを確認**

```bash
npx vitest run tests/streaming/tool-formatter.test.ts 2>&1 | tail -5
```

Expected: FAIL — functions not exported

- [ ] **Step 3: 折りたたみ表示関数を実装**

`src/streaming/tool-formatter.ts` に以下を追加する：

```typescript
// --- Collapsed display blocks (1-line summary + detail button) ---

interface ToolCountSummary {
  toolName: string;
  count: number;
}

export function buildThinkingCollapsedBlocks(count: number, groupId: string): Block[] {
  const countStr = count > 1 ? ` (${count}回)` : '';
  return [
    {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `:thought_balloon: 思考完了${countStr}` }],
    },
    {
      type: 'actions',
      elements: [{
        type: 'button',
        text: { type: 'plain_text', text: '詳細を見る' },
        action_id: `view_group_detail:${groupId}`,
      }],
    },
  ];
}

export function buildToolGroupCollapsedBlocks(
  tools: ToolCountSummary[],
  totalDurationMs: number,
  groupId: string,
): Block[] {
  const toolStr = tools.map(t => `${t.toolName} × ${t.count}`).join(', ');
  const durationStr = `${(totalDurationMs / 1000).toFixed(1)}s`;

  return [
    {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `:wrench: ${toolStr} 完了 (${durationStr})` }],
    },
    {
      type: 'actions',
      elements: [{
        type: 'button',
        text: { type: 'plain_text', text: '詳細を見る' },
        action_id: `view_group_detail:${groupId}`,
      }],
    },
  ];
}

export function buildSubagentCollapsedBlocks(
  description: string,
  totalDurationMs: number,
  groupId: string,
): Block[] {
  const durationStr = `${(totalDurationMs / 1000).toFixed(1)}s`;

  return [
    {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `:robot_face: SubAgent: "${escapeMarkdown(truncate(description, 40))}" 完了 (${durationStr})` }],
    },
    {
      type: 'actions',
      elements: [{
        type: 'button',
        text: { type: 'plain_text', text: '詳細を見る' },
        action_id: `view_group_detail:${groupId}`,
      }],
    },
  ];
}
```

- [ ] **Step 4: テストがパスすることを確認**

```bash
npx vitest run tests/streaming/tool-formatter.test.ts && echo "✅ PASS"
```

- [ ] **Step 5: コミット**

```bash
git add src/streaming/tool-formatter.ts tests/streaming/tool-formatter.test.ts
git commit -m "feat(streaming-v2): add collapsed display block builders with detail buttons"
```

---

## Chunk 3: GroupTracker

### Task 3.1: GroupTracker — thinking グループ

**Files:**
- Create: `src/streaming/group-tracker.ts`
- Create: `tests/streaming/group-tracker.test.ts`

- [ ] **Step 1: thinking グループのテストを書く**

```typescript
// tests/streaming/group-tracker.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { GroupTracker } from '../../src/streaming/group-tracker.js';

describe('GroupTracker', () => {
  let tracker: GroupTracker;

  beforeEach(() => {
    tracker = new GroupTracker();
  });

  describe('thinking groups', () => {
    it('creates a new group on first thinking', () => {
      const actions = tracker.handleThinking('First thought');
      expect(actions).toHaveLength(1);
      expect(actions[0].type).toBe('postMessage');
      expect(actions[0].category).toBe('thinking');
    });

    it('updates existing group on subsequent thinking', () => {
      const first = tracker.handleThinking('First thought');
      const groupId = first[0].groupId;
      // Register messageTs (simulating Slack API callback)
      tracker.registerMessageTs(groupId, 'MSG_TS_1');

      const second = tracker.handleThinking('Second thought');
      // Should emit update (not postMessage)
      expect(second.length).toBeGreaterThanOrEqual(1);
      const updateAction = second.find(a => a.type === 'update');
      expect(updateAction).toBeDefined();
      expect(updateAction!.groupId).toBe(groupId);
    });

    it('collapses thinking group when tool arrives', () => {
      const first = tracker.handleThinking('Thinking...');
      const groupId = first[0].groupId;
      tracker.registerMessageTs(groupId, 'MSG_TS_1');

      const actions = tracker.handleToolUse('toolu_001', 'Read', { file_path: '/a.ts' });
      // Should include: collapse for thinking + postMessage for tool group
      const collapseAction = actions.find(a => a.type === 'collapse');
      const postAction = actions.find(a => a.type === 'postMessage');
      expect(collapseAction).toBeDefined();
      expect(collapseAction!.groupId).toBe(groupId);
      expect(postAction).toBeDefined();
      expect(postAction!.category).toBe('tool');
    });

    it('collapses thinking group when text arrives', () => {
      const first = tracker.handleThinking('Thinking...');
      const groupId = first[0].groupId;
      tracker.registerMessageTs(groupId, 'MSG_TS_1');

      const actions = tracker.handleTextStart();
      const collapseAction = actions.find(a => a.type === 'collapse');
      expect(collapseAction).toBeDefined();
      expect(collapseAction!.groupId).toBe(groupId);
    });
  });
});
```

- [ ] **Step 2: テストが失敗することを確認**

```bash
npx vitest run tests/streaming/group-tracker.test.ts 2>&1 | tail -5
```

- [ ] **Step 3: GroupTracker の thinking 部分を実装**

```typescript
// src/streaming/group-tracker.ts
import {
  buildThinkingLiveBlocks,
  buildThinkingCollapsedBlocks,
  buildToolGroupLiveBlocks,
  buildToolGroupCollapsedBlocks,
  buildSubagentLiveBlocks,
  buildSubagentCollapsedBlocks,
  getToolOneLiner,
  getToolResultSummary,
} from './tool-formatter.js';
import type {
  GroupAction,
  GroupCategory,
  ActiveGroup,
  GroupToolInfo,
  GroupStepInfo,
  Block,
} from './types.js';

const DEBOUNCE_MS = 500;

export class GroupTracker {
  private activeGroup: ActiveGroup | null = null;
  private completedGroups: Map<string, ActiveGroup> = new Map();
  private groupCounter = 0;

  handleThinking(text: string): GroupAction[] {
    const actions: GroupAction[] = [];

    if (this.activeGroup && this.activeGroup.category !== 'thinking') {
      // Different category active — collapse it first
      actions.push(...this.collapseActiveGroup());
    }

    if (!this.activeGroup) {
      // Start new thinking group
      const group = this.createGroup('thinking');
      group.thinkingTexts.push(text);
      this.activeGroup = group;

      actions.push({
        type: 'postMessage',
        groupId: group.id,
        blocks: buildThinkingLiveBlocks(group.thinkingTexts),
        text: '思考中...',
        category: 'thinking',
      });
    } else {
      // Same thinking group — add text and update
      this.activeGroup.thinkingTexts.push(text);

      if (this.activeGroup.messageTs && this.shouldEmitUpdate()) {
        this.activeGroup.lastUpdateTime = Date.now();
        actions.push({
          type: 'update',
          groupId: this.activeGroup.id,
          messageTs: this.activeGroup.messageTs,
          blocks: buildThinkingLiveBlocks(this.activeGroup.thinkingTexts),
          text: '思考中...',
          category: 'thinking',
        });
      }
    }

    return actions;
  }

  handleToolUse(toolUseId: string, toolName: string, input: Record<string, unknown>): GroupAction[] {
    const actions: GroupAction[] = [];
    const oneLiner = getToolOneLiner(toolName, input);

    if (this.activeGroup && this.activeGroup.category !== 'tool') {
      actions.push(...this.collapseActiveGroup());
    }

    if (!this.activeGroup) {
      const group = this.createGroup('tool');
      group.tools.push({ toolUseId, toolName, input, oneLiner, status: 'running', startTime: Date.now() });
      this.activeGroup = group;

      actions.push({
        type: 'postMessage',
        groupId: group.id,
        blocks: buildToolGroupLiveBlocks(group.tools),
        text: `${toolName}: ${oneLiner}`,
        category: 'tool',
      });
    } else {
      // Same tool group — add tool and update
      this.activeGroup.tools.push({ toolUseId, toolName, input, oneLiner, status: 'running', startTime: Date.now() });

      if (this.activeGroup.messageTs && this.shouldEmitUpdate()) {
        this.activeGroup.lastUpdateTime = Date.now();
        actions.push({
          type: 'update',
          groupId: this.activeGroup.id,
          messageTs: this.activeGroup.messageTs,
          blocks: buildToolGroupLiveBlocks(this.activeGroup.tools),
          text: `${this.activeGroup.tools.length}ツール実行中`,
          category: 'tool',
        });
      }
    }

    return actions;
  }

  handleToolResult(toolUseId: string, result: string, isError: boolean): GroupAction[] {
    const actions: GroupAction[] = [];

    if (!this.activeGroup || this.activeGroup.category !== 'tool') return actions;

    const tool = this.activeGroup.tools.find(t => t.toolUseId === toolUseId);
    if (!tool) return actions;

    tool.status = isError ? 'error' : 'completed';
    tool.durationMs = Date.now() - tool.startTime;
    tool.result = result;
    tool.isError = isError;

    // Check if all tools in group are completed
    const allDone = this.activeGroup.tools.every(t => t.status !== 'running');

    if (allDone) {
      // Collapse
      actions.push(...this.collapseActiveGroup());
    } else if (this.activeGroup.messageTs && this.shouldEmitUpdate()) {
      // Update live display
      this.activeGroup.lastUpdateTime = Date.now();
      actions.push({
        type: 'update',
        groupId: this.activeGroup.id,
        messageTs: this.activeGroup.messageTs,
        blocks: buildToolGroupLiveBlocks(this.activeGroup.tools),
        text: `${this.activeGroup.tools.length}ツール実行中`,
      });
    }

    return actions;
  }

  handleSubagentStart(toolUseId: string, description: string): GroupAction[] {
    const actions: GroupAction[] = [];

    if (this.activeGroup) {
      actions.push(...this.collapseActiveGroup());
    }

    const group = this.createGroup('subagent');
    group.agentToolUseId = toolUseId;
    group.agentDescription = description;
    this.activeGroup = group;

    actions.push({
      type: 'postMessage',
      groupId: group.id,
      blocks: buildSubagentLiveBlocks(description, []),
      text: `SubAgent: ${description}`,
      category: 'subagent',
    });

    return actions;
  }

  handleSubagentStep(agentToolUseId: string, toolName: string, toolUseId: string, oneLiner: string): GroupAction[] {
    const actions: GroupAction[] = [];

    if (!this.activeGroup || this.activeGroup.category !== 'subagent') return actions;
    if (this.activeGroup.agentToolUseId !== agentToolUseId) return actions;

    this.activeGroup.agentSteps.push({ toolName, toolUseId, oneLiner, status: 'running' });

    if (this.activeGroup.messageTs && this.shouldEmitUpdate()) {
      this.activeGroup.lastUpdateTime = Date.now();
      actions.push({
        type: 'update',
        groupId: this.activeGroup.id,
        messageTs: this.activeGroup.messageTs,
        blocks: buildSubagentLiveBlocks(this.activeGroup.agentDescription || '', this.activeGroup.agentSteps),
        text: `SubAgent: ${this.activeGroup.agentDescription}`,
        category: 'subagent',
      });
    }

    return actions;
  }

  handleSubagentStepResult(agentToolUseId: string, toolUseId: string, isError: boolean): GroupAction[] {
    const actions: GroupAction[] = [];

    if (!this.activeGroup || this.activeGroup.category !== 'subagent') return actions;
    if (this.activeGroup.agentToolUseId !== agentToolUseId) return actions;

    const step = this.activeGroup.agentSteps.find(s => s.toolUseId === toolUseId);
    if (step) {
      step.status = isError ? 'error' : 'completed';
    }

    if (this.activeGroup.messageTs && this.shouldEmitUpdate()) {
      this.activeGroup.lastUpdateTime = Date.now();
      actions.push({
        type: 'update',
        groupId: this.activeGroup.id,
        messageTs: this.activeGroup.messageTs,
        blocks: buildSubagentLiveBlocks(this.activeGroup.agentDescription || '', this.activeGroup.agentSteps),
        text: `SubAgent: ${this.activeGroup.agentDescription}`,
        category: 'subagent',
      });
    }

    return actions;
  }

  handleSubagentComplete(agentToolUseId: string, result: string, durationMs: number): GroupAction[] {
    if (!this.activeGroup || this.activeGroup.category !== 'subagent') return [];
    if (this.activeGroup.agentToolUseId !== agentToolUseId) return [];

    return this.collapseActiveGroup();
  }

  handleTextStart(): GroupAction[] {
    if (!this.activeGroup) return [];
    return this.collapseActiveGroup();
  }

  flushActiveGroup(): GroupAction[] {
    if (!this.activeGroup) return [];
    // Mark incomplete tools as interrupted
    if (this.activeGroup.category === 'tool') {
      for (const tool of this.activeGroup.tools) {
        if (tool.status === 'running') tool.status = 'error';
      }
    }
    if (this.activeGroup.category === 'subagent') {
      for (const step of this.activeGroup.agentSteps) {
        if (step.status === 'running') step.status = 'error';
      }
    }
    return this.collapseActiveGroup();
  }

  registerMessageTs(groupId: string, messageTs: string): void {
    if (this.activeGroup && this.activeGroup.id === groupId) {
      this.activeGroup.messageTs = messageTs;
    }
  }

  setAgentId(groupId: string, agentId: string): void {
    if (this.activeGroup && this.activeGroup.id === groupId) {
      this.activeGroup.agentId = agentId;
    }
    const completed = this.completedGroups.get(groupId);
    if (completed) {
      completed.agentId = agentId;
    }
  }

  getGroupData(groupId: string): ActiveGroup | undefined {
    if (this.activeGroup && this.activeGroup.id === groupId) {
      return this.activeGroup;
    }
    return this.completedGroups.get(groupId);
  }

  private shouldEmitUpdate(): boolean {
    if (!this.activeGroup) return false;
    return Date.now() - this.activeGroup.lastUpdateTime >= DEBOUNCE_MS;
  }

  private collapseActiveGroup(): GroupAction[] {
    const group = this.activeGroup;
    if (!group) return [];

    this.activeGroup = null;
    this.completedGroups.set(group.id, group);

    if (!group.messageTs) return [];

    const blocks = this.buildCollapseBlocks(group);
    return [{
      type: 'collapse',
      groupId: group.id,
      messageTs: group.messageTs,
      blocks,
      text: this.buildCollapseText(group),
      category: group.category,
    }];
  }

  private buildCollapseBlocks(group: ActiveGroup): Block[] {
    switch (group.category) {
      case 'thinking':
        return buildThinkingCollapsedBlocks(group.thinkingTexts.length, group.id);
      case 'tool': {
        const counts = new Map<string, number>();
        for (const t of group.tools) {
          counts.set(t.toolName, (counts.get(t.toolName) || 0) + 1);
        }
        const toolSummaries = [...counts.entries()].map(([toolName, count]) => ({ toolName, count }));
        const totalDuration = group.tools.reduce((sum, t) => sum + (t.durationMs || 0), 0);
        return buildToolGroupCollapsedBlocks(toolSummaries, totalDuration, group.id);
      }
      case 'subagent': {
        const totalDuration = Date.now() - group.startTime;
        return buildSubagentCollapsedBlocks(group.agentDescription || 'SubAgent', totalDuration, group.id);
      }
    }
  }

  private buildCollapseText(group: ActiveGroup): string {
    switch (group.category) {
      case 'thinking': return '思考完了';
      case 'tool': return `${group.tools.length}ツール完了`;
      case 'subagent': return `SubAgent: ${group.agentDescription || ''} 完了`;
    }
  }

  private createGroup(category: GroupCategory): ActiveGroup {
    this.groupCounter++;
    return {
      id: `grp-${this.groupCounter}`,
      category,
      messageTs: null,
      startTime: Date.now(),
      lastUpdateTime: 0,
      thinkingTexts: [],
      tools: [],
      agentSteps: [],
    };
  }
}
```

- [ ] **Step 4: テストがパスすることを確認**

```bash
npx vitest run tests/streaming/group-tracker.test.ts && echo "✅ PASS"
```

- [ ] **Step 5: コミット**

```bash
git add src/streaming/group-tracker.ts tests/streaming/group-tracker.test.ts
git commit -m "feat(streaming-v2): add GroupTracker with thinking/tool/subagent group management"
```

### Task 3.2: GroupTracker — tool + subagent + flush テスト追加

**Files:**
- Modify: `tests/streaming/group-tracker.test.ts`

- [ ] **Step 1: tool グループのテストを追加**

```typescript
// tests/streaming/group-tracker.test.ts に追加

  describe('tool groups', () => {
    it('creates new tool group on first tool_use', () => {
      const actions = tracker.handleToolUse('toolu_001', 'Read', { file_path: '/a.ts' });
      expect(actions).toHaveLength(1);
      expect(actions[0].type).toBe('postMessage');
      expect(actions[0].category).toBe('tool');
    });

    it('updates group on subsequent tool_use', () => {
      const first = tracker.handleToolUse('toolu_001', 'Read', { file_path: '/a.ts' });
      tracker.registerMessageTs(first[0].groupId, 'MSG_TS');

      // Force debounce to pass
      const group = tracker.getGroupData(first[0].groupId)!;
      group.lastUpdateTime = 0;

      const second = tracker.handleToolUse('toolu_002', 'Read', { file_path: '/b.ts' });
      const updateAction = second.find(a => a.type === 'update');
      expect(updateAction).toBeDefined();
    });

    it('collapses tool group when all tools complete', () => {
      const first = tracker.handleToolUse('toolu_001', 'Read', { file_path: '/a.ts' });
      tracker.registerMessageTs(first[0].groupId, 'MSG_TS');

      const result = tracker.handleToolResult('toolu_001', 'file content', false);
      const collapseAction = result.find(a => a.type === 'collapse');
      expect(collapseAction).toBeDefined();
    });

    it('does NOT collapse when some tools still running', () => {
      const first = tracker.handleToolUse('toolu_001', 'Read', { file_path: '/a.ts' });
      tracker.registerMessageTs(first[0].groupId, 'MSG_TS');
      tracker.handleToolUse('toolu_002', 'Read', { file_path: '/b.ts' });

      const result = tracker.handleToolResult('toolu_001', 'content', false);
      const collapseAction = result.find(a => a.type === 'collapse');
      expect(collapseAction).toBeUndefined();
    });
  });

  describe('subagent groups', () => {
    it('creates new subagent group', () => {
      const actions = tracker.handleSubagentStart('toolu_agent', 'コード探索');
      expect(actions).toHaveLength(1);
      expect(actions[0].type).toBe('postMessage');
      expect(actions[0].category).toBe('subagent');
    });

    it('collapses subagent group on complete', () => {
      const first = tracker.handleSubagentStart('toolu_agent', 'コード探索');
      tracker.registerMessageTs(first[0].groupId, 'MSG_TS');

      const complete = tracker.handleSubagentComplete('toolu_agent', 'done', 5000);
      const collapseAction = complete.find(a => a.type === 'collapse');
      expect(collapseAction).toBeDefined();
    });
  });

  describe('flushActiveGroup', () => {
    it('collapses active group', () => {
      const first = tracker.handleToolUse('toolu_001', 'Read', { file_path: '/a.ts' });
      tracker.registerMessageTs(first[0].groupId, 'MSG_TS');

      const actions = tracker.flushActiveGroup();
      expect(actions).toHaveLength(1);
      expect(actions[0].type).toBe('collapse');
    });

    it('marks running tools as error on flush', () => {
      const first = tracker.handleToolUse('toolu_001', 'Read', { file_path: '/a.ts' });
      const groupId = first[0].groupId;
      tracker.registerMessageTs(groupId, 'MSG_TS');

      tracker.flushActiveGroup();

      const group = tracker.getGroupData(groupId)!;
      expect(group.tools[0].status).toBe('error');
    });

    it('returns empty when no active group', () => {
      const actions = tracker.flushActiveGroup();
      expect(actions).toHaveLength(0);
    });
  });

  describe('group data retrieval', () => {
    it('returns active group data', () => {
      const first = tracker.handleThinking('Thinking...');
      const data = tracker.getGroupData(first[0].groupId);
      expect(data).toBeDefined();
      expect(data!.thinkingTexts).toEqual(['Thinking...']);
    });

    it('returns completed group data', () => {
      const first = tracker.handleThinking('Thinking...');
      const groupId = first[0].groupId;
      tracker.registerMessageTs(groupId, 'MSG_TS');
      tracker.handleTextStart(); // triggers collapse

      const data = tracker.getGroupData(groupId);
      expect(data).toBeDefined();
      expect(data!.thinkingTexts).toEqual(['Thinking...']);
    });
  });
```

- [ ] **Step 2: テストがパスすることを確認**

```bash
npx vitest run tests/streaming/group-tracker.test.ts && echo "✅ PASS"
```

- [ ] **Step 3: コミット**

```bash
git add tests/streaming/group-tracker.test.ts
git commit -m "test(streaming-v2): add tool/subagent/flush tests for GroupTracker"
```

---

## Chunk 4: ModalBuilder + ToolResultCache 拡張

### Task 4.1: ToolResultCache にグループデータ機能追加

**Files:**
- Modify: `src/streaming/tool-result-cache.ts`
- Modify: `tests/streaming/tool-result-cache.test.ts`

- [ ] **Step 1: テストを追加**

`tests/streaming/tool-result-cache.test.ts` に以下を追加する：

```typescript
// 既存テストの末尾に追加

describe('group data cache', () => {
  it('stores and retrieves group data', () => {
    const cache = new ToolResultCache({ ttlMs: 60000, maxSizeBytes: 1024 * 1024 });
    cache.setGroupData('grp-1', {
      category: 'thinking',
      thinkingTexts: ['First thought', 'Second thought'],
    });
    const data = cache.getGroupData('grp-1');
    expect(data).toBeDefined();
    expect(data!.thinkingTexts).toEqual(['First thought', 'Second thought']);
  });

  it('returns undefined for missing group', () => {
    const cache = new ToolResultCache({ ttlMs: 60000, maxSizeBytes: 1024 * 1024 });
    expect(cache.getGroupData('nonexistent')).toBeUndefined();
  });

  it('respects TTL for group data', () => {
    vi.useFakeTimers();
    const cache = new ToolResultCache({ ttlMs: 1000, maxSizeBytes: 1024 * 1024 });
    cache.setGroupData('grp-1', { category: 'thinking', thinkingTexts: ['test'] });

    vi.advanceTimersByTime(1001);
    expect(cache.getGroupData('grp-1')).toBeUndefined();
    vi.useRealTimers();
  });
});
```

- [ ] **Step 2: テスト失敗確認**

```bash
npx vitest run tests/streaming/tool-result-cache.test.ts 2>&1 | tail -5
```

- [ ] **Step 3: グループデータ機能を実装**

`src/streaming/tool-result-cache.ts` に以下を追加する：

```typescript
// 既存のimportの後に追加
export interface GroupCacheData {
  category: 'thinking' | 'tool' | 'subagent';
  thinkingTexts?: string[];
  tools?: Array<{
    toolUseId: string;
    toolName: string;
    input: Record<string, unknown>;
    oneLiner: string;
    durationMs?: number;
    isError?: boolean;
  }>;
  agentDescription?: string;
  agentId?: string;
  sessionId?: string;
  projectPath?: string;
}

// GroupCacheEntry を定義
interface GroupCacheEntry {
  data: GroupCacheData;
  createdAt: number;
}
```

`ToolResultCache` クラスに以下を追加：

```typescript
  private groupEntries: Map<string, GroupCacheEntry> = new Map();

  setGroupData(groupId: string, data: GroupCacheData): void {
    this.groupEntries.set(groupId, { data, createdAt: Date.now() });
  }

  getGroupData(groupId: string): GroupCacheData | undefined {
    const entry = this.groupEntries.get(groupId);
    if (!entry) return undefined;
    if (Date.now() - entry.createdAt > this.config.ttlMs) {
      this.groupEntries.delete(groupId);
      return undefined;
    }
    return entry.data;
  }
```

`clear()` メソッドに `this.groupEntries.clear();` を追加する。

- [ ] **Step 4: テストパス確認**

```bash
npx vitest run tests/streaming/tool-result-cache.test.ts && echo "✅ PASS"
```

- [ ] **Step 5: コミット**

```bash
git add src/streaming/tool-result-cache.ts tests/streaming/tool-result-cache.test.ts
git commit -m "feat(streaming-v2): add group data cache to ToolResultCache"
```

### Task 4.2: ModalBuilder — 思考 + ツールグループモーダル

**Files:**
- Modify: `src/slack/modal-builder.ts`
- Modify: `tests/slack/modal-builder.test.ts`

- [ ] **Step 1: テストを書く**

`tests/slack/modal-builder.test.ts` を更新する：

```typescript
// tests/slack/modal-builder.test.ts
import { describe, it, expect } from 'vitest';
import { buildToolModal, buildThinkingModal, buildToolGroupModal } from '../../src/slack/modal-builder.js';

// 既存のbuildToolModalテストはそのまま残す

describe('buildThinkingModal', () => {
  it('displays all thinking texts with separators', () => {
    const modal = buildThinkingModal(['First thought', 'Second thought']);
    expect(modal.type).toBe('modal');
    const allText = JSON.stringify(modal.blocks);
    expect(allText).toContain('First thought');
    expect(allText).toContain('Second thought');
    // Should have divider between thoughts
    expect(modal.blocks.some((b: any) => b.type === 'divider')).toBe(true);
  });

  it('truncates very long thinking text', () => {
    const modal = buildThinkingModal(['a'.repeat(5000)]);
    const allText = JSON.stringify(modal.blocks);
    expect(allText.length).toBeLessThan(10000);
  });
});

describe('buildToolGroupModal', () => {
  it('displays tool list with detail buttons', () => {
    const modal = buildToolGroupModal([
      { toolUseId: 'toolu_001', toolName: 'Read', oneLiner: 'src/auth.ts', durationMs: 300, isError: false },
      { toolUseId: 'toolu_002', toolName: 'Bash', oneLiner: 'npm test', durationMs: 1200, isError: false },
    ]);
    expect(modal.type).toBe('modal');
    const allText = JSON.stringify(modal.blocks);
    expect(allText).toContain('Read');
    expect(allText).toContain('Bash');
    expect(allText).toContain('view_tool_detail:toolu_001');
    expect(allText).toContain('view_tool_detail:toolu_002');
  });

  it('shows error icon for failed tools', () => {
    const modal = buildToolGroupModal([
      { toolUseId: 'toolu_001', toolName: 'Bash', oneLiner: 'exit 1', durationMs: 100, isError: true },
    ]);
    const allText = JSON.stringify(modal.blocks);
    expect(allText).toContain(':x:');
  });
});
```

- [ ] **Step 2: テスト失敗確認**

```bash
npx vitest run tests/slack/modal-builder.test.ts 2>&1 | tail -5
```

- [ ] **Step 3: 実装**

まず `src/slack/modal-builder.ts` 先頭のローカル `type Block = Record<string, unknown>;` を削除し、`import type { Block } from '../streaming/types.js';` に置き換える。

次に以下を追加する：

```typescript
export function buildThinkingModal(thinkingTexts: string[]): any {
  const blocks: Block[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: '思考詳細' },
    },
  ];

  for (const [i, text] of thinkingTexts.entries()) {
    if (i > 0) {
      blocks.push({ type: 'divider' });
    }

    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `*思考 ${i + 1}*` }],
    });

    const parts = splitContent(text, 2900);
    for (const part of parts) {
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: part },
      });
    }
  }

  return {
    type: 'modal',
    title: { type: 'plain_text', text: '思考詳細' },
    close: { type: 'plain_text', text: '閉じる' },
    blocks: blocks.slice(0, 100), // Slack modal max 100 blocks
  };
}

interface ToolGroupModalItem {
  toolUseId: string;
  toolName: string;
  oneLiner: string;
  durationMs: number;
  isError: boolean;
}

export function buildToolGroupModal(tools: ToolGroupModalItem[]): any {
  const blocks: Block[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: 'ツール実行詳細' },
    },
  ];

  for (const tool of tools) {
    const icon = tool.isError ? ':x:' : ':white_check_mark:';
    const durationStr = `${(tool.durationMs / 1000).toFixed(1)}s`;

    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `${icon} \`${tool.toolName}\` ${tool.oneLiner} (${durationStr})`,
      },
      accessory: {
        type: 'button',
        text: { type: 'plain_text', text: '詳細' },
        action_id: `view_tool_detail:${tool.toolUseId}`,
      },
    });
  }

  return {
    type: 'modal',
    title: { type: 'plain_text', text: 'ツール実行詳細' },
    close: { type: 'plain_text', text: '閉じる' },
    blocks: blocks.slice(0, 100),
  };
}
```

- [ ] **Step 4: テストパス確認**

```bash
npx vitest run tests/slack/modal-builder.test.ts && echo "✅ PASS"
```

- [ ] **Step 5: コミット**

```bash
git add src/slack/modal-builder.ts tests/slack/modal-builder.test.ts
git commit -m "feat(streaming-v2): add thinking and tool group modals"
```

---

## Chunk 5: SubagentJsonlReader + SubAgentモーダル

### Task 5.1: SubagentJsonlReader

**Files:**
- Create: `src/streaming/subagent-jsonl-reader.ts`
- Create: `tests/streaming/subagent-jsonl-reader.test.ts`

- [ ] **Step 1: テスト用のフィクスチャを作成**

```bash
mkdir -p tests/fixtures && echo "✅ created"
```

テストフィクスチャファイルを作成する：

```typescript
// tests/fixtures/sample-subagent.jsonl
// 各行は独立したJSONオブジェクト — テストコード内で直接生成する
```

- [ ] **Step 2: テストを書く**

```typescript
// tests/streaming/subagent-jsonl-reader.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SubagentJsonlReader } from '../../src/streaming/subagent-jsonl-reader.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('SubagentJsonlReader', () => {
  let tmpDir: string;
  let reader: SubagentJsonlReader;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'subagent-test-'));
    reader = new SubagentJsonlReader(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeFixture(projectPath: string, sessionId: string, agentId: string, lines: any[]): void {
    const dirName = projectPath.replace(/\//g, '-');
    const dir = path.join(tmpDir, dirName, sessionId, 'subagents');
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, `agent-${agentId}.jsonl`);
    fs.writeFileSync(filePath, lines.map(l => JSON.stringify(l)).join('\n'));
  }

  it('reads subagent JSONL and extracts conversation flow', async () => {
    writeFixture('/Users/test/project', 'session-123', 'abc123', [
      { type: 'user', message: { role: 'user', content: 'You are a search agent. Find auth code.' } },
      { type: 'assistant' , message: { role: 'assistant', content: [{ type: 'text', text: 'I will search for auth code.' }] } },  // Note: not "message" wrapper for assistant, just content array
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_001', name: 'Grep', input: { pattern: 'auth' } }] } },
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_001', content: 'found 5 matches' }] } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Found auth code in 5 files.' }] } },
    ]);

    const flow = await reader.read('/Users/test/project', 'session-123', 'abc123');
    expect(flow).not.toBeNull();
    expect(flow!.systemPromptSummary.length).toBeGreaterThan(0);
    expect(flow!.systemPromptSummary.length).toBeLessThanOrEqual(200);
    expect(flow!.steps.length).toBeGreaterThan(0);
    expect(flow!.finalResult).toContain('Found auth');
  });

  it('returns null when file does not exist', async () => {
    const flow = await reader.read('/nonexistent', 'session-x', 'agent-x');
    expect(flow).toBeNull();
  });

  it('correctly converts project path to directory name', () => {
    // Access via class method (made public for testing or test via read)
    const dirName = (reader as any).toProjectDirName('/Users/archeco055/dev/claude-slack-pipe');
    expect(dirName).toBe('-Users-archeco055-dev-claude-slack-pipe');
  });
});
```

- [ ] **Step 3: テスト失敗確認**

```bash
npx vitest run tests/streaming/subagent-jsonl-reader.test.ts 2>&1 | tail -5
```

- [ ] **Step 4: 実装**

```typescript
// src/streaming/subagent-jsonl-reader.ts
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { logger } from '../utils/logger.js';
import { getToolOneLiner } from './tool-formatter.js';

export interface SubagentConversationFlow {
  agentType: string;
  systemPromptSummary: string;
  steps: Array<{
    type: 'text' | 'tool_use' | 'tool_result';
    text?: string;
    toolName?: string;
    toolUseId?: string;
    input?: Record<string, unknown>;
    oneLiner?: string;
    resultSummary?: string;
    isError?: boolean;
  }>;
  finalResult: string;
  totalDurationMs: number;
}

export class SubagentJsonlReader {
  constructor(private readonly claudeProjectsDir: string) {}

  async read(
    projectPath: string,
    sessionId: string,
    agentId: string,
  ): Promise<SubagentConversationFlow | null> {
    const dirName = this.toProjectDirName(projectPath);
    const filePath = path.join(
      this.claudeProjectsDir,
      dirName,
      sessionId,
      'subagents',
      `agent-${agentId}.jsonl`,
    );

    if (!fs.existsSync(filePath)) {
      logger.warn(`SubAgent JSONL not found: ${filePath}`);
      return null;
    }

    try {
      return await this.parseFile(filePath);
    } catch (err) {
      logger.error('Failed to parse SubAgent JSONL', { error: (err as Error).message, filePath });
      return null;
    }
  }

  private async parseFile(filePath: string): Promise<SubagentConversationFlow> {
    const stream = fs.createReadStream(filePath);
    const rl = readline.createInterface({ input: stream });

    let systemPromptSummary = '';
    const steps: SubagentConversationFlow['steps'] = [];
    let finalResult = '';
    let firstTimestamp: number | null = null;
    let lastTimestamp: number | null = null;
    let agentType = 'general-purpose';
    let isFirstUser = true;

    for await (const line of rl) {
      if (!line.trim()) continue;

      let entry: any;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }

      // Track timestamps
      if (entry.timestamp) {
        const ts = new Date(entry.timestamp).getTime();
        if (!firstTimestamp) firstTimestamp = ts;
        lastTimestamp = ts;
      }

      const msg = entry.message;
      if (!msg) continue;

      if (entry.type === 'user' && isFirstUser) {
        // First user message = system prompt
        isFirstUser = false;
        const content = typeof msg.content === 'string'
          ? msg.content
          : JSON.stringify(msg.content);
        systemPromptSummary = content.slice(0, 200);
        continue;
      }

      if (msg.role === 'assistant' && Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === 'text' && block.text) {
            finalResult = block.text; // Keep updating — last one is the final result
            steps.push({ type: 'text', text: block.text.slice(0, 200) });
          } else if (block.type === 'tool_use') {
            const oneLiner = getToolOneLiner(block.name || '', block.input || {});
            steps.push({
              type: 'tool_use',
              toolName: block.name,
              toolUseId: block.id,
              input: block.input,
              oneLiner,
            });
          }
        }
      }

      if (msg.role === 'user' && Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === 'tool_result') {
            const resultContent = typeof block.content === 'string'
              ? block.content
              : JSON.stringify(block.content);
            steps.push({
              type: 'tool_result',
              toolUseId: block.tool_use_id,
              resultSummary: resultContent.slice(0, 100),
              isError: block.is_error === true,
            });
          }
        }
      }
    }

    const totalDurationMs = (firstTimestamp && lastTimestamp)
      ? lastTimestamp - firstTimestamp
      : 0;

    return {
      agentType,
      systemPromptSummary,
      steps: steps.slice(0, 50), // Limit to avoid modal overflow
      finalResult: finalResult.slice(0, 2000),
      totalDurationMs,
    };
  }

  private toProjectDirName(projectPath: string): string {
    return projectPath.replace(/\//g, '-');
  }
}
```

- [ ] **Step 5: テストパス確認**

```bash
npx vitest run tests/streaming/subagent-jsonl-reader.test.ts && echo "✅ PASS"
```

- [ ] **Step 6: コミット**

```bash
git add src/streaming/subagent-jsonl-reader.ts tests/streaming/subagent-jsonl-reader.test.ts
git commit -m "feat(streaming-v2): add SubagentJsonlReader for JSONL parsing"
```

### Task 5.2: SubAgent モーダル

**Files:**
- Modify: `src/slack/modal-builder.ts`
- Modify: `tests/slack/modal-builder.test.ts`

- [ ] **Step 1: テストを追加**

```typescript
// tests/slack/modal-builder.test.ts に追加
import { buildSubagentModal } from '../../src/slack/modal-builder.js';
import type { SubagentConversationFlow } from '../../src/streaming/subagent-jsonl-reader.js';

describe('buildSubagentModal', () => {
  it('displays conversation flow from JSONL', () => {
    const flow: SubagentConversationFlow = {
      agentType: 'general-purpose',
      systemPromptSummary: 'You are a search agent...',
      steps: [
        { type: 'text', text: 'I will search.' },
        { type: 'tool_use', toolName: 'Grep', toolUseId: 'toolu_001', oneLiner: 'auth' },
        { type: 'tool_result', toolUseId: 'toolu_001', resultSummary: '5 matches', isError: false },
      ],
      finalResult: 'Found auth in 5 files.',
      totalDurationMs: 5000,
    };

    const modal = buildSubagentModal('コード探索', flow);
    expect(modal.type).toBe('modal');
    const allText = JSON.stringify(modal.blocks);
    expect(allText).toContain('コード探索');
    expect(allText).toContain('search agent');
    expect(allText).toContain('Grep');
    expect(allText).toContain('Found auth');
  });

  it('displays fallback when flow is null', () => {
    const modal = buildSubagentModal('コード探索', null);
    const allText = JSON.stringify(modal.blocks);
    expect(allText).toContain('取得できませんでした');
  });
});
```

- [ ] **Step 2: テスト失敗確認**

```bash
npx vitest run tests/slack/modal-builder.test.ts 2>&1 | tail -5
```

- [ ] **Step 3: 実装**

`src/slack/modal-builder.ts` に以下を追加する：

```typescript
import type { SubagentConversationFlow } from '../streaming/subagent-jsonl-reader.js';

export function buildSubagentModal(
  description: string,
  flow: SubagentConversationFlow | null,
): any {
  const blocks: Block[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: truncate(`SubAgent: ${description}`, 24) },
    },
  ];

  if (!flow) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: 'SubAgent詳細を取得できませんでした。' },
    });
    return {
      type: 'modal',
      title: { type: 'plain_text', text: 'SubAgent詳細' },
      close: { type: 'plain_text', text: '閉じる' },
      blocks,
    };
  }

  // System prompt summary
  blocks.push({
    type: 'section',
    text: { type: 'mrkdwn', text: `*プロンプト:*\n_${flow.systemPromptSummary}_` },
  });
  blocks.push({ type: 'divider' });

  // Steps
  for (const step of flow.steps) {
    if (step.type === 'tool_use' && step.toolName) {
      const sectionBlock: Block = {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `:wrench: \`${step.toolName}\` ${step.oneLiner || ''}`,
        },
      };
      if (step.toolUseId) {
        sectionBlock.accessory = {
          type: 'button',
          text: { type: 'plain_text', text: '詳細' },
          action_id: `view_tool_detail:${step.toolUseId}`,
        };
      }
      blocks.push(sectionBlock);
    } else if (step.type === 'tool_result') {
      const icon = step.isError ? ':x:' : ':white_check_mark:';
      blocks.push({
        type: 'context',
        elements: [{ type: 'mrkdwn', text: `${icon} ${step.resultSummary || '完了'}` }],
      });
    }
    // Skip 'text' steps to keep modal concise — final result shown below
  }

  // Final result
  blocks.push({ type: 'divider' });
  blocks.push({
    type: 'section',
    text: { type: 'mrkdwn', text: `*最終結果:*` },
  });

  const resultParts = splitContent(flow.finalResult, 2900);
  for (const part of resultParts) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: part },
    });
  }

  return {
    type: 'modal',
    title: { type: 'plain_text', text: 'SubAgent詳細' },
    close: { type: 'plain_text', text: '閉じる' },
    blocks: blocks.slice(0, 100),
  };
}
```

- [ ] **Step 4: テストパス確認**

```bash
npx vitest run tests/slack/modal-builder.test.ts && echo "✅ PASS"
```

- [ ] **Step 5: コミット**

```bash
git add src/slack/modal-builder.ts tests/slack/modal-builder.test.ts
git commit -m "feat(streaming-v2): add SubAgent modal with JSONL conversation flow"
```

---

## Chunk 6: StreamProcessor 全面改修

### Task 6.1: StreamProcessor — 返り値方式 + GroupTracker統合

**Files:**
- Rewrite: `src/streaming/stream-processor.ts`
- Rewrite: `tests/streaming/stream-processor.test.ts`

- [ ] **Step 1: テストを書く**

```typescript
// tests/streaming/stream-processor.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { StreamProcessor } from '../../src/streaming/stream-processor.js';

describe('StreamProcessor', () => {
  let processor: StreamProcessor;

  beforeEach(() => {
    processor = new StreamProcessor({ channel: 'C123', threadTs: 'T123' });
  });

  describe('thinking events', () => {
    it('returns postMessage group action for first thinking', () => {
      const result = processor.processEvent({
        type: 'assistant',
        message: {
          content: [{ type: 'thinking', thinking: 'Analyzing...' }],
          stop_reason: null,
        },
      });

      expect(result.groupActions).toHaveLength(1);
      expect(result.groupActions[0].type).toBe('postMessage');
      expect(result.groupActions[0].category).toBe('thinking');
      expect(result.textAction).toBeUndefined();
      expect(result.resultEvent).toBeUndefined();
    });
  });

  describe('tool_use events', () => {
    it('collapses thinking and starts tool group', () => {
      // First: thinking
      const think = processor.processEvent({
        type: 'assistant',
        message: {
          content: [{ type: 'thinking', thinking: 'Need to read file' }],
          stop_reason: null,
        },
      });
      // Register thinking message ts
      processor.registerGroupMessageTs(think.groupActions[0].groupId, 'THINK_TS');

      // Then: tool_use
      const tool = processor.processEvent({
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', id: 'toolu_001', name: 'Read', input: { file_path: '/a.ts' } }],
          stop_reason: 'tool_use',
        },
      });

      // Should have collapse (thinking) + postMessage (tool)
      const collapse = tool.groupActions.find(a => a.type === 'collapse');
      const post = tool.groupActions.find(a => a.type === 'postMessage');
      expect(collapse).toBeDefined();
      expect(post).toBeDefined();
      expect(post!.category).toBe('tool');
    });
  });

  describe('tool_result events', () => {
    it('collapses tool group when all tools complete', () => {
      // tool_use
      const toolAction = processor.processEvent({
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', id: 'toolu_001', name: 'Read', input: { file_path: '/a.ts' } }],
          stop_reason: 'tool_use',
        },
      });
      processor.registerGroupMessageTs(toolAction.groupActions[0].groupId, 'TOOL_TS');

      // tool_result
      const result = processor.processEvent({
        type: 'user',
        message: {
          content: [{ type: 'tool_result', tool_use_id: 'toolu_001', content: 'file contents' }],
        },
      });

      const collapse = result.groupActions.find(a => a.type === 'collapse');
      expect(collapse).toBeDefined();
    });
  });

  describe('text events', () => {
    it('returns text action for text content', () => {
      const result = processor.processEvent({
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'Hello world' }],
          stop_reason: 'end_turn',
        },
      });

      expect(result.textAction).toBeDefined();
      expect(result.textAction!.type).toBe('postMessage');
      expect(result.textAction!.metadata.messageType).toBe('text');
    });

    it('returns update action for subsequent text', () => {
      // First text
      const first = processor.processEvent({
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'Hello' }],
          stop_reason: null,
        },
      });
      processor.registerTextMessageTs('TEXT_TS');

      // Second text
      const second = processor.processEvent({
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: ' world' }],
          stop_reason: 'end_turn',
        },
      });

      expect(second.textAction).toBeDefined();
      expect(second.textAction!.type).toBe('update');
    });
  });

  describe('result events', () => {
    it('returns resultEvent and flushes active group', () => {
      // Active tool
      const toolAction = processor.processEvent({
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', id: 'toolu_001', name: 'Read', input: { file_path: '/a.ts' } }],
          stop_reason: 'tool_use',
        },
      });
      processor.registerGroupMessageTs(toolAction.groupActions[0].groupId, 'TOOL_TS');

      // Result (without tool_result — interrupted)
      const result = processor.processEvent({
        type: 'result',
        duration_ms: 5000,
        usage: { input_tokens: 1000, output_tokens: 500 },
      });

      expect(result.resultEvent).toBeDefined();
      expect(result.groupActions.length).toBeGreaterThanOrEqual(1); // flush
    });
  });

  describe('subagent events', () => {
    it('handles Agent tool as subagent', () => {
      const result = processor.processEvent({
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', id: 'toolu_agent', name: 'Agent', input: { prompt: 'Search code', description: 'コード探索' } }],
          stop_reason: 'tool_use',
        },
      });

      expect(result.groupActions).toHaveLength(1);
      expect(result.groupActions[0].category).toBe('subagent');
    });

    it('tracks child tools via parent_tool_use_id', () => {
      // Agent start
      const agentResult = processor.processEvent({
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', id: 'toolu_agent', name: 'Agent', input: { description: 'Search' } }],
          stop_reason: 'tool_use',
        },
      });
      processor.registerGroupMessageTs(agentResult.groupActions[0].groupId, 'AGENT_TS');

      // Child tool
      const childResult = processor.processEvent({
        type: 'assistant',
        parent_tool_use_id: 'toolu_agent',
        message: {
          content: [{ type: 'tool_use', id: 'toolu_child', name: 'Grep', input: { pattern: 'auth' } }],
          stop_reason: 'tool_use',
        },
      });

      // Should update subagent group (not create new tool group)
      const updateOrSkip = childResult.groupActions.filter(a =>
        a.type === 'update' || a.type === 'postMessage'
      );
      // Either an update or no action (debounced)
      expect(childResult.groupActions.every(a => a.type !== 'postMessage' || a.groupId === agentResult.groupActions[0].groupId)).toBe(true);
    });
  });

  describe('mixed event sequences', () => {
    it('handles thinking → tool → thinking → tool → text', () => {
      // Thinking 1
      const t1 = processor.processEvent({
        type: 'assistant',
        message: { content: [{ type: 'thinking', thinking: 'Think 1' }], stop_reason: null },
      });
      processor.registerGroupMessageTs(t1.groupActions[0].groupId, 'T1_TS');

      // Tool 1
      const tool1 = processor.processEvent({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/a.ts' } }], stop_reason: 'tool_use' },
      });
      const tool1PostAction = tool1.groupActions.find(a => a.type === 'postMessage');
      processor.registerGroupMessageTs(tool1PostAction!.groupId, 'TOOL1_TS');

      // Tool 1 result
      processor.processEvent({
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }] },
      });

      // Thinking 2
      const t2 = processor.processEvent({
        type: 'assistant',
        message: { content: [{ type: 'thinking', thinking: 'Think 2' }], stop_reason: null },
      });
      processor.registerGroupMessageTs(t2.groupActions.find(a => a.type === 'postMessage')!.groupId, 'T2_TS');

      // Text
      const text = processor.processEvent({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Answer' }], stop_reason: 'end_turn' },
      });

      // Text should trigger thinking 2 collapse
      const collapse = text.groupActions.find(a => a.type === 'collapse');
      expect(collapse).toBeDefined();
      expect(text.textAction).toBeDefined();
    });
  });
});
```

- [ ] **Step 2: テスト失敗確認**

```bash
npx vitest run tests/streaming/stream-processor.test.ts 2>&1 | tail -5
```

- [ ] **Step 3: StreamProcessor を全面書き換え**

```typescript
// src/streaming/stream-processor.ts
import { logger } from '../utils/logger.js';
import { getToolOneLiner } from './tool-formatter.js';
import { convertMarkdownToMrkdwn } from './markdown-converter.js';
import { GroupTracker } from './group-tracker.js';
import type {
  SlackAction,
  ProcessedActions,
  GroupAction,
  Block,
} from './types.js';

interface StreamProcessorConfig {
  channel: string;
  threadTs: string;
}

export class StreamProcessor {
  private readonly config: StreamProcessorConfig;
  private readonly groupTracker: GroupTracker;
  private textBuffer = '';
  private textMessageTs: string | null = null;

  constructor(config: StreamProcessorConfig) {
    this.config = config;
    this.groupTracker = new GroupTracker();
  }

  processEvent(event: any): ProcessedActions {
    const parentToolUseId = event.parent_tool_use_id || null;
    const result: ProcessedActions = { groupActions: [] };

    if (event.type === 'assistant' && event.message?.content) {
      this.handleAssistant(event.message.content, parentToolUseId, result);
    } else if (event.type === 'user' && event.message?.content) {
      this.handleUser(event.message.content, parentToolUseId, result);
    } else if (event.type === 'result') {
      this.handleResult(event, result);
    }

    return result;
  }

  registerGroupMessageTs(groupId: string, messageTs: string): void {
    this.groupTracker.registerMessageTs(groupId, messageTs);
  }

  registerTextMessageTs(messageTs: string): void {
    this.textMessageTs = messageTs;
  }

  setAgentId(groupId: string, agentId: string): void {
    this.groupTracker.setAgentId(groupId, agentId);
  }

  getGroupData(groupId: string) {
    return this.groupTracker.getGroupData(groupId);
  }

  getAccumulatedText(): string {
    return this.textBuffer;
  }

  reset(): void {
    this.textBuffer = '';
    this.textMessageTs = null;
  }

  dispose(): void {
    // No-op — no timers or listeners to clean up in v2
  }

  private handleAssistant(content: any[], parentToolUseId: string | null, result: ProcessedActions): void {
    for (const block of content) {
      if (block.type === 'thinking') {
        const actions = this.groupTracker.handleThinking(block.thinking);
        result.groupActions.push(...actions);
      } else if (block.type === 'tool_use') {
        this.handleToolUse(block, parentToolUseId, result);
      } else if (block.type === 'text' && block.text) {
        this.handleText(block.text, result);
      }
    }
  }

  private handleToolUse(block: any, parentToolUseId: string | null, result: ProcessedActions): void {
    const toolUseId = block.id;
    const toolName = block.name;
    const input = block.input || {};

    // Subagent child tool
    if (parentToolUseId) {
      const oneLiner = getToolOneLiner(toolName, input);
      const actions = this.groupTracker.handleSubagentStep(parentToolUseId, toolName, toolUseId, oneLiner);
      result.groupActions.push(...actions);
      return;
    }

    // Agent tool = new subagent
    if (toolName === 'Agent') {
      const description = String(input.description || input.prompt || 'SubAgent');
      const actions = this.groupTracker.handleSubagentStart(toolUseId, description);
      result.groupActions.push(...actions);
      return;
    }

    // Normal tool
    const actions = this.groupTracker.handleToolUse(toolUseId, toolName, input);
    result.groupActions.push(...actions);
  }

  private handleText(text: string, result: ProcessedActions): void {
    // Collapse any active group before text
    const collapseActions = this.groupTracker.handleTextStart();
    result.groupActions.push(...collapseActions);

    this.textBuffer += text;
    const converted = convertMarkdownToMrkdwn(this.textBuffer);
    const blocks = this.buildTextBlocks(converted, false);

    if (!this.textMessageTs) {
      result.textAction = {
        type: 'postMessage',
        priority: 1,
        channel: this.config.channel,
        threadTs: this.config.threadTs,
        blocks,
        text: this.textBuffer.slice(0, 100),
        metadata: { messageType: 'text' },
      };
    } else {
      result.textAction = {
        type: 'update',
        priority: 1,
        channel: this.config.channel,
        threadTs: this.config.threadTs,
        messageTs: this.textMessageTs,
        blocks,
        text: this.textBuffer.slice(0, 100),
        metadata: { messageType: 'text' },
      };
    }
  }

  private handleUser(content: any[], parentToolUseId: string | null, result: ProcessedActions): void {
    for (const block of content) {
      if (typeof block === 'object' && block.type === 'tool_result') {
        this.handleToolResult(block, parentToolUseId, result);
      }
    }
  }

  private handleToolResult(block: any, parentToolUseId: string | null, result: ProcessedActions): void {
    const toolUseId = block.tool_use_id;
    const isError = block.is_error === true
      || (typeof block.content === 'string' && /^(Error|error:|ERROR)/.test(block.content));
    const resultText = typeof block.content === 'string'
      ? block.content
      : JSON.stringify(block.content);

    // Subagent child tool result
    if (parentToolUseId) {
      const actions = this.groupTracker.handleSubagentStepResult(parentToolUseId, toolUseId, isError);
      result.groupActions.push(...actions);
      return;
    }

    // Try subagent complete first (toolUseId matches the Agent tool's id)
    const subagentActions = this.groupTracker.handleSubagentComplete(toolUseId, resultText, 0);
    if (subagentActions.length > 0) {
      // Extract agentId from result text for JSONL lookup
      const agentIdMatch = resultText.match(/agentId:\s*([\w]+)/);
      if (agentIdMatch) {
        const collapsedAction = subagentActions.find(a => a.type === 'collapse');
        if (collapsedAction) {
          this.groupTracker.setAgentId(collapsedAction.groupId, agentIdMatch[1]);
        }
      }
      result.groupActions.push(...subagentActions);
      return;
    }

    // Normal tool result — GroupTracker calculates durationMs internally from tool.startTime
    const actions = this.groupTracker.handleToolResult(toolUseId, resultText, isError);
    result.groupActions.push(...actions);
  }

  private handleResult(event: any, result: ProcessedActions): void {
    // Flush any active group
    const flushActions = this.groupTracker.flushActiveGroup();
    result.groupActions.push(...flushActions);

    // Finalize text
    if (this.textMessageTs && this.textBuffer) {
      const converted = convertMarkdownToMrkdwn(this.textBuffer);
      const blocks = this.buildTextBlocks(converted, true);
      result.textAction = {
        type: 'update',
        priority: 1,
        channel: this.config.channel,
        threadTs: this.config.threadTs,
        messageTs: this.textMessageTs,
        blocks,
        text: this.textBuffer.slice(0, 100),
        metadata: { messageType: 'text' },
      };
    }

    result.resultEvent = event;
  }

  private buildTextBlocks(mrkdwn: string, isComplete: boolean): Block[] {
    const blocks: Block[] = [];
    const parts = mrkdwn.match(/.{1,2900}/gs) || [mrkdwn];
    for (const part of parts) {
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: part },
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
}
```

- [ ] **Step 4: テストパス確認**

```bash
npx vitest run tests/streaming/stream-processor.test.ts && echo "✅ PASS"
```

- [ ] **Step 5: 型チェック確認**

```bash
npx tsc --noEmit && echo "✅ types pass"
```

- [ ] **Step 6: コミット**

```bash
git add src/streaming/stream-processor.ts tests/streaming/stream-processor.test.ts
git commit -m "feat(streaming-v2): rewrite StreamProcessor with GroupTracker + return-value pattern"
```

---

## Chunk 7: index.ts 統合 + 不要ファイル削除

### Task 7.1: index.ts — SerialActionQueue + GroupAction統合

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: wireSessionOutput を書き換え**

`src/index.ts` の `wireSessionOutput` 関数を以下のように変更する：

1. `import { SerialActionQueue } from './streaming/serial-action-queue.js';` を追加
2. `import { SubagentJsonlReader } from './streaming/subagent-jsonl-reader.js';` を追加
3. `import { buildThinkingModal, buildToolGroupModal, buildSubagentModal } from './slack/modal-builder.js';` に変更（既存importを拡張）

`wireSessionOutput` の中身を以下に置き換える：

```typescript
  function wireSessionOutput(
    session: PersistentSession,
    channelId: string,
    threadTs: string,
    rm: ReactionManager,
    client: any,
    indexStore: SessionIndexStore,
  ): void {
    if (wiredSessions.has(session.sessionId)) return;
    wiredSessions.add(session.sessionId);

    const executor = new SlackActionExecutor(client);
    const streamProcessor = new StreamProcessor({ channel: channelId, threadTs });
    const serialQueue = new SerialActionQueue();

    serialQueue.onError((err) => {
      logger.error('SerialActionQueue error', { error: err.message });
    });

    // Helper: convert GroupAction to SlackAction
    function convertGroupActionToSlackAction(ga: any): any {
      const priority = ga.type === 'update' ? 4 : 3; // update=P4 (skippable), post/collapse=P3
      return {
        type: ga.type === 'postMessage' ? 'postMessage' : 'update',
        priority,
        channel: channelId,
        threadTs,
        messageTs: ga.messageTs,
        blocks: ga.blocks,
        text: ga.text || '',
        metadata: {
          messageType: ga.category || 'tool_use',
          groupId: ga.groupId,
        },
      };
    }

    session.on('message', (event: any) => {
      serialQueue.enqueue(async () => {
        try {
          const { groupActions, textAction, resultEvent } = streamProcessor.processEvent(event);

          // Execute group actions sequentially
          for (const ga of groupActions) {
            const slackAction = convertGroupActionToSlackAction(ga);
            const result = await executor.execute(slackAction);
            if (result.ok && result.ts && ga.type === 'postMessage') {
              streamProcessor.registerGroupMessageTs(ga.groupId, result.ts);
            }
          }

          // Cache tool results for modal display (after group actions so tool info is available)
          if (event.type === 'user' && event.message?.content) {
            for (const block of event.message.content) {
              if (block.type === 'tool_result' && block.tool_use_id) {
                const resultText = typeof block.content === 'string' ? block.content : JSON.stringify(block.content);
                // Find tool info from GroupTracker's completed/active groups
                let toolName = '';
                let toolInput: Record<string, unknown> = {};
                let toolDuration = 0;
                // Search all groups for this toolUseId
                for (const ga of groupActions) {
                  const gd = streamProcessor.getGroupData(ga.groupId);
                  const toolInfo = gd?.tools?.find(t => t.toolUseId === block.tool_use_id);
                  if (toolInfo) {
                    toolName = toolInfo.toolName;
                    toolInput = toolInfo.input;
                    toolDuration = toolInfo.durationMs || 0;
                    break;
                  }
                }
                toolResultCache.set(block.tool_use_id, {
                  toolId: block.tool_use_id,
                  toolName,
                  input: toolInput,
                  result: resultText,
                  durationMs: toolDuration,
                  isError: block.is_error === true,
                });
              }
            }
          }

          // Execute text action
          if (textAction) {
            const result = await executor.execute(textAction);
            if (result.ok && result.ts && textAction.type === 'postMessage') {
              streamProcessor.registerTextMessageTs(result.ts);
            }
          }

          // Handle result event
          if (resultEvent) {
            const usage = resultEvent.usage || {};
            const contextTokens = (usage.input_tokens || 0)
              + (usage.cache_read_input_tokens || 0)
              + (usage.cache_creation_input_tokens || 0)
              + (usage.output_tokens || 0);

            const sessionModel = indexStore.findByThreadTs(threadTs)?.model || '';
            const contextWindow = sessionModel.includes('haiku') ? 200_000 : 1_000_000;

            const footerBlocks = buildResponseFooter({
              inputTokens: usage.input_tokens || 0,
              outputTokens: usage.output_tokens || 0,
              contextTokens,
              contextWindow,
              model: indexStore.findByThreadTs(threadTs)?.model || 'unknown',
              durationMs: resultEvent.duration_ms || 0,
            });

            await client.chat.postMessage({
              channel: channelId,
              thread_ts: threadTs,
              blocks: footerBlocks,
              text: 'Complete',
            });

            const msgTs = activeMessageTs.get(session.sessionId) || threadTs;
            await rm.replaceWithDone(channelId, msgTs);
            activeMessageTs.delete(session.sessionId);

            indexStore.update(
              indexStore.findByThreadTs(threadTs)?.cliSessionId || '',
              { lastActiveAt: new Date().toISOString() },
            );

            streamProcessor.reset();
          }
        } catch (err) {
          logger.error('Error handling session message', { error: (err as Error).message });
        }
      });
    });

    session.on('error', async (err: Error) => {
      logger.error('Session error', { sessionId: session.sessionId, error: err.message });
      try {
        await client.chat.postMessage({
          channel: channelId,
          thread_ts: threadTs,
          text: `Error: ${err.message}`,
        });
      } catch { /* ignore */ }
    });

    session.on('stateChange', (_from: string, to: string) => {
      if (to === 'dead' || to === 'ending') {
        streamProcessor.dispose();
      }
    });
  }
```

- [ ] **Step 2: モーダルアクションハンドラを拡張**

既存の `app.action(/^view_tool_detail:/, ...)` はそのまま維持。

新しいグループ詳細アクションハンドラを追加する：

```typescript
  // --- Group Detail Modal Action ---
  const subagentReader = new SubagentJsonlReader(config.claudeProjectsDir);

  app.action(/^view_group_detail:/, async ({ ack, body }: any) => {
    await ack();
    const actionId = body.actions?.[0]?.action_id || '';
    const groupId = actionId.split(':')[1];
    if (!groupId) return;

    const groupData = toolResultCache.getGroupData(groupId);
    if (!groupData) {
      logger.warn(`No cached group data for ${groupId}`);
      return;
    }

    let modal: any;

    if (groupData.category === 'thinking') {
      modal = buildThinkingModal(groupData.thinkingTexts || []);
    } else if (groupData.category === 'tool') {
      modal = buildToolGroupModal(
        (groupData.tools || []).map(t => ({
          toolUseId: t.toolUseId,
          toolName: t.toolName,
          oneLiner: t.oneLiner,
          durationMs: t.durationMs || 0,
          isError: t.isError || false,
        })),
      );
    } else if (groupData.category === 'subagent') {
      let flow = null;
      if (groupData.agentId && groupData.sessionId && groupData.projectPath) {
        flow = await subagentReader.read(
          groupData.projectPath,
          groupData.sessionId,
          groupData.agentId,
        );
      }
      modal = buildSubagentModal(groupData.agentDescription || 'SubAgent', flow);
    }

    if (modal) {
      await app.client.views.open({
        trigger_id: body.trigger_id,
        view: modal,
      });
    }
  });
```

- [ ] **Step 3: グループデータをキャッシュに保存するロジックを追加**

`serialQueue.enqueue` 内の `// Handle result event` の前に、以下を追加する：

```typescript
          // Cache group data for collapse actions (for modal display)
          for (const ga of groupActions) {
            if (ga.type === 'collapse') {
              const groupData = streamProcessor.getGroupData(ga.groupId);
              if (groupData) {
                const entry = indexStore.findByThreadTs(threadTs);
                toolResultCache.setGroupData(ga.groupId, {
                  category: groupData.category,
                  thinkingTexts: groupData.thinkingTexts,
                  tools: groupData.tools.map(t => ({
                    toolUseId: t.toolUseId,
                    toolName: t.toolName,
                    input: t.input,
                    oneLiner: t.oneLiner,
                    durationMs: t.durationMs,
                    isError: t.isError,
                  })),
                  agentDescription: groupData.agentDescription,
                  agentId: groupData.agentId,
                  sessionId: entry?.cliSessionId,
                  projectPath: entry?.projectPath,
                });
              }
            }
          }
```

- [ ] **Step 4: 型チェック確認**

```bash
npx tsc --noEmit && echo "✅ types pass"
```

- [ ] **Step 5: コミット**

```bash
git add src/index.ts
git commit -m "feat(streaming-v2): integrate SerialActionQueue and GroupAction flow into index.ts"
```

### Task 7.2: 不要ファイルの削除

**Files:**
- Delete: `src/streaming/batch-aggregator.ts`
- Delete: `src/streaming/subagent-tracker.ts`
- Delete: `src/streaming/priority-queue.ts`
- Delete: `src/streaming/text-stream-updater.ts`
- Delete: `tests/streaming/batch-aggregator.test.ts`
- Delete: `tests/streaming/subagent-tracker.test.ts`
- Delete: `tests/streaming/priority-queue.test.ts`
- Delete: `tests/streaming/text-stream-updater.test.ts`

- [ ] **Step 1: ファイル削除**

```bash
rm src/streaming/batch-aggregator.ts src/streaming/subagent-tracker.ts src/streaming/priority-queue.ts src/streaming/text-stream-updater.ts && echo "✅ source deleted"
rm tests/streaming/batch-aggregator.test.ts tests/streaming/subagent-tracker.test.ts tests/streaming/priority-queue.test.ts tests/streaming/text-stream-updater.test.ts && echo "✅ tests deleted"
```

- [ ] **Step 2: 残存importの確認と修正**

```bash
grep -r 'batch-aggregator\|subagent-tracker\|priority-queue\|text-stream-updater' src/ tests/ && echo "⚠️ stale imports found" || echo "✅ no stale imports"
```

残存importがあれば削除する。

- [ ] **Step 3: 全テスト + 型チェック**

```bash
npx vitest run && npx tsc --noEmit && echo "✅ ALL PASS"
```

- [ ] **Step 4: コミット**

```bash
git add -A
git commit -m "refactor(streaming-v2): remove BatchAggregator, SubagentTracker, PriorityQueue, TextStreamUpdater"
```

### Task 7.3: 最終検証

- [ ] **Step 1: 全テスト実行**

```bash
npx vitest run && echo "✅ ALL TESTS PASS"
```

- [ ] **Step 2: 型チェック**

```bash
npx tsc --noEmit && echo "✅ TYPE CHECK PASS"
```

- [ ] **Step 3: マイルストーンコミット**

```bash
git commit --allow-empty -m "milestone: Streaming Display V2 implementation complete"
```

---

## Dependencies

```
Chunk 1 (型 + SerialActionQueue)
    ↓
Chunk 2 (ToolFormatter ライブ + 折りたたみ)
    ↓
Chunk 3 (GroupTracker)
    ↓
Chunk 4 (ToolResultCache + ModalBuilder)
    ↓
Chunk 5 (SubagentJsonlReader + SubAgentモーダル)
    ↓
Chunk 6 (StreamProcessor 全面改修)
    ↓
Chunk 7 (index.ts 統合 + 削除 + 検証)
```

Chunk 1-2 は並列可能。Chunk 4-5 も並列可能。Chunk 3, 6, 7 はそれぞれ前段に依存する。
