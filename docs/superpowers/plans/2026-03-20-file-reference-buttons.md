# File Reference Buttons Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect file paths in Claude CLI's final text response and display them as clickable buttons on Slack that open modals showing file contents.

**Architecture:** Extract file paths from the `textBuffer` at `result` event time, verify they exist on disk, then append section blocks with button accessories to the text message. Button clicks trigger action handlers that read the file and display contents in a modal, with chunked pagination for large files.

**Tech Stack:** TypeScript, Slack Block Kit (section + button accessory), fs module for file operations.

**Spec:** `docs/superpowers/specs/2026-03-20-file-reference-buttons-design.md`

---

### Task 1: File Path Extractor Module

**Files:**
- Create: `src/streaming/file-path-extractor.ts`
- Test: `src/streaming/__tests__/file-path-extractor.test.ts`

- [ ] **Step 1: Write tests for extractFilePaths**

```typescript
// src/streaming/__tests__/file-path-extractor.test.ts
import { describe, it, expect } from 'vitest';
import { extractFilePaths } from '../file-path-extractor.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';

describe('extractFilePaths', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), 'file-path-test-'));
    // Create test files
    mkdirSync(path.join(tempDir, 'src', 'streaming'), { recursive: true });
    writeFileSync(path.join(tempDir, 'src', 'index.ts'), 'console.log("hello")');
    writeFileSync(path.join(tempDir, 'src', 'streaming', 'processor.ts'), 'export {}');
    writeFileSync(path.join(tempDir, 'README.md'), '# README');
    writeFileSync(path.join(tempDir, 'image.png'), Buffer.from([0x89, 0x50]));
  });

  it('extracts backtick-quoted paths that exist', () => {
    const text = 'Modified `src/index.ts` and `src/streaming/processor.ts`.';
    const result = extractFilePaths(text, tempDir);
    expect(result).toEqual(['src/index.ts', 'src/streaming/processor.ts']);
  });

  it('extracts bare slash-separated paths that exist', () => {
    const text = 'Changed src/index.ts to fix the bug.';
    const result = extractFilePaths(text, tempDir);
    expect(result).toEqual(['src/index.ts']);
  });

  it('deduplicates paths found in both backtick and bare form', () => {
    const text = '`src/index.ts` was modified. See src/index.ts for details.';
    const result = extractFilePaths(text, tempDir);
    expect(result).toEqual(['src/index.ts']);
  });

  it('excludes paths inside code blocks', () => {
    const text = 'Here is an example:\n```\nsrc/index.ts\n```\nDone.';
    const result = extractFilePaths(text, tempDir);
    expect(result).toEqual([]);
  });

  it('excludes non-existent paths', () => {
    const text = '`src/nonexistent.ts` was changed.';
    const result = extractFilePaths(text, tempDir);
    expect(result).toEqual([]);
  });

  it('excludes binary file extensions', () => {
    const text = 'Updated `image.png` as well.';
    const result = extractFilePaths(text, tempDir);
    expect(result).toEqual([]);
  });

  it('excludes absolute paths outside cwd', () => {
    const text = 'Do not read `/etc/passwd`.';
    const result = extractFilePaths(text, tempDir);
    expect(result).toEqual([]);
  });

  it('allows absolute paths inside cwd', () => {
    const absPath = path.join(tempDir, 'src/index.ts');
    const text = `Modified \`${absPath}\`.`;
    const result = extractFilePaths(text, tempDir);
    expect(result).toEqual(['src/index.ts']);
  });

  it('excludes files larger than 1MB', () => {
    const bigFile = path.join(tempDir, 'src', 'big.ts');
    writeFileSync(bigFile, 'x'.repeat(1024 * 1024 + 1));
    const text = '`src/big.ts` is large.';
    const result = extractFilePaths(text, tempDir);
    expect(result).toEqual([]);
  });

  it('returns empty array when no paths found', () => {
    const text = 'No file paths here at all.';
    const result = extractFilePaths(text, tempDir);
    expect(result).toEqual([]);
  });

  it('handles backtick content without slashes (not a path)', () => {
    const text = 'Run `npm install` to get started.';
    const result = extractFilePaths(text, tempDir);
    expect(result).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/streaming/__tests__/file-path-extractor.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement extractFilePaths**

```typescript
// src/streaming/file-path-extractor.ts
import * as fs from 'node:fs';
import * as path from 'node:path';

const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.svg', '.webp',
  '.wasm', '.exe', '.dll', '.so', '.dylib',
  '.zip', '.tar', '.gz', '.bz2', '.7z', '.rar',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx',
  '.mp3', '.mp4', '.wav', '.avi', '.mov', '.mkv',
  '.ttf', '.otf', '.woff', '.woff2', '.eot',
]);

const MAX_FILE_SIZE = 1024 * 1024; // 1MB

export function extractFilePaths(text: string, cwd: string): string[] {
  // Remove code blocks before scanning
  const textWithoutCodeBlocks = text.replace(/```[\s\S]*?```/g, '');

  const candidates = new Set<string>();

  // 1. Backtick-quoted paths containing /
  const backtickRegex = /`([^`]+)`/g;
  for (const match of textWithoutCodeBlocks.matchAll(backtickRegex)) {
    const candidate = match[1];
    if (candidate.includes('/')) {
      candidates.add(candidate);
    }
  }

  // 2. Bare slash-separated paths
  const bareRegex = /(?:^|\s)((?:[\w@.-]+\/)+[\w.-]+)(?:\s|$|[,.:;)])/gm;
  for (const match of textWithoutCodeBlocks.matchAll(bareRegex)) {
    candidates.add(match[1]);
  }

  // Validate and filter
  const results: string[] = [];
  const normalizedCwd = path.resolve(cwd) + path.sep;

  for (const candidate of candidates) {
    // Resolve to absolute path
    const resolved = path.resolve(cwd, candidate);

    // Security: must be under cwd
    if (!resolved.startsWith(normalizedCwd) && resolved !== path.resolve(cwd)) {
      continue;
    }

    // Check extension
    const ext = path.extname(resolved).toLowerCase();
    if (BINARY_EXTENSIONS.has(ext)) continue;

    // Check existence and size
    try {
      const stat = fs.statSync(resolved);
      if (!stat.isFile()) continue;
      if (stat.size > MAX_FILE_SIZE) continue;

      // Symlink resolution: verify real path is still under cwd
      const realPath = fs.realpathSync(resolved);
      if (!realPath.startsWith(normalizedCwd)) continue;
    } catch {
      continue;
    }

    // Normalize to relative path
    const relative = path.relative(cwd, resolved);
    if (!results.includes(relative)) {
      results.push(relative);
    }
  }

  return results;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/streaming/__tests__/file-path-extractor.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/streaming/file-path-extractor.ts src/streaming/__tests__/file-path-extractor.test.ts
git commit -m "feat: add file path extractor with existence and security checks"
```

---

### Task 2: File Content Modal Builder

**Files:**
- Modify: `src/slack/modal-builder.ts` — add `buildFileContentModal`, `buildFileChunksModal`, `buildFileChunkModal`

- [ ] **Step 1: Write tests for modal builders**

```typescript
// src/slack/__tests__/file-modal-builder.test.ts
import { describe, it, expect } from 'vitest';
import { buildFileContentModal, buildFileChunksModal, buildFileChunkModal } from '../modal-builder.js';

describe('buildFileContentModal', () => {
  it('builds modal with file content in code blocks', () => {
    const modal = buildFileContentModal('src/index.ts', 'console.log("hello")');
    expect(modal.type).toBe('modal');
    expect(modal.title.text).toContain('src/index.ts');
    // Content should be in code block
    const textBlocks = modal.blocks.filter((b: any) => b.type === 'section');
    expect(textBlocks.length).toBeGreaterThan(0);
    expect(textBlocks[0].text.text).toContain('```');
  });

  it('splits long content into multiple sections', () => {
    const longContent = 'x'.repeat(6000);
    const modal = buildFileContentModal('src/big.ts', longContent);
    const textBlocks = modal.blocks.filter((b: any) => b.type === 'section');
    expect(textBlocks.length).toBeGreaterThan(1);
  });
});

describe('buildFileChunksModal', () => {
  it('builds parent modal with chunk buttons', () => {
    const modal = buildFileChunksModal('src/index.ts', 642);
    expect(modal.type).toBe('modal');
    const actionsBlocks = modal.blocks.filter((b: any) => b.type === 'actions');
    expect(actionsBlocks.length).toBeGreaterThan(0);
    const buttons = actionsBlocks[0].elements;
    expect(buttons[0].value).toContain('src/index.ts');
  });

  it('splits buttons into multiple actions blocks when >25 chunks', () => {
    const modal = buildFileChunksModal('src/huge.ts', 3000);
    const actionsBlocks = modal.blocks.filter((b: any) => b.type === 'actions');
    expect(actionsBlocks.length).toBeGreaterThan(1);
  });
});

describe('buildFileChunkModal', () => {
  it('builds child modal with chunk content', () => {
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join('\n');
    const modal = buildFileChunkModal('src/index.ts', lines, 1, 50);
    expect(modal.type).toBe('modal');
    expect(modal.title.text).toContain('1-50');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/slack/__tests__/file-modal-builder.test.ts`
Expected: FAIL — functions not exported

- [ ] **Step 3: Implement modal builder functions**

Add to `src/slack/modal-builder.ts`:

```typescript
const LINES_PER_CHUNK = 100;

export function buildFileContentModal(filePath: string, content: string): any {
  const blocks: Block[] = [];
  const fileName = filePath.split('/').pop() || filePath;

  const parts = splitContent(content, 2850); // Leave room for ``` markers
  for (const part of parts) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `\`\`\`\n${part}\n\`\`\`` },
    });
  }

  return {
    type: 'modal',
    title: { type: 'plain_text', text: truncate(fileName, 24) },
    close: { type: 'plain_text', text: '閉じる' },
    blocks: blocks.slice(0, 100),
  };
}

export function buildFileChunksModal(filePath: string, totalLines: number): any {
  const blocks: Block[] = [];
  const fileName = filePath.split('/').pop() || filePath;

  blocks.push({
    type: 'section',
    text: { type: 'mrkdwn', text: `:page_facing_up: \`${filePath}\` (${totalLines}行)` },
  });
  blocks.push({ type: 'divider' });

  const buttons: any[] = [];
  for (let start = 1; start <= totalLines; start += LINES_PER_CHUNK) {
    const end = Math.min(start + LINES_PER_CHUNK - 1, totalLines);
    const index = buttons.length;
    buttons.push({
      type: 'button',
      text: { type: 'plain_text', text: `${start}-${end}行` },
      action_id: `view_file_chunk:${index}`,
      value: `${filePath}:${start}:${end}`,
    });
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
    title: { type: 'plain_text', text: truncate(fileName, 24) },
    close: { type: 'plain_text', text: '閉じる' },
    blocks: blocks.slice(0, 100),
  };
}

export function buildFileChunkModal(filePath: string, content: string, startLine: number, endLine: number): any {
  const blocks: Block[] = [];
  const fileName = filePath.split('/').pop() || filePath;

  const parts = splitContent(content, 2850);
  for (const part of parts) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `\`\`\`\n${part}\n\`\`\`` },
    });
  }

  return {
    type: 'modal',
    title: { type: 'plain_text', text: truncate(`${fileName} ${startLine}-${endLine}`, 24) },
    close: { type: 'plain_text', text: '閉じる' },
    blocks: blocks.slice(0, 100),
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/slack/__tests__/file-modal-builder.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/slack/modal-builder.ts src/slack/__tests__/file-modal-builder.test.ts
git commit -m "feat: add file content modal builders (direct, chunks, chunk)"
```

---

### Task 3: File Reference Block Builder

**Files:**
- Create: `src/streaming/file-reference-blocks.ts`

- [ ] **Step 1: Write tests**

```typescript
// src/streaming/__tests__/file-reference-blocks.test.ts
import { describe, it, expect } from 'vitest';
import { buildFileReferenceBlocks } from '../file-reference-blocks.js';

describe('buildFileReferenceBlocks', () => {
  it('builds section + button for each file path', () => {
    const blocks = buildFileReferenceBlocks(['src/index.ts', 'src/types.ts']);
    expect(blocks).toHaveLength(3); // divider + 2 sections
    expect(blocks[0].type).toBe('divider');
    expect(blocks[1].type).toBe('section');
    expect(blocks[1].accessory.type).toBe('button');
    expect(blocks[1].accessory.action_id).toBe('view_file_content');
    expect(blocks[1].accessory.value).toBe('src/index.ts');
  });

  it('returns empty array for no file paths', () => {
    const blocks = buildFileReferenceBlocks([]);
    expect(blocks).toHaveLength(0);
  });

  it('respects max blocks limit', () => {
    const paths = Array.from({ length: 60 }, (_, i) => `src/file${i}.ts`);
    const blocks = buildFileReferenceBlocks(paths, 10);
    // divider(1) + sections limited to fit within 10
    expect(blocks.length).toBeLessThanOrEqual(10);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/streaming/__tests__/file-reference-blocks.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement buildFileReferenceBlocks**

```typescript
// src/streaming/file-reference-blocks.ts
import type { Block } from './types.js';

export function buildFileReferenceBlocks(filePaths: string[], maxBlocks?: number): Block[] {
  if (filePaths.length === 0) return [];

  const blocks: Block[] = [];
  blocks.push({ type: 'divider' });

  const limit = maxBlocks ? maxBlocks - 1 : filePaths.length; // -1 for divider
  for (const filePath of filePaths.slice(0, limit)) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `:page_facing_up: \`${filePath}\``,
      },
      accessory: {
        type: 'button',
        text: { type: 'plain_text', text: '表示' },
        action_id: 'view_file_content',
        value: filePath,
      },
    } as any);
  }

  return blocks;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/streaming/__tests__/file-reference-blocks.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/streaming/file-reference-blocks.ts src/streaming/__tests__/file-reference-blocks.test.ts
git commit -m "feat: add file reference block builder for Slack display"
```

---

### Task 4: Integrate into StreamProcessor

**Files:**
- Modify: `src/streaming/stream-processor.ts:17-22` — add `cwd` to config
- Modify: `src/streaming/stream-processor.ts:264-324` — add file path extraction in `handleResult`
- Modify: `src/index.ts` — pass `cwd` to StreamProcessorConfig

- [ ] **Step 1: Add `cwd` to StreamProcessorConfig**

In `src/streaming/stream-processor.ts`, add `cwd` to the config interface and import new modules:

```typescript
// Add imports at top:
import { extractFilePaths } from './file-path-extractor.js';
import { buildFileReferenceBlocks } from './file-reference-blocks.js';

// Add to StreamProcessorConfig:
interface StreamProcessorConfig {
  channel: string;
  threadTs: string;
  sessionId: string;
  cwd: string;  // <-- add this
  tunnelManager?: TunnelManager;
  onFirstContent?: () => void;
}
```

- [ ] **Step 2: Add file reference blocks in handleResult**

In `src/streaming/stream-processor.ts`, modify `handleResult` to append file reference blocks after building text blocks. Insert after line 294 (`const blocks = this.buildTextBlocks(converted);`):

```typescript
      // Append file reference buttons
      const filePaths = extractFilePaths(this.textBuffer, this.config.cwd);
      if (filePaths.length > 0) {
        const maxFileBlocks = 50 - blocks.length;
        if (maxFileBlocks > 1) {
          const fileBlocks = buildFileReferenceBlocks(filePaths, maxFileBlocks);
          blocks.push(...fileBlocks);
        }
      }
```

Note: `blocks` must be declared with `const` but since we're pushing to an array that's fine. The `buildTextBlocks` return is already used as a local — just ensure the variable is mutable (it's an array, so `.push` works on `const`).

- [ ] **Step 3: Pass `cwd` from index.ts to StreamProcessor**

In `src/index.ts`, find where `StreamProcessor` is constructed (inside `wireSessionOutput`) and add `cwd` from the session entry's `projectPath`:

Search for `new StreamProcessor({` and add `cwd: entry.projectPath,` to the config object.

- [ ] **Step 4: Manual test — restart bridge, send a message that triggers file path mentions**

Run: `cc /restart-bridge` in Slack, then ask Claude to modify a file. Verify file reference buttons appear at the bottom of the text response.

- [ ] **Step 5: Commit**

```bash
git add src/streaming/stream-processor.ts src/index.ts
git commit -m "feat: integrate file path extraction into handleResult"
```

---

### Task 5: Action Handlers for File Content Modal

**Files:**
- Modify: `src/index.ts` — add `view_file_content` and `view_file_chunk` action handlers

- [ ] **Step 1: Add view_file_content action handler**

In `src/index.ts`, add after the existing `view_subagent_detail:` action handler block. Follow the existing pattern (see lines 756-811 for reference):

```typescript
  // --- File Content Modal Action ---
  app.action('view_file_content', async ({ ack, body }: any) => {
    await ack();
    const filePath = body.actions?.[0]?.value;
    if (!filePath) return;

    // Resolve cwd from session
    const threadTs = body.message?.thread_ts || body.message?.ts || '';
    const entry = threadTs ? sessionIndexStore.findByThreadTs(threadTs) : null;
    const cwd = entry?.projectPath || process.cwd();

    const resolved = path.resolve(cwd, filePath);
    const normalizedCwd = path.resolve(cwd) + path.sep;

    // Security: must be under cwd
    if (!resolved.startsWith(normalizedCwd) && resolved !== path.resolve(cwd)) {
      logger.warn(`Path traversal blocked: ${filePath}`);
      return;
    }

    try {
      const content = fs.readFileSync(resolved, 'utf-8');
      const lines = content.split('\n');
      const MODAL_MAX_BLOCKS = 98; // Reserve 2 for header
      const blocksNeeded = Math.ceil(content.length / 2850);

      let modal: any;
      if (blocksNeeded <= MODAL_MAX_BLOCKS) {
        modal = buildFileContentModal(filePath, content);
      } else {
        modal = buildFileChunksModal(filePath, lines.length);
      }

      await app.client.views.open({ trigger_id: body.trigger_id, view: modal });
    } catch (err: any) {
      const modal = {
        type: 'modal',
        title: { type: 'plain_text', text: 'エラー' },
        close: { type: 'plain_text', text: '閉じる' },
        blocks: [{
          type: 'section',
          text: { type: 'mrkdwn', text: `ファイルが見つかりません: \`${filePath}\`` },
        }],
      };
      await app.client.views.open({ trigger_id: body.trigger_id, view: modal });
    }
  });
```

- [ ] **Step 2: Add view_file_chunk action handler**

```typescript
  // --- File Chunk Modal Action ---
  app.action(/^view_file_chunk:/, async ({ ack, body }: any) => {
    await ack();
    const value = body.actions?.[0]?.value;
    if (!value) return;

    // Parse value: "filePath:startLine:endLine"
    const lastColon2 = value.lastIndexOf(':');
    const lastColon1 = value.lastIndexOf(':', lastColon2 - 1);
    const filePath = value.substring(0, lastColon1);
    const startLine = parseInt(value.substring(lastColon1 + 1, lastColon2), 10);
    const endLine = parseInt(value.substring(lastColon2 + 1), 10);

    if (!filePath || isNaN(startLine) || isNaN(endLine)) return;

    // Resolve cwd from modal's private_metadata or fallback
    const privateMetadata = body.view?.private_metadata || '';
    const entry = privateMetadata ? sessionIndexStore.findByThreadTs(privateMetadata) : null;
    const cwd = entry?.projectPath || process.cwd();

    const resolved = path.resolve(cwd, filePath);
    const normalizedCwd = path.resolve(cwd) + path.sep;

    if (!resolved.startsWith(normalizedCwd) && resolved !== path.resolve(cwd)) {
      logger.warn(`Path traversal blocked: ${filePath}`);
      return;
    }

    try {
      const content = fs.readFileSync(resolved, 'utf-8');
      const lines = content.split('\n');
      const chunk = lines.slice(startLine - 1, endLine).join('\n');
      const modal = buildFileChunkModal(filePath, chunk, startLine, endLine);
      await app.client.views.push({ trigger_id: body.trigger_id, view: modal });
    } catch {
      const modal = {
        type: 'modal',
        title: { type: 'plain_text', text: 'エラー' },
        close: { type: 'plain_text', text: '閉じる' },
        blocks: [{
          type: 'section',
          text: { type: 'mrkdwn', text: `ファイルが見つかりません: \`${filePath}\`` },
        }],
      };
      await app.client.views.push({ trigger_id: body.trigger_id, view: modal });
    }
  });
```

- [ ] **Step 3: Add necessary imports to index.ts**

```typescript
import * as fs from 'node:fs';
import * as path from 'node:path';
import { buildFileContentModal, buildFileChunksModal, buildFileChunkModal } from './slack/modal-builder.js';
```

Check if `fs` and `path` are already imported — if so, skip.

- [ ] **Step 4: Set private_metadata on file chunks parent modal**

In the `view_file_content` handler, pass `threadTs` as `private_metadata` on the chunks modal so the chunk handler can resolve cwd:

```typescript
modal.private_metadata = threadTs;
```

- [ ] **Step 5: Manual test — click file reference button, verify modal opens**

Restart bridge via `cc /restart-bridge`, trigger a response with file paths, click the "表示" button. Verify:
- Small file: content shows directly
- Large file: chunk buttons appear, clicking opens chunk content

- [ ] **Step 6: Commit**

```bash
git add src/index.ts
git commit -m "feat: add action handlers for file content and chunk modals"
```

---

### Task 6: End-to-End Verification

- [ ] **Step 1: Run all tests**

Run: `npx vitest run`
Expected: All tests PASS

- [ ] **Step 2: Manual e2e test via Slack**

1. Restart bridge: `cc /restart-bridge`
2. Ask Claude to read or modify a file
3. Verify buttons appear at bottom of text response
4. Click "表示" button → modal opens with file content
5. Test with a large file (>100 lines) → chunk parent modal → chunk child modal

- [ ] **Step 3: Edge case tests**

1. Response with no file paths → no buttons appear
2. Response mentioning non-existent paths → no buttons
3. Response with code blocks containing paths → paths not extracted
4. Click button after file has been deleted → error modal shown

- [ ] **Step 4: Final commit if any fixes needed**

```bash
git add -A
git commit -m "fix: address e2e test findings for file reference buttons"
```
