# Channel Router Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a generic channel routing layer to the Bridge so channel messages are dispatched to external project handlers via slack-memory.json

**Architecture:** Event Classification Layer intercepts non-DM messages before existing DM processing. Channel Router looks up channelId in slack-memory.json and spawns the registered handler process with standardized CLI arguments. Files are downloaded to temp and paths passed to the handler.

**Tech Stack:** TypeScript, Vitest, Node.js child_process

**Branch:** `feat/channel-router`

---

## File Structure

| Action | Path | Responsibility |
|--------|------|---------------|
| Create | `src/bridge/channel-router.ts` | Load slack-memory.json, watch for changes, dispatch messages to handlers |
| Create | `src/bridge/file-downloader.ts` | Download Slack files to temp directory (reuses downloadFile logic) |
| Create | `tests/bridge/channel-router.test.ts` | Unit tests for ChannelRouter |
| Create | `tests/bridge/file-downloader.test.ts` | Unit tests for file downloader |
| Modify | `src/index.ts` | Add channel routing before DM gate |
| Modify | `src/slack/file-processor.ts` | Export downloadFile for reuse |

---

### Task 1: Export downloadFile from file-processor

**Files:**
- Modify: `src/slack/file-processor.ts`

- [ ] **Step 1: Export downloadFile**

Currently `downloadFile` is not exported. Add export:

```typescript
// src/slack/file-processor.ts — change the function signature (around line 56)
// FROM:
async function downloadFile(url: string, botToken: string): Promise<Buffer> {
// TO:
export async function downloadFile(url: string, botToken: string): Promise<Buffer> {
```

- [ ] **Step 2: Run existing tests to verify no breakage**

Run: `npx vitest run tests/slack/ --reporter=verbose`
Expected: All existing tests pass (downloadFile was already used internally, exporting doesn't change behavior)

- [ ] **Step 3: Commit**

```bash
git add src/slack/file-processor.ts
git commit -m "refactor: export downloadFile from file-processor for reuse"
```

---

### Task 2: File Downloader — tests

**Files:**
- Create: `src/bridge/file-downloader.ts`
- Create: `tests/bridge/file-downloader.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/bridge/file-downloader.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

// Mock the downloadFile function
vi.mock('../../src/slack/file-processor.js', () => ({
  downloadFile: vi.fn(),
}));

import { downloadFilesToTemp } from '../../src/bridge/file-downloader.js';
import { downloadFile } from '../../src/slack/file-processor.js';

const mockedDownload = vi.mocked(downloadFile);

describe('downloadFilesToTemp', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'file-dl-test-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('downloads files and returns temp paths', async () => {
    const files = [
      { id: 'F1', name: 'photo.jpg', mimetype: 'image/jpeg', size: 100, url_private_download: 'https://files.slack.com/photo.jpg' },
    ];
    mockedDownload.mockResolvedValue(Buffer.from('fake-image-data'));

    const result = await downloadFilesToTemp(files, 'xoxb-token', tempDir);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatch(/photo\.jpg$/);
    const content = await fs.readFile(result[0]);
    expect(content.toString()).toBe('fake-image-data');
    expect(mockedDownload).toHaveBeenCalledWith('https://files.slack.com/photo.jpg', 'xoxb-token');
  });

  it('returns empty array when no files', async () => {
    const result = await downloadFilesToTemp([], 'xoxb-token', tempDir);
    expect(result).toEqual([]);
  });

  it('skips files without download URL', async () => {
    const files = [
      { id: 'F1', name: 'no-url.jpg', mimetype: 'image/jpeg', size: 100 },
    ];

    const result = await downloadFilesToTemp(files as any, 'xoxb-token', tempDir);
    expect(result).toEqual([]);
    expect(mockedDownload).not.toHaveBeenCalled();
  });

  it('skips files that fail to download', async () => {
    const files = [
      { id: 'F1', name: 'fail.jpg', mimetype: 'image/jpeg', size: 100, url_private_download: 'https://example.com/fail' },
    ];
    mockedDownload.mockRejectedValue(new Error('download failed'));

    const result = await downloadFilesToTemp(files, 'xoxb-token', tempDir);
    expect(result).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/bridge/file-downloader.test.ts --reporter=verbose`
Expected: FAIL — cannot resolve module `../../src/bridge/file-downloader.js`

- [ ] **Step 3: Implement file-downloader**

```typescript
// src/bridge/file-downloader.ts
import fs from 'node:fs/promises';
import path from 'node:path';
import { downloadFile } from '../slack/file-processor.js';
import { logger } from '../utils/logger.js';

interface SlackFileRef {
  id: string;
  name: string;
  mimetype: string;
  size: number;
  url_private_download?: string;
}

export async function downloadFilesToTemp(
  files: SlackFileRef[],
  botToken: string,
  tempDir: string,
): Promise<string[]> {
  const paths: string[] = [];

  for (const file of files) {
    if (!file.url_private_download) {
      logger.warn(`Skipping file ${file.name}: no download URL`);
      continue;
    }
    try {
      const buffer = await downloadFile(file.url_private_download, botToken);
      const filePath = path.join(tempDir, `${file.id}-${file.name}`);
      await fs.writeFile(filePath, buffer);
      paths.push(filePath);
    } catch (err) {
      logger.warn(`Failed to download file ${file.name}:`, err);
    }
  }

  return paths;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/bridge/file-downloader.test.ts --reporter=verbose`
Expected: All 4 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/bridge/file-downloader.ts tests/bridge/file-downloader.test.ts
git commit -m "feat: add file-downloader for channel router temp file handling"
```

---

### Task 3: Channel Router — core logic and tests

**Files:**
- Create: `src/bridge/channel-router.ts`
- Create: `tests/bridge/channel-router.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/bridge/channel-router.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ChannelRouter } from '../../src/bridge/channel-router.js';

describe('ChannelRouter', () => {
  let tempDir: string;
  let memoryPath: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ch-router-test-'));
    memoryPath = path.join(tempDir, 'slack-memory.json');
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe('load', () => {
    it('loads routes from slack-memory.json', async () => {
      const entries = [
        {
          folder: '/tmp/test-project',
          description: 'Test Project',
          channel: '#test',
          channelId: 'C111',
          handler: 'src/handler.ts',
          createdAt: '2026-03-27',
        },
      ];
      await fs.writeFile(memoryPath, JSON.stringify(entries));

      const router = new ChannelRouter(memoryPath);
      await router.load();

      expect(router.hasRoute('C111')).toBe(true);
      expect(router.hasRoute('C999')).toBe(false);
    });

    it('handles missing file gracefully', async () => {
      const router = new ChannelRouter(path.join(tempDir, 'nonexistent.json'));
      await router.load();
      expect(router.hasRoute('C111')).toBe(false);
    });

    it('handles invalid JSON gracefully', async () => {
      await fs.writeFile(memoryPath, 'not json');
      const router = new ChannelRouter(memoryPath);
      await router.load();
      expect(router.hasRoute('C111')).toBe(false);
    });

    it('handles entries without handler field', async () => {
      const entries = [
        {
          folder: '/tmp/project',
          description: 'No handler',
          channel: '#no-handler',
          channelId: 'C222',
          createdAt: '2026-03-27',
        },
      ];
      await fs.writeFile(memoryPath, JSON.stringify(entries));

      const router = new ChannelRouter(memoryPath);
      await router.load();
      expect(router.hasRoute('C222')).toBe(false);
    });
  });

  describe('getRoute', () => {
    it('returns route entry for known channelId', async () => {
      const entries = [
        {
          folder: '/tmp/project-a',
          description: 'Project A',
          channel: '#proj-a',
          channelId: 'C111',
          handler: 'src/handler.ts',
          createdAt: '2026-03-27',
        },
      ];
      await fs.writeFile(memoryPath, JSON.stringify(entries));

      const router = new ChannelRouter(memoryPath);
      await router.load();

      const route = router.getRoute('C111');
      expect(route).toBeDefined();
      expect(route!.folder).toBe('/tmp/project-a');
      expect(route!.handler).toBe('src/handler.ts');
    });

    it('returns undefined for unknown channelId', async () => {
      const router = new ChannelRouter(memoryPath);
      await router.load();
      expect(router.getRoute('CUNKNOWN')).toBeUndefined();
    });
  });

  describe('reload', () => {
    it('picks up new routes after reload', async () => {
      await fs.writeFile(memoryPath, JSON.stringify([]));
      const router = new ChannelRouter(memoryPath);
      await router.load();
      expect(router.hasRoute('C111')).toBe(false);

      const entries = [
        {
          folder: '/tmp/new',
          description: 'New',
          channel: '#new',
          channelId: 'C111',
          handler: 'src/h.ts',
          createdAt: '2026-03-27',
        },
      ];
      await fs.writeFile(memoryPath, JSON.stringify(entries));
      await router.load();
      expect(router.hasRoute('C111')).toBe(true);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/bridge/channel-router.test.ts --reporter=verbose`
Expected: FAIL — cannot resolve module

- [ ] **Step 3: Implement ChannelRouter**

```typescript
// src/bridge/channel-router.ts
import fs from 'node:fs/promises';
import { watch, type FSWatcher } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { logger } from '../utils/logger.js';
import { downloadFilesToTemp } from './file-downloader.js';

export interface ChannelRouteEntry {
  folder: string;
  description: string;
  channel: string;
  channelId: string;
  handler: string;
  createdAt: string;
}

export interface ChannelMessageParams {
  text: string;
  files: Array<{ id: string; name: string; mimetype: string; size: number; url_private_download?: string }>;
  botToken: string;
  userId: string;
  channelId: string;
  threadTs: string;
  timestamp: string;
}

export class ChannelRouter {
  private routes: Map<string, ChannelRouteEntry> = new Map();
  private watcher: FSWatcher | null = null;
  private reloadTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly slackMemoryPath: string) {}

  async load(): Promise<void> {
    try {
      const content = await fs.readFile(this.slackMemoryPath, 'utf-8');
      const entries: unknown[] = JSON.parse(content);
      this.routes.clear();
      for (const entry of entries) {
        const e = entry as Record<string, unknown>;
        if (typeof e.channelId === 'string' && typeof e.handler === 'string' && typeof e.folder === 'string') {
          this.routes.set(e.channelId, entry as ChannelRouteEntry);
        }
      }
      logger.info(`Channel router loaded ${this.routes.size} route(s)`);
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        logger.info('No slack-memory.json found, channel routing disabled');
      } else {
        logger.warn('Failed to load slack-memory.json:', err.message);
      }
      this.routes.clear();
    }
  }

  startWatching(): void {
    try {
      this.watcher = watch(this.slackMemoryPath, () => {
        // Debounce: wait 500ms after last change
        if (this.reloadTimer) clearTimeout(this.reloadTimer);
        this.reloadTimer = setTimeout(() => {
          logger.info('slack-memory.json changed, reloading routes');
          this.load();
        }, 500);
      });
      logger.info('Watching slack-memory.json for changes');
    } catch {
      logger.info('Cannot watch slack-memory.json (file may not exist yet)');
    }
  }

  stopWatching(): void {
    this.watcher?.close();
    this.watcher = null;
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
  }

  hasRoute(channelId: string): boolean {
    return this.routes.has(channelId);
  }

  getRoute(channelId: string): ChannelRouteEntry | undefined {
    return this.routes.get(channelId);
  }

  private expandTilde(filePath: string): string {
    if (filePath.startsWith('~/')) {
      return path.join(os.homedir(), filePath.slice(2));
    }
    return filePath;
  }

  async dispatch(params: ChannelMessageParams): Promise<void> {
    const route = this.routes.get(params.channelId);
    if (!route) return;

    const folder = this.expandTilde(route.folder);
    const handler = path.join(folder, route.handler);

    // Download files to temp directory
    let filePaths: string[] = [];
    let tempDir: string | null = null;
    if (params.files.length > 0) {
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ch-router-'));
      filePaths = await downloadFilesToTemp(params.files, params.botToken, tempDir);
    }

    const args = [handler];
    if (params.text) {
      args.push('--text', params.text);
    }
    if (filePaths.length > 0) {
      args.push('--files', filePaths.join(','));
    }
    args.push('--user-id', params.userId);
    args.push('--channel-id', params.channelId);
    args.push('--thread-ts', params.threadTs);
    args.push('--timestamp', params.timestamp);

    logger.info(`Dispatching to ${route.channel}: ${route.description}`);

    const child = spawn('tsx', args, {
      cwd: folder,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (data: Buffer) => { stdout += data.toString(); });
    child.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });

    child.on('exit', async (code) => {
      if (code !== 0) {
        logger.error(`Channel handler ${route.channel} exited with code ${code}. stderr: ${stderr}`);
      } else {
        logger.debug(`Channel handler ${route.channel} completed. stdout: ${stdout}`);
      }
      // Clean up temp files
      if (tempDir) {
        await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
      }
    });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/bridge/channel-router.test.ts --reporter=verbose`
Expected: All 7 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/bridge/channel-router.ts tests/bridge/channel-router.test.ts
git commit -m "feat: add ChannelRouter with slack-memory.json routing"
```

---

### Task 4: Integrate Channel Router into index.ts

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Add ChannelRouter initialization**

In `main()`, after config loading and data directory setup, add ChannelRouter initialization.

Find the section where `buildBridgeContext` is called (around line 145-160) and add after it:

```typescript
// After bridge context setup, add:
import { ChannelRouter } from './bridge/channel-router.js';

// In main(), after bridgeContext setup:
const slackMemoryPath = path.join(config.dataDir, 'slack-memory.json');
const channelRouter = new ChannelRouter(slackMemoryPath);
await channelRouter.load();
channelRouter.startWatching();
```

- [ ] **Step 2: Add channel routing to handleMessage**

Find the DM gate in `handleMessage()` (the line `if (event.channel_type !== 'im') return;` around line 198).

Replace:
```typescript
if (event.channel_type !== 'im') return;
```

With:
```typescript
if (event.channel_type !== 'im') {
  // Channel message — route via Channel Router
  if (event.channel && channelRouter.hasRoute(event.channel)) {
    // Skip bot's own messages
    if (event.bot_id || event.subtype === 'bot_message') return;

    const slackFiles = (event.files ?? []) as Array<{
      id: string; name: string; mimetype: string; size: number;
      url_private_download?: string;
    }>;

    channelRouter.dispatch({
      text: event.text ?? '',
      files: slackFiles,
      botToken: config.slackBotToken,
      userId: event.user ?? '',
      channelId: event.channel,
      threadTs: event.thread_ts ?? event.ts ?? '',
      timestamp: event.ts ?? '',
    }).catch((err) => {
      logger.error('Channel dispatch error:', err);
    });
  }
  return;
}
```

- [ ] **Step 3: Add path import if not present**

Verify `path` is imported at the top of index.ts. If not, add:
```typescript
import path from 'node:path';
```

- [ ] **Step 4: Run full test suite**

Run: `npx vitest run --reporter=verbose`
Expected: All tests PASS (no existing tests break)

- [ ] **Step 5: Manual verification**

Start the bridge in dev mode and confirm:
1. DM messages still work normally
2. Channel messages to unregistered channels are silently ignored
3. No errors in logs at startup (slack-memory.json may not exist yet)

- [ ] **Step 6: Commit**

```bash
git add src/index.ts
git commit -m "feat: integrate Channel Router into Bridge message handling"
```

---

### Task 5: Integration test for channel routing

**Files:**
- Create: `tests/bridge/channel-router-integration.test.ts`

- [ ] **Step 1: Write integration test**

```typescript
// tests/bridge/channel-router-integration.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ChannelRouter } from '../../src/bridge/channel-router.js';

// Mock child_process.spawn
vi.mock('node:child_process', () => {
  const EventEmitter = require('node:events');
  return {
    spawn: vi.fn(() => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdin = { write: vi.fn(), end: vi.fn() };
      // Simulate successful exit
      setTimeout(() => child.emit('exit', 0), 10);
      return child;
    }),
  };
});

// Mock file-downloader
vi.mock('../../src/bridge/file-downloader.js', () => ({
  downloadFilesToTemp: vi.fn().mockResolvedValue(['/tmp/test/photo.jpg']),
}));

import { spawn } from 'node:child_process';
import { downloadFilesToTemp } from '../../src/bridge/file-downloader.js';

describe('ChannelRouter dispatch', () => {
  let tempDir: string;
  let memoryPath: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ch-dispatch-'));
    memoryPath = path.join(tempDir, 'slack-memory.json');
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('spawns handler with correct arguments', async () => {
    const entries = [
      {
        folder: '/home/user/dev/body-concierge',
        description: 'Body Concierge',
        channel: '#body-concierge',
        channelId: 'C123',
        handler: 'src/process-message.ts',
        createdAt: '2026-03-27',
      },
    ];
    await fs.writeFile(memoryPath, JSON.stringify(entries));

    const router = new ChannelRouter(memoryPath);
    await router.load();

    await router.dispatch({
      text: 'チキンサラダ食べた',
      files: [],
      botToken: 'xoxb-test',
      userId: 'U123',
      channelId: 'C123',
      threadTs: '1711000000.000000',
      timestamp: '1711000001.000000',
    });

    expect(spawn).toHaveBeenCalledWith(
      'tsx',
      expect.arrayContaining([
        '/home/user/dev/body-concierge/src/process-message.ts',
        '--text', 'チキンサラダ食べた',
        '--user-id', 'U123',
        '--channel-id', 'C123',
      ]),
      expect.objectContaining({
        cwd: '/home/user/dev/body-concierge',
      }),
    );
  });

  it('downloads files and passes paths when files present', async () => {
    const entries = [
      {
        folder: '/home/user/dev/body-concierge',
        description: 'BC',
        channel: '#bc',
        channelId: 'C123',
        handler: 'src/process-message.ts',
        createdAt: '2026-03-27',
      },
    ];
    await fs.writeFile(memoryPath, JSON.stringify(entries));

    const router = new ChannelRouter(memoryPath);
    await router.load();

    await router.dispatch({
      text: '',
      files: [{ id: 'F1', name: 'meal.jpg', mimetype: 'image/jpeg', size: 500, url_private_download: 'https://files.slack.com/meal.jpg' }],
      botToken: 'xoxb-test',
      userId: 'U123',
      channelId: 'C123',
      threadTs: '1711000000.000000',
      timestamp: '1711000001.000000',
    });

    expect(downloadFilesToTemp).toHaveBeenCalled();
    expect(spawn).toHaveBeenCalledWith(
      'tsx',
      expect.arrayContaining(['--files', '/tmp/test/photo.jpg']),
      expect.anything(),
    );
  });

  it('does nothing for unknown channelId', async () => {
    await fs.writeFile(memoryPath, JSON.stringify([]));
    const router = new ChannelRouter(memoryPath);
    await router.load();

    await router.dispatch({
      text: 'hello',
      files: [],
      botToken: 'xoxb-test',
      userId: 'U123',
      channelId: 'CUNKNOWN',
      threadTs: '1711000000.000000',
      timestamp: '1711000001.000000',
    });

    expect(spawn).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test**

Run: `npx vitest run tests/bridge/channel-router-integration.test.ts --reporter=verbose`
Expected: All 3 tests PASS

- [ ] **Step 3: Run full test suite**

Run: `npx vitest run --reporter=verbose`
Expected: All tests PASS

- [ ] **Step 4: Commit**

```bash
git add tests/bridge/channel-router-integration.test.ts
git commit -m "test: add integration tests for channel router dispatch"
```
