# Reaction Timing Synchronization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Synchronize Slack emoji reactions (⏳🧠✅) with actual Claude CLI processing state, and fix cross-session ✅ cleanup bug.

**Architecture:** Three changes: (1) ReactionManager gets session-scoped `lastDone` tracking, (2) StreamProcessor gains `onFirstContent` callback for ⏳→🧠 transition, (3) index.ts wiring unifies both session paths to use firstContent-driven reactions.

**Tech Stack:** TypeScript, Vitest

---

## File Structure

| File | Role |
|---|---|
| `src/slack/reaction-manager.ts` | Reaction lifecycle management — add sessionId scoping |
| `src/streaming/stream-processor.ts` | Stream event processing — add firstContent callback |
| `src/index.ts` | Orchestration — rewire reaction triggers |
| `tests/slack/reaction-manager.test.ts` | Unit tests for reaction manager |

---

### Task 1: ReactionManager + StreamProcessor + index.ts wiring

**Note:** All three source files are changed together in one task to avoid non-compilable intermediate states (signature changes must be atomic with call-site updates).

**Files:**
- Modify: `src/slack/reaction-manager.ts`
- Modify: `src/streaming/stream-processor.ts`
- Modify: `src/index.ts`
- Modify: `tests/slack/reaction-manager.test.ts`

- [ ] **Step 1: Write failing tests for sessionId-scoped API**

Add to `tests/slack/reaction-manager.test.ts`:

```typescript
describe('session-scoped lastDone', () => {
  it('replaceWithProcessing only clears checkmark from same session', async () => {
    await rm.replaceWithDone('session-A', 'C001', '100');
    client.reactions.remove.mockClear();
    client.reactions.add.mockClear();

    // Different session starts processing — should NOT clear session-A's checkmark
    await rm.replaceWithProcessing('session-B', 'C001', '200');
    expect(client.reactions.remove).not.toHaveBeenCalledWith({
      channel: 'C001', timestamp: '100', name: 'white_check_mark',
    });
  });

  it('replaceWithProcessing clears checkmark from same session', async () => {
    await rm.replaceWithDone('session-A', 'C001', '100');
    client.reactions.remove.mockClear();
    client.reactions.add.mockClear();

    await rm.replaceWithProcessing('session-A', 'C001', '200');
    expect(client.reactions.remove).toHaveBeenCalledWith({
      channel: 'C001', timestamp: '100', name: 'white_check_mark',
    });
  });

  it('cleanupSession removes session entry from map', async () => {
    await rm.replaceWithDone('session-A', 'C001', '100');
    rm.cleanupSession('session-A');
    client.reactions.remove.mockClear();

    await rm.replaceWithProcessing('session-A', 'C001', '200');
    // No checkmark to clear since session was cleaned up
    expect(client.reactions.remove).not.toHaveBeenCalledWith({
      channel: 'C001', timestamp: '100', name: 'white_check_mark',
    });
  });
});
```

- [ ] **Step 2: Write new tests (they will fail until Step 3)**

- [ ] **Step 3: Update ReactionManager implementation**

Replace the full contents of `src/slack/reaction-manager.ts` with:

```typescript
export class ReactionManager {
  private lastDoneBySession: Map<string, { channel: string; ts: string }> = new Map();

  constructor(private readonly client: any) {}

  async addSpawning(channel: string, timestamp: string): Promise<void> {
    await this.safeAdd(channel, timestamp, 'hourglass_flowing_sand');
  }

  async replaceWithProcessing(sessionId: string, channel: string, timestamp: string): Promise<void> {
    const lastDone = this.lastDoneBySession.get(sessionId);
    if (lastDone) {
      await this.safeRemove(lastDone.channel, lastDone.ts, 'white_check_mark');
      this.lastDoneBySession.delete(sessionId);
    }
    await this.safeRemove(channel, timestamp, 'hourglass_flowing_sand');
    await this.safeAdd(channel, timestamp, 'brain');
  }

  async replaceWithDone(sessionId: string, channel: string, timestamp: string): Promise<void> {
    await this.safeRemove(channel, timestamp, 'brain');
    await this.safeAdd(channel, timestamp, 'white_check_mark');
    this.lastDoneBySession.set(sessionId, { channel, ts: timestamp });
  }

  async removeProcessing(channel: string, timestamp: string): Promise<void> {
    await this.safeRemove(channel, timestamp, 'brain');
    await this.safeRemove(channel, timestamp, 'hourglass_flowing_sand');
  }

  cleanupSession(sessionId: string): void {
    this.lastDoneBySession.delete(sessionId);
  }

  async addQueued(channel: string, timestamp: string): Promise<void> {
    await this.safeAdd(channel, timestamp, 'hourglass_flowing_sand');
  }

  // safeAdd and safeRemove unchanged
}
```

- [ ] **Step 4: Update existing tests to pass sessionId**

Update all existing test calls in `tests/slack/reaction-manager.test.ts`:

| Before | After |
|---|---|
| `rm.replaceWithProcessing('C001', '123')` | `rm.replaceWithProcessing('test-session', 'C001', '123')` |
| `rm.replaceWithProcessing('C001', '200')` | `rm.replaceWithProcessing('test-session', 'C001', '200')` |
| `rm.replaceWithDone('C001', '123')` | `rm.replaceWithDone('test-session', 'C001', '123')` |
| `rm.replaceWithDone('C001', '100')` | `rm.replaceWithDone('test-session', 'C001', '100')` |

- [ ] **Step 5: Add onFirstContent to StreamProcessorConfig**

In `src/streaming/stream-processor.ts`, update the interface:

```typescript
interface StreamProcessorConfig {
  channel: string;
  threadTs: string;
  sessionId: string;
  tunnelManager?: TunnelManager;
  onFirstContent?: () => void;
}
```

- [ ] **Step 6: Add firstContentReceived flag and detection logic**

Add field to StreamProcessor class:

```typescript
private firstContentReceived = false;
```

In `processEvent()`, add at the top (before the if/else chain). **Important:** Only top-level events trigger this — subagent child events (with `parentToolUseId`) are filtered by `handleAssistant` already, and only `assistant` events with content blocks reach this check:

```typescript
// Detect first content for reaction timing (top-level only)
if (!this.firstContentReceived) {
  if (event.type === 'assistant' && event.message?.content) {
    const hasContent = event.message.content.some(
      (block: any) => block.type === 'thinking' || block.type === 'text' || block.type === 'tool_use'
    );
    if (hasContent) {
      this.firstContentReceived = true;
      this.config.onFirstContent?.();
    }
  }
}
```

- [ ] **Step 7: Reset flag in reset() only**

Update `reset()` to include the flag (reset is called after every result event in wireSessionOutput):

```typescript
reset(): void {
  this.textBuffer = '';
  this.textMessageTs = null;
  this.mainToolUseCount = 0;
  this.firstContentReceived = false;
}
```

**Do NOT** add a reset in `handleResult()` — `reset()` is always called after result processing, so a separate reset would be redundant.

- [ ] **Step 8: Update wireSessionOutput — inject onFirstContent callback**

In `wireSessionOutput()` (line 488), add `onFirstContent` to StreamProcessor config. Use `void` to indicate fire-and-forget async:

```typescript
const streamProcessor = new StreamProcessor({
  channel: channelId,
  threadTs,
  sessionId: session.sessionId,
  tunnelManager,
  onFirstContent: () => {
    const msgTs = activeMessageTs.get(session.sessionId);
    if (msgTs) {
      void rm.replaceWithProcessing(session.sessionId, channelId, msgTs);
    }
  },
});
```

- [ ] **Step 9: Update replaceWithDone call in wireSessionOutput**

In wireSessionOutput, the `replaceWithDone` call (around line 578):

Change:
```typescript
await rm.replaceWithDone(channelId, msgTs);
```
To:
```typescript
await rm.replaceWithDone(session.sessionId, channelId, msgTs);
```

- [ ] **Step 10: Add cleanupSession on session death**

In the existing `stateChange` listener in wireSessionOutput (line 605):

Change:
```typescript
session.on('stateChange', (_from: string, to: string) => {
  if (to === 'dead' || to === 'ending') {
    streamProcessor.dispose();
    wiredSessions.delete(session.sessionId);
  }
});
```
To:
```typescript
session.on('stateChange', (_from: string, to: string) => {
  if (to === 'dead' || to === 'ending') {
    streamProcessor.dispose();
    wiredSessions.delete(session.sessionId);
    rm.cleanupSession(session.sessionId);
  }
});
```

- [ ] **Step 11: Change idle session path — replaceWithProcessing → addSpawning**

In handleMessage, idle session path (line 449-452):

Change:
```typescript
if (session.state === 'idle') {
  activeMessageTs.set(session.sessionId, messageTs);
  await reactionManager.replaceWithProcessing(channelId, messageTs);
  session.sendPrompt(prompt);
}
```
To:
```typescript
if (session.state === 'idle') {
  activeMessageTs.set(session.sessionId, messageTs);
  await reactionManager.addSpawning(channelId, messageTs);
  session.sendPrompt(prompt);
}
```

- [ ] **Step 12: Remove stateChange('processing') listener from new session path**

In handleMessage, new session path (lines 424-431):

Remove these lines:
```typescript
// Replace hourglass with brain when CLI starts processing
const onStateChange = (_from: string, to: string) => {
  if (to === 'processing') {
    reactionManager.replaceWithProcessing(channelId, messageTs);
    session.removeListener('stateChange', onStateChange);
  }
};
session.on('stateChange', onStateChange);
```

And remove the `session.removeListener('stateChange', onStateChange);` in the catch block (line 436).

The ⏳→🧠 transition is now handled by `onFirstContent` in wireSessionOutput.

- [ ] **Step 13: Run all tests**

Run: `npx vitest run`
Expected: ALL PASS

- [ ] **Step 14: Commit**

```bash
git add src/slack/reaction-manager.ts src/streaming/stream-processor.ts src/index.ts tests/slack/reaction-manager.test.ts
git commit -m "feat: synchronize reaction timing with actual CLI processing state"
```

---

### Task 2: Verification

- [ ] **Step 1: TypeScript compilation check**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 2: Full test suite**

Run: `npx vitest run`
Expected: ALL PASS

- [ ] **Step 3: Remind user to restart Bridge**

> コードを変更しました。Slackで `cc /restart-bridge` と送信して再起動してください。

Manual verification checklist after restart:
1. New thread message → ⏳ appears first, then 🧠 when first content arrives
2. Idle session message → same ⏳→🧠 behavior
3. Response complete → 🧠→✅
4. Different thread processing → doesn't clear ✅ on other thread
5. 🔴 interrupt → ⏳/🧠 removed correctly
