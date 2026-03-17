# Bundle Grouping Fix Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix two bugs that cause bundle grouping to break unnecessarily — child events from subagents and short intermediate text both prematurely collapse bundles.

**Architecture:** Two targeted fixes in the streaming pipeline. Fix 1: filter child `text`/`thinking` events in `StreamProcessor.handleAssistant()`. Fix 2: defer `handleTextStart()` until text is actually posted (after the 100-char buffer check). JSONL reader updated to match.

**Tech Stack:** TypeScript, Vitest

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `src/streaming/stream-processor.ts` | Modify | Fix 1: skip child text/thinking. Fix 2: move collapse after buffer check |
| `src/streaming/session-jsonl-reader.ts` | Modify | Fix 2: match streaming-side bundle boundary logic (short text threshold) |
| `tests/streaming/stream-processor.test.ts` | Create | Tests for both fixes |
| `tests/streaming/session-jsonl-reader.test.ts` | Create | Tests for JSONL reader bundle boundary fix |

---

## Chunk 1: Fix 1 — Child event filtering

### Task 1: Test child text/thinking events are ignored

**Files:**
- Create: `tests/streaming/stream-processor.test.ts`

- [ ] **Step 1: Write failing tests for child text collapsing parent bundle**

```typescript
import { describe, it, expect } from 'vitest';
import { StreamProcessor } from '../../src/streaming/stream-processor.js';

function makeProcessor() {
  return new StreamProcessor({
    channel: 'C_TEST',
    threadTs: '1000.0001',
    sessionId: 'sess-test',
  });
}

describe('StreamProcessor child event filtering', () => {
  it('should NOT collapse bundle when child text event arrives', () => {
    const sp = makeProcessor();

    // 1. Start subagent — creates bundle + subagent group
    const r1 = sp.processEvent({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'agent-1', name: 'Agent', input: { description: 'test agent' } }] },
    });
    expect(r1.bundleActions.length).toBeGreaterThan(0);
    expect(r1.bundleActions[0].type).toBe('postMessage');

    // 2. Child text event — should NOT collapse the bundle
    const r2 = sp.processEvent({
      type: 'assistant',
      parent_tool_use_id: 'agent-1',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Using brainstorming skill...' }] },
    });
    // No collapse action should be emitted
    const collapseActions = r2.bundleActions.filter(a => a.type === 'collapse');
    expect(collapseActions).toHaveLength(0);
    // No text action should be emitted for child text
    expect(r2.textAction).toBeUndefined();

    // 3. Child tool_use — subagent step should still work
    const r3 = sp.processEvent({
      type: 'assistant',
      parent_tool_use_id: 'agent-1',
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: '/tmp/test' } }] },
    });
    // Should produce update action (subagent step added)
    // No collapse
    const collapseActions3 = r3.bundleActions.filter(a => a.type === 'collapse');
    expect(collapseActions3).toHaveLength(0);
  });

  it('should NOT switch group category when child thinking event arrives', () => {
    const sp = makeProcessor();

    // 1. Start subagent
    sp.processEvent({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'agent-1', name: 'Agent', input: { description: 'test' } }] },
    });

    // 2. Child thinking event — should NOT create a thinking group
    const r2 = sp.processEvent({
      type: 'assistant',
      parent_tool_use_id: 'agent-1',
      message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'Let me think about this...' }] },
    });
    const collapseActions = r2.bundleActions.filter(a => a.type === 'collapse');
    expect(collapseActions).toHaveLength(0);

    // 3. Active group should still be subagent (not thinking)
    const activeGroup = sp.getActiveGroupData();
    expect(activeGroup).not.toBeNull();
    expect(activeGroup!.category).toBe('subagent');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/streaming/stream-processor.test.ts`
Expected: FAIL — child text causes bundle collapse, child thinking switches group to 'thinking'

- [ ] **Step 3: Implement child event filtering in handleAssistant**

Modify: `src/streaming/stream-processor.ts:74-85`

```typescript
private handleAssistant(content: any[], parentToolUseId: string | null, result: ProcessedActions): void {
  for (const block of content) {
    if (block.type === 'thinking') {
      // Skip child thinking — internal to subagent
      if (parentToolUseId) continue;
      const actions = this.groupTracker.handleThinking(block.thinking);
      result.bundleActions.push(...actions);
    } else if (block.type === 'tool_use') {
      this.handleToolUse(block, parentToolUseId, result);
    } else if (block.type === 'text' && block.text) {
      // Skip child text — internal to subagent
      if (parentToolUseId) continue;
      this.handleText(block.text, result);
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/streaming/stream-processor.test.ts`
Expected: PASS

- [ ] **Step 5: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass

- [ ] **Step 6: Commit**

```bash
git add tests/streaming/stream-processor.test.ts src/streaming/stream-processor.ts
git commit -m "fix(streaming): skip child text/thinking events in handleAssistant

Child events from subagents (text, thinking) were being processed as
top-level events, causing premature bundle collapse and incorrect
group category switches."
```

---

## Chunk 2: Fix 2 — Short text bundle collapse deferral

### Task 2: Test short text does not collapse bundle

**Files:**
- Modify: `tests/streaming/stream-processor.test.ts`

- [ ] **Step 1: Write failing test for short text collapsing bundle**

Append to `tests/streaming/stream-processor.test.ts`:

```typescript
describe('StreamProcessor short text bundle deferral', () => {
  it('should NOT collapse bundle when short text arrives between tool calls', () => {
    const sp = makeProcessor();

    // 1. thinking + tool_use → bundle starts
    sp.processEvent({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'Let me search...' }] },
    });
    sp.processEvent({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tool-1', name: 'ToolSearch', input: { query: 'mcp' } }] },
    });
    sp.processEvent({
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'found tools' }] },
    });

    // 2. Short text (< 100 chars) — should NOT collapse bundle
    const r = sp.processEvent({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'ツールを確認しました。' }] },
    });
    const collapseActions = r.bundleActions.filter(a => a.type === 'collapse');
    expect(collapseActions).toHaveLength(0);

    // 3. Next tool_use — should be in the SAME bundle (not a new one)
    const r2 = sp.processEvent({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tool-2', name: 'mcp__gcal', input: {} }] },
    });
    const postActions = r2.bundleActions.filter(a => a.type === 'postMessage');
    expect(postActions).toHaveLength(0); // No new bundle posted
  });

  it('should collapse bundle when long text arrives', () => {
    const sp = makeProcessor();

    // 1. tool_use → bundle starts
    sp.processEvent({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: '/tmp/f' } }] },
    });
    sp.processEvent({
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'file contents' }] },
    });

    // 2. Long text (>= 100 chars) — should collapse bundle
    const longText = 'これは非常に長いテキストレスポンスです。ユーザーの質問に対して詳細な回答を提供しています。バンドルはこのテキストで折りたたまれるべきです。十分な長さがあるため、バッファのチェックを超えます。';
    const r = sp.processEvent({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: longText }] },
    });
    const collapseActions = r.bundleActions.filter(a => a.type === 'collapse');
    expect(collapseActions).toHaveLength(1);
  });

  it('should collapse bundle on result even with buffered short text', () => {
    const sp = makeProcessor();

    // 1. tool_use → bundle starts
    sp.processEvent({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: '/tmp/f' } }] },
    });
    sp.processEvent({
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'ok' }] },
    });

    // 2. Short text — NOT collapsed
    sp.processEvent({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: '完了。' }] },
    });

    // 3. Result event — flushes active bundle
    const r = sp.processEvent({ type: 'result', duration_ms: 1000 });
    expect(r.resultEvent).toBeDefined();
    // Bundle should have been flushed (collapsed)
    const collapseActions = r.bundleActions.filter(a => a.type === 'collapse');
    expect(collapseActions).toHaveLength(1);
  });

  it('should collapse bundle when accumulated short texts exceed threshold', () => {
    const sp = makeProcessor();

    // 1. tool_use → bundle starts
    sp.processEvent({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: '/tmp/f' } }] },
    });
    sp.processEvent({
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'ok' }] },
    });

    // 2. First short text (30 chars) — NOT collapsed
    const r1 = sp.processEvent({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'ファイルを確認しました。次に進みます。' }] },
    });
    expect(r1.bundleActions.filter(a => a.type === 'collapse')).toHaveLength(0);

    // 3. Second short text — accumulated total >= 100 chars → COLLAPSE
    const r2 = sp.processEvent({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'このファイルには重要な設定が含まれています。変更内容を詳しく確認して、適切な修正を提案します。では具体的に見ていきましょう。' }] },
    });
    const collapseActions = r2.bundleActions.filter(a => a.type === 'collapse');
    expect(collapseActions).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/streaming/stream-processor.test.ts`
Expected: FAIL — short text currently collapses bundle

- [ ] **Step 3: Implement deferred collapse in handleText**

Modify: `src/streaming/stream-processor.ts:113-153`

Change `handleText` to defer `handleTextStart()` until text is actually going to be posted:

```typescript
private handleText(text: string, result: ProcessedActions): void {
  this.textBuffer += text;

  // Buffer short text — don't post or collapse yet
  if (!this.textMessageTs && this.textBuffer.length < 100) {
    return;
  }

  // Text is being posted — collapse the active bundle now
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

Also update `handleResult` to flush buffered short text that deferred bundle collapse:

Modify: `src/streaming/stream-processor.ts:197-234` — no change needed. `flushActiveBundle` already handles this in `handleResult`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/streaming/stream-processor.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/streaming/stream-processor.ts tests/streaming/stream-processor.test.ts
git commit -m "fix(streaming): defer bundle collapse until text is posted

Short intermediate text (< 100 chars) was already buffered and not
posted, but still triggered bundle collapse. Now collapse only
happens when text exceeds the buffer threshold and is actually posted
to Slack. This keeps ToolSearch → MCP tool sequences in one bundle."
```

---

### Task 3: JSONL reader bundle boundary alignment

**Files:**
- Modify: `src/streaming/session-jsonl-reader.ts:66-183`
- Create: `tests/streaming/session-jsonl-reader.test.ts`

- [ ] **Step 1: Write failing test for JSONL reader short-text boundary**

```typescript
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SessionJsonlReader } from '../../src/streaming/session-jsonl-reader.js';

function writeJsonl(dir: string, projectPath: string, sessionId: string, lines: object[]): void {
  const dirName = projectPath.replace(/\//g, '-');
  const fullDir = path.join(dir, dirName);
  fs.mkdirSync(fullDir, { recursive: true });
  const filePath = path.join(fullDir, `${sessionId}.jsonl`);
  const content = lines.map(l => JSON.stringify(l)).join('\n') + '\n';
  fs.writeFileSync(filePath, content);
}

describe('SessionJsonlReader bundle boundary', () => {
  it('should NOT create bundle boundary on short assistant text', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsonl-test-'));
    const projectPath = '/test/project';
    const sessionId = 'sess-1';

    // Event flow:
    // thinking → tool_use(ToolSearch) → tool_result → short text → tool_use(mcp_tool) → tool_result → long text
    // Expected: ONE bundle containing thinking + ToolSearch + mcp_tool
    writeJsonl(tmpDir, projectPath, sessionId, [
      { message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'searching...' }] } },
      { message: { role: 'assistant', content: [{ type: 'tool_use', id: 'ts-1', name: 'ToolSearch', input: { query: 'mcp' } }] } },
      { message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'ts-1', content: 'found' }] } },
      { message: { role: 'assistant', content: [{ type: 'text', text: 'ツールを確認。' }] } },  // short < 100
      { message: { role: 'assistant', content: [{ type: 'tool_use', id: 'mcp-1', name: 'mcp__gcal', input: {} }] } },
      { message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'mcp-1', content: 'events: []' }] } },
      { message: { role: 'assistant', content: [{ type: 'text', text: 'これは非常に長いテキストレスポンスです。ユーザーの質問に対して詳細な回答を提供しています。バンドルはこのテキストで折りたたまれるべきです。十分な長さがあるため、バッファのチェックを超えます。' }] } },
    ]);

    const reader = new SessionJsonlReader(tmpDir);
    const entries = await reader.readBundle(projectPath, sessionId, 0);

    // Bundle 0 should contain: thinking + ToolSearch + mcp_tool
    expect(entries.length).toBe(3);
    expect(entries[0].type).toBe('thinking');
    expect(entries[1].type).toBe('tool');
    expect(entries[2].type).toBe('tool');

    // Clean up
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should create bundle boundary on long assistant text', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsonl-test-'));
    const projectPath = '/test/project';
    const sessionId = 'sess-2';

    const longText = 'これは非常に長いテキストレスポンスです。ユーザーの質問に対して詳細な回答を提供しています。バンドルはこのテキストで折りたたまれるべきです。十分な長さがあるため、バッファのチェックを超えます。';

    writeJsonl(tmpDir, projectPath, sessionId, [
      { message: { role: 'assistant', content: [{ type: 'tool_use', id: 't-1', name: 'Read', input: { file_path: '/tmp/f' } }] } },
      { message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't-1', content: 'ok' }] } },
      { message: { role: 'assistant', content: [{ type: 'text', text: longText }] } },
      { message: { role: 'assistant', content: [{ type: 'tool_use', id: 't-2', name: 'Write', input: { file_path: '/tmp/f' } }] } },
      { message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't-2', content: 'ok' }] } },
      { message: { role: 'assistant', content: [{ type: 'text', text: longText }] } },
    ]);

    const reader = new SessionJsonlReader(tmpDir);
    const bundle0 = await reader.readBundle(projectPath, sessionId, 0);
    const bundle1 = await reader.readBundle(projectPath, sessionId, 1);

    // Bundle 0: Read tool only
    expect(bundle0.length).toBe(1);
    expect(bundle0[0].type).toBe('tool');

    // Bundle 1: Write tool only
    expect(bundle1.length).toBe(1);
    expect(bundle1[0].type).toBe('tool');

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/streaming/session-jsonl-reader.test.ts`
Expected: FAIL — short text currently creates bundle boundary

- [ ] **Step 3: Implement short-text threshold in collectBundleEntries**

Modify: `src/streaming/session-jsonl-reader.ts:66-183`

Add a `textBuffer` to accumulate text length and only count as boundary when threshold exceeded:

```typescript
private async collectBundleEntries(filePath: string, bundleIndex: number): Promise<BundleEntry[]> {
  const stream = fs.createReadStream(filePath);
  const rl = readline.createInterface({ input: stream });

  const entries: BundleEntry[] = [];
  const pendingToolEntries = new Map<string, number>();
  const toolUseTimestamps = new Map<string, number>();
  const agentToolUseIds = new Set<string>();

  let textBlockCount = 0;
  let hasActivityInCurrentSegment = false;
  let textBufferLength = 0; // accumulated text length for bundle boundary check
  let lineTimestamp = 0;

  for await (const line of rl) {
    if (!line.trim()) continue;

    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    lineTimestamp++;

    const msg = entry.message;
    if (!msg || !Array.isArray(msg.content)) continue;

    const isChild = typeof entry.parentToolUseID === 'string'
      || typeof entry.parent_tool_use_id === 'string';
    if (isChild) continue;

    const role = msg.role;
    const isCollecting = textBlockCount === bundleIndex;

    for (const block of msg.content) {
      if (!block || typeof block !== 'object') continue;

      if (block.type === 'text' && role === 'assistant') {
        const textLen = typeof block.text === 'string' ? block.text.length : 0;
        textBufferLength += textLen;

        // Only count as bundle boundary when accumulated text >= 100 chars
        if (hasActivityInCurrentSegment && textBufferLength >= 100) {
          textBlockCount++;
          hasActivityInCurrentSegment = false;
          textBufferLength = 0;
        }
        continue;
      }

      // Mark activity but do NOT reset textBufferLength —
      // streaming side accumulates textBuffer across tool calls
      if (block.type === 'thinking' || block.type === 'tool_use') {
        hasActivityInCurrentSegment = true;
      }

      if (!isCollecting) continue;

      if (block.type === 'thinking') {
        const text = String(block.thinking || '');
        const last = entries[entries.length - 1];
        if (last && last.type === 'thinking') {
          last.texts.push(text);
        } else {
          entries.push({ type: 'thinking', texts: [text] });
        }
      } else if (block.type === 'tool_use') {
        const toolUseId = String(block.id || '');
        const toolName = String(block.name || '');
        const input = (block.input || {}) as Record<string, unknown>;

        toolUseTimestamps.set(toolUseId, lineTimestamp);

        if (toolName === 'Agent') {
          agentToolUseIds.add(toolUseId);
          const description = String(input.prompt || input.description || '');
          const idx = entries.length;
          entries.push({ type: 'subagent', toolUseId, description, agentId: '', durationMs: 0 });
          pendingToolEntries.set(toolUseId, idx);
        } else {
          const oneLiner = getToolOneLiner(toolName, input);
          const idx = entries.length;
          entries.push({ type: 'tool', toolUseId, toolName, oneLiner, durationMs: 0 });
          pendingToolEntries.set(toolUseId, idx);
        }
      } else if (block.type === 'tool_result') {
        const toolUseId = String(block.tool_use_id || '');
        const entryIdx = pendingToolEntries.get(toolUseId);
        if (entryIdx === undefined) continue;

        const startTs = toolUseTimestamps.get(toolUseId) ?? lineTimestamp;
        const durationMs = (lineTimestamp - startTs) * 10;

        const existing = entries[entryIdx];
        if (existing.type === 'subagent') {
          const resultContent = typeof block.content === 'string'
            ? block.content
            : JSON.stringify(block.content);
          const agentIdMatch = resultContent.match(/agentId:\s*(\S+)/);
          const agentId = agentIdMatch ? agentIdMatch[1] : '';
          entries[entryIdx] = { ...existing, agentId, durationMs };
        } else if (existing.type === 'tool') {
          entries[entryIdx] = { ...existing, durationMs };
        }

        pendingToolEntries.delete(toolUseId);
      }
    }
  }

  return entries;
}
```

Key changes from original:
1. Added `textBufferLength` variable to accumulate text length
2. Text boundary check: `textBufferLength >= 100` instead of always incrementing
3. Do NOT reset `textBufferLength` on tool_use/thinking — streaming side accumulates `textBuffer` across tool calls, so JSONL reader must match

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/streaming/session-jsonl-reader.test.ts`
Expected: PASS

- [ ] **Step 5: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass

- [ ] **Step 6: Commit**

```bash
git add src/streaming/session-jsonl-reader.ts tests/streaming/session-jsonl-reader.test.ts
git commit -m "fix(jsonl-reader): align bundle boundary with streaming-side threshold

Short assistant text (< 100 chars) no longer creates a bundle
boundary in the JSONL reader, matching the streaming-side behavior.
This prevents bundle index mismatch between live display and
detail modals."
```

---

### Task 4: Knowledge doc + final verification

**Files:**
- Create: `docs/knowledge/2026-03-17-bundle-grouping-break.md`

- [ ] **Step 1: Write knowledge doc**

```markdown
# バンドルグルーピングが途切れるバグ

## 症状

Slackのストリーミング表示で、一連のツール活動（thinking → ToolSearch → MCP tool）が
本来1つのバンドル（折りたたみメッセージ）にまとまるべきところ、複数のバンドルに分割されていた。
また、サブエージェント実行中にバンドルが早期に崩壊し、後続のサブエージェントステップが失われた。

## 根本原因

2つの独立したバグ:

1. **子イベントのフィルタリング漏れ**: `StreamProcessor.handleAssistant()` で
   `tool_use` ブロックのみ `parentToolUseId` をチェックしていた。
   子 `text`/`thinking` イベントは親レベルのハンドラに到達し、
   `handleTextStart()` によるバンドル崩壊や `handleThinking()` によるグループ切り替えを引き起こした。

2. **短文テキストのバンドル崩壊**: `handleText()` で `handleTextStart()`（バンドル崩壊）が
   短文バッファリングチェック（100文字未満は投稿しない）の**前**に実行されていた。
   投稿されない短いナレーションテキストでもバンドルが崩壊した。

## 証拠

- JSOLNデータ分析: セッション `b8ca68fa` で ToolSearch 後の短文テキスト
  `"ブレインストーミングを始めます。"` がバンドル境界を作成していることを確認
- コードトレース: `handleAssistant()` L74-85 で `thinking`/`text` に
  `parentToolUseId` チェックがないことを特定
- `handleText()` L113-126 で `handleTextStart()` がバッファチェック前に呼ばれていることを確認

## 修正内容

1. `handleAssistant()`: `parentToolUseId` がある場合、`text`/`thinking` ブロックを `continue` でスキップ
2. `handleText()`: `handleTextStart()` をテキストバッファの100文字閾値チェック後に移動
3. `session-jsonl-reader.ts`: `collectBundleEntries()` にテキスト長の累積チェックを追加し、
   100文字未満の短文テキストではバンドル境界を作らないように変更

## 教訓

- ストリームイベントの `parentToolUseId` チェックは全ブロックタイプに一貫して適用すべき。
  新しいブロックタイプを追加する際も同様。
- ストリーミング側とJSONLリーダー側でバンドル境界のロジックが一致していないと、
  バンドルインデックスのズレが発生し、詳細モーダルの表示が壊れる。
  変更時は必ず両側を揃えること。
```

- [ ] **Step 2: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass

- [ ] **Step 3: Commit**

```bash
git add docs/knowledge/2026-03-17-bundle-grouping-break.md
git commit -m "docs: add knowledge doc for bundle grouping break bug"
```
