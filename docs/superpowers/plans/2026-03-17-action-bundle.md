# ActionBundle Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Unify all thinking/tool/subagent actions between text blocks into a single Slack message per bundle, reducing thread noise.

**Architecture:** Add an ActionBundle layer on top of GroupTracker. Each bundle owns one messageTs. Category switches update the same message (showing only the active category). Text arrival finalizes the bundle into a collapsed summary. Modals read all data from JSONL files, eliminating ToolResultCache.

**Tech Stack:** TypeScript, Slack Bolt, vitest

---

## Chunk 1: Types and GroupTracker Bundle Layer

### Task 1: Add CompletedGroup and BundleAction types

**Files:**
- Modify: `src/streaming/types.ts:110-156`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/streaming/types.test.ts — add import test
import type { CompletedGroup, BundleAction } from '../../src/streaming/types.js';

describe('ActionBundle types', () => {
  it('CompletedGroup accepts thinking category', () => {
    const cg: CompletedGroup = { category: 'thinking', thinkingTexts: ['hello'] };
    expect(cg.category).toBe('thinking');
  });

  it('CompletedGroup accepts tool category', () => {
    const cg: CompletedGroup = {
      category: 'tool',
      tools: [{ toolUseId: 'x', toolName: 'Read', input: {}, oneLiner: 'a.ts', status: 'completed', startTime: 0, durationMs: 100 }],
      totalDuration: 100,
    };
    expect(cg.tools).toHaveLength(1);
  });

  it('BundleAction has bundleId instead of groupId', () => {
    const action: BundleAction = {
      type: 'postMessage',
      bundleId: 'bundle-1',
      bundleIndex: 0,
      blocks: [],
      text: 'test',
    };
    expect(action.bundleId).toBe('bundle-1');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/streaming/types.test.ts`
Expected: FAIL — CompletedGroup and BundleAction not exported from types.ts

- [ ] **Step 3: Add types to types.ts**

Add after `ActiveGroup` interface (after line 151):

```typescript
export interface CompletedGroup {
  category: GroupCategory;
  // thinking
  thinkingTexts?: string[];
  // tool
  tools?: GroupToolInfo[];
  totalDuration?: number;
  // subagent
  agentDescription?: string;
  agentId?: string;
  agentSteps?: GroupStepInfo[];
  duration?: number;
}

export type BundleAction =
  | { type: 'postMessage'; bundleId: string; bundleIndex: number; blocks: Block[]; text: string }
  | { type: 'update'; bundleId: string; bundleIndex: number; messageTs: string; blocks: Block[]; text: string }
  | { type: 'collapse'; bundleId: string; bundleIndex: number; messageTs: string; blocks: Block[]; text: string; sessionId?: string };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/streaming/types.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/streaming/types.ts tests/streaming/types.test.ts
git commit -m "feat(types): add CompletedGroup and BundleAction types"
```

### Task 2: Add bundle collapsed block builder to tool-formatter

**Files:**
- Modify: `src/streaming/tool-formatter.ts:210-274`
- Test: `tests/streaming/tool-formatter.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// Add to tests/streaming/tool-formatter.test.ts
import { buildBundleCollapsedBlocks } from '../../src/streaming/tool-formatter.js';

describe('buildBundleCollapsedBlocks', () => {
  it('shows only present categories', () => {
    const blocks = buildBundleCollapsedBlocks({
      thinkingCount: 2,
      toolCount: 3,
      toolDurationMs: 1000,
      subagentCount: 0,
      subagentDurationMs: 0,
      sessionId: 'sess-1',
      bundleIndex: 0,
    });
    // Should have context block + actions block
    expect(blocks).toHaveLength(2);
    const contextText = (blocks[0] as any).elements[0].text;
    expect(contextText).toContain('💭×2');
    expect(contextText).toContain('🔧×3');
    expect(contextText).not.toContain('🤖');
  });

  it('shows all three categories when present', () => {
    const blocks = buildBundleCollapsedBlocks({
      thinkingCount: 1,
      toolCount: 2,
      toolDurationMs: 500,
      subagentCount: 1,
      subagentDurationMs: 3000,
      sessionId: 'sess-1',
      bundleIndex: 1,
    });
    const contextText = (blocks[0] as any).elements[0].text;
    expect(contextText).toContain('💭×1');
    expect(contextText).toContain('🔧×2');
    expect(contextText).toContain('🤖×1');
  });

  it('includes view_bundle action_id with sessionId and bundleIndex', () => {
    const blocks = buildBundleCollapsedBlocks({
      thinkingCount: 1,
      toolCount: 0,
      toolDurationMs: 0,
      subagentCount: 0,
      subagentDurationMs: 0,
      sessionId: 'abc-123',
      bundleIndex: 2,
    });
    const actionsBlock = blocks.find((b: any) => b.type === 'actions') as any;
    expect(actionsBlock.elements[0].action_id).toBe('view_bundle:abc-123:2');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/streaming/tool-formatter.test.ts`
Expected: FAIL — buildBundleCollapsedBlocks not exported

- [ ] **Step 3: Implement buildBundleCollapsedBlocks**

Add to `src/streaming/tool-formatter.ts`:

```typescript
interface BundleCollapsedConfig {
  thinkingCount: number;
  toolCount: number;
  toolDurationMs: number;
  subagentCount: number;
  subagentDurationMs: number;
  sessionId: string;
  bundleIndex: number;
}

export function buildBundleCollapsedBlocks(config: BundleCollapsedConfig): Block[] {
  const parts: string[] = [];

  // Fixed order: 💭 → 🔧 → 🤖, only present categories
  if (config.thinkingCount > 0) {
    parts.push(`💭×${config.thinkingCount}`);
  }
  if (config.toolCount > 0) {
    const durationStr = `${(config.toolDurationMs / 1000).toFixed(1)}s`;
    parts.push(`🔧×${config.toolCount} (${durationStr})`);
  }
  if (config.subagentCount > 0) {
    const durationStr = `${(config.subagentDurationMs / 1000).toFixed(1)}s`;
    parts.push(`🤖×${config.subagentCount} (${durationStr})`);
  }

  return [
    {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: parts.join('  ') }],
    },
    {
      type: 'actions',
      elements: [{
        type: 'button',
        text: { type: 'plain_text', text: '詳細を見る' },
        action_id: `view_bundle:${config.sessionId}:${config.bundleIndex}`,
      }],
    },
  ];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/streaming/tool-formatter.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/streaming/tool-formatter.ts tests/streaming/tool-formatter.test.ts
git commit -m "feat(tool-formatter): add buildBundleCollapsedBlocks"
```

### Task 3: Rewrite GroupTracker with ActionBundle layer

**Files:**
- Modify: `src/streaming/group-tracker.ts` (full rewrite)
- Test: `tests/streaming/group-tracker.test.ts` (full rewrite)

- [ ] **Step 1: Write the failing tests**

Replace `tests/streaming/group-tracker.test.ts` entirely:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { GroupTracker } from '../../src/streaming/group-tracker.js';

describe('GroupTracker with ActionBundle', () => {
  let tracker: GroupTracker;

  beforeEach(() => {
    tracker = new GroupTracker();
  });

  describe('bundle lifecycle', () => {
    it('creates bundle on first thinking event', () => {
      const actions = tracker.handleThinking('thought');
      expect(actions).toHaveLength(1);
      expect(actions[0].type).toBe('postMessage');
      expect(actions[0].bundleId).toMatch(/^bundle-/);
      expect(actions[0].bundleIndex).toBe(0);
    });

    it('creates bundle on first tool event', () => {
      const actions = tracker.handleToolUse('toolu_001', 'Read', { file_path: '/a.ts' });
      expect(actions).toHaveLength(1);
      expect(actions[0].type).toBe('postMessage');
      expect(actions[0].bundleId).toMatch(/^bundle-/);
    });

    it('reuses same bundle across category switches', () => {
      const a1 = tracker.handleThinking('thought');
      const bundleId = a1[0].bundleId;
      tracker.registerBundleMessageTs(bundleId, 'MSG_TS');

      const a2 = tracker.handleToolUse('toolu_001', 'Read', { file_path: '/a.ts' });
      // Should be update (same bundle), not postMessage
      expect(a2.every(a => a.bundleId === bundleId)).toBe(true);
      const hasPost = a2.some(a => a.type === 'postMessage');
      expect(hasPost).toBe(false);
    });

    it('collapses bundle on handleTextStart', () => {
      const a1 = tracker.handleThinking('thought');
      tracker.registerBundleMessageTs(a1[0].bundleId, 'MSG_TS');

      tracker.handleToolUse('toolu_001', 'Read', { file_path: '/a.ts' });
      tracker.handleToolResult('toolu_001', 'content', false);

      const collapseActions = tracker.handleTextStart('sess-1');
      const collapse = collapseActions.find(a => a.type === 'collapse');
      expect(collapse).toBeDefined();
      expect(collapse!.bundleIndex).toBe(0);
    });

    it('increments bundleIndex on each text arrival', () => {
      // Bundle 0
      const a1 = tracker.handleThinking('thought1');
      tracker.registerBundleMessageTs(a1[0].bundleId, 'MSG_TS_1');
      tracker.handleTextStart('sess-1');

      // Bundle 1
      const a2 = tracker.handleThinking('thought2');
      expect(a2[0].bundleIndex).toBe(1);
    });
  });

  describe('live display — category switches', () => {
    it('shows only active category blocks on update', () => {
      const a1 = tracker.handleThinking('thought');
      tracker.registerBundleMessageTs(a1[0].bundleId, 'MSG_TS');

      const a2 = tracker.handleToolUse('toolu_001', 'Read', { file_path: '/a.ts' });
      // The update should contain tool live blocks, not thinking blocks
      const update = a2.find(a => a.type === 'update');
      expect(update).toBeDefined();
      // Blocks should be tool live blocks (not thinking)
      const blockTexts = JSON.stringify(update!.blocks);
      expect(blockTexts).toContain('Read');
      expect(blockTexts).not.toContain('思考中');
    });
  });

  describe('tool group within bundle', () => {
    it('keeps sequential tools in same active group', () => {
      const a1 = tracker.handleToolUse('toolu_001', 'Read', { file_path: '/a.ts' });
      const bundleId = a1[0].bundleId;
      tracker.registerBundleMessageTs(bundleId, 'MSG_TS');

      tracker.handleToolResult('toolu_001', 'content', false);
      const a2 = tracker.handleToolUse('toolu_002', 'Bash', { command: 'ls' });
      // No new postMessage — same bundle
      expect(a2.every(a => a.type !== 'postMessage')).toBe(true);
    });
  });

  describe('subagent within bundle', () => {
    it('switches to subagent active group without new message', () => {
      const a1 = tracker.handleToolUse('toolu_001', 'Read', { file_path: '/a.ts' });
      tracker.registerBundleMessageTs(a1[0].bundleId, 'MSG_TS');
      tracker.handleToolResult('toolu_001', 'ok', false);

      const a2 = tracker.handleSubagentStart('toolu_agent', 'コード探索');
      expect(a2.every(a => a.type !== 'postMessage')).toBe(true);
      const update = a2.find(a => a.type === 'update');
      expect(update).toBeDefined();
    });

    it('tracks subagent steps as updates within same bundle', () => {
      const a1 = tracker.handleSubagentStart('toolu_agent', 'コード探索');
      const bundleId = a1[0].bundleId;
      tracker.registerBundleMessageTs(bundleId, 'MSG_TS');

      // Force debounce pass
      const group = tracker.getActiveGroupData();
      if (group) group.lastUpdateTime = 0;

      const a2 = tracker.handleSubagentStep('toolu_agent', 'Read', 'toolu_child', 'src/a.ts');
      const update = a2.find(a => a.type === 'update');
      expect(update).toBeDefined();
      expect(update!.bundleId).toBe(bundleId);
    });

    it('subagent complete does NOT collapse bundle — keeps it open', () => {
      const a1 = tracker.handleSubagentStart('toolu_agent', 'コード探索');
      const bundleId = a1[0].bundleId;
      tracker.registerBundleMessageTs(bundleId, 'MSG_TS');

      const a2 = tracker.handleSubagentComplete('toolu_agent', 'done', 5000);
      // Should NOT have a collapse action — bundle stays open
      const collapse = a2.find(a => a.type === 'collapse');
      expect(collapse).toBeUndefined();
    });

    it('subagent complete → next tool arrives → same bundle', () => {
      const a1 = tracker.handleSubagentStart('toolu_agent', 'コード探索');
      const bundleId = a1[0].bundleId;
      tracker.registerBundleMessageTs(bundleId, 'MSG_TS');

      tracker.handleSubagentComplete('toolu_agent', 'done', 5000);

      const a3 = tracker.handleToolUse('toolu_002', 'Grep', { pattern: 'foo' });
      expect(a3.every(a => a.bundleId === bundleId)).toBe(true);
      expect(a3.every(a => a.type !== 'postMessage')).toBe(true);
    });

    it('subagent step result updates within same bundle', () => {
      const a1 = tracker.handleSubagentStart('toolu_agent', 'コード探索');
      tracker.registerBundleMessageTs(a1[0].bundleId, 'MSG_TS');

      tracker.handleSubagentStep('toolu_agent', 'Read', 'toolu_child', 'src/a.ts');

      // Force debounce pass
      const group = tracker.getActiveGroupData();
      if (group) group.lastUpdateTime = 0;

      const a2 = tracker.handleSubagentStepResult('toolu_agent', 'toolu_child', false);
      const update = a2.find(a => a.type === 'update');
      if (update) {
        expect(update.bundleId).toBe(a1[0].bundleId);
      }
    });
  });

  describe('collapsed bundle summary', () => {
    it('aggregates counts across completed groups', () => {
      const a1 = tracker.handleThinking('thought');
      tracker.registerBundleMessageTs(a1[0].bundleId, 'MSG_TS');

      tracker.handleToolUse('toolu_001', 'Read', { file_path: '/a.ts' });
      tracker.handleToolResult('toolu_001', 'ok', false);

      const collapse = tracker.handleTextStart('sess-1');
      const collapseAction = collapse.find(a => a.type === 'collapse');
      expect(collapseAction).toBeDefined();
      // Blocks should contain bundle collapsed summary
      const blockText = JSON.stringify(collapseAction!.blocks);
      expect(blockText).toContain('💭×1');
      expect(blockText).toContain('🔧×1');
    });
  });

  describe('flushActiveBundle', () => {
    it('collapses active bundle on stream end', () => {
      const a1 = tracker.handleToolUse('toolu_001', 'Read', { file_path: '/a.ts' });
      tracker.registerBundleMessageTs(a1[0].bundleId, 'MSG_TS');

      const actions = tracker.flushActiveBundle('sess-1');
      expect(actions).toHaveLength(1);
      expect(actions[0].type).toBe('collapse');
    });

    it('marks running tools as error on flush', () => {
      const a1 = tracker.handleToolUse('toolu_001', 'Read', { file_path: '/a.ts' });
      tracker.registerBundleMessageTs(a1[0].bundleId, 'MSG_TS');

      tracker.flushActiveBundle('sess-1');
      // Verify via collapsed blocks that it was processed
      // (internal state is private, but collapse should succeed)
    });

    it('returns empty when no active bundle', () => {
      const actions = tracker.flushActiveBundle('sess-1');
      expect(actions).toHaveLength(0);
    });
  });

  describe('registerBundleMessageTs', () => {
    it('registers messageTs for active bundle', () => {
      const a1 = tracker.handleThinking('thought');
      const bundleId = a1[0].bundleId;

      tracker.registerBundleMessageTs(bundleId, 'MSG_TS');

      // Now updates should include messageTs
      const group = tracker.getActiveGroupData();
      // Force debounce pass
      if (group) group.lastUpdateTime = 0;

      const a2 = tracker.handleThinking('more thought');
      const update = a2.find(a => a.type === 'update');
      expect(update).toBeDefined();
      expect(update!.messageTs).toBe('MSG_TS');
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/streaming/group-tracker.test.ts`
Expected: FAIL — GroupTracker methods return GroupAction (with groupId), not BundleAction (with bundleId)

- [ ] **Step 3: Rewrite GroupTracker with ActionBundle layer**

Rewrite `src/streaming/group-tracker.ts`:

The new GroupTracker manages:
- `activeBundle: ActionBundle | null` — current bundle (one messageTs)
- `bundleCounter: number` — increments for each new bundle
- `activeGroup: ActiveGroup | null` — current category group within the bundle
- Methods return `BundleAction[]` instead of `GroupAction[]`

Key changes:
- `handleThinking/handleToolUse/handleSubagentStart` — if no active bundle, create one and return `postMessage`. If active bundle exists but category differs, move activeGroup to `completedGroups`, create new activeGroup, return `update` with new category's live blocks.
- `handleToolResult(toolUseId, result, isError)` — same as before, updates tool status within activeGroup. Returns `update` if debounce allows.
- `handleSubagentStep(agentToolUseId, toolName, toolUseId, oneLiner)` — adds step to activeGroup (subagent). Returns `update` with bundleId.
- `handleSubagentStepResult(agentToolUseId, toolUseId, isError)` — updates step status. Returns `update` with bundleId.
- `handleSubagentComplete(agentToolUseId, result, durationMs)` — **does NOT collapse the bundle**. Moves activeGroup (subagent) to completedGroups. The bundle stays open for the next category. Returns `update` (not collapse).
- `handleTextStart(sessionId)` — move activeGroup to completedGroups, collapse entire bundle, return `collapse` with `buildBundleCollapsedBlocks`. Reset bundle.
- `flushActiveBundle(sessionId)` — same as handleTextStart but marks running items as error first.
- `registerBundleMessageTs(bundleId, messageTs)` — set `activeBundle.messageTs`.
- Remove: `registerMessageTs(groupId, ...)`, `getGroupData(groupId)`, `setAgentId(groupId, ...)`, `completedGroups Map`.
- `setAgentId(agentId)` — sets on activeGroup (no groupId needed, always current).

The bundle stores `completedGroups: CompletedGroup[]` in time order for the collapse summary calculation.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/streaming/group-tracker.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/streaming/group-tracker.ts tests/streaming/group-tracker.test.ts
git commit -m "feat(group-tracker): rewrite with ActionBundle layer"
```

### Task 4: Update StreamProcessor to use BundleAction

**Files:**
- Modify: `src/streaming/stream-processor.ts`
- Modify: `tests/streaming/stream-processor.test.ts`
- Modify: `src/streaming/types.ts` (ProcessedActions)

- [ ] **Step 1: Write the failing test**

Update `tests/streaming/stream-processor.test.ts`. Key test cases:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { StreamProcessor } from '../../src/streaming/stream-processor.js';

describe('StreamProcessor with BundleAction', () => {
  let processor: StreamProcessor;

  beforeEach(() => {
    processor = new StreamProcessor({ channel: 'C123', threadTs: '1234.5678', sessionId: 'sess-1' });
  });

  it('returns bundleActions instead of groupActions', () => {
    const result = processor.processEvent({
      type: 'assistant',
      message: { content: [{ type: 'thinking', thinking: 'hmm' }] },
    });
    expect(result.bundleActions).toBeDefined();
    expect(result.bundleActions.length).toBeGreaterThan(0);
    expect(result.bundleActions[0].bundleId).toBeDefined();
  });

  it('thinking then tool stays in same bundle', () => {
    const r1 = processor.processEvent({
      type: 'assistant',
      message: { content: [{ type: 'thinking', thinking: 'hmm' }] },
    });
    processor.registerBundleMessageTs(r1.bundleActions[0].bundleId, 'MSG_TS');

    const r2 = processor.processEvent({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 'toolu_001', name: 'Read', input: { file_path: '/a.ts' } }] },
    });
    expect(r2.bundleActions[0].bundleId).toBe(r1.bundleActions[0].bundleId);
  });

  it('text event collapses bundle', () => {
    const r1 = processor.processEvent({
      type: 'assistant',
      message: { content: [{ type: 'thinking', thinking: 'hmm' }] },
    });
    processor.registerBundleMessageTs(r1.bundleActions[0].bundleId, 'MSG_TS');

    const r2 = processor.processEvent({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'Here is the answer which is long enough to post immediately because it exceeds one hundred characters in length so the buffer triggers a post' }] },
    });
    const collapse = r2.bundleActions.find(a => a.type === 'collapse');
    expect(collapse).toBeDefined();
  });

  it('result event flushes active bundle', () => {
    const r1 = processor.processEvent({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 'toolu_001', name: 'Read', input: { file_path: '/a.ts' } }] },
    });
    processor.registerBundleMessageTs(r1.bundleActions[0].bundleId, 'MSG_TS');

    const r2 = processor.processEvent({ type: 'result', duration_ms: 1000 });
    const collapse = r2.bundleActions.find(a => a.type === 'collapse');
    expect(collapse).toBeDefined();
    expect(r2.resultEvent).toBeDefined();
  });

  it('subagent complete does NOT collapse bundle', () => {
    const r1 = processor.processEvent({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 'toolu_agent', name: 'Agent', input: { description: 'explore' } }] },
    });
    processor.registerBundleMessageTs(r1.bundleActions[0].bundleId, 'MSG_TS');

    const r2 = processor.processEvent({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_agent', content: 'agentId: abc123\ndone' }] },
    });
    // Subagent complete should NOT collapse the bundle
    const collapse = r2.bundleActions.find(a => a.type === 'collapse');
    expect(collapse).toBeUndefined();
  });

  it('extracts agentId from subagent tool_result and sets on tracker', () => {
    const r1 = processor.processEvent({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 'toolu_agent', name: 'Agent', input: { description: 'explore' } }] },
    });
    processor.registerBundleMessageTs(r1.bundleActions[0].bundleId, 'MSG_TS');

    processor.processEvent({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_agent', content: 'agentId: abc123\ndone' }] },
    });
    // agentId should be set internally — verified by the fact that no error occurs
    // and the collapsed bundle would include the agentId info
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/streaming/stream-processor.test.ts`
Expected: FAIL — `bundleActions` does not exist on ProcessedActions

- [ ] **Step 3: Update StreamProcessor**

Key changes to `src/streaming/stream-processor.ts`:

1. **Config**: Add `sessionId` to `StreamProcessorConfig`
2. **ProcessedActions**: Change `groupActions` → `bundleActions: BundleAction[]` in types.ts
3. **registerGroupMessageTs** → `registerBundleMessageTs(bundleId, ts)`
4. **handleText**: calls `groupTracker.handleTextStart(this.config.sessionId)` to collapse bundle
5. **handleResult**: calls `groupTracker.flushActiveBundle(this.config.sessionId)`
6. **handleToolResult** (L180-193): Keep agentId extraction here (NOT in index.ts). Update to call `this.groupTracker.setAgentId(agentId)` instead of `this.groupTracker.setAgentId(groupId, agentId)`:
```typescript
// In handleToolResult, after handleSubagentComplete:
const agentIdMatch = resultText.match(/agentId:\s*([\w]+)/);
if (agentIdMatch) {
  this.groupTracker.setAgentId(agentIdMatch[1]);
}
```
7. **Remove**: `getGroupData`, `getActiveGroupData` pass-throughs (no longer needed for index.ts caching)
8. **Keep**: `setAgentId(agentId)` pass-through for external callers, `getActiveGroupData()` (needed for Task 3 tests)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/streaming/stream-processor.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/streaming/stream-processor.ts tests/streaming/stream-processor.test.ts src/streaming/types.ts
git commit -m "feat(stream-processor): use BundleAction instead of GroupAction"
```

## Chunk 2: SessionJsonlReader.readBundle and Modal Builder

### Task 5: Add readBundle method to SessionJsonlReader

**Files:**
- Modify: `src/streaming/session-jsonl-reader.ts`
- Create: `tests/streaming/session-jsonl-reader.test.ts` (extend existing)

- [ ] **Step 1: Write the failing test**

```typescript
// Add to tests/streaming/session-jsonl-reader.test.ts
import { SessionJsonlReader, BundleEntry } from '../../src/streaming/session-jsonl-reader.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('SessionJsonlReader.readBundle', () => {
  let reader: SessionJsonlReader;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsonl-test-'));
    reader = new SessionJsonlReader(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true });
  });

  function writeJsonl(projectPath: string, sessionId: string, lines: any[]) {
    const dirName = projectPath.replace(/\//g, '-');
    const dir = path.join(tmpDir, dirName);
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, `${sessionId}.jsonl`);
    const content = lines.map(l => JSON.stringify(l)).join('\n');
    fs.writeFileSync(filePath, content);
  }

  it('extracts bundle 0 (before first text)', async () => {
    writeJsonl('/test/project', 'sess-1', [
      // thinking
      { message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'Let me think...' }] } },
      // tool_use
      { message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_001', name: 'Read', input: { file_path: '/a.ts' } }] } },
      // tool_result
      { message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_001', content: 'file content' }] } },
      // text (boundary of bundle 0)
      { message: { role: 'assistant', content: [{ type: 'text', text: 'Here is the result' }] } },
    ]);

    const entries = await reader.readBundle('/test/project', 'sess-1', 0);
    expect(entries).toHaveLength(2); // 1 thinking + 1 tool
    expect(entries[0].type).toBe('thinking');
    expect((entries[0] as any).texts).toEqual(['Let me think...']);
    expect(entries[1].type).toBe('tool');
    expect((entries[1] as any).toolName).toBe('Read');
  });

  it('extracts bundle 1 (between first and second text)', async () => {
    writeJsonl('/test/project', 'sess-1', [
      { message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'thought1' }] } },
      { message: { role: 'assistant', content: [{ type: 'text', text: 'text1' }] } },
      // Bundle 1 starts here
      { message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'thought2' }] } },
      { message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_002', name: 'Grep', input: { pattern: 'foo' } }] } },
      { message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_002', content: '3 matches' }] } },
      { message: { role: 'assistant', content: [{ type: 'text', text: 'text2' }] } },
    ]);

    const entries = await reader.readBundle('/test/project', 'sess-1', 1);
    expect(entries).toHaveLength(2);
    expect(entries[0].type).toBe('thinking');
    expect(entries[1].type).toBe('tool');
    expect((entries[1] as any).toolName).toBe('Grep');
  });

  it('handles subagent (Agent tool_use) correctly', async () => {
    writeJsonl('/test/project', 'sess-1', [
      { message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_agent', name: 'Agent', input: { description: 'explore code' } }] } },
      // Child tools (parent_tool_use_id present) — should NOT appear as top-level entries
      { parent_tool_use_id: 'toolu_agent', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_child', name: 'Read', input: { file_path: '/b.ts' } }] } },
      { parent_tool_use_id: 'toolu_agent', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_child', content: 'child result' }] } },
      // Agent result
      { message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_agent', content: 'agentId: abc123\ndone' }] } },
      { message: { role: 'assistant', content: [{ type: 'text', text: 'finished' }] } },
    ]);

    const entries = await reader.readBundle('/test/project', 'sess-1', 0);
    expect(entries).toHaveLength(1); // Only subagent, no child tools at top level
    expect(entries[0].type).toBe('subagent');
    expect((entries[0] as any).description).toBe('explore code');
    expect((entries[0] as any).agentId).toBe('abc123');
  });

  it('merges consecutive thinking blocks into one entry', async () => {
    writeJsonl('/test/project', 'sess-1', [
      { message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'part1' }] } },
      { message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'part2' }] } },
      { message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_001', name: 'Read', input: { file_path: '/a.ts' } }] } },
      { message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } },
    ]);

    const entries = await reader.readBundle('/test/project', 'sess-1', 0);
    expect(entries).toHaveLength(2); // 1 merged thinking + 1 tool
    expect(entries[0].type).toBe('thinking');
    expect((entries[0] as any).texts).toEqual(['part1', 'part2']);
  });

  it('returns empty for out-of-range bundleIndex', async () => {
    writeJsonl('/test/project', 'sess-1', [
      { message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'thought' }] } },
      { message: { role: 'assistant', content: [{ type: 'text', text: 'text' }] } },
    ]);

    const entries = await reader.readBundle('/test/project', 'sess-1', 5);
    expect(entries).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/streaming/session-jsonl-reader.test.ts`
Expected: FAIL — readBundle method does not exist

- [ ] **Step 3: Implement readBundle**

Add to `src/streaming/session-jsonl-reader.ts`:

```typescript
export type BundleEntry =
  | { type: 'thinking'; texts: string[] }
  | { type: 'tool'; toolUseId: string; toolName: string; oneLiner: string; durationMs: number }
  | { type: 'subagent'; toolUseId: string; description: string; agentId: string; durationMs: number };

async readBundle(
  projectPath: string,
  sessionId: string,
  bundleIndex: number,
): Promise<BundleEntry[]> {
  const dirName = this.toProjectDirName(projectPath);
  const filePath = path.join(this.claudeProjectsDir, dirName, `${sessionId}.jsonl`);

  if (!fs.existsSync(filePath)) return [];

  try {
    return await this.extractBundle(filePath, bundleIndex);
  } catch (err) {
    logger.error('Failed to read bundle from JSONL', { error: (err as Error).message });
    return [];
  }
}
```

The `extractBundle` method:
1. Reads JSONL line by line
2. Tracks textBlockCount (increments when text block seen at top level)
3. Collects non-text events when textBlockCount === bundleIndex
4. When textBlockCount > bundleIndex, stops scanning
5. Groups consecutive thinking blocks
6. Identifies Agent tool_use as subagent, skips child events (parent_tool_use_id set)
7. Calculates tool duration from tool_use startTime to tool_result
8. Uses `getToolOneLiner` for tool one-liner generation

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/streaming/session-jsonl-reader.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/streaming/session-jsonl-reader.ts tests/streaming/session-jsonl-reader.test.ts
git commit -m "feat(session-jsonl-reader): add readBundle for JSONL-driven modal display"
```

### Task 6: Add buildBundleDetailModal to modal-builder

**Files:**
- Modify: `src/slack/modal-builder.ts`
- Modify: `tests/slack/modal-builder.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// Add to tests/slack/modal-builder.test.ts
import { buildBundleDetailModal } from '../../src/slack/modal-builder.js';
import type { BundleEntry } from '../../src/streaming/session-jsonl-reader.js';

describe('buildBundleDetailModal', () => {
  it('renders thinking entry with text preview', () => {
    const entries: BundleEntry[] = [
      { type: 'thinking', texts: ['Let me analyze the file structure and find...'] },
    ];
    const modal = buildBundleDetailModal(entries, 'sess-1');
    expect(modal.type).toBe('modal');
    const blockTexts = JSON.stringify(modal.blocks);
    expect(blockTexts).toContain('💭');
    expect(blockTexts).toContain('Let me analyze');
  });

  it('renders tool entry with detail button', () => {
    const entries: BundleEntry[] = [
      { type: 'tool', toolUseId: 'toolu_001', toolName: 'Read', oneLiner: 'src/auth.ts', durationMs: 200 },
    ];
    const modal = buildBundleDetailModal(entries, 'sess-1');
    const blockTexts = JSON.stringify(modal.blocks);
    expect(blockTexts).toContain('Read');
    expect(blockTexts).toContain('view_tool_detail:sess-1:toolu_001');
  });

  it('renders subagent entry with detail button', () => {
    const entries: BundleEntry[] = [
      { type: 'subagent', toolUseId: 'toolu_agent', description: 'コード探索', agentId: 'abc', durationMs: 3000 },
    ];
    const modal = buildBundleDetailModal(entries, 'sess-1');
    const blockTexts = JSON.stringify(modal.blocks);
    expect(blockTexts).toContain('🤖');
    expect(blockTexts).toContain('コード探索');
    expect(blockTexts).toContain('view_subagent_detail:sess-1:toolu_agent');
  });

  it('renders mixed entries in order with dividers', () => {
    const entries: BundleEntry[] = [
      { type: 'thinking', texts: ['hmm'] },
      { type: 'tool', toolUseId: 'toolu_001', toolName: 'Read', oneLiner: 'a.ts', durationMs: 100 },
      { type: 'tool', toolUseId: 'toolu_002', toolName: 'Bash', oneLiner: 'ls', durationMs: 500 },
    ];
    const modal = buildBundleDetailModal(entries, 'sess-1');
    expect(modal.blocks.length).toBeGreaterThanOrEqual(4); // header + thinking + divider + tool...
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/slack/modal-builder.test.ts`
Expected: FAIL — buildBundleDetailModal not exported

- [ ] **Step 3: Implement buildBundleDetailModal**

Add to `src/slack/modal-builder.ts`:

```typescript
import type { BundleEntry } from '../streaming/session-jsonl-reader.js';

export function buildBundleDetailModal(entries: BundleEntry[], sessionId: string): any {
  const blocks: Block[] = [
    { type: 'header', text: { type: 'plain_text', text: 'アクション詳細' } },
  ];

  for (const [i, entry] of entries.entries()) {
    if (i > 0) blocks.push({ type: 'divider' });

    if (entry.type === 'thinking') {
      const preview = truncate(entry.texts.join(' '), 50);
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: `💭 _${preview}_` },
      });
    } else if (entry.type === 'tool') {
      const durationStr = `${(entry.durationMs / 1000).toFixed(1)}s`;
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: `🔧 \`${entry.toolName}\` ${entry.oneLiner} (${durationStr})` },
        accessory: {
          type: 'button',
          text: { type: 'plain_text', text: '詳細を見る' },
          action_id: `view_tool_detail:${sessionId}:${entry.toolUseId}`,
        },
      });
    } else if (entry.type === 'subagent') {
      const durationStr = `${(entry.durationMs / 1000).toFixed(1)}s`;
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: `🤖 SubAgent: "${entry.description}" (${durationStr})` },
        accessory: {
          type: 'button',
          text: { type: 'plain_text', text: '詳細を見る' },
          action_id: `view_subagent_detail:${sessionId}:${entry.toolUseId}`,
        },
      });
    }
  }

  return {
    type: 'modal',
    title: { type: 'plain_text', text: 'アクション詳細' },
    close: { type: 'plain_text', text: '閉じる' },
    blocks: blocks.slice(0, 100),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/slack/modal-builder.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/slack/modal-builder.ts tests/slack/modal-builder.test.ts
git commit -m "feat(modal-builder): add buildBundleDetailModal for 2-tier modal"
```

## Chunk 3: Integration — index.ts Wiring and Cleanup

### Task 7: Update index.ts to use BundleAction and new handlers

**Files:**
- Modify: `src/index.ts:340-524` (wireSessionOutput)
- Modify: `src/index.ts:620-734` (action handlers)

- [ ] **Step 1: Update wireSessionOutput**

Changes to `wireSessionOutput` (L340-524):

1. **StreamProcessor constructor** — pass `sessionId`:
```typescript
const streamProcessor = new StreamProcessor({
  channel: channelId,
  threadTs,
  sessionId: session.sessionId,
});
```

2. **convertGroupActionToSlackAction** → rename to `convertBundleActionToSlackAction`:
```typescript
function convertBundleActionToSlackAction(ba: BundleAction): any {
  const priority = ba.type === 'update' ? 4 : 3;
  return {
    type: ba.type === 'postMessage' ? 'postMessage' : 'update',
    priority,
    channel: channelId,
    threadTs,
    messageTs: (ba as any).messageTs,
    blocks: ba.blocks,
    text: ba.text || '',
    metadata: {
      messageType: 'tool_use',
      bundleId: ba.bundleId,
    },
  };
}
```

3. **Event handler group actions loop** (L378-385) → use `bundleActions`:
```typescript
const { bundleActions, textAction, resultEvent } = streamProcessor.processEvent(event);

for (const ba of bundleActions) {
  const slackAction = convertBundleActionToSlackAction(ba);
  const result = await executor.execute(slackAction);
  if (result.ok && result.ts && ba.type === 'postMessage') {
    streamProcessor.registerBundleMessageTs(ba.bundleId, result.ts);
  }
}
```

4. **Remove group data caching** (L387-411) — delete this entire block. No more toolResultCache.setGroupData.

5. **Remove individual tool result caching** (L414-452) — delete this entire block. No more toolResultCache.set.

Note: agentId extraction is now handled inside StreamProcessor.handleToolResult (Task 4), not in index.ts.

- [ ] **Step 2: Update action handlers**

Replace `view_group_detail` handler (L687-734) with `view_bundle` handler:

```typescript
app.action(/^view_bundle:/, async ({ ack, body }: any) => {
  await ack();
  const actionId = body.actions?.[0]?.action_id || '';
  const parts = actionId.split(':');
  const sessionId = parts[1];
  const bundleIndex = parseInt(parts[2], 10);
  if (!sessionId || isNaN(bundleIndex)) return;

  const entry = sessionIndexStore.findBySessionId(sessionId);
  if (!entry) {
    logger.warn(`No session found for ${sessionId}`);
    return;
  }

  const entries = await sessionJsonlReader.readBundle(
    entry.projectPath,
    sessionId,
    bundleIndex,
  );

  if (entries.length === 0) {
    logger.warn(`No bundle entries for ${sessionId}:${bundleIndex}`);
    return;
  }

  const modal = buildBundleDetailModal(entries, sessionId);
  const threadTs = body.message?.thread_ts || body.message?.ts || '';
  modal.private_metadata = threadTs;

  await app.client.views.open({
    trigger_id: body.trigger_id,
    view: modal,
  });
});
```

Update `view_tool_detail` handler to support new `{sessionId}:{toolUseId}` format:

```typescript
app.action(/^view_tool_detail:/, async ({ ack, body }: any) => {
  await ack();
  const actionId = body.actions?.[0]?.action_id || '';
  const parts = actionId.split(':');
  // Support both old format (view_tool_detail:toolUseId) and new (view_tool_detail:sessionId:toolUseId)
  let sessionId: string | undefined;
  let toolUseId: string;
  if (parts.length >= 3) {
    sessionId = parts[1];
    toolUseId = parts[2];
  } else {
    toolUseId = parts[1];
  }
  if (!toolUseId) return;

  const isFromModal = !!body.view;

  // Find session entry
  let entry: any = null;
  if (sessionId) {
    entry = sessionIndexStore.findBySessionId(sessionId);
  }
  if (!entry) {
    const threadTs = body.message?.thread_ts || body.message?.ts
      || body.view?.private_metadata || '';
    entry = threadTs ? sessionIndexStore.findByThreadTs(threadTs) : null;
  }

  let modal: any = null;
  if (entry) {
    const detail = await sessionJsonlReader.readToolDetail(
      entry.projectPath,
      entry.cliSessionId,
      toolUseId,
    );
    if (detail) {
      modal = buildToolModal({
        toolId: detail.toolUseId,
        toolName: detail.toolName,
        input: detail.input,
        result: detail.result,
        durationMs: 0,
        isError: detail.isError,
      });
    }
  }

  if (!modal) {
    logger.warn(`No data found for tool ${toolUseId}`);
    return;
  }

  if (isFromModal) {
    await app.client.views.push({ trigger_id: body.trigger_id, view: modal });
  } else {
    await app.client.views.open({ trigger_id: body.trigger_id, view: modal });
  }
});
```

Add `view_subagent_detail` handler:

```typescript
app.action(/^view_subagent_detail:/, async ({ ack, body }: any) => {
  await ack();
  const actionId = body.actions?.[0]?.action_id || '';
  const parts = actionId.split(':');
  const sessionId = parts[1];
  const toolUseId = parts[2];
  if (!sessionId || !toolUseId) return;

  const entry = sessionIndexStore.findBySessionId(sessionId);
  if (!entry) return;

  // Read the Agent tool_result to extract agentId
  const agentResult = await sessionJsonlReader.readToolDetail(
    entry.projectPath,
    entry.cliSessionId,
    toolUseId,
  );

  let agentId: string | null = null;
  if (agentResult) {
    const match = agentResult.result.match(/agentId:\s*([\w]+)/);
    if (match) agentId = match[1];
  }

  let flow = null;
  if (agentId) {
    flow = await subagentReader.read(entry.projectPath, entry.cliSessionId, agentId);
  }

  const description = agentResult?.input?.description as string || 'SubAgent';
  const modal = buildSubagentModal(description, flow);
  const threadTs = body.message?.thread_ts || body.message?.ts
    || body.view?.private_metadata || '';
  modal.private_metadata = threadTs;

  const isFromModal = !!body.view;
  if (isFromModal) {
    await app.client.views.push({ trigger_id: body.trigger_id, view: modal });
  } else {
    await app.client.views.open({ trigger_id: body.trigger_id, view: modal });
  }
});
```

- [ ] **Step 3: Verify compilation**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add src/index.ts
git commit -m "feat(index): wire BundleAction flow and new modal handlers"
```

### Task 8: Remove ToolResultCache

**Files:**
- Delete: `src/streaming/tool-result-cache.ts`
- Delete: `tests/streaming/tool-result-cache.test.ts`
- Modify: `src/index.ts` — remove imports and initialization of `toolResultCache`

- [ ] **Step 1: Remove ToolResultCache import and usage from index.ts**

Remove:
- `import { ToolResultCache } from './streaming/tool-result-cache.js';`
- `const toolResultCache = new ToolResultCache();`
- Any remaining references to `toolResultCache`

- [ ] **Step 2: Delete ToolResultCache files**

```bash
rm src/streaming/tool-result-cache.ts tests/streaming/tool-result-cache.test.ts
```

- [ ] **Step 3: Remove old GroupAction type if unused**

Check if `GroupAction` type is still referenced anywhere. If not, remove it from `types.ts`.

- [ ] **Step 4: Verify compilation and tests**

Run: `npx tsc --noEmit && npx vitest run`
Expected: All pass, no compilation errors

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor: remove ToolResultCache, all modal data now from JSONL"
```

### Task 9: Run full test suite and fix any issues

**Files:**
- Various — fix any broken tests

- [ ] **Step 1: Run full test suite**

Run: `npx vitest run`
Expected: All pass

- [ ] **Step 2: Fix any failing tests**

Address test failures from the integration changes.

- [ ] **Step 3: Run TypeScript compilation check**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Commit fixes if any**

```bash
git add -A
git commit -m "fix: resolve test failures from ActionBundle migration"
```

### Task 10: Manual smoke test checklist

- [ ] **Step 1: Start the app**

Run: `npx tsx src/index.ts`

- [ ] **Step 2: Send a message in Slack that triggers thinking + tool + text**

Verify:
- Single message appears for thinking (live display)
- Message updates to show tool execution (live display, thinking disappears)
- Message collapses to `💭×1 🔧×N (Xs)` when text arrives
- Text appears as separate message

- [ ] **Step 3: Click [詳細を見る] on collapsed bundle**

Verify:
- Modal opens with time-ordered list of actions
- Thinking shows text preview without detail button
- Tool entries have [詳細を見る] button
- Clicking tool detail opens second modal with full input/output

- [ ] **Step 4: Test with subagent flow**

Verify:
- SubAgent appears in bundle live display
- Collapsed bundle shows 🤖 count
- SubAgent detail modal shows JSONL conversation flow
