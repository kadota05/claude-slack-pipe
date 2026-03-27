# File Input Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable Slack DM file attachments (images, PDFs, text files) to be processed and sent to Claude CLI via stream-json content blocks.

**Architecture:** Add a `FileProcessor` module that downloads Slack file attachments, classifies them by MIME type, and converts them to Claude API content blocks (image/document/text). Widen the prompt type throughout the pipeline (`sendPrompt`, `sendInitialPrompt`, `QueuedMessage`) from `string` to `string | ContentBlock[]` so file content flows through unchanged.

**Tech Stack:** TypeScript, Slack Web API (`files:read` scope), Node.js `fetch` for file download, `Buffer.toString('base64')` for encoding.

---

### Task 1: Add `files:read` scope to manifests and setup

**Files:**
- Modify: `slack-app-manifest.json:20-30`
- Modify: `.claude/skills/setup.md`

- [ ] **Step 1: Add `files:read` to slack-app-manifest.json**

In `slack-app-manifest.json`, add `"files:read"` to the `oauth_config.scopes.bot` array:

```json
"bot": [
  "channels:join",
  "channels:manage",
  "channels:read",
  "chat:write",
  "files:read",
  "im:history",
  "im:read",
  "im:write",
  "reactions:read",
  "reactions:write"
]
```

- [ ] **Step 2: Add `files:read` to setup skill**

In `.claude/skills/setup.md`, the setup skill references `slack-app-manifest.json` via Read tool during Task 4 Step 2. Since the manifest file itself is updated in Step 1, the setup flow will automatically include `files:read` when users paste the manifest. No separate change needed in the skill file.

Verify by reading the skill to confirm Task 4 Step 2 says "Read `slack-app-manifest.json` and display to user" — the updated manifest will be shown.

- [ ] **Step 3: Commit**

```bash
git add slack-app-manifest.json
git commit -m "feat: add files:read scope to Slack app manifest"
```

---

### Task 2: Widen `StdinUserMessage` content type

**Files:**
- Modify: `src/types.ts:354-360`

- [ ] **Step 1: Update `StdinUserMessage` type**

In `src/types.ts`, change the `StdinUserMessage` interface to accept image and document content blocks alongside text. The existing `ImageContent` (line 108) and `DocumentContent` (line 113) types are already defined:

```typescript
export interface StdinUserMessage {
  type: 'user';
  message: {
    role: 'user';
    content: Array<{ type: 'text'; text: string } | ImageContent | DocumentContent>;
  };
}
```

- [ ] **Step 2: Define `StdinContentBlock` type alias for convenience**

Add below the `StdinUserMessage` definition:

```typescript
export type StdinContentBlock = { type: 'text'; text: string } | ImageContent | DocumentContent;
```

- [ ] **Step 3: Commit**

```bash
git add src/types.ts
git commit -m "feat: widen StdinUserMessage to accept image and document blocks"
```

---

### Task 3: Widen `sendPrompt` and `sendInitialPrompt` in PersistentSession

**Files:**
- Modify: `src/bridge/persistent-session.ts:86-119`

- [ ] **Step 1: Update `sendPrompt` to accept `string | StdinContentBlock[]`**

Add the import and change the method signature:

```typescript
import type {
  SessionStartParams,
  SessionState,
  StdinMessage,
  StdinContentBlock,
  ControlMessage,
  StreamEvent,
} from '../types.js';
```

Update `sendPrompt`:

```typescript
sendPrompt(prompt: string | StdinContentBlock[]): void {
  if (this._state !== 'idle') {
    throw new Error(`Cannot send prompt in state: ${this._state}`);
  }
  this.clearIdleTimer();
  const content: StdinContentBlock[] = typeof prompt === 'string'
    ? [{ type: 'text', text: prompt }]
    : prompt;
  this.writeStdin({
    type: 'user',
    message: {
      role: 'user',
      content,
    },
  });
  this.transition('processing');
}
```

- [ ] **Step 2: Update `sendInitialPrompt` the same way**

```typescript
sendInitialPrompt(prompt: string | StdinContentBlock[]): void {
  if (this._state !== 'starting') {
    throw new Error(`sendInitialPrompt only valid in starting state, got: ${this._state}`);
  }
  this._hasPendingInitialPrompt = true;
  const content: StdinContentBlock[] = typeof prompt === 'string'
    ? [{ type: 'text', text: prompt }]
    : prompt;
  this.writeStdin({
    type: 'user',
    message: {
      role: 'user',
      content,
    },
  });
  logger.info(`[${this.sessionId}] initial prompt written to stdin (before init)`);
}
```

- [ ] **Step 3: Commit**

```bash
git add src/bridge/persistent-session.ts
git commit -m "feat: widen sendPrompt/sendInitialPrompt to accept content blocks"
```

---

### Task 4: Widen `QueuedMessage` and coordinator dequeue

**Files:**
- Modify: `src/bridge/message-queue.ts:1-6`
- Modify: `src/bridge/session-coordinator.ts:129`

- [ ] **Step 1: Widen `QueuedMessage.prompt` type**

In `src/bridge/message-queue.ts`, add the import and update the type:

```typescript
import type { StdinContentBlock } from '../types.js';

export interface QueuedMessage {
  id: string;
  prompt: string | StdinContentBlock[];
  enqueuedAt?: number;
}
```

- [ ] **Step 2: Verify coordinator dequeue**

In `src/bridge/session-coordinator.ts` line 129, the dequeue call is:
```typescript
session.sendPrompt(next.prompt);
```

Since both `QueuedMessage.prompt` and `sendPrompt` now accept `string | StdinContentBlock[]`, this requires no code change — the types align automatically. Verify by reading the file to confirm.

- [ ] **Step 3: Commit**

```bash
git add src/bridge/message-queue.ts
git commit -m "feat: widen QueuedMessage.prompt to accept content blocks"
```

---

### Task 5: Create `FileProcessor`

**Files:**
- Create: `src/slack/file-processor.ts`

- [ ] **Step 1: Create file-processor.ts with types and classification**

```typescript
// src/slack/file-processor.ts
import { logger } from '../utils/logger.js';
import type { StdinContentBlock } from '../types.js';

export interface SlackFile {
  id: string;
  name: string;
  mimetype: string;
  size: number;
  url_private_download?: string;
  url_private?: string;
}

export interface FileProcessResult {
  contentBlocks: StdinContentBlock[];
  warnings: string[];
}

const IMAGE_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
]);

const PDF_TYPE = 'application/pdf';

const TEXT_TYPES = new Set([
  'text/plain',
  'text/html',
  'text/css',
  'text/csv',
  'text/markdown',
  'text/xml',
  'application/json',
  'application/xml',
  'application/javascript',
  'application/typescript',
]);

function isTextType(mimetype: string): boolean {
  return TEXT_TYPES.has(mimetype) || mimetype.startsWith('text/');
}

type FileCategory = 'image' | 'pdf' | 'text' | 'unsupported';

function classifyFile(mimetype: string): FileCategory {
  if (IMAGE_TYPES.has(mimetype)) return 'image';
  if (mimetype === PDF_TYPE) return 'pdf';
  if (isTextType(mimetype)) return 'text';
  return 'unsupported';
}
```

- [ ] **Step 2: Add download and processing functions**

Append to the same file:

```typescript
const MAX_TOTAL_SIZE_BYTES = 32 * 1024 * 1024; // 32 MB

async function downloadFile(
  url: string,
  botToken: string,
): Promise<Buffer> {
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${botToken}` },
  });
  if (!response.ok) {
    throw new Error(`Failed to download file: ${response.status} ${response.statusText}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

export async function processFiles(
  files: SlackFile[],
  botToken: string,
): Promise<FileProcessResult> {
  const contentBlocks: StdinContentBlock[] = [];
  const warnings: string[] = [];
  let totalBase64Bytes = 0;

  for (const file of files) {
    const category = classifyFile(file.mimetype);

    if (category === 'unsupported') {
      warnings.push(`${file.name} (${file.mimetype}) is not supported. Supported: images, PDF, text files.`);
      continue;
    }

    const downloadUrl = file.url_private_download || file.url_private;
    if (!downloadUrl) {
      warnings.push(`${file.name}: no download URL available.`);
      continue;
    }

    let buffer: Buffer;
    try {
      buffer = await downloadFile(downloadUrl, botToken);
    } catch (err) {
      logger.error(`Failed to download file ${file.name}`, { error: (err as Error).message });
      warnings.push(`${file.name}: download failed.`);
      continue;
    }

    if (category === 'text') {
      try {
        const text = buffer.toString('utf-8');
        contentBlocks.push({ type: 'text', text: `${file.name}:\n${text}` });
      } catch {
        warnings.push(`${file.name}: could not decode as UTF-8 text.`);
      }
      continue;
    }

    // image or pdf — base64 encode
    const base64 = buffer.toString('base64');
    totalBase64Bytes += buffer.length;

    if (totalBase64Bytes > MAX_TOTAL_SIZE_BYTES) {
      warnings.push(`Total file size exceeds 32MB limit. Skipping ${file.name} and remaining files.`);
      break;
    }

    if (category === 'image') {
      contentBlocks.push({
        type: 'image',
        source: { type: 'base64', media_type: file.mimetype, data: base64 },
      });
    } else if (category === 'pdf') {
      contentBlocks.push({
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: base64 },
      });
    }
  }

  return { contentBlocks, warnings };
}
```

- [ ] **Step 3: Commit**

```bash
git add src/slack/file-processor.ts
git commit -m "feat: add FileProcessor for Slack file downloads and classification"
```

---

### Task 6: Integrate file processing into `handleMessage`

**Files:**
- Modify: `src/slack/event-handler.ts:17`
- Modify: `src/index.ts:197-520`

- [ ] **Step 1: Allow `file_share` subtype in event-handler.ts**

In `src/slack/event-handler.ts` line 17, change:

```typescript
if (event.bot_id || event.subtype) return 'ignore';
```

to:

```typescript
if (event.bot_id) return 'ignore';
if (event.subtype && event.subtype !== 'file_share') return 'ignore';
```

- [ ] **Step 2: Allow `file_share` subtype in index.ts**

In `src/index.ts` line 201, change:

```typescript
if (event.bot_id || event.subtype) { logger.info('[DEBUG] skipped: bot_id or subtype', { bot_id: event.bot_id, subtype: event.subtype }); return; }
```

to:

```typescript
if (event.bot_id) { logger.info('[DEBUG] skipped: bot_id', { bot_id: event.bot_id }); return; }
if (event.subtype && event.subtype !== 'file_share') { logger.info('[DEBUG] skipped: subtype', { subtype: event.subtype }); return; }
```

- [ ] **Step 3: Add file processing import and logic in index.ts**

Add the import at the top of `src/index.ts`:

```typescript
import { processFiles, type SlackFile } from './slack/file-processor.js';
```

Then, after the `text` variable assignment (line 215), add file processing logic. Find this block:

```typescript
const text = sanitizeUserInput(event.text || '');
```

After it, add:

```typescript
// Process file attachments if present
let fileContentBlocks: import('./types.js').StdinContentBlock[] | null = null;
if (event.files && Array.isArray(event.files) && event.files.length > 0) {
  const botToken = process.env.SLACK_BOT_TOKEN!;
  const result = await processFiles(event.files as SlackFile[], botToken);

  // Post warnings for unsupported/failed files
  if (result.warnings.length > 0) {
    await app.client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text: `⚠️ ${result.warnings.join('\n⚠️ ')}`,
    });
  }

  if (result.contentBlocks.length === 0 && !text) {
    // All files unsupported and no text — nothing to process
    return;
  }

  if (result.contentBlocks.length > 0) {
    // Build combined content blocks: files + optional text
    fileContentBlocks = [...result.contentBlocks];
    if (text) {
      fileContentBlocks.push({ type: 'text', text });
    }
  }
}
```

- [ ] **Step 4: Update prompt variable to use content blocks when files are present**

Find the line that defines the prompt variable (around line 356):

```typescript
const prompt = parsed.type === 'passthrough' ? parsed.content : parsed.content;
```

Change to:

```typescript
const prompt: string | import('./types.js').StdinContentBlock[] = fileContentBlocks || (parsed.type === 'passthrough' ? parsed.content : parsed.content);
```

- [ ] **Step 5: Update queue enqueue call for content blocks**

Find the queue enqueue call (around line 508):

```typescript
const enqueued = queue.enqueue({ id: messageTs, prompt });
```

This works as-is since `QueuedMessage.prompt` now accepts `string | StdinContentBlock[]`.

Verify by reading the code — no change needed here.

- [ ] **Step 6: Handle `file_share` in text-is-empty guard**

The current code at line 215-216 does:
```typescript
const text = sanitizeUserInput(event.text || '');
```

And later the command parser runs on `text`. When only files are sent (no text), `text` will be empty string. The command parser returns `plain_text` for empty strings, which is fine — the prompt will be the `fileContentBlocks` array.

However, there's a dedup guard at line 220 that uses `text` as part of the key. For file-only messages, all would have the same empty-string key. Fix by including a file indicator:

Find:
```typescript
const dedupKey = `${userId}:${text}`;
```

Change to:
```typescript
const fileIds = event.files?.map((f: any) => f.id).join(',') || '';
const dedupKey = `${userId}:${text}:${fileIds}`;
```

- [ ] **Step 7: Commit**

```bash
git add src/slack/event-handler.ts src/index.ts
git commit -m "feat: integrate file processing into message handler"
```

---

### Task 7: Update README

**Files:**
- Modify: `README.md:37`

- [ ] **Step 1: Update the unsupported notice**

Find:
```markdown
- **ファイル・画像の添付は未対応です。** 必ずテキストだけ送ってください。
```

Replace with:
```markdown
- **ファイル添付に対応しています。** 画像（JPEG, PNG, GIF, WebP）、PDF、テキスト系ファイル（.txt, .json, .csv, .md, .xml 等）を送信できます。動画・音声・Office系ファイルは未対応です。
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: update README to reflect file input support"
```

---

### Task 8: Manual Slack App scope update (instructions only)

This task is not code — it's a manual step for the user.

- [ ] **Step 1: Instruct user to update Slack App scopes**

After all code changes are committed, inform the user:

> コードの変更は完了しました。Slack App側にも `files:read` スコープを追加する必要があります：
>
> 1. https://api.slack.com/apps でアプリを開く
> 2. **OAuth & Permissions** → **Scopes** → **Bot Token Scopes**
> 3. `files:read` を追加
> 4. ページ上部の「**Reinstall to Workspace**」をクリック
> 5. Slackで `cc /restart-bridge` を送信してBridgeを再起動

- [ ] **Step 2: Verify after restart**

After the user restarts the bridge, test by sending an image in the DM. The bridge should process it and send it to Claude CLI.
