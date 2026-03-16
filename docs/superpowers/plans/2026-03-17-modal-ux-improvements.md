# Modal UX Improvements Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Improve Slack modal UX for mobile: remove redundant headers, add thinking detail modal, convert entries to buttons, persist checkmark reactions, and fix interrupt targeting.

**Architecture:** Five independent changes to `modal-builder.ts`, `reaction-manager.ts`, and `index.ts`. Changes 1-3 are in the modal layer, change 4 is in the reaction layer, change 5 is in the event handler layer. No new files needed.

**Tech Stack:** TypeScript, Slack Block Kit, Vitest

**Spec:** `docs/superpowers/specs/2026-03-17-modal-ux-improvements-design.md`

---

## Chunk 1: Modal Header Removal + Reaction Changes

### Task 1: Remove header blocks from all modals

**Files:**
- Modify: `src/slack/modal-builder.ts:20-24, 56-61, 99-103, 139-143, 215`
- Modify: `tests/slack/modal-builder.test.ts`

- [ ] **Step 1: Update tests — assert no header block exists**

In `tests/slack/modal-builder.test.ts`, add assertions to existing tests. For each `describe` block, add a test:

```typescript
// In describe('buildToolModal')
it('does not include a header block in body', () => {
  const modal = buildToolModal({
    toolId: 'toolu_001',
    toolName: 'Read',
    input: { file_path: '/a.ts' },
    result: 'ok',
    durationMs: 100,
    isError: false,
  });
  const headerBlocks = modal.blocks.filter((b: any) => b.type === 'header');
  expect(headerBlocks).toHaveLength(0);
});

// In describe('buildThinkingModal')
it('does not include a header block in body', () => {
  const modal = buildThinkingModal(['thought']);
  const headerBlocks = modal.blocks.filter((b: any) => b.type === 'header');
  expect(headerBlocks).toHaveLength(0);
});

// In describe('buildToolGroupModal')
it('does not include a header block in body', () => {
  const modal = buildToolGroupModal([
    { toolUseId: 'toolu_001', toolName: 'Read', oneLiner: 'a.ts', durationMs: 100, isError: false },
  ]);
  const headerBlocks = modal.blocks.filter((b: any) => b.type === 'header');
  expect(headerBlocks).toHaveLength(0);
});

// In describe('buildSubagentModal') — add to the existing 'displays conversation flow' test or new test
it('does not include a header block in body', () => {
  const modal = buildSubagentModal('test', null);
  const headerBlocks = modal.blocks.filter((b: any) => b.type === 'header');
  expect(headerBlocks).toHaveLength(0);
});

// In describe('buildBundleDetailModal')
it('does not include a header block in body', () => {
  const entries = [{ type: 'thinking' as const, texts: ['hmm'] }];
  const modal = buildBundleDetailModal(entries, 'sess-1', 0);
  const headerBlocks = modal.blocks.filter((b: any) => b.type === 'header');
  expect(headerBlocks).toHaveLength(0);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/slack/modal-builder.test.ts`
Expected: FAIL — all 5 new tests fail because header blocks still exist.

- [ ] **Step 3: Remove header blocks from all 5 functions**

In `src/slack/modal-builder.ts`:

**`buildToolModal` (L20-24):** Remove the header block from the blocks array:
```typescript
// BEFORE:
const blocks: Block[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: config.toolName },
    },
    {
// AFTER:
const blocks: Block[] = [
    {
```
Remove lines 21-24 (the header object). The next element (`type: 'section'` for input) becomes the first block.

**`buildThinkingModal` (L56-61):** Remove the header block:
```typescript
// BEFORE:
const blocks: Block[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: '思考詳細' },
    },
  ];
// AFTER:
const blocks: Block[] = [];
```

**`buildToolGroupModal` (L99-103):** Remove the header block:
```typescript
// BEFORE:
const blocks: Block[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: 'ツール実行詳細' },
    },
  ];
// AFTER:
const blocks: Block[] = [];
```

**`buildSubagentModal` (L139-143):** Remove the header block:
```typescript
// BEFORE:
const blocks: Block[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: truncate(`SubAgent: ${description}`, 24) },
    },
  ];
// AFTER:
const blocks: Block[] = [];
```

**`buildBundleDetailModal` (L215):** Remove the header block:
```typescript
// BEFORE:
const blocks: Block[] = [
    { type: 'header', text: { type: 'plain_text', text: 'アクション詳細' } },
  ];
// AFTER:
const blocks: Block[] = [];
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/slack/modal-builder.test.ts`
Expected: All tests PASS. Some existing tests may need adjustment if they depended on header block count.

- [ ] **Step 5: Commit**

```bash
git add src/slack/modal-builder.ts tests/slack/modal-builder.test.ts
git commit -m "fix(modal-builder): remove redundant header blocks from all modals"
```

---

### Task 2: Persist checkmark reaction until next message

**Files:**
- Modify: `src/slack/reaction-manager.ts`
- Modify: `tests/slack/reaction-manager.test.ts`

- [ ] **Step 1: Update tests for new behavior**

In `tests/slack/reaction-manager.test.ts`, modify the `replaceWithDone` tests and add new tests:

```typescript
describe('replaceWithDone', () => {
  it('removes brain and adds check mark', async () => {
    await rm.replaceWithDone('C001', '123');
    expect(client.reactions.remove).toHaveBeenCalledWith({
      channel: 'C001', timestamp: '123', name: 'brain',
    });
    expect(client.reactions.add).toHaveBeenCalledWith({
      channel: 'C001', timestamp: '123', name: 'white_check_mark',
    });
  });

  it('does NOT auto-remove check mark after 3 seconds', async () => {
    await rm.replaceWithDone('C001', '123');
    client.reactions.remove.mockClear();
    vi.advanceTimersByTime(5000);
    await vi.runAllTimersAsync();
    // white_check_mark should NOT be removed
    expect(client.reactions.remove).not.toHaveBeenCalledWith({
      channel: 'C001', timestamp: '123', name: 'white_check_mark',
    });
  });
});

describe('replaceWithProcessing clears previous checkmark', () => {
  it('removes previous checkmark when starting new processing', async () => {
    // First: complete a task (adds checkmark)
    await rm.replaceWithDone('C001', '100');
    client.reactions.remove.mockClear();
    client.reactions.add.mockClear();

    // Then: start processing new message
    await rm.replaceWithProcessing('C001', '200');

    // Should remove the old checkmark
    expect(client.reactions.remove).toHaveBeenCalledWith({
      channel: 'C001', timestamp: '100', name: 'white_check_mark',
    });
    // Should also remove hourglass and add brain for new message
    expect(client.reactions.add).toHaveBeenCalledWith({
      channel: 'C001', timestamp: '200', name: 'brain',
    });
  });

  it('works when there is no previous checkmark', async () => {
    // No prior replaceWithDone call
    await rm.replaceWithProcessing('C001', '200');
    // Should not throw, should just add brain
    expect(client.reactions.add).toHaveBeenCalledWith({
      channel: 'C001', timestamp: '200', name: 'brain',
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/slack/reaction-manager.test.ts`
Expected: FAIL — the "does NOT auto-remove" test fails (current code auto-removes), and "removes previous checkmark" fails (no such logic yet).

- [ ] **Step 3: Implement changes in ReactionManager**

In `src/slack/reaction-manager.ts`:

```typescript
export class ReactionManager {
  private lastDone: { channel: string; ts: string } | null = null;

  constructor(private readonly client: any) {}

  async addSpawning(channel: string, timestamp: string): Promise<void> {
    await this.safeAdd(channel, timestamp, 'hourglass_flowing_sand');
  }

  async replaceWithProcessing(channel: string, timestamp: string): Promise<void> {
    // Clear previous checkmark if exists
    if (this.lastDone) {
      await this.safeRemove(this.lastDone.channel, this.lastDone.ts, 'white_check_mark');
      this.lastDone = null;
    }
    await this.safeRemove(channel, timestamp, 'hourglass_flowing_sand');
    await this.safeAdd(channel, timestamp, 'brain');
  }

  async replaceWithDone(channel: string, timestamp: string): Promise<void> {
    await this.safeRemove(channel, timestamp, 'brain');
    await this.safeAdd(channel, timestamp, 'white_check_mark');
    this.lastDone = { channel, ts: timestamp };
  }

  async addQueued(channel: string, timestamp: string): Promise<void> {
    await this.safeAdd(channel, timestamp, 'hourglass_flowing_sand');
  }

  private async safeAdd(channel: string, timestamp: string, name: string): Promise<void> {
    try {
      await this.client.reactions.add({ channel, timestamp, name });
    } catch (err) {
      logger.debug(`Failed to add reaction ${name}`, { error: (err as Error).message });
    }
  }

  private async safeRemove(channel: string, timestamp: string, name: string): Promise<void> {
    try {
      await this.client.reactions.remove({ channel, timestamp, name });
    } catch (err) {
      logger.debug(`Failed to remove reaction ${name}`, { error: (err as Error).message });
    }
  }
}
```

Key changes:
- Added `private lastDone` field
- `replaceWithDone`: removed setTimeout, stores `lastDone`
- `replaceWithProcessing`: clears previous checkmark before adding brain

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/slack/reaction-manager.test.ts`
Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/slack/reaction-manager.ts tests/slack/reaction-manager.test.ts
git commit -m "feat(reaction-manager): persist checkmark until next message"
```

---

### Task 3: Change interrupt to activeMessageTs-based lookup

**Files:**
- Modify: `src/index.ts:471-481`

- [ ] **Step 1: Replace reaction_added handler**

In `src/index.ts`, find the `reaction_added` handler (around L471-481):

```typescript
// BEFORE:
app.event('reaction_added', async ({ event }) => {
    if ((event as any).reaction !== 'red_circle') return;
    const item = (event as any).item;
    if (!item?.ts) return;
    const entry = sessionIndexStore.findByThreadTs(item.ts);
    if (!entry) return;
    const session = coordinator.getSession(entry.cliSessionId);
    if (session && session.state === 'processing') {
      session.sendControl({ type: 'control', subtype: 'interrupt' });
    }
  });

// AFTER:
app.event('reaction_added', async ({ event }) => {
    if ((event as any).reaction !== 'red_circle') return;
    const item = (event as any).item;
    if (!item?.ts) return;
    // Find session by matching activeMessageTs values
    for (const [sessionId, msgTs] of activeMessageTs) {
      if (msgTs === item.ts) {
        const session = coordinator.getSession(sessionId);
        if (session && session.state === 'processing') {
          session.sendControl({ type: 'control', subtype: 'interrupt' });
        }
        break;
      }
    }
  });
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat(index): use activeMessageTs for interrupt targeting"
```

---

## Chunk 2: Bundle Detail Modal Redesign + Thinking Detail

### Task 4: Convert BundleDetailModal entries to buttons and add thinking support

**Files:**
- Modify: `src/slack/modal-builder.ts` — `buildBundleDetailModal` function
- Modify: `tests/slack/modal-builder.test.ts`

- [ ] **Step 1: Update tests for new button-based layout and thinking**

In `tests/slack/modal-builder.test.ts`, replace the `buildBundleDetailModal` describe block:

```typescript
describe('buildBundleDetailModal', () => {
  it('renders thinking entry as button', () => {
    const entries: BundleEntry[] = [
      { type: 'thinking', texts: ['Let me analyze the file structure...'] },
    ];
    const modal = buildBundleDetailModal(entries, 'sess-1', 0);
    expect(modal.type).toBe('modal');
    const actionsBlocks = modal.blocks.filter((b: any) => b.type === 'actions');
    expect(actionsBlocks.length).toBeGreaterThan(0);
    const buttons = actionsBlocks.flatMap((b: any) => b.elements);
    expect(buttons[0].action_id).toBe('view_thinking_detail:sess-1:0:0');
    expect(buttons[0].text.text).toContain('💭');
  });

  it('renders tool entry as button with action_id', () => {
    const entries: BundleEntry[] = [
      { type: 'tool', toolUseId: 'toolu_001', toolName: 'Read', oneLiner: 'src/auth.ts', durationMs: 200 },
    ];
    const modal = buildBundleDetailModal(entries, 'sess-1', 0);
    const actionsBlocks = modal.blocks.filter((b: any) => b.type === 'actions');
    const buttons = actionsBlocks.flatMap((b: any) => b.elements);
    expect(buttons[0].action_id).toBe('view_tool_detail:sess-1:toolu_001');
    expect(buttons[0].text.text).toContain('🔧');
    expect(buttons[0].text.text).toContain('Read');
  });

  it('renders subagent entry as button with action_id', () => {
    const entries: BundleEntry[] = [
      { type: 'subagent', toolUseId: 'toolu_agent', description: 'コード探索', agentId: 'abc', durationMs: 3000 },
    ];
    const modal = buildBundleDetailModal(entries, 'sess-1', 0);
    const actionsBlocks = modal.blocks.filter((b: any) => b.elements);
    const buttons = actionsBlocks.flatMap((b: any) => b.elements);
    expect(buttons[0].action_id).toBe('view_subagent_detail:sess-1:toolu_agent');
    expect(buttons[0].text.text).toContain('🤖');
  });

  it('truncates button text to 75 chars max', () => {
    const entries: BundleEntry[] = [
      { type: 'tool', toolUseId: 'toolu_001', toolName: 'Read', oneLiner: 'a'.repeat(100), durationMs: 200 },
    ];
    const modal = buildBundleDetailModal(entries, 'sess-1', 0);
    const actionsBlocks = modal.blocks.filter((b: any) => b.type === 'actions');
    const buttons = actionsBlocks.flatMap((b: any) => b.elements);
    expect(buttons[0].text.text.length).toBeLessThanOrEqual(75);
  });

  it('assigns correct thinkingIndex for multiple thinking entries', () => {
    const entries: BundleEntry[] = [
      { type: 'thinking', texts: ['first'] },
      { type: 'tool', toolUseId: 'toolu_001', toolName: 'Read', oneLiner: 'a.ts', durationMs: 100 },
      { type: 'thinking', texts: ['second'] },
    ];
    const modal = buildBundleDetailModal(entries, 'sess-1', 2);
    const actionsBlocks = modal.blocks.filter((b: any) => b.type === 'actions');
    const buttons = actionsBlocks.flatMap((b: any) => b.elements);
    // First thinking -> thinkingIndex 0
    expect(buttons[0].action_id).toBe('view_thinking_detail:sess-1:2:0');
    // Tool
    expect(buttons[1].action_id).toBe('view_tool_detail:sess-1:toolu_001');
    // Second thinking -> thinkingIndex 1
    expect(buttons[2].action_id).toBe('view_thinking_detail:sess-1:2:1');
  });

  it('does not include header block', () => {
    const entries: BundleEntry[] = [
      { type: 'thinking', texts: ['hmm'] },
    ];
    const modal = buildBundleDetailModal(entries, 'sess-1', 0);
    const headerBlocks = modal.blocks.filter((b: any) => b.type === 'header');
    expect(headerBlocks).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/slack/modal-builder.test.ts`
Expected: FAIL — button-based tests fail because current implementation uses section+accessory.

- [ ] **Step 3: Rewrite buildBundleDetailModal**

In `src/slack/modal-builder.ts`, replace the entire `buildBundleDetailModal` function:

```typescript
export function buildBundleDetailModal(entries: BundleEntry[], sessionId: string, bundleIndex: number): any {
  const blocks: Block[] = [];
  const buttons: Block[] = [];
  let thinkingIndex = 0;

  for (const entry of entries) {
    if (entry.type === 'thinking') {
      const preview = truncate(entry.texts.join(' '), 40);
      buttons.push({
        type: 'button',
        text: { type: 'plain_text', text: truncate(`💭 ${preview}`, 72) },
        action_id: `view_thinking_detail:${sessionId}:${bundleIndex}:${thinkingIndex}`,
      });
      thinkingIndex++;
    } else if (entry.type === 'tool') {
      const durationStr = `${(entry.durationMs / 1000).toFixed(1)}s`;
      buttons.push({
        type: 'button',
        text: { type: 'plain_text', text: truncate(`🔧 ${entry.toolName} ${entry.oneLiner} (${durationStr})`, 72) },
        action_id: `view_tool_detail:${sessionId}:${entry.toolUseId}`,
      });
    } else if (entry.type === 'subagent') {
      const durationStr = `${(entry.durationMs / 1000).toFixed(1)}s`;
      buttons.push({
        type: 'button',
        text: { type: 'plain_text', text: truncate(`🤖 SubAgent: "${entry.description}" (${durationStr})`, 72) },
        action_id: `view_subagent_detail:${sessionId}:${entry.toolUseId}`,
      });
    }
  }

  // Split buttons into actions blocks (max 25 per block)
  for (let i = 0; i < buttons.length; i += 25) {
    blocks.push({
      type: 'actions',
      elements: buttons.slice(i, i + 25),
    });
  }

  return {
    type: 'modal',
    title: { type: 'plain_text', text: 'アクション詳細' },
    close: { type: 'plain_text', text: '閉じる' },
    blocks: blocks.slice(0, 100),
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/slack/modal-builder.test.ts`
Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/slack/modal-builder.ts tests/slack/modal-builder.test.ts
git commit -m "feat(modal-builder): convert bundle entries to buttons, add thinking support"
```

---

### Task 5: Add view_thinking_detail handler and update view_bundle caller

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Update view_bundle handler to pass bundleIndex**

In `src/index.ts`, find the `buildBundleDetailModal` call (around L641):

```typescript
// BEFORE:
const modal = buildBundleDetailModal(entries, sessionId);

// AFTER:
const modal = buildBundleDetailModal(entries, sessionId, bundleIndex);
```

The `bundleIndex` variable is already parsed at L621.

- [ ] **Step 2: Add view_thinking_detail action handler**

In `src/index.ts`, add a new handler after the `view_bundle` handler (after L649) and before the `view_subagent_detail` handler:

```typescript
  // --- Thinking Detail Modal Action ---
  app.action(/^view_thinking_detail:/, async ({ ack, body }: any) => {
    await ack();
    const actionId = body.actions?.[0]?.action_id || '';
    const parts = actionId.split(':');
    const sessionId = parts[1];
    const bundleIndex = parseInt(parts[2], 10);
    const thinkingIndex = parseInt(parts[3], 10);
    if (!sessionId || isNaN(bundleIndex) || isNaN(thinkingIndex)) return;

    const entry = sessionIndexStore.findBySessionId(sessionId);
    if (!entry) return;

    const bundleEntries = await sessionJsonlReader.readBundle(
      entry.projectPath,
      sessionId,
      bundleIndex,
    );

    // Filter thinking entries and pick by index
    const thinkingEntries = bundleEntries.filter(e => e.type === 'thinking');
    const target = thinkingEntries[thinkingIndex];
    if (!target || target.type !== 'thinking') return;

    const modal = buildThinkingModal(target.texts);
    const threadTs = body.view?.private_metadata || '';
    modal.private_metadata = threadTs;

    await app.client.views.push({ trigger_id: body.trigger_id, view: modal });
  });
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add src/index.ts
git commit -m "feat(index): add view_thinking_detail handler, pass bundleIndex to modal"
```

---

### Task 6: Final verification

- [ ] **Step 1: Run full test suite**

Run: `npx vitest run`
Expected: All tests PASS.

- [ ] **Step 2: Verify TypeScript compilation**

Run: `npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 3: Commit any remaining fixes if needed**
