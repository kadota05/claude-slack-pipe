# メッセージ順序整列 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Slackスレッド内のメッセージ表示順序を、Claude CLIの論理的なラウンド（bundle→text）の繰り返しに合わせて正しく整列する。

**Architecture:** GroupTrackerにactiveSubagents Mapを追加し、StreamProcessorの100文字バッファリングを廃止してテキスト到着時に即座にbundle collapseする。textMessageTsをラウンドスコープ化して各ラウンドのテキストを独立メッセージにする。

**Tech Stack:** TypeScript, Vitest, Slack API (chat.postMessage / chat.update)

**Spec:** `docs/superpowers/specs/2026-03-19-message-ordering-design.md`

---

### File Structure

| ファイル | 役割 | 変更種別 |
|---------|------|---------|
| `src/streaming/group-tracker.ts` | bundle/groupライフサイクル管理。activeSubagents Map追加、collapse条件変更、buildLiveBundleBlocks追加 | Modify |
| `src/streaming/stream-processor.ts` | イベント→アクション変換。100文字バッファ廃止、textMessageTsリセット、subagent完了時flush | Modify |
| `src/streaming/tool-formatter.ts` | 変更なし（buildSubagentLiveBlocksは既存のまま利用可能） | — |
| `src/streaming/session-jsonl-reader.ts` | bundle境界ロジックをストリーミング側と一致させる | Modify |
| `src/index.ts` | textMessageTsリセット呼び出し | Modify |
| `tests/streaming/group-tracker.test.ts` | GroupTrackerユニットテスト | Create |
| `tests/streaming/stream-processor.test.ts` | StreamProcessorユニットテスト | Create |

---

### Task 1: GroupTracker — 並列Subagentトラッキング

**Files:**
- Modify: `src/streaming/group-tracker.ts`
- Create: `tests/streaming/group-tracker.test.ts`

- [ ] **Step 1: テスト作成 — 並列subagentの基本トラッキング**

```typescript
// tests/streaming/group-tracker.test.ts
import { describe, it, expect } from 'vitest';
import { GroupTracker } from '../../src/streaming/group-tracker.js';

describe('GroupTracker - parallel subagents', () => {
  it('tracks two subagents simultaneously in the same bundle', () => {
    const tracker = new GroupTracker();

    // Start subagent A
    const actionsA = tracker.handleSubagentStart('agent-A', 'Explore codebase');
    expect(actionsA.length).toBeGreaterThan(0);
    expect(actionsA[0].type).toBe('postMessage'); // new bundle

    // Start subagent B — should NOT displace A
    const actionsB = tracker.handleSubagentStart('agent-B', 'Run tests');
    // Both should be trackable
    const stepA = tracker.handleSubagentStep('agent-A', 'Read', 'tool-1', 'src/index.ts');
    const stepB = tracker.handleSubagentStep('agent-B', 'Bash', 'tool-2', 'npm test');
    // Neither should return empty (dropped)
    // stepA targets agent-A, stepB targets agent-B
    expect(stepA).toBeDefined();
    expect(stepB).toBeDefined();
  });

  it('completes subagents independently', () => {
    const tracker = new GroupTracker();
    tracker.handleSubagentStart('agent-A', 'Explore');
    tracker.handleSubagentStart('agent-B', 'Test');

    // Complete A — B should still be active
    tracker.handleSubagentComplete('agent-A', 'done', 0);

    // B's steps should still work
    const stepB = tracker.handleSubagentStep('agent-B', 'Bash', 'tool-3', 'npm test');
    expect(stepB).toBeDefined();
  });

  it('allows collapse only when all subagents are done', () => {
    const tracker = new GroupTracker();
    tracker.handleSubagentStart('agent-A', 'Explore');
    tracker.handleSubagentStart('agent-B', 'Test');

    // Complete A only — handleTextStart should NOT collapse
    tracker.handleSubagentComplete('agent-A', 'done', 0);
    const actions1 = tracker.handleTextStart('session-1');
    expect(actions1.find(a => a.type === 'collapse')).toBeUndefined();

    // Complete B — now handleTextStart SHOULD collapse
    tracker.handleSubagentComplete('agent-B', 'done', 0);
    const actions2 = tracker.handleTextStart('session-1');
    expect(actions2.find(a => a.type === 'collapse')).toBeDefined();
  });
});
```

- [ ] **Step 2: テスト実行 — 失敗を確認**

Run: `npx vitest run tests/streaming/group-tracker.test.ts`
Expected: FAIL — 現在のGroupTrackerは並列subagentをサポートしていない

- [ ] **Step 3: GroupTrackerにactiveSubagents Map追加**

`src/streaming/group-tracker.ts` を修正:

```typescript
// フィールド追加（activeGroupの下に）
private activeSubagents: Map<string, ActiveGroup> = new Map();
```

`handleSubagentStart` を修正 — activeGroupではなくactiveSubagents Mapに格納:

```typescript
handleSubagentStart(toolUseId: string, description: string): BundleAction[] {
  const actions: BundleAction[] = [];
  const isNewBundle = this.ensureBundle(actions);

  // If activeGroup is thinking/tool, move to completed
  if (this.activeGroup) {
    this.moveActiveGroupToCompleted();
    this.activeGroup = null;
  }

  const group = this.createActiveGroup('subagent');
  group.agentToolUseId = toolUseId;
  group.agentDescription = description;
  this.activeSubagents.set(toolUseId, group);

  if (isNewBundle) {
    const postAction = actions.find(a => a.type === 'postMessage');
    if (postAction) {
      postAction.blocks = this.buildLiveBundleBlocks();
      postAction.text = `SubAgent: ${description}`;
    }
  } else if (this.activeBundle!.messageTs) {
    actions.push(this.buildUpdateAction(
      this.buildLiveBundleBlocks(),
      `SubAgent: ${description}`,
    ));
  }

  return actions;
}
```

`handleSubagentStep` を修正 — activeSubagents Mapから参照:

```typescript
handleSubagentStep(agentToolUseId: string, toolName: string, toolUseId: string, oneLiner: string): BundleAction[] {
  const actions: BundleAction[] = [];
  const agent = this.activeSubagents.get(agentToolUseId);
  if (!agent) return actions;

  agent.agentSteps.push({ toolName, toolUseId, oneLiner, status: 'running' });

  if (this.activeBundle?.messageTs && this.shouldEmitUpdateForGroup(agent)) {
    agent.lastUpdateTime = Date.now();
    actions.push(this.buildUpdateAction(
      this.buildLiveBundleBlocks(),
      `SubAgent: ${agent.agentDescription}`,
    ));
  }

  return actions;
}
```

`handleSubagentStepResult` を修正 — 同様にMap参照:

```typescript
handleSubagentStepResult(agentToolUseId: string, toolUseId: string, isError: boolean): BundleAction[] {
  const actions: BundleAction[] = [];
  const agent = this.activeSubagents.get(agentToolUseId);
  if (!agent) return actions;

  const step = agent.agentSteps.find(s => s.toolUseId === toolUseId);
  if (step) {
    step.status = isError ? 'error' : 'completed';
  }

  if (this.activeBundle?.messageTs && this.shouldEmitUpdateForGroup(agent)) {
    agent.lastUpdateTime = Date.now();
    actions.push(this.buildUpdateAction(
      this.buildLiveBundleBlocks(),
      `SubAgent: ${agent.agentDescription}`,
    ));
  }

  return actions;
}
```

`handleSubagentComplete` を修正 — Mapから削除、pendingTextBufferのflush:

```typescript
handleSubagentComplete(agentToolUseId: string, result: string, _durationMs: number): BundleAction[] {
  const agent = this.activeSubagents.get(agentToolUseId);
  if (!agent) return [];

  // Move to completed
  const cg: CompletedGroup = {
    category: 'subagent',
    agentDescription: agent.agentDescription,
    agentId: agent.agentId,
    agentSteps: [...agent.agentSteps],
    duration: Date.now() - agent.startTime,
  };
  this.activeBundle!.completedGroups.push(cg);
  this.activeSubagents.delete(agentToolUseId);

  // If all subagents done and there's pending text, signal flush
  // (actual text postMessage is handled by StreamProcessor)
  return [];
}
```

`shouldEmitUpdate` をリネームして`shouldEmitUpdateForGroup`に:

```typescript
private shouldEmitUpdateForGroup(group: ActiveGroup): boolean {
  return Date.now() - group.lastUpdateTime >= DEBOUNCE_MS;
}

// Keep original for activeGroup
private shouldEmitUpdate(): boolean {
  if (!this.activeGroup) return false;
  return this.shouldEmitUpdateForGroup(this.activeGroup);
}
```

collapse判定にsubagentチェックを追加:

```typescript
canCollapse(): boolean {
  return this.activeGroup === null && this.activeSubagents.size === 0;
}
```

`handleTextStart`を修正:

```typescript
handleTextStart(sessionId: string): BundleAction[] {
  if (!this.activeBundle) return [];

  // If subagents still running, buffer text (don't collapse)
  if (this.activeSubagents.size > 0) {
    return [];
  }

  // Move active group to completed
  if (this.activeGroup) {
    this.moveActiveGroupToCompleted();
    this.activeGroup = null;
  }

  return this.collapseActiveBundle(sessionId);
}
```

`buildLiveBundleBlocks` メソッド追加:

```typescript
buildLiveBundleBlocks(): Block[] {
  const blocks: Block[] = [];

  // 1. Completed groups
  for (const cg of this.activeBundle!.completedGroups) {
    blocks.push(...this.buildCompletedGroupBlocks(cg));
  }

  // 2. Active group (thinking/tool)
  if (this.activeGroup) {
    if (this.activeGroup.category === 'thinking') {
      blocks.push(...buildThinkingLiveBlocks(this.activeGroup.thinkingTexts));
    } else if (this.activeGroup.category === 'tool') {
      blocks.push(...buildToolGroupLiveBlocks(this.activeGroup.tools));
    }
  }

  // 3. Active subagents
  for (const [, agent] of this.activeSubagents) {
    blocks.push(...buildSubagentLiveBlocks(
      agent.agentDescription || '',
      agent.agentSteps,
    ));
  }

  return blocks;
}

private buildCompletedGroupBlocks(cg: CompletedGroup): Block[] {
  if (cg.category === 'thinking') {
    return [{ type: 'context', elements: [{ type: 'mrkdwn', text: `💭 思考完了` }] }];
  }
  if (cg.category === 'tool') {
    const count = cg.tools?.length || 0;
    const dur = ((cg.totalDuration || 0) / 1000).toFixed(1);
    return [{ type: 'context', elements: [{ type: 'mrkdwn', text: `🔧 ×${count} 完了 (${dur}s)` }] }];
  }
  if (cg.category === 'subagent') {
    const dur = ((cg.duration || 0) / 1000).toFixed(1);
    return [{ type: 'context', elements: [{ type: 'mrkdwn', text: `🤖 ${cg.agentDescription} 完了 (${dur}s)` }] }];
  }
  return [];
}
```

`flushActiveBundle`のsubagent対応:

```typescript
flushActiveBundle(sessionId: string): BundleAction[] {
  if (!this.activeBundle) return [];

  // Mark running subagent items as error
  for (const [, agent] of this.activeSubagents) {
    for (const step of agent.agentSteps) {
      if (step.status === 'running') step.status = 'error';
    }
    const cg: CompletedGroup = {
      category: 'subagent',
      agentDescription: agent.agentDescription,
      agentId: agent.agentId,
      agentSteps: [...agent.agentSteps],
      duration: Date.now() - agent.startTime,
    };
    this.activeBundle!.completedGroups.push(cg);
  }
  this.activeSubagents.clear();

  // Mark running tool items as error
  if (this.activeGroup) {
    if (this.activeGroup.category === 'tool') {
      for (const tool of this.activeGroup.tools) {
        if (tool.status === 'running') tool.status = 'error';
      }
    }
    this.moveActiveGroupToCompleted();
    this.activeGroup = null;
  }

  return this.collapseActiveBundle(sessionId);
}
```

`setAgentId`をactiveSubagents対応に:

```typescript
setAgentId(agentId: string, agentToolUseId?: string): void {
  if (agentToolUseId) {
    const agent = this.activeSubagents.get(agentToolUseId);
    if (agent) agent.agentId = agentId;
  } else if (this.activeGroup) {
    this.activeGroup.agentId = agentId;
  }
}
```

`getActiveSubagent` ヘルパー追加:

```typescript
getActiveSubagent(agentToolUseId: string): ActiveGroup | undefined {
  return this.activeSubagents.get(agentToolUseId);
}

hasActiveSubagents(): boolean {
  return this.activeSubagents.size > 0;
}
```

- [ ] **Step 4: テスト実行 — パスを確認**

Run: `npx vitest run tests/streaming/group-tracker.test.ts`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add src/streaming/group-tracker.ts tests/streaming/group-tracker.test.ts
git commit -m "feat: parallel subagent tracking with Map in GroupTracker"
```

---

### Task 2: StreamProcessor — 100文字バッファ廃止 + ラウンド分割

**Files:**
- Modify: `src/streaming/stream-processor.ts`
- Create: `tests/streaming/stream-processor.test.ts`

- [ ] **Step 1: テスト作成 — ラウンド分割のテキスト処理**

```typescript
// tests/streaming/stream-processor.test.ts
import { describe, it, expect } from 'vitest';
import { StreamProcessor } from '../../src/streaming/stream-processor.js';

describe('StreamProcessor - round-based text splitting', () => {
  const config = { channel: 'C123', threadTs: '1234.5678', sessionId: 'test-session' };

  it('posts text immediately regardless of length (no 100-char buffering)', () => {
    const sp = new StreamProcessor(config);

    // Simulate: thinking → tool → short text
    sp.processEvent({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'hmm' }] } });
    sp.registerBundleMessageTs('bundle-1', '1111.0000');

    sp.processEvent({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/a.txt' } }] } });
    sp.processEvent({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } });

    // Short text (< 100 chars) — should still produce textAction
    const result = sp.processEvent({ type: 'assistant', message: { content: [{ type: 'text', text: '確認しました。' }] } });
    expect(result.textAction).toBeDefined();
    expect(result.textAction!.type).toBe('postMessage');
  });

  it('resets textMessageTs when new bundle starts', () => {
    const sp = new StreamProcessor(config);

    // Round 1: text
    sp.processEvent({ type: 'assistant', message: { content: [{ type: 'text', text: 'Round 1 text' }] } });
    sp.registerTextMessageTs('2222.0000');

    // Round 2: thinking starts → should reset textMessageTs
    sp.processEvent({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'thinking again' }] } });
    sp.registerBundleMessageTs('bundle-2', '3333.0000');

    // Round 2: text → should be NEW postMessage, not update
    const result = sp.processEvent({ type: 'assistant', message: { content: [{ type: 'text', text: 'Round 2 text' }] } });
    expect(result.textAction).toBeDefined();
    expect(result.textAction!.type).toBe('postMessage');
  });
});
```

- [ ] **Step 2: テスト実行 — 失敗を確認**

Run: `npx vitest run tests/streaming/stream-processor.test.ts`
Expected: FAIL — 100文字バッファリングによりshort textでtextActionが生成されない

- [ ] **Step 3: StreamProcessor.handleTextの100文字バッファ廃止**

`src/streaming/stream-processor.ts` の `handleText` メソッドを修正:

```typescript
private handleText(text: string, result: ProcessedActions): void {
  this.textBuffer += text;

  if (this.tunnelManager) {
    const localUrls = extractLocalUrls(this.textBuffer);
    for (const { port } of localUrls) {
      this.tunnelManager.startTunnel(port);
    }
  }

  // If subagents are running, buffer text (don't collapse yet)
  if (this.groupTracker.hasActiveSubagents()) {
    return;
  }

  // Text arrival = round boundary — collapse bundle immediately
  const collapseActions = this.groupTracker.handleTextStart(this.config.sessionId);
  result.bundleActions.push(...collapseActions);

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
```

- [ ] **Step 4: textMessageTsのリセットとtextBufferのリセット**

`handleAssistant`でthinking/tool_useが来たらtextMessageTsをリセット:

```typescript
private handleAssistant(content: any[], parentToolUseId: string | null, result: ProcessedActions): void {
  for (const block of content) {
    if (block.type === 'thinking') {
      if (parentToolUseId) continue;
      // Reset text state for new round
      this.finalizeCurrentText();
      const actions = this.groupTracker.handleThinking(block.thinking);
      result.bundleActions.push(...actions);
    } else if (block.type === 'tool_use') {
      this.handleToolUse(block, parentToolUseId, result);
    } else if (block.type === 'text' && block.text) {
      if (parentToolUseId) continue;
      this.handleText(block.text, result);
    }
  }
}
```

`handleToolUse`の先頭でもリセット（メインツールのみ）:

```typescript
private handleToolUse(block: any, parentToolUseId: string | null, result: ProcessedActions): void {
  const toolUseId = block.id;
  const toolName = block.name;
  const input = block.input || {};

  if (parentToolUseId) {
    // subagent child tool — no text reset
    const oneLiner = getToolOneLiner(toolName, input);
    const actions = this.groupTracker.handleSubagentStep(parentToolUseId, toolName, toolUseId, oneLiner);
    result.bundleActions.push(...actions);
    return;
  }

  // Main tool — reset text state for new round
  this.finalizeCurrentText();

  if (toolName === 'Agent') {
    this.mainToolUseCount++;
    const description = String(input.description || input.prompt || 'SubAgent');
    const actions = this.groupTracker.handleSubagentStart(toolUseId, description);
    result.bundleActions.push(...actions);
    return;
  }

  this.mainToolUseCount++;
  const actions = this.groupTracker.handleToolUse(toolUseId, toolName, input);
  result.bundleActions.push(...actions);
}
```

`finalizeCurrentText`メソッド追加:

```typescript
private finalizeCurrentText(): void {
  // If text was being streamed, finalize it (remove streaming indicator)
  // and reset for next round
  if (this.textMessageTs) {
    this.textMessageTs = null;
    this.textBuffer = '';
  }
}
```

- [ ] **Step 5: subagent完了時のpendingText flush**

`handleToolResult`のsubagent完了判定を修正:

```typescript
private handleToolResult(block: any, parentToolUseId: string | null, result: ProcessedActions): void {
  const toolUseId = block.tool_use_id;
  const isError = block.is_error === true
    || (typeof block.content === 'string' && /^(Error|error:|ERROR)/.test(block.content));
  const resultText = typeof block.content === 'string'
    ? block.content
    : JSON.stringify(block.content);

  if (parentToolUseId) {
    const actions = this.groupTracker.handleSubagentStepResult(parentToolUseId, toolUseId, isError);
    result.bundleActions.push(...actions);
    return;
  }

  // Check if this is a subagent completion (using activeSubagents Map)
  const agent = this.groupTracker.getActiveSubagent(toolUseId);
  if (agent) {
    const agentIdMatch = resultText.match(/agentId:\s*([\w]+)/);
    if (agentIdMatch) {
      this.groupTracker.setAgentId(agentIdMatch[1], toolUseId);
    }
    const subagentActions = this.groupTracker.handleSubagentComplete(toolUseId, resultText, 0);
    result.bundleActions.push(...subagentActions);

    // If all subagents done and text was buffered, flush now
    if (!this.groupTracker.hasActiveSubagents() && this.textBuffer) {
      const collapseActions = this.groupTracker.handleTextStart(this.config.sessionId);
      result.bundleActions.push(...collapseActions);

      const converted = convertMarkdownToMrkdwn(this.textBuffer);
      const blocks = this.buildTextBlocks(converted, false);
      result.textAction = {
        type: 'postMessage',
        priority: 1,
        channel: this.config.channel,
        threadTs: this.config.threadTs,
        blocks,
        text: this.textBuffer.slice(0, 100),
        metadata: { messageType: 'text' },
      };
    }
    return;
  }

  // Normal tool result
  const actions = this.groupTracker.handleToolResult(toolUseId, resultText, isError);
  result.bundleActions.push(...actions);
}
```

- [ ] **Step 6: テスト実行 — パスを確認**

Run: `npx vitest run tests/streaming/stream-processor.test.ts`
Expected: PASS

- [ ] **Step 7: コミット**

```bash
git add src/streaming/stream-processor.ts tests/streaming/stream-processor.test.ts
git commit -m "feat: round-based text splitting, remove 100-char buffering"
```

---

### Task 3: tool-formatter — buildLiveBundleBlocksの合成ブロック更新

**Files:**
- Modify: `src/streaming/tool-formatter.ts`

- [ ] **Step 1: buildSubagentLiveBlocksが並列subagentで正しく動作するか確認**

現在の`buildSubagentLiveBlocks`は単一subagent前提で、description + stepsを受け取る。GroupTrackerの`buildLiveBundleBlocks`は各subagentごとに個別にこの関数を呼ぶので、変更は不要。

確認ポイント: Slackのブロック数上限（50ブロック）に並列subagentで到達しないか。3 subagent × (header + 10 steps) = 最大33ブロック → 問題なし。

- [ ] **Step 2: コミット（変更がある場合のみ）**

tool-formatter.tsに変更が不要な場合はスキップ。

---

### Task 4: session-jsonl-reader — bundle境界ロジックの更新

**Files:**
- Modify: `src/streaming/session-jsonl-reader.ts`

- [ ] **Step 1: collectBundleEntriesのbundle境界ロジックを修正**

100文字閾値チェックを廃止し、テキスト出現 = bundle境界に変更:

```typescript
// 変更前 (L115-134):
// const shouldCollapse = textPosted || textBufferLength >= 100;
// if (hasActivityInCurrentSegment && shouldCollapse) { ... }

// 変更後:
if (block.type === 'text' && role === 'assistant') {
  // Any text after activity = bundle boundary (no 100-char threshold)
  if (hasActivityInCurrentSegment) {
    textBlockCount++;
    hasActivityInCurrentSegment = false;
  }
  continue;
}
```

不要になった変数を削除: `textBufferLength`, `textPosted`

- [ ] **Step 2: テスト — 既存のreadBundleテストがあれば確認**

Run: `npx vitest run`
Expected: PASS（全テスト）

- [ ] **Step 3: コミット**

```bash
git add src/streaming/session-jsonl-reader.ts
git commit -m "feat: simplify bundle boundary detection in JSONL reader"
```

---

### Task 5: index.ts — textMessageTsリセット連携

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: wireSessionOutput内のtextAction処理を確認**

`src/index.ts` L520-525で`registerTextMessageTs`を呼んでいる箇所は変更不要。StreamProcessor側で`finalizeCurrentText`がtextMessageTsをリセットするので、index.ts側の変更は最小限。

確認: bundleのpostMessage後にtextMessage用のtsが正しく管理されているか。

- [ ] **Step 2: コミット（変更がある場合のみ）**

---

### Task 6: 統合テスト — 全シナリオ検証

**Files:**
- Modify: `tests/streaming/stream-processor.test.ts`

- [ ] **Step 1: シナリオ1テスト — 3ラウンドのbundle→text交互**

```typescript
describe('StreamProcessor - multi-round ordering', () => {
  it('produces [bundle][text][bundle][text][bundle][text] for 3 rounds', async () => {
    const sp = new StreamProcessor({ channel: 'C1', threadTs: '1.0', sessionId: 's1' });
    const allActions: { bundleActions: any[]; textAction?: any }[] = [];

    // Round 1: thinking → tool → text
    allActions.push(await sp.processEvent({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'think1' }] } }));
    sp.registerBundleMessageTs('bundle-1', 'b1.ts');
    allActions.push(await sp.processEvent({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/a' } }] } }));
    allActions.push(await sp.processEvent({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } }));
    const r1text = await sp.processEvent({ type: 'assistant', message: { content: [{ type: 'text', text: 'Round 1 response' }] } });
    expect(r1text.textAction?.type).toBe('postMessage');
    sp.registerTextMessageTs('t1.ts');

    // Round 2: thinking → tool → text (should be NEW postMessage)
    allActions.push(await sp.processEvent({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'think2' }] } }));
    sp.registerBundleMessageTs('bundle-2', 'b2.ts');
    allActions.push(await sp.processEvent({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'npm test' } }] } }));
    allActions.push(await sp.processEvent({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't2', content: 'pass' }] } }));
    const r2text = await sp.processEvent({ type: 'assistant', message: { content: [{ type: 'text', text: 'Round 2 response' }] } });
    // Critical: this must be postMessage (new message), NOT update
    expect(r2text.textAction?.type).toBe('postMessage');
  });
});
```

- [ ] **Step 2: シナリオ4テスト — 並列subagent**

```typescript
describe('StreamProcessor - parallel subagents', () => {
  it('tracks both subagents and flushes text after all complete', async () => {
    const sp = new StreamProcessor({ channel: 'C1', threadTs: '1.0', sessionId: 's1' });

    // Start agent A and B
    await sp.processEvent({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'agentA', name: 'Agent', input: { description: 'Explore' } }] } });
    sp.registerBundleMessageTs('bundle-1', 'b1.ts');
    await sp.processEvent({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'agentB', name: 'Agent', input: { description: 'Test' } }] } });

    // Text while subagents running — should be buffered
    const textDuring = await sp.processEvent({ type: 'assistant', message: { content: [{ type: 'text', text: 'Working on it...' }] } });
    expect(textDuring.textAction).toBeUndefined();

    // Complete A — text still buffered (B still running)
    await sp.processEvent({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'agentA', content: 'agentId: abc123\ndone' }] } });

    // Complete B — text should now flush
    const completionResult = await sp.processEvent({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'agentB', content: 'agentId: def456\ndone' }] } });
    expect(completionResult.textAction).toBeDefined();
    expect(completionResult.textAction!.type).toBe('postMessage');
  });
});
```

- [ ] **Step 3: テスト実行**

Run: `npx vitest run tests/streaming/`
Expected: ALL PASS

- [ ] **Step 4: コミット**

```bash
git add tests/streaming/
git commit -m "test: add integration tests for multi-round ordering and parallel subagents"
```

---

### Task 7: 全テスト実行 + 手動検証

- [ ] **Step 1: 全テスト実行**

Run: `npx vitest run`
Expected: ALL PASS

- [ ] **Step 2: 手動検証の準備**

ユーザーに以下を依頼:
1. `cc /restart-bridge` でBridge再起動
2. 以下のテストプロンプトをSlackで送信:
   - 簡単なタスク（1ラウンド）: "package.jsonを読んで内容を教えて"
   - 複数ラウンド: "src/index.tsを読んで、改善提案を3つして"
   - Subagent使用: "コードベースを調査して、アーキテクチャを説明して"

3. Slackスレッドで `[bundle][text][bundle][text]...` の順序になっていることを確認

- [ ] **Step 3: 最終コミット**

```bash
git commit -m "feat: message ordering — round-based text splitting and parallel subagent tracking"
```
