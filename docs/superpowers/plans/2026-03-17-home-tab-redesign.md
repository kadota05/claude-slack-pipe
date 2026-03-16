# Home Tab Redesign Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign the Slack Home Tab into a focused dashboard with heartbeat-based status card, integrated model/directory dropdowns, and JSONL-based recent sessions.

**Architecture:** New `Heartbeat` class handles bridge liveness detection via a timestamp file. `RecentSessionScanner` scans `~/.claude/projects/` JSONL files across all projects, filters recurring sessions by first-prompt deduplication. `buildHomeTabBlocks` is rewritten to produce a simplified 3-section layout (header, status card with dropdowns, recent sessions).

**Tech Stack:** TypeScript, Slack Block Kit, Node.js fs API

**Spec:** `docs/superpowers/specs/2026-03-17-home-tab-redesign-design.md`

---

## Chunk 1: Heartbeat Module

### Task 1: Create `src/heartbeat.ts`

**Files:**
- Create: `src/heartbeat.ts`

- [ ] **Step 1: Write the heartbeat class**

```typescript
// src/heartbeat.ts
import fs from 'node:fs';
import path from 'node:path';
import { logger } from './utils/logger.js';

const HEARTBEAT_FILE = 'heartbeat';
const INTERVAL_MS = 30_000;
const STALENESS_MS = 60_000;

export class Heartbeat {
  private readonly filePath: string;
  private intervalId: ReturnType<typeof setInterval> | null = null;

  constructor(dataDir: string) {
    this.filePath = path.join(dataDir, HEARTBEAT_FILE);
  }

  start(): void {
    this.write();
    this.intervalId = setInterval(() => this.write(), INTERVAL_MS);
    logger.info('Heartbeat started', { path: this.filePath });
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    try {
      fs.unlinkSync(this.filePath);
    } catch {
      // File may not exist
    }
    logger.info('Heartbeat stopped');
  }

  isAlive(): boolean {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf-8').trim();
      const ts = parseInt(raw, 10);
      if (isNaN(ts)) return false;
      return Date.now() - ts < STALENESS_MS;
    } catch {
      return false;
    }
  }

  private write(): void {
    try {
      fs.writeFileSync(this.filePath, String(Date.now()));
    } catch (err) {
      logger.error('Failed to write heartbeat', { error: (err as Error).message });
    }
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/heartbeat.ts
git commit -m "feat(heartbeat): add bridge liveness detection via timestamp file"
```

### Task 2: Wire heartbeat into `src/index.ts`

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Add heartbeat import and initialization**

After the `pidLock` line (~line 53), add:

```typescript
import { Heartbeat } from './heartbeat.js';
```

(Add to imports at top of file)

In `main()`, after `const pidLock = acquirePidLock(config.dataDir);`:

```typescript
const heartbeat = new Heartbeat(config.dataDir);
heartbeat.start();
```

- [ ] **Step 2: Add heartbeat to shutdown handler**

In the existing `shutdown` function (~line 737), add `heartbeat.stop()` before `pidLock.release()`:

```typescript
const shutdown = async (signal: string) => {
  logger.info(`Received ${signal}, shutting down...`);
  heartbeat.stop();
  for (const entry of sessionIndexStore.getActive()) {
    coordinator.endSession(entry.cliSessionId);
  }
  pidLock.release();
  await app.stop();
  process.exit(0);
};
```

- [ ] **Step 3: Pass heartbeat to HomeTabHandler**

Change the HomeTabHandler construction (~line 80):

```typescript
const homeTabHandler = new HomeTabHandler(app.client, userPrefStore, sessionIndexStore, projectStore, heartbeat);
```

- [ ] **Step 4: Commit**

```bash
git add src/index.ts
git commit -m "feat(index): wire heartbeat start/stop and pass to HomeTabHandler"
```

---

## Chunk 2: Recent Session Scanner

### Task 3: Create `src/store/recent-session-scanner.ts`

**Files:**
- Create: `src/store/recent-session-scanner.ts`
- Modify: `src/types.ts` (add `RecentSession` type)

- [ ] **Step 1: Add RecentSession type to types.ts**

Add after the `SessionIndexFile` interface (~line 419):

```typescript
// ============================================================
// Recent Session (Home Tab)
// ============================================================

export interface RecentSession {
  sessionId: string;
  projectPath: string;
  mtime: Date;
  firstPrompt: string;
  firstPromptPreview: string;
}
```

- [ ] **Step 2: Write the scanner class**

```typescript
// src/store/recent-session-scanner.ts
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { logger } from '../utils/logger.js';
import { decodeProjectId } from './project-store.js';
import type { RecentSession } from '../types.js';

const MAX_CANDIDATES = 15;
const MAX_LINES_TO_READ = 20;
const MAX_DISPLAY = 5;
const PREVIEW_LENGTH = 50;

export class RecentSessionScanner {
  constructor(private readonly claudeProjectsDir: string) {}

  async scan(): Promise<RecentSession[]> {
    const candidates = this.collectCandidates();
    if (candidates.length === 0) return [];

    const sessions: RecentSession[] = [];
    for (const c of candidates) {
      const firstPrompt = await this.readFirstUserMessage(c.filePath);
      if (firstPrompt === null) continue;
      const parts = decodeProjectId(c.projectId).split('/').filter(Boolean);
      sessions.push({
        sessionId: c.sessionId,
        projectPath: parts.slice(-2).join('/') || c.projectId,
        mtime: c.mtime,
        firstPrompt,
        firstPromptPreview: firstPrompt.length > PREVIEW_LENGTH
          ? firstPrompt.slice(0, PREVIEW_LENGTH) + '...'
          : firstPrompt,
      });
    }

    return this.filterRecurring(sessions).slice(0, MAX_DISPLAY);
  }

  private collectCandidates(): Array<{
    filePath: string;
    sessionId: string;
    projectId: string;
    mtime: Date;
  }> {
    if (!fs.existsSync(this.claudeProjectsDir)) return [];

    const all: Array<{
      filePath: string;
      sessionId: string;
      projectId: string;
      mtime: Date;
    }> = [];

    try {
      const projectDirs = fs.readdirSync(this.claudeProjectsDir, { withFileTypes: true });
      for (const dir of projectDirs) {
        if (!dir.isDirectory()) continue;
        const projectDir = path.join(this.claudeProjectsDir, dir.name);
        try {
          const files = fs.readdirSync(projectDir);
          for (const f of files) {
            if (!f.endsWith('.jsonl')) continue;
            const filePath = path.join(projectDir, f);
            try {
              const stat = fs.statSync(filePath);
              all.push({
                filePath,
                sessionId: path.basename(f, '.jsonl'),
                projectId: dir.name,
                mtime: new Date(stat.mtimeMs),
              });
            } catch { /* skip unreadable files */ }
          }
        } catch { /* skip unreadable dirs */ }
      }
    } catch {
      return [];
    }

    all.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
    return all.slice(0, MAX_CANDIDATES);
  }

  private async readFirstUserMessage(filePath: string): Promise<string | null> {
    return new Promise((resolve) => {
      try {
        const stream = fs.createReadStream(filePath, { encoding: 'utf-8' });
        const rl = readline.createInterface({ input: stream });
        let lineCount = 0;

        rl.on('line', (line) => {
          lineCount++;
          if (lineCount > MAX_LINES_TO_READ) {
            rl.close();
            stream.destroy();
            return;
          }
          try {
            const entry = JSON.parse(line);
            if (entry.type === 'user' && entry.message?.role === 'user') {
              const content = entry.message.content;
              let text: string | null = null;
              if (typeof content === 'string') {
                text = content;
              } else if (Array.isArray(content)) {
                const textBlock = content.find((b: any) => b.type === 'text');
                text = textBlock?.text || null;
              }
              if (text) {
                rl.close();
                stream.destroy();
                resolve(text.replace(/\n/g, ' ').trim());
                return;
              }
            }
          } catch { /* skip unparseable lines */ }
        });

        rl.on('close', () => resolve(null));
        rl.on('error', () => resolve(null));
        stream.on('error', () => resolve(null));
      } catch {
        resolve(null);
      }
    });
  }

  private filterRecurring(sessions: RecentSession[]): RecentSession[] {
    const promptCounts = new Map<string, number>();
    for (const s of sessions) {
      promptCounts.set(s.firstPrompt, (promptCounts.get(s.firstPrompt) || 0) + 1);
    }
    return sessions.filter(s => (promptCounts.get(s.firstPrompt) || 0) < 2);
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add src/types.ts src/store/recent-session-scanner.ts
git commit -m "feat(recent-session-scanner): scan JSONL files across all projects with recurring filter"
```

---

## Chunk 3: Rewrite Block Builder and Home Tab Handler

### Task 4: Rewrite `buildHomeTabBlocks` in `src/slack/block-builder.ts`

**Files:**
- Modify: `src/slack/block-builder.ts:108-300`

- [ ] **Step 1: Replace HomeTabV2Params and buildHomeTabBlocks**

Replace the `HomeTabV2Params` interface and `buildHomeTabBlocks` function (lines 108-300) with the following. Note: `capitalize` (line 3) and `getTimeAgo` (line 7) remain unchanged at the top of the file — only the HomeTab-related code is replaced:

```typescript
export interface HomeTabParams {
  isActive: boolean;
  model: string;
  directoryId: string;
  directories: Array<{ id: string; name: string; path: string }>;
  recentSessions: Array<{
    timeAgo: string;
    firstPromptPreview: string;
    projectPath: string;
  }>;
}

export function buildHomeTabBlocks(params: HomeTabParams): Block[] {
  const { isActive, model, directoryId, directories, recentSessions } = params;

  const statusEmoji = isActive ? '🟢' : '🔴';
  const statusText = isActive ? 'Active' : 'Inactive';

  const blocks: Block[] = [
    // 1. Header
    {
      type: 'header',
      text: { type: 'plain_text', text: 'Claude Code Bridge' },
    },
    // 2. Status indicator
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `${statusEmoji} *${statusText}*` },
    },
    // 3. Dropdown labels (spacing is approximate — adjust during manual verification in Task 8)
    {
      type: 'context',
      elements: [
        { type: 'mrkdwn', text: '          *MODEL*                                              *DIRECTORY*' },
      ],
    },
    // 4. Dropdowns side-by-side
    {
      type: 'actions',
      elements: [
        {
          type: 'static_select',
          action_id: 'home_set_default_model',
          initial_option: {
            text: { type: 'plain_text', text: capitalize(model) },
            value: model,
          },
          options: [
            { text: { type: 'plain_text', text: 'Opus' }, value: 'opus' },
            { text: { type: 'plain_text', text: 'Sonnet' }, value: 'sonnet' },
            { text: { type: 'plain_text', text: 'Haiku' }, value: 'haiku' },
          ],
        },
        {
          type: 'static_select',
          action_id: 'home_set_directory',
          ...(directoryId && directories.find(d => d.id === directoryId) ? {
            initial_option: {
              text: { type: 'plain_text', text: directories.find(d => d.id === directoryId)!.name },
              value: directoryId,
            },
          } : {}),
          options: directories.length > 0
            ? directories.map(d => ({
                text: { type: 'plain_text', text: d.name || d.id },
                value: d.id,
              }))
            : [{ text: { type: 'plain_text', text: '~' }, value: 'home' }],
        },
      ],
    },
    // 5. Divider
    { type: 'divider' },
    // 6. Recent Sessions header
    {
      type: 'section',
      text: { type: 'mrkdwn', text: '*Recent Sessions*' },
    },
  ];

  // 7. Recent session entries
  if (recentSessions.length === 0) {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: '_No recent sessions_' }],
    });
  } else {
    for (const s of recentSessions) {
      blocks.push({
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: `${s.timeAgo} — ${s.firstPromptPreview}\n${s.projectPath}`,
          },
        ],
      });
    }
  }

  return blocks;
}
```

- [ ] **Step 2: Commit (note: compile will fail until Task 5 completes — home-tab.ts still references old interface)**

```bash
git add src/slack/block-builder.ts
git commit -m "feat(block-builder): rewrite home tab to status card + recent sessions layout"
```

### Task 5: Rewrite `HomeTabHandler` in `src/slack/home-tab.ts`

**Files:**
- Modify: `src/slack/home-tab.ts`

- [ ] **Step 1: Rewrite the handler**

Replace the entire file:

```typescript
// src/slack/home-tab.ts
import { buildHomeTabBlocks } from './block-builder.js';
import { getTimeAgo } from './block-builder.js';
import { logger } from '../utils/logger.js';
import type { Heartbeat } from '../heartbeat.js';
import type { RecentSessionScanner } from '../store/recent-session-scanner.js';

export class HomeTabHandler {
  constructor(
    private readonly client: any,
    private readonly userPrefStore: any,
    private readonly projectStore: any,
    private readonly heartbeat: Heartbeat,
    private readonly recentSessionScanner: RecentSessionScanner,
  ) {}

  async publishHomeTab(userId: string): Promise<void> {
    const prefs = this.userPrefStore.get(userId);
    const projects = this.projectStore.getProjects();
    const directories = projects
      .filter((p: any) => p.workingDirectory)
      .map((p: any) => {
        const parts = p.workingDirectory.split('/').filter(Boolean);
        const displayName = parts.slice(-2).join('/') || p.id;
        return {
          id: p.id,
          name: displayName.slice(0, 75),
          path: p.projectPath,
        };
      })
      .slice(0, 100);

    const isActive = this.heartbeat.isAlive();

    let recentSessions: Array<{
      timeAgo: string;
      firstPromptPreview: string;
      projectPath: string;
    }> = [];

    try {
      const scanned = await this.recentSessionScanner.scan();
      recentSessions = scanned.map(s => ({
        timeAgo: getTimeAgo(s.mtime),
        firstPromptPreview: s.firstPromptPreview,
        projectPath: s.projectPath,
      }));
    } catch (err) {
      logger.error('Failed to scan recent sessions', { error: (err as Error).message });
    }

    const blocks = buildHomeTabBlocks({
      isActive,
      model: prefs.defaultModel,
      directoryId: prefs.activeDirectoryId,
      directories,
      recentSessions,
    });

    try {
      await this.client.views.publish({
        user_id: userId,
        view: { type: 'home', blocks },
      });
    } catch (err) {
      logger.error('Failed to publish home tab', { error: (err as Error).message });
    }
  }
}
```

- [ ] **Step 2: Export `getTimeAgo` from block-builder.ts**

In `src/slack/block-builder.ts`, change `function getTimeAgo` (line 7) to:

```typescript
export function getTimeAgo(date: Date): string {
```

- [ ] **Step 3: Commit**

```bash
git add src/slack/home-tab.ts src/slack/block-builder.ts
git commit -m "feat(home-tab): rewrite handler with heartbeat status and recent sessions"
```

---

## Chunk 4: Update Default Preferences and Wire Everything

### Task 6: Update default model in `src/store/user-preference-store.ts`

**Files:**
- Modify: `src/store/user-preference-store.ts:8`

- [ ] **Step 1: Change default model from sonnet to opus**

Change line 8:

```typescript
const DEFAULT_PREFS: UserPreferences = { defaultModel: 'opus', activeDirectoryId: null };
```

- [ ] **Step 2: Commit**

```bash
git add src/store/user-preference-store.ts
git commit -m "feat(user-prefs): change default model from sonnet to opus"
```

### Task 7: Update `src/index.ts` wiring

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Add RecentSessionScanner import and initialization**

Add import:

```typescript
import { RecentSessionScanner } from './store/recent-session-scanner.js';
```

After the `sessionIndexStore` initialization (~line 60), add:

```typescript
const recentSessionScanner = new RecentSessionScanner(config.claudeProjectsDir);
```

- [ ] **Step 2: Update HomeTabHandler constructor**

Change the HomeTabHandler construction (~line 80) to remove `sessionIndexStore` and add `heartbeat` and `recentSessionScanner`:

```typescript
const homeTabHandler = new HomeTabHandler(app.client, userPrefStore, projectStore, heartbeat, recentSessionScanner);
```

- [ ] **Step 3: Remove obsolete action handlers**

Remove the `session_page_prev` and `session_page_next` action handlers (~lines 523-534). Also remove `open_session` handler (~lines 508-521) since Active Sessions section is removed. Note: `ActionHandler` requires no changes — it calls `publishHomeTab` which still exists with the same signature (minus the `page` param).

- [ ] **Step 4: Remove `page` parameter from `publishHomeTab` calls**

The `publishHomeTab` method no longer accepts a `page` parameter. Update the `app_home_opened` handler and any pagination-related calls. The `app_home_opened` handler (~line 469) should already work as-is since it doesn't pass a page parameter.

- [ ] **Step 5: Verify no compile errors**

Run: `npx tsc --noEmit`

- [ ] **Step 6: Commit**

```bash
git add src/index.ts
git commit -m "feat(index): wire RecentSessionScanner, update HomeTabHandler constructor, remove pagination handlers"
```

### Task 8: Manual verification

- [ ] **Step 1: Start the bridge**

```bash
npx tsx src/index.ts
```

- [ ] **Step 2: Verify in Slack**

1. Open the app's Home Tab in Slack
2. Verify: Header shows "Claude Code Bridge"
3. Verify: Status shows 🟢 Active
4. Verify: Model and Directory dropdowns appear side-by-side
5. Verify: Model defaults to Opus for new users
6. Verify: Recent Sessions shows up to 5 entries
7. Verify: Changing model/directory updates the home tab
8. Stop the bridge (Ctrl+C), reopen home tab → should show 🔴 Inactive

- [ ] **Step 3: Final commit if any fixes needed**

```bash
git add -A
git commit -m "fix(home-tab): adjustments from manual verification"
```
