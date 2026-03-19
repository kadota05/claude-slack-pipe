# Slack Context Injection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prepend Slack environment context to every user message sent to Claude CLI, so Claude knows it's responding via Slack and keeps output mobile-friendly.

**Architecture:** A new `slack-context.ts` exports a constant prefix string. `persistent-session.ts` imports it and prepends to user text in `sendPrompt()` and `sendInitialPrompt()`.

**Tech Stack:** TypeScript

**Spec:** `docs/superpowers/specs/2026-03-19-slack-context-injection-design.md`

---

### Task 1: Create `src/bridge/slack-context.ts`

**Files:**
- Create: `src/bridge/slack-context.ts`

- [ ] **Step 1: Create the file with the context prefix constant**

```typescript
// src/bridge/slack-context.ts

// Keep this prefix under 100 tokens to minimize
// context window overhead (currently ~60 tokens).
export const SLACK_CONTEXT_PREFIX = `\
[Slack Bridge Context]
You are normally used directly from the CLI,
but right now the user is talking to you
through Slack, likely from a mobile phone.
Your responses are posted to a Slack channel
and they read them there, so keep diagrams,
tables, and ASCII art within 45 characters
wide — wider content breaks on mobile. Since
the user is NOT at the machine running your
process, they cannot check logs, approve
system prompts, or perform local-only
operations — ask them to run slash commands
instead. localhost URLs are still accessible
through the bridge, so use them freely.
`;
```

- [ ] **Step 2: Verify the file compiles**

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add src/bridge/slack-context.ts
git commit -m "feat: add Slack context prefix constant"
```

---

### Task 2: Inject prefix in `persistent-session.ts`

**Files:**
- Modify: `src/bridge/persistent-session.ts:1` (add import)
- Modify: `src/bridge/persistent-session.ts:95` (`sendPrompt` — change `text: prompt`)
- Modify: `src/bridge/persistent-session.ts:115` (`sendInitialPrompt` — change `text: prompt`)

- [ ] **Step 1: Add import**

Add after line 4 (`import { logger }...`):

```typescript
import { SLACK_CONTEXT_PREFIX } from './slack-context.js';
```

- [ ] **Step 2: Modify `sendPrompt()`**

In `sendPrompt()` (line 95), change:

```typescript
content: [{ type: 'text', text: prompt }],
```

to:

```typescript
content: [{ type: 'text', text: SLACK_CONTEXT_PREFIX + '\n' + prompt }],
```

- [ ] **Step 3: Modify `sendInitialPrompt()`**

In `sendInitialPrompt()` (line 115), change:

```typescript
content: [{ type: 'text', text: prompt }],
```

to:

```typescript
content: [{ type: 'text', text: SLACK_CONTEXT_PREFIX + '\n' + prompt }],
```

- [ ] **Step 4: Verify compilation**

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 5: Commit**

```bash
git add src/bridge/persistent-session.ts
git commit -m "feat: inject Slack context prefix into all prompts"
```

---

### Task 3: Manual verification

- [ ] **Step 1: Ask user to restart Bridge**

> コードを変更しました。Slackで `cc /restart-bridge` と送信して再起動してください。

- [ ] **Step 2: Send a test message from Slack requesting a diagram**

Send something like: "ディレクトリ構成をツリー図で見せて" and verify the output fits within 45 characters wide.
