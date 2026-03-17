# Phase 2 Redesign Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate from spawn-on-demand to persistent process model with reaction-based thread UX, command passthrough, and persistent stores.

**Architecture:** 1 session = 1 persistent process via `--input-format stream-json`. Anchor messages abolished — reactions (⏳→🧠→✅) indicate state. Commands pass through to CLI stdin. JSON file stores for preferences and session index. SessionCoordinator manages process lifecycle, queues, and crash recovery.

**Tech Stack:** TypeScript, Node.js 20+, @slack/bolt 4.6 (Socket Mode), Claude CLI (`--input-format stream-json --output-format stream-json`), Vitest, Winston

**Dependency Graph:**
```
2-C (永続ストア) ────────────┬─→ 2-D (Home Tab) ──→ 2-G (過去セッション復元)
                              │
2-A (永続プロセス基盤) ──────┼─→ 2-B (コマンド刷新) ──→ 2-E (スレッド体験)
                              │
                              └─→ 2-F (キュー)
```

**Parallel tracks:** 2-A and 2-C can start simultaneously.

---

## Chunk 1: Phase 2-A — Persistent Process Foundation

### Task 1: Add new types for persistent session

**Files:**
- Modify: `src/types.ts`
- Test: `tests/types.test.ts`

- [ ] **Step 1: Write type definition tests**

```typescript
// tests/types.test.ts — add new describe block
import { describe, it, expect } from 'vitest';

describe('SessionState type', () => {
  it('should accept all valid states', () => {
    const states: import('../src/types').SessionState[] = [
      'not_started', 'starting', 'idle', 'processing', 'ending', 'dead',
    ];
    expect(states).toHaveLength(6);
  });
});
```

- [ ] **Step 2: Add SessionState and related types to src/types.ts**

Add after the existing `SessionMetadata` interface:

```typescript
// --- Phase 2: Persistent Process Types ---

export type SessionState = 'not_started' | 'starting' | 'idle' | 'processing' | 'ending' | 'dead';

export interface SessionStartParams {
  sessionId: string;
  model: string;
  projectPath: string;
  budgetUsd: number;
  isResume: boolean;
}

export interface ControlMessage {
  type: 'control';
  subtype: 'set_model' | 'interrupt' | 'can_use_tool' | 'keep_alive' | 'set_permission_mode';
  [key: string]: unknown;
}

export interface UserMessage {
  type: 'user_message';
  content: string;
}

export type StdinMessage = ControlMessage | UserMessage;

export interface StreamEvent {
  type: 'assistant' | 'system' | 'user' | 'result';
  subtype?: string;
  [key: string]: unknown;
}

export interface ResultEvent extends StreamEvent {
  type: 'result';
  result?: string;
  total_cost_usd?: number;
  duration_ms?: number;
  usage?: { input_tokens: number; output_tokens: number };
  session_id?: string;
}

export interface SystemInitEvent extends StreamEvent {
  type: 'system';
  subtype: 'init';
  session_id?: string;
}
```

- [ ] **Step 3: Run tests**

Run: `npx vitest run tests/types.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/types.ts tests/types.test.ts
git commit -m "feat(phase2): add persistent session types (SessionState, StdinMessage, StreamEvent)"
```

---

### Task 2: Create PersistentSession class

**Files:**
- Create: `src/bridge/persistent-session.ts`
- Test: `tests/bridge/persistent-session.test.ts`

- [ ] **Step 1: Write failing tests for PersistentSession**

```typescript
// tests/bridge/persistent-session.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

// Mock child_process
vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

import { spawn } from 'node:child_process';
import { PersistentSession } from '../../src/bridge/persistent-session.js';

const mockedSpawn = vi.mocked(spawn);

function createMockProcess() {
  const proc = new EventEmitter() as any;
  proc.pid = 12345;
  proc.kill = vi.fn();
  proc.stdin = { write: vi.fn(), end: vi.fn(), destroyed: false };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  return proc;
}

describe('PersistentSession', () => {
  let session: PersistentSession;
  let mockProc: ReturnType<typeof createMockProcess>;

  beforeEach(() => {
    vi.useFakeTimers();
    mockProc = createMockProcess();
    mockedSpawn.mockReturnValue(mockProc as any);
    session = new PersistentSession({
      sessionId: 'test-session-id',
      model: 'sonnet',
      projectPath: '/tmp/test-project',
      budgetUsd: 1.0,
      isResume: false,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('starts in not_started state', () => {
    expect(session.state).toBe('not_started');
  });

  it('transitions to starting on spawn()', () => {
    session.spawn();
    expect(session.state).toBe('starting');
    expect(mockedSpawn).toHaveBeenCalledOnce();
  });

  it('spawns with correct CLI args', () => {
    session.spawn();
    const args = mockedSpawn.mock.calls[0][1] as string[];
    expect(args).toContain('-p');
    expect(args).toContain('--input-format');
    expect(args).toContain('stream-json');
    expect(args).toContain('--output-format');
    expect(args).toContain('stream-json');
    expect(args).toContain('--verbose');
    expect(args).toContain('--model');
    expect(args).toContain('sonnet');
    expect(args).toContain('--session-id');
    expect(args).toContain('test-session-id');
  });

  it('uses -r flag for resume', () => {
    const resumeSession = new PersistentSession({
      sessionId: 'resume-id',
      model: 'opus',
      projectPath: '/tmp/test',
      budgetUsd: 1.0,
      isResume: true,
    });
    resumeSession.spawn();
    const args = mockedSpawn.mock.calls[0][1] as string[];
    expect(args).toContain('-r');
    expect(args).toContain('resume-id');
    expect(args).not.toContain('--session-id');
  });

  it('transitions to idle on system init event', () => {
    session.spawn();
    const stateChanges: string[] = [];
    session.on('stateChange', (_from, to) => stateChanges.push(to));

    // Simulate system init JSON line
    mockProc.stdout.emit('data', Buffer.from(
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'test-session-id' }) + '\n'
    ));

    expect(session.state).toBe('idle');
    expect(stateChanges).toContain('idle');
  });

  it('transitions to processing on sendPrompt()', () => {
    session.spawn();
    mockProc.stdout.emit('data', Buffer.from(
      JSON.stringify({ type: 'system', subtype: 'init' }) + '\n'
    ));
    expect(session.state).toBe('idle');

    session.sendPrompt('Hello');
    expect(session.state).toBe('processing');
    expect(mockProc.stdin.write).toHaveBeenCalledWith(
      JSON.stringify({ type: 'user_message', content: 'Hello' }) + '\n'
    );
  });

  it('throws if sendPrompt called when not idle', () => {
    session.spawn();
    // Still in 'starting' state
    expect(() => session.sendPrompt('Hello')).toThrow();
  });

  it('transitions back to idle on result event', () => {
    session.spawn();
    mockProc.stdout.emit('data', Buffer.from(
      JSON.stringify({ type: 'system', subtype: 'init' }) + '\n'
    ));
    session.sendPrompt('Hello');
    expect(session.state).toBe('processing');

    mockProc.stdout.emit('data', Buffer.from(
      JSON.stringify({ type: 'result', result: 'Done', total_cost_usd: 0.01 }) + '\n'
    ));
    expect(session.state).toBe('idle');
  });

  it('emits message events for each JSON line', () => {
    session.spawn();
    const messages: any[] = [];
    session.on('message', (msg) => messages.push(msg));

    mockProc.stdout.emit('data', Buffer.from(
      JSON.stringify({ type: 'system', subtype: 'init' }) + '\n' +
      JSON.stringify({ type: 'assistant', subtype: 'text', text: 'Hi' }) + '\n'
    ));

    expect(messages).toHaveLength(2);
    expect(messages[0].type).toBe('system');
    expect(messages[1].type).toBe('assistant');
  });

  it('handles idle timeout', () => {
    session.spawn();
    mockProc.stdout.emit('data', Buffer.from(
      JSON.stringify({ type: 'system', subtype: 'init' }) + '\n'
    ));
    expect(session.state).toBe('idle');

    vi.advanceTimersByTime(10 * 60 * 1000); // 10 minutes
    expect(mockProc.stdin.end).toHaveBeenCalled();
    expect(session.state).toBe('ending');
  });

  it('resets idle timer on sendPrompt', () => {
    session.spawn();
    mockProc.stdout.emit('data', Buffer.from(
      JSON.stringify({ type: 'system', subtype: 'init' }) + '\n'
    ));

    vi.advanceTimersByTime(9 * 60 * 1000); // 9 minutes
    session.sendPrompt('Hello');
    vi.advanceTimersByTime(9 * 60 * 1000); // another 9 minutes
    // Should NOT have ended (timer was reset)
    expect(session.state).toBe('processing');
  });

  it('transitions to dead on process exit', () => {
    session.spawn();
    mockProc.emit('exit', 0, null);
    expect(session.state).toBe('dead');
  });

  it('transitions to dead on process crash', () => {
    session.spawn();
    mockProc.stdout.emit('data', Buffer.from(
      JSON.stringify({ type: 'system', subtype: 'init' }) + '\n'
    ));
    session.sendPrompt('Hello');

    const errors: Error[] = [];
    session.on('error', (err) => errors.push(err));
    mockProc.emit('exit', 1, null);

    expect(session.state).toBe('dead');
    expect(errors).toHaveLength(1);
  });

  it('end() closes stdin gracefully', () => {
    session.spawn();
    mockProc.stdout.emit('data', Buffer.from(
      JSON.stringify({ type: 'system', subtype: 'init' }) + '\n'
    ));
    session.end();
    expect(mockProc.stdin.end).toHaveBeenCalled();
    expect(session.state).toBe('ending');
  });

  it('kill() sends SIGTERM then SIGKILL after grace period', () => {
    session.spawn();
    session.kill();
    expect(mockProc.kill).toHaveBeenCalledWith('SIGTERM');

    vi.advanceTimersByTime(5000);
    expect(mockProc.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('sendControl() writes control message to stdin', () => {
    session.spawn();
    mockProc.stdout.emit('data', Buffer.from(
      JSON.stringify({ type: 'system', subtype: 'init' }) + '\n'
    ));

    session.sendControl({ type: 'control', subtype: 'set_model', model: 'opus' });
    expect(mockProc.stdin.write).toHaveBeenCalledWith(
      JSON.stringify({ type: 'control', subtype: 'set_model', model: 'opus' }) + '\n'
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/bridge/persistent-session.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement PersistentSession**

```typescript
// src/bridge/persistent-session.ts
import { EventEmitter } from 'node:events';
import { spawn, type ChildProcess } from 'node:child_process';
import { logger } from '../utils/logger.js';
import type {
  SessionStartParams,
  SessionState,
  StdinMessage,
  ControlMessage,
  StreamEvent,
} from '../types.js';

const IDLE_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
const KILL_GRACE_MS = 5_000;

export class PersistentSession extends EventEmitter {
  readonly sessionId: string;
  private _state: SessionState = 'not_started';
  private process: ChildProcess | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private killTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly params: SessionStartParams;
  private stdoutBuffer = '';

  constructor(params: SessionStartParams) {
    super();
    this.sessionId = params.sessionId;
    this.params = params;
  }

  get state(): SessionState {
    return this._state;
  }

  spawn(): void {
    if (this._state !== 'not_started' && this._state !== 'dead') {
      throw new Error(`Cannot spawn in state: ${this._state}`);
    }
    this.transition('starting');

    const executable = process.env.CLAUDE_EXECUTABLE || 'claude';
    const args = this.buildArgs();

    logger.info(`Spawning persistent session ${this.sessionId}`, { args: args.join(' ') });

    this.process = spawn(executable, args, {
      cwd: this.params.projectPath,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    this.process.stdout!.on('data', (chunk: Buffer) => this.handleStdout(chunk));
    this.process.stderr!.on('data', (chunk: Buffer) => {
      logger.debug(`[${this.sessionId}] stderr: ${chunk.toString()}`);
    });
    this.process.on('exit', (code, signal) => this.handleExit(code, signal));
    this.process.on('error', (err) => this.handleProcessError(err));
  }

  sendPrompt(prompt: string): void {
    if (this._state !== 'idle') {
      throw new Error(`Cannot send prompt in state: ${this._state}`);
    }
    this.clearIdleTimer();
    this.writeStdin({ type: 'user_message', content: prompt });
    this.transition('processing');
  }

  sendControl(msg: ControlMessage): void {
    if (!this.process || this.process.stdin!.destroyed) {
      logger.warn(`Cannot send control to ${this.sessionId}: no active process`);
      return;
    }
    this.writeStdin(msg);
  }

  end(): void {
    if (this._state === 'dead' || this._state === 'ending' || this._state === 'not_started') {
      return;
    }
    this.clearIdleTimer();
    this.transition('ending');
    if (this.process && !this.process.stdin!.destroyed) {
      this.process.stdin!.end();
    }
  }

  kill(): void {
    if (!this.process) return;
    this.clearIdleTimer();
    this.process.kill('SIGTERM');
    this.killTimer = setTimeout(() => {
      if (this.process) {
        this.process.kill('SIGKILL');
      }
    }, KILL_GRACE_MS);
  }

  private buildArgs(): string[] {
    const args = [
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--model', this.params.model,
      '--max-budget-usd', String(this.params.budgetUsd),
    ];

    if (this.params.isResume) {
      args.push('-r', this.params.sessionId);
    } else {
      args.push('--session-id', this.params.sessionId);
    }

    return args;
  }

  private writeStdin(msg: StdinMessage): void {
    if (this.process && !this.process.stdin!.destroyed) {
      this.process.stdin!.write(JSON.stringify(msg) + '\n');
    }
  }

  private handleStdout(chunk: Buffer): void {
    this.stdoutBuffer += chunk.toString();
    const lines = this.stdoutBuffer.split('\n');
    this.stdoutBuffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const event: StreamEvent = JSON.parse(line);
        this.handleEvent(event);
      } catch {
        logger.debug(`[${this.sessionId}] non-JSON stdout: ${line}`);
      }
    }
  }

  private handleEvent(event: StreamEvent): void {
    this.emit('message', event);

    if (event.type === 'system' && event.subtype === 'init') {
      this.transition('idle');
      this.startIdleTimer();
    } else if (event.type === 'result') {
      this.transition('idle');
      this.startIdleTimer();
    }
  }

  private handleExit(code: number | null, signal: string | null): void {
    if (this.killTimer) {
      clearTimeout(this.killTimer);
      this.killTimer = null;
    }
    this.clearIdleTimer();

    const wasProcessing = this._state === 'processing';
    this.transition('dead');

    if (wasProcessing || (code !== null && code !== 0)) {
      this.emit('error', new Error(
        `Process exited unexpectedly: code=${code}, signal=${signal}`
      ));
    }

    this.process = null;
  }

  private handleProcessError(err: Error): void {
    logger.error(`[${this.sessionId}] process error`, { error: err.message });
    this.emit('error', err);
  }

  private transition(to: SessionState): void {
    const from = this._state;
    this._state = to;
    this.emit('stateChange', from, to);
    logger.debug(`[${this.sessionId}] ${from} → ${to}`);
  }

  private startIdleTimer(): void {
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      logger.info(`[${this.sessionId}] idle timeout — ending session`);
      this.end();
    }, IDLE_TIMEOUT_MS);
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/bridge/persistent-session.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add src/bridge/persistent-session.ts tests/bridge/persistent-session.test.ts
git commit -m "feat(phase2-A): PersistentSession with state machine, idle timeout, crash detection"
```

---

### Task 3: Add --replay-user-messages flag and update executor

**Files:**
- Modify: `src/bridge/executor.ts`
- Modify: `tests/bridge/executor.test.ts`

- [ ] **Step 1: Write test for replay flag in buildClaudeArgs**

Add test to `tests/bridge/executor.test.ts`:

```typescript
describe('buildClaudeArgs with replay flag', () => {
  it('includes --replay-user-messages when specified', () => {
    const args = buildClaudeArgs(
      { sessionId: 'sid', model: 'sonnet', projectPath: '/tmp' } as any,
      false,
      { replayUserMessages: true }
    );
    expect(args).toContain('--replay-user-messages');
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `npx vitest run tests/bridge/executor.test.ts`
Expected: FAIL

- [ ] **Step 3: Add replayUserMessages option to buildClaudeArgs**

In `src/bridge/executor.ts`, add `replayUserMessages?: boolean` to the options parameter of `buildClaudeArgs()`, and push `'--replay-user-messages'` to args when true.

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/bridge/executor.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/bridge/executor.ts tests/bridge/executor.test.ts
git commit -m "feat(phase2-A): add --replay-user-messages support to buildClaudeArgs"
```

---

## Chunk 2: Phase 2-C — Persistent Stores (parallel with 2-A)

### Task 4: Create UserPreferenceStore

**Files:**
- Create: `src/store/user-preference-store.ts`
- Test: `tests/store/user-preference-store.test.ts`
- Modify: `src/types.ts` (add UserPreferences type)

- [ ] **Step 1: Add UserPreferences type to src/types.ts**

```typescript
// Add to src/types.ts
export interface UserPreferences {
  defaultModel: string;
  activeDirectoryId: string | null;
}

export interface UserPreferenceFile {
  version: 1;
  users: Record<string, UserPreferences>;
}
```

- [ ] **Step 2: Write failing tests**

```typescript
// tests/store/user-preference-store.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { UserPreferenceStore } from '../../src/store/user-preference-store.js';

describe('UserPreferenceStore', () => {
  let store: UserPreferenceStore;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ups-test-'));
    store = new UserPreferenceStore(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns defaults for unknown user', () => {
    const prefs = store.get('U_UNKNOWN');
    expect(prefs.defaultModel).toBe('sonnet');
    expect(prefs.activeDirectoryId).toBeNull();
  });

  it('saves and retrieves model preference', () => {
    store.setModel('U001', 'opus');
    expect(store.get('U001').defaultModel).toBe('opus');
  });

  it('saves and retrieves directory preference', () => {
    store.setDirectory('U001', 'dir-123');
    expect(store.get('U001').activeDirectoryId).toBe('dir-123');
  });

  it('persists across instances', () => {
    store.setModel('U001', 'haiku');
    const store2 = new UserPreferenceStore(tmpDir);
    expect(store2.get('U001').defaultModel).toBe('haiku');
  });

  it('handles concurrent updates to different users', () => {
    store.setModel('U001', 'opus');
    store.setModel('U002', 'haiku');
    expect(store.get('U001').defaultModel).toBe('opus');
    expect(store.get('U002').defaultModel).toBe('haiku');
  });
});
```

- [ ] **Step 3: Run tests to verify failure**

Run: `npx vitest run tests/store/user-preference-store.test.ts`
Expected: FAIL

- [ ] **Step 4: Implement UserPreferenceStore**

```typescript
// src/store/user-preference-store.ts
import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../utils/logger.js';
import type { UserPreferences, UserPreferenceFile } from '../types.js';

const FILE_NAME = 'user-preferences.json';
const DEFAULT_PREFS: UserPreferences = { defaultModel: 'sonnet', activeDirectoryId: null };

export class UserPreferenceStore {
  private readonly filePath: string;
  private data: UserPreferenceFile;

  constructor(dataDir: string) {
    this.filePath = path.join(dataDir, FILE_NAME);
    this.data = this.load();
  }

  get(userId: string): UserPreferences {
    return this.data.users[userId] ?? { ...DEFAULT_PREFS };
  }

  setModel(userId: string, model: string): void {
    this.ensureUser(userId);
    this.data.users[userId].defaultModel = model;
    this.save();
  }

  setDirectory(userId: string, directoryId: string | null): void {
    this.ensureUser(userId);
    this.data.users[userId].activeDirectoryId = directoryId;
    this.save();
  }

  private ensureUser(userId: string): void {
    if (!this.data.users[userId]) {
      this.data.users[userId] = { ...DEFAULT_PREFS };
    }
  }

  private load(): UserPreferenceFile {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf-8');
      return JSON.parse(raw) as UserPreferenceFile;
    } catch {
      return { version: 1, users: {} };
    }
  }

  private save(): void {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = this.filePath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.filePath);
  }
}
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run tests/store/user-preference-store.test.ts`
Expected: ALL PASS

- [ ] **Step 6: Commit**

```bash
git add src/store/user-preference-store.ts tests/store/user-preference-store.test.ts src/types.ts
git commit -m "feat(phase2-C): UserPreferenceStore with atomic JSON file persistence"
```

---

### Task 5: Create SessionIndexStore

**Files:**
- Create: `src/store/session-index-store.ts`
- Test: `tests/store/session-index-store.test.ts`
- Modify: `src/types.ts` (add SessionIndexEntry type)

- [ ] **Step 1: Add SessionIndexEntry type to src/types.ts**

```typescript
export interface SessionIndexEntry {
  cliSessionId: string;
  threadTs: string;
  channelId: string;
  userId: string;
  projectPath: string;
  name: string;
  model: string;
  status: 'active' | 'ended';
  createdAt: string; // ISO
  lastActiveAt: string; // ISO
}

export interface SessionIndexFile {
  version: 1;
  sessions: Record<string, SessionIndexEntry>; // keyed by cliSessionId
}
```

- [ ] **Step 2: Write failing tests**

```typescript
// tests/store/session-index-store.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SessionIndexStore } from '../../src/store/session-index-store.js';

describe('SessionIndexStore', () => {
  let store: SessionIndexStore;
  let tmpDir: string;

  const entry = {
    cliSessionId: 'cli-001',
    threadTs: '1234567890.000001',
    channelId: 'C001',
    userId: 'U001',
    projectPath: '/home/user/myapp',
    name: 'test-session',
    model: 'sonnet',
    status: 'active' as const,
    createdAt: new Date().toISOString(),
    lastActiveAt: new Date().toISOString(),
  };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sis-test-'));
    store = new SessionIndexStore(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('registers and retrieves a session', () => {
    store.register(entry);
    expect(store.get('cli-001')).toMatchObject({ cliSessionId: 'cli-001' });
  });

  it('finds session by threadTs', () => {
    store.register(entry);
    const found = store.findByThreadTs('1234567890.000001');
    expect(found?.cliSessionId).toBe('cli-001');
  });

  it('returns undefined for unknown threadTs', () => {
    expect(store.findByThreadTs('unknown')).toBeUndefined();
  });

  it('lists sessions by directory', () => {
    store.register(entry);
    store.register({ ...entry, cliSessionId: 'cli-002', threadTs: '999', projectPath: '/other' });
    const results = store.listByDirectory('/home/user/myapp');
    expect(results).toHaveLength(1);
    expect(results[0].cliSessionId).toBe('cli-001');
  });

  it('updates session fields', () => {
    store.register(entry);
    store.update('cli-001', { status: 'ended', name: 'renamed' });
    expect(store.get('cli-001')?.status).toBe('ended');
    expect(store.get('cli-001')?.name).toBe('renamed');
  });

  it('lists active and ended sessions separately', () => {
    store.register(entry);
    store.register({ ...entry, cliSessionId: 'cli-002', threadTs: '999', status: 'ended' });
    expect(store.getActive()).toHaveLength(1);
    expect(store.getEnded()).toHaveLength(1);
  });

  it('persists across instances', () => {
    store.register(entry);
    const store2 = new SessionIndexStore(tmpDir);
    expect(store2.get('cli-001')).toBeDefined();
  });
});
```

- [ ] **Step 3: Run tests to verify failure**

Run: `npx vitest run tests/store/session-index-store.test.ts`
Expected: FAIL

- [ ] **Step 4: Implement SessionIndexStore**

```typescript
// src/store/session-index-store.ts
import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../utils/logger.js';
import type { SessionIndexEntry, SessionIndexFile } from '../types.js';

const FILE_NAME = 'session-index.json';

export class SessionIndexStore {
  private readonly filePath: string;
  private data: SessionIndexFile;
  private threadIndex: Map<string, string>; // threadTs → cliSessionId

  constructor(dataDir: string) {
    this.filePath = path.join(dataDir, FILE_NAME);
    this.data = this.load();
    this.threadIndex = this.buildThreadIndex();
  }

  register(entry: SessionIndexEntry): void {
    this.data.sessions[entry.cliSessionId] = entry;
    this.threadIndex.set(entry.threadTs, entry.cliSessionId);
    this.save();
  }

  get(cliSessionId: string): SessionIndexEntry | undefined {
    return this.data.sessions[cliSessionId];
  }

  findByThreadTs(threadTs: string): SessionIndexEntry | undefined {
    const id = this.threadIndex.get(threadTs);
    return id ? this.data.sessions[id] : undefined;
  }

  update(cliSessionId: string, fields: Partial<Pick<SessionIndexEntry, 'status' | 'name' | 'model' | 'lastActiveAt'>>): void {
    const entry = this.data.sessions[cliSessionId];
    if (!entry) return;
    Object.assign(entry, fields);
    this.save();
  }

  listByDirectory(projectPath: string): SessionIndexEntry[] {
    return Object.values(this.data.sessions)
      .filter((e) => e.projectPath === projectPath)
      .sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt));
  }

  getActive(): SessionIndexEntry[] {
    return Object.values(this.data.sessions)
      .filter((e) => e.status === 'active')
      .sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt));
  }

  getEnded(limit = 20): SessionIndexEntry[] {
    return Object.values(this.data.sessions)
      .filter((e) => e.status === 'ended')
      .sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt))
      .slice(0, limit);
  }

  private buildThreadIndex(): Map<string, string> {
    const map = new Map<string, string>();
    for (const [id, entry] of Object.entries(this.data.sessions)) {
      map.set(entry.threadTs, id);
    }
    return map;
  }

  private load(): SessionIndexFile {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf-8');
      return JSON.parse(raw) as SessionIndexFile;
    } catch {
      return { version: 1, sessions: {} };
    }
  }

  private save(): void {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = this.filePath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.filePath);
  }
}
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run tests/store/session-index-store.test.ts`
Expected: ALL PASS

- [ ] **Step 6: Commit**

```bash
git add src/store/session-index-store.ts tests/store/session-index-store.test.ts src/types.ts
git commit -m "feat(phase2-C): SessionIndexStore with threadTs reverse lookup and directory scoping"
```

---

### Task 6: Add dataDir config and update config.ts

**Files:**
- Modify: `src/config.ts`
- Modify: `tests/config.test.ts`

- [ ] **Step 1: Write test for dataDir config**

Add to `tests/config.test.ts`:

```typescript
it('sets default dataDir to ~/.claude-slack-pipe/', () => {
  const config = loadConfig();
  expect(config.dataDir).toMatch(/\.claude-slack-pipe/);
});

it('reads DATA_DIR from env', () => {
  process.env.DATA_DIR = '/tmp/test-data';
  const config = loadConfig();
  expect(config.dataDir).toBe('/tmp/test-data');
  delete process.env.DATA_DIR;
});
```

- [ ] **Step 2: Add dataDir to config.ts Zod schema**

Add `dataDir` field with default `~/.claude-slack-pipe/` (with tilde expansion).

- [ ] **Step 3: Run tests**

Run: `npx vitest run tests/config.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/config.ts tests/config.test.ts
git commit -m "feat(phase2-C): add dataDir config for persistent stores"
```

---

## Chunk 3: Phase 2-B — Command Architecture Overhaul

### Task 7: Rewrite command-parser.ts for 3-category classification

**Files:**
- Modify: `src/slack/command-parser.ts`
- Modify: `tests/slack/command-parser.test.ts`

- [ ] **Step 1: Write new tests for 3-category parser**

Replace tests in `tests/slack/command-parser.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { parseCommand } from '../../src/slack/command-parser.js';

describe('parseCommand (phase2)', () => {
  describe('bot_command', () => {
    it('recognizes cc /end', () => {
      const result = parseCommand('cc /end');
      expect(result).toEqual({ type: 'bot_command', command: 'end', args: '' });
    });

    it('recognizes cc /status', () => {
      const result = parseCommand('cc /status');
      expect(result).toEqual({ type: 'bot_command', command: 'status', args: '' });
    });

    it('recognizes cc /restart', () => {
      const result = parseCommand('cc /restart');
      expect(result).toEqual({ type: 'bot_command', command: 'restart', args: '' });
    });

    it('recognizes cc /cli-status as cc /status alias', () => {
      const result = parseCommand('cc /cli-status');
      expect(result).toEqual({ type: 'bot_command', command: 'status', args: '' });
    });
  });

  describe('passthrough', () => {
    it('passes /compact through', () => {
      const result = parseCommand('/compact');
      expect(result).toEqual({ type: 'passthrough', content: '/compact' });
    });

    it('passes cc /compact through (strips cc prefix)', () => {
      const result = parseCommand('cc /compact');
      expect(result).toEqual({ type: 'passthrough', content: '/compact' });
    });

    it('passes /model opus through', () => {
      const result = parseCommand('/model opus');
      expect(result).toEqual({ type: 'passthrough', content: '/model opus' });
    });

    it('passes cc /commit through', () => {
      const result = parseCommand('cc /commit');
      expect(result).toEqual({ type: 'passthrough', content: '/commit' });
    });

    it('passes /help through', () => {
      const result = parseCommand('/help');
      expect(result).toEqual({ type: 'passthrough', content: '/help' });
    });

    it('passes /diff through', () => {
      const result = parseCommand('cc /diff');
      expect(result).toEqual({ type: 'passthrough', content: '/diff' });
    });
  });

  describe('plain_text', () => {
    it('classifies normal text', () => {
      const result = parseCommand('Fix the auth bug');
      expect(result).toEqual({ type: 'plain_text', content: 'Fix the auth bug' });
    });

    it('classifies empty string', () => {
      const result = parseCommand('');
      expect(result).toEqual({ type: 'plain_text', content: '' });
    });
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `npx vitest run tests/slack/command-parser.test.ts`
Expected: FAIL

- [ ] **Step 3: Rewrite command-parser.ts**

```typescript
// src/slack/command-parser.ts

const BOT_COMMANDS = new Set(['end', 'status', 'restart']);
const BOT_COMMAND_ALIASES: Record<string, string> = { 'cli-status': 'status' };

export type ParsedCommand =
  | { type: 'bot_command'; command: string; args: string }
  | { type: 'passthrough'; content: string }
  | { type: 'plain_text'; content: string };

export function parseCommand(input: string): ParsedCommand {
  const trimmed = input.trim();

  // Check for cc / prefix or bare / prefix
  const ccMatch = trimmed.match(/^cc\s+\/(\S+)\s*(.*)/);
  const bareMatch = trimmed.match(/^\/(\S+)\s*(.*)/);

  const match = ccMatch || bareMatch;
  if (!match) {
    return { type: 'plain_text', content: trimmed };
  }

  const rawCommand = match[1];
  const args = match[2].trim();

  // Resolve aliases
  const command = BOT_COMMAND_ALIASES[rawCommand] ?? rawCommand;

  // Bot-handled commands
  if (BOT_COMMANDS.has(command)) {
    return { type: 'bot_command', command, args };
  }

  // Everything else with a slash is passthrough to CLI
  const content = `/${rawCommand}${args ? ' ' + args : ''}`;
  return { type: 'passthrough', content };
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/slack/command-parser.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add src/slack/command-parser.ts tests/slack/command-parser.test.ts
git commit -m "feat(phase2-B): rewrite command parser — 3 categories (bot_command, passthrough, plain_text)"
```

---

### Task 8: Rewrite bridge-commands.ts for bot-only commands

**Files:**
- Modify: `src/slack/bridge-commands.ts`
- Modify: `tests/slack/bridge-commands.test.ts`

- [ ] **Step 1: Write failing tests for new BridgeCommandHandler**

```typescript
// tests/slack/bridge-commands.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BridgeCommandHandler } from '../../src/slack/bridge-commands.js';

describe('BridgeCommandHandler (phase2)', () => {
  let handler: BridgeCommandHandler;
  let mockClient: any;

  beforeEach(() => {
    mockClient = {
      chat: {
        postEphemeral: vi.fn().mockResolvedValue({ ok: true }),
      },
    };
    handler = new BridgeCommandHandler(mockClient);
  });

  describe('handleStatus', () => {
    it('posts ephemeral session status', async () => {
      await handler.handleStatus({
        channelId: 'C001',
        threadTs: '123',
        userId: 'U001',
        sessionInfo: {
          sessionId: 'sid',
          model: 'sonnet',
          projectPath: '/home/user/app',
          totalCost: 0.12,
          totalTokens: 18600,
          turnCount: 2,
          processState: 'idle',
          startedAt: '2026-03-16 10:00',
        },
      });
      expect(mockClient.chat.postEphemeral).toHaveBeenCalledOnce();
      const call = mockClient.chat.postEphemeral.mock.calls[0][0];
      expect(call.channel).toBe('C001');
      expect(call.user).toBe('U001');
      expect(call.text).toContain('sid');
    });
  });

  describe('handleEnd', () => {
    it('posts ephemeral end summary', async () => {
      const onEnd = vi.fn().mockResolvedValue(undefined);
      await handler.handleEnd({
        channelId: 'C001',
        threadTs: '123',
        userId: 'U001',
        sessionId: 'sid',
        totalCost: 0.423,
        totalTokens: 52400,
        turnCount: 4,
        duration: '45m',
        onEnd,
      });
      expect(onEnd).toHaveBeenCalled();
      expect(mockClient.chat.postEphemeral).toHaveBeenCalledOnce();
    });
  });

  describe('handleRestart', () => {
    it('calls onRestart callback', async () => {
      const onRestart = vi.fn().mockResolvedValue(undefined);
      await handler.handleRestart({
        channelId: 'C001',
        threadTs: '123',
        userId: 'U001',
        sessionId: 'sid',
        onRestart,
      });
      expect(onRestart).toHaveBeenCalled();
    });
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `npx vitest run tests/slack/bridge-commands.test.ts`
Expected: FAIL

- [ ] **Step 3: Rewrite bridge-commands.ts**

Implement `BridgeCommandHandler` with only 3 methods: `handleStatus()`, `handleEnd()`, `handleRestart()`. Remove all model/rename/panel/help handlers (model → control message, help → passthrough).

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/slack/bridge-commands.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add src/slack/bridge-commands.ts tests/slack/bridge-commands.test.ts
git commit -m "feat(phase2-B): rewrite bridge commands — status, end, restart only"
```

---

## Chunk 4: Phase 2-F — SessionCoordinator (Queue + Process Lifecycle)

### Task 9: Create MessageQueue

**Files:**
- Create: `src/bridge/message-queue.ts`
- Test: `tests/bridge/message-queue.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/bridge/message-queue.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MessageQueue } from '../../src/bridge/message-queue.js';

describe('MessageQueue', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('enqueues and dequeues FIFO', () => {
    const q = new MessageQueue(5);
    q.enqueue({ id: '1', prompt: 'a' });
    q.enqueue({ id: '2', prompt: 'b' });
    expect(q.dequeue()?.prompt).toBe('a');
    expect(q.dequeue()?.prompt).toBe('b');
  });

  it('reports size correctly', () => {
    const q = new MessageQueue(5);
    q.enqueue({ id: '1', prompt: 'a' });
    expect(q.size).toBe(1);
  });

  it('rejects when full', () => {
    const q = new MessageQueue(2);
    expect(q.enqueue({ id: '1', prompt: 'a' })).toBe(true);
    expect(q.enqueue({ id: '2', prompt: 'b' })).toBe(true);
    expect(q.enqueue({ id: '3', prompt: 'c' })).toBe(false);
  });

  it('expires entries after TTL', () => {
    const q = new MessageQueue(5, 5 * 60 * 1000); // 5min TTL
    q.enqueue({ id: '1', prompt: 'a' });
    vi.advanceTimersByTime(6 * 60 * 1000);
    expect(q.dequeue()).toBeUndefined();
  });

  it('isEmpty returns correct value', () => {
    const q = new MessageQueue(5);
    expect(q.isEmpty).toBe(true);
    q.enqueue({ id: '1', prompt: 'a' });
    expect(q.isEmpty).toBe(false);
  });
});
```

- [ ] **Step 2: Implement MessageQueue**

```typescript
// src/bridge/message-queue.ts
export interface QueuedMessage {
  id: string;
  prompt: string;
  enqueuedAt?: number;
}

export class MessageQueue {
  private queue: QueuedMessage[] = [];
  private readonly maxSize: number;
  private readonly ttlMs: number | null;

  constructor(maxSize: number, ttlMs: number | null = null) {
    this.maxSize = maxSize;
    this.ttlMs = ttlMs;
  }

  enqueue(msg: QueuedMessage): boolean {
    this.purgeExpired();
    if (this.queue.length >= this.maxSize) return false;
    msg.enqueuedAt = Date.now();
    this.queue.push(msg);
    return true;
  }

  dequeue(): QueuedMessage | undefined {
    this.purgeExpired();
    return this.queue.shift();
  }

  get size(): number {
    this.purgeExpired();
    return this.queue.length;
  }

  get isEmpty(): boolean {
    return this.size === 0;
  }

  private purgeExpired(): void {
    if (!this.ttlMs) return;
    const now = Date.now();
    this.queue = this.queue.filter((m) => now - (m.enqueuedAt ?? 0) < this.ttlMs!);
  }
}
```

- [ ] **Step 3: Run tests**

Run: `npx vitest run tests/bridge/message-queue.test.ts`
Expected: ALL PASS

- [ ] **Step 4: Commit**

```bash
git add src/bridge/message-queue.ts tests/bridge/message-queue.test.ts
git commit -m "feat(phase2-F): MessageQueue with FIFO, max size, TTL expiration"
```

---

### Task 10: Create SessionCoordinator

**Files:**
- Create: `src/bridge/session-coordinator.ts`
- Test: `tests/bridge/session-coordinator.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/bridge/session-coordinator.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { SessionCoordinator } from '../../src/bridge/session-coordinator.js';

// Mock PersistentSession
vi.mock('../../src/bridge/persistent-session.js', () => {
  return {
    PersistentSession: vi.fn().mockImplementation((params) => {
      const emitter = new EventEmitter() as any;
      emitter.sessionId = params.sessionId;
      emitter._state = 'not_started';
      Object.defineProperty(emitter, 'state', { get: () => emitter._state });
      emitter.spawn = vi.fn(() => {
        emitter._state = 'starting';
        // Simulate async init
        setTimeout(() => {
          emitter._state = 'idle';
          emitter.emit('stateChange', 'starting', 'idle');
        }, 10);
      });
      emitter.sendPrompt = vi.fn((prompt) => {
        emitter._state = 'processing';
        emitter.emit('stateChange', 'idle', 'processing');
      });
      emitter.sendControl = vi.fn();
      emitter.end = vi.fn(() => {
        emitter._state = 'ending';
        setTimeout(() => {
          emitter._state = 'dead';
          emitter.emit('stateChange', 'ending', 'dead');
        }, 10);
      });
      emitter.kill = vi.fn();
      return emitter;
    }),
  };
});

describe('SessionCoordinator', () => {
  let coordinator: SessionCoordinator;

  beforeEach(() => {
    vi.useFakeTimers();
    coordinator = new SessionCoordinator({
      maxAlivePerUser: 1,
      maxAliveGlobal: 3,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('creates and starts a session on first message', async () => {
    const session = await coordinator.getOrCreateSession({
      sessionId: 's1',
      userId: 'U001',
      model: 'sonnet',
      projectPath: '/tmp/test',
      budgetUsd: 1.0,
      isResume: false,
    });
    expect(session).toBeDefined();
    expect(session.spawn).toHaveBeenCalled();
  });

  it('returns existing session for same sessionId', async () => {
    const params = {
      sessionId: 's1',
      userId: 'U001',
      model: 'sonnet',
      projectPath: '/tmp/test',
      budgetUsd: 1.0,
      isResume: false,
    };
    const s1 = await coordinator.getOrCreateSession(params);
    const s2 = await coordinator.getOrCreateSession(params);
    expect(s1).toBe(s2);
  });

  it('ends previous session when user exceeds maxAlivePerUser', async () => {
    const s1 = await coordinator.getOrCreateSession({
      sessionId: 's1',
      userId: 'U001',
      model: 'sonnet',
      projectPath: '/tmp/test',
      budgetUsd: 1.0,
      isResume: false,
    });
    vi.advanceTimersByTime(20); // allow init

    const s2 = await coordinator.getOrCreateSession({
      sessionId: 's2',
      userId: 'U001',
      model: 'sonnet',
      projectPath: '/tmp/test2',
      budgetUsd: 1.0,
      isResume: false,
    });
    expect(s1.end).toHaveBeenCalled();
  });

  it('getAliveCount returns correct count', async () => {
    await coordinator.getOrCreateSession({
      sessionId: 's1',
      userId: 'U001',
      model: 'sonnet',
      projectPath: '/tmp/test',
      budgetUsd: 1.0,
      isResume: false,
    });
    expect(coordinator.getAliveCount()).toBe(1);
  });

  it('broadcasts control message to all alive sessions', async () => {
    const s1 = await coordinator.getOrCreateSession({
      sessionId: 's1',
      userId: 'U001',
      model: 'sonnet',
      projectPath: '/tmp/test',
      budgetUsd: 1.0,
      isResume: false,
    });
    coordinator.broadcastControl({ type: 'control', subtype: 'set_model', model: 'opus' });
    expect(s1.sendControl).toHaveBeenCalledWith({
      type: 'control', subtype: 'set_model', model: 'opus',
    });
  });
});
```

- [ ] **Step 2: Implement SessionCoordinator**

```typescript
// src/bridge/session-coordinator.ts
import { logger } from '../utils/logger.js';
import { PersistentSession } from './persistent-session.js';
import { MessageQueue, type QueuedMessage } from './message-queue.js';
import type { SessionStartParams, ControlMessage } from '../types.js';

interface CoordinatorConfig {
  maxAlivePerUser: number;
  maxAliveGlobal: number;
}

interface ManagedEntry {
  session: PersistentSession;
  userId: string;
  sessionQueue: MessageQueue; // per-session queue (max 5)
  crashCount: number;
}

export class SessionCoordinator {
  private readonly config: CoordinatorConfig;
  private readonly entries = new Map<string, ManagedEntry>();
  private readonly globalQueue = new MessageQueue(10, 5 * 60 * 1000);

  constructor(config: CoordinatorConfig) {
    this.config = config;
  }

  async getOrCreateSession(params: SessionStartParams & { userId: string }): Promise<PersistentSession> {
    // Return existing if alive
    const existing = this.entries.get(params.sessionId);
    if (existing && existing.session.state !== 'dead') {
      return existing.session;
    }

    // Enforce per-user limit — end oldest alive session for this user
    await this.enforceUserLimit(params.userId);

    const session = new PersistentSession(params);
    const entry: ManagedEntry = {
      session,
      userId: params.userId,
      sessionQueue: new MessageQueue(5),
      crashCount: 0,
    };

    this.entries.set(params.sessionId, entry);
    this.wireEvents(entry, params);
    session.spawn();

    return session;
  }

  getSession(sessionId: string): PersistentSession | undefined {
    return this.entries.get(sessionId)?.session;
  }

  getSessionQueue(sessionId: string): MessageQueue | undefined {
    return this.entries.get(sessionId)?.sessionQueue;
  }

  getAliveCount(): number {
    let count = 0;
    for (const entry of this.entries.values()) {
      if (entry.session.state !== 'dead' && entry.session.state !== 'not_started') {
        count++;
      }
    }
    return count;
  }

  getAliveCountForUser(userId: string): number {
    let count = 0;
    for (const entry of this.entries.values()) {
      if (entry.userId === userId && entry.session.state !== 'dead' && entry.session.state !== 'not_started') {
        count++;
      }
    }
    return count;
  }

  broadcastControl(msg: ControlMessage): void {
    for (const entry of this.entries.values()) {
      const s = entry.session.state;
      if (s !== 'dead' && s !== 'not_started' && s !== 'ending') {
        entry.session.sendControl(msg);
      }
    }
  }

  endSession(sessionId: string): void {
    const entry = this.entries.get(sessionId);
    if (entry) {
      entry.session.end();
    }
  }

  private async enforceUserLimit(userId: string): Promise<void> {
    const userSessions: ManagedEntry[] = [];
    for (const entry of this.entries.values()) {
      if (entry.userId === userId && entry.session.state !== 'dead' && entry.session.state !== 'not_started') {
        userSessions.push(entry);
      }
    }

    while (userSessions.length >= this.config.maxAlivePerUser) {
      const oldest = userSessions.shift()!;
      oldest.session.end();
    }
  }

  private wireEvents(entry: ManagedEntry, params: SessionStartParams & { userId: string }): void {
    const { session } = entry;

    session.on('stateChange', (from, to) => {
      if (to === 'idle' && !entry.sessionQueue.isEmpty) {
        const next = entry.sessionQueue.dequeue();
        if (next) {
          session.sendPrompt(next.prompt);
        }
      }

      if (to === 'dead' && from === 'processing') {
        entry.crashCount++;
        if (entry.crashCount <= 3) {
          const delay = Math.pow(2, entry.crashCount - 1) * 1000;
          logger.info(`Auto-respawn ${session.sessionId} in ${delay}ms (crash #${entry.crashCount})`);
          setTimeout(() => {
            session.spawn();
          }, delay);
        } else {
          logger.warn(`Session ${session.sessionId} exceeded crash limit (${entry.crashCount})`);
        }
      }

      // Reset crash counter on successful result
      if (to === 'idle' && from === 'processing') {
        entry.crashCount = 0;
      }
    });
  }
}
```

- [ ] **Step 3: Run tests**

Run: `npx vitest run tests/bridge/session-coordinator.test.ts`
Expected: ALL PASS

- [ ] **Step 4: Commit**

```bash
git add src/bridge/session-coordinator.ts tests/bridge/session-coordinator.test.ts
git commit -m "feat(phase2-F): SessionCoordinator with per-user limits, session queues, crash recovery"
```

---

## Chunk 5: Phase 2-E — Thread Experience Redesign

### Task 11: Update ReactionManager for new state flow

**Files:**
- Modify: `src/slack/reaction-manager.ts`
- Modify: `tests/slack/reaction-manager.test.ts`

- [ ] **Step 1: Write new tests for reaction lifecycle**

```typescript
// tests/slack/reaction-manager.test.ts — replace existing tests
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ReactionManager } from '../../src/slack/reaction-manager.js';

function createMockClient() {
  return {
    reactions: {
      add: vi.fn().mockResolvedValue({ ok: true }),
      remove: vi.fn().mockResolvedValue({ ok: true }),
    },
  };
}

describe('ReactionManager (phase2)', () => {
  let rm: ReactionManager;
  let client: ReturnType<typeof createMockClient>;

  beforeEach(() => {
    vi.useFakeTimers();
    client = createMockClient();
    rm = new ReactionManager(client as any);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('addSpawning', () => {
    it('adds hourglass_flowing_sand reaction', async () => {
      await rm.addSpawning('C001', '123');
      expect(client.reactions.add).toHaveBeenCalledWith({
        channel: 'C001', timestamp: '123', name: 'hourglass_flowing_sand',
      });
    });
  });

  describe('replaceWithProcessing', () => {
    it('removes hourglass and adds brain', async () => {
      await rm.replaceWithProcessing('C001', '123');
      expect(client.reactions.remove).toHaveBeenCalledWith({
        channel: 'C001', timestamp: '123', name: 'hourglass_flowing_sand',
      });
      expect(client.reactions.add).toHaveBeenCalledWith({
        channel: 'C001', timestamp: '123', name: 'brain',
      });
    });
  });

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

    it('auto-removes check mark after 3 seconds', async () => {
      await rm.replaceWithDone('C001', '123');
      vi.advanceTimersByTime(3000);
      // Should have called remove for white_check_mark
      expect(client.reactions.remove).toHaveBeenCalledWith({
        channel: 'C001', timestamp: '123', name: 'white_check_mark',
      });
    });
  });

  describe('addQueued', () => {
    it('adds hourglass_flowing_sand reaction', async () => {
      await rm.addQueued('C001', '123');
      expect(client.reactions.add).toHaveBeenCalledWith({
        channel: 'C001', timestamp: '123', name: 'hourglass_flowing_sand',
      });
    });
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `npx vitest run tests/slack/reaction-manager.test.ts`
Expected: FAIL — new methods not found

- [ ] **Step 3: Implement new reaction methods**

```typescript
// src/slack/reaction-manager.ts — rewrite
import type { WebClient } from '@slack/web-api';
import { logger } from '../utils/logger.js';

export class ReactionManager {
  constructor(private readonly client: WebClient) {}

  async addSpawning(channel: string, timestamp: string): Promise<void> {
    await this.safeAdd(channel, timestamp, 'hourglass_flowing_sand');
  }

  async replaceWithProcessing(channel: string, timestamp: string): Promise<void> {
    await this.safeRemove(channel, timestamp, 'hourglass_flowing_sand');
    await this.safeAdd(channel, timestamp, 'brain');
  }

  async replaceWithDone(channel: string, timestamp: string): Promise<void> {
    await this.safeRemove(channel, timestamp, 'brain');
    await this.safeAdd(channel, timestamp, 'white_check_mark');
    setTimeout(async () => {
      await this.safeRemove(channel, timestamp, 'white_check_mark');
    }, 3000);
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

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/slack/reaction-manager.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add src/slack/reaction-manager.ts tests/slack/reaction-manager.test.ts
git commit -m "feat(phase2-E): reaction lifecycle — ⏳ spawn → 🧠 processing → ✅ done (3s auto-remove)"
```

---

### Task 12: Add response footer, thread header, and streaming display builders

**Files:**
- Modify: `src/slack/block-builder.ts`
- Modify: `tests/slack/block-builder.test.ts`

- [ ] **Step 1: Write tests for buildResponseFooter, buildThreadHeaderText, and streaming blocks**

```typescript
// Add to tests/slack/block-builder.test.ts
import { buildResponseFooter, buildThreadHeaderText, buildStreamingBlocks } from '../../src/slack/block-builder.js';

describe('buildResponseFooter', () => {
  it('formats cost, tokens, model, and duration', () => {
    const blocks = buildResponseFooter({
      inputTokens: 1200,
      outputTokens: 3400,
      costUsd: 0.042,
      model: 'sonnet',
      durationMs: 12300,
    });
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe('context');
    const text = (blocks[0] as any).elements[0].text;
    expect(text).toContain('1.2k');
    expect(text).toContain('3.4k');
    expect(text).toContain('$0.042');
    expect(text).toContain('sonnet');
    expect(text).toContain('12.3s');
  });

  it('handles zero cost', () => {
    const blocks = buildResponseFooter({
      inputTokens: 0, outputTokens: 0, costUsd: 0, model: 'haiku', durationMs: 500,
    });
    expect(blocks).toHaveLength(1);
  });
});

describe('buildThreadHeaderText', () => {
  it('includes project dir basename, model, session ID', () => {
    const text = buildThreadHeaderText({
      projectPath: '/Users/alice/dev/myapp',
      model: 'sonnet',
      sessionId: 'abc12345',
    });
    expect(text).toContain('myapp');
    expect(text).toContain('sonnet');
    expect(text).toContain('abc12345');
  });
});

describe('buildStreamingBlocks', () => {
  it('builds blocks for partial assistant text', () => {
    const blocks = buildStreamingBlocks({ text: 'Thinking about...', isComplete: false });
    expect(blocks.length).toBeGreaterThan(0);
    const textBlock = blocks.find((b: any) => b.type === 'section');
    expect(textBlock).toBeDefined();
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `npx vitest run tests/slack/block-builder.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement builders**

```typescript
// Add to src/slack/block-builder.ts

function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function formatDuration(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

export function buildResponseFooter(params: {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  model: string;
  durationMs: number;
}): any[] {
  const text = `📊 ${formatTokens(params.inputTokens)}→${formatTokens(params.outputTokens)} tokens | $${params.costUsd.toFixed(3)} | ${params.model} | ${formatDuration(params.durationMs)}`;
  return [{
    type: 'context',
    elements: [{ type: 'mrkdwn', text }],
  }];
}

export function buildThreadHeaderText(params: {
  projectPath: string;
  model: string;
  sessionId: string;
}): string {
  const dirName = params.projectPath.split('/').pop() || params.projectPath;
  return `📋 Session Started\n📁 ${params.projectPath}\nModel: ${params.model} | Session: ${params.sessionId}`;
}

export function buildStreamingBlocks(params: {
  text: string;
  isComplete: boolean;
}): any[] {
  const blocks: any[] = [];
  if (params.text) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: params.text.slice(0, 3000) },
    });
  }
  if (!params.isComplete) {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: '⏳ _応答中..._' }],
    });
  }
  return blocks;
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/slack/block-builder.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/slack/block-builder.ts tests/slack/block-builder.test.ts
git commit -m "feat(phase2-E): response footer, thread header, streaming display builders"
```

---

### Task 13: Add interrupt via 🔴 reaction and permission prompt UI

**Files:**
- Modify: `src/index.ts` (add `reaction_added` handler)
- Create: `src/slack/permission-prompt.ts`
- Test: `tests/slack/permission-prompt.test.ts`

- [ ] **Step 1: Write tests for interrupt handler and permission prompt**

```typescript
// tests/slack/permission-prompt.test.ts
import { describe, it, expect, vi } from 'vitest';
import { buildPermissionPromptBlocks, parsePermissionAction } from '../../src/slack/permission-prompt.js';

describe('buildPermissionPromptBlocks', () => {
  it('builds blocks with tool name and Approve/Deny buttons', () => {
    const blocks = buildPermissionPromptBlocks({
      toolName: 'Bash',
      toolInput: { command: 'rm -rf node_modules && npm install' },
      toolUseId: 'toolu_123',
    });
    expect(blocks.length).toBeGreaterThan(0);
    const actionBlock = blocks.find((b: any) => b.type === 'actions');
    expect(actionBlock).toBeDefined();
    const buttons = (actionBlock as any).elements;
    expect(buttons).toHaveLength(2);
  });
});

describe('parsePermissionAction', () => {
  it('parses approve action', () => {
    const result = parsePermissionAction('approve:toolu_123');
    expect(result).toEqual({ toolUseId: 'toolu_123', allowed: true });
  });

  it('parses deny action', () => {
    const result = parsePermissionAction('deny:toolu_123');
    expect(result).toEqual({ toolUseId: 'toolu_123', allowed: false });
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `npx vitest run tests/slack/permission-prompt.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement permission-prompt.ts**

```typescript
// src/slack/permission-prompt.ts
export function buildPermissionPromptBlocks(params: {
  toolName: string;
  toolInput: Record<string, unknown>;
  toolUseId: string;
}): any[] {
  const inputPreview = JSON.stringify(params.toolInput).slice(0, 200);
  return [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `🔧 *${params.toolName}* を実行しようとしています\n> \`${inputPreview}\`` },
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: '✅ Approve' },
          action_id: 'permission_approve',
          value: `approve:${params.toolUseId}`,
          style: 'primary',
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: '❌ Deny' },
          action_id: 'permission_deny',
          value: `deny:${params.toolUseId}`,
          style: 'danger',
        },
      ],
    },
  ];
}

export function parsePermissionAction(value: string): { toolUseId: string; allowed: boolean } {
  const [action, toolUseId] = value.split(':');
  return { toolUseId, allowed: action === 'approve' };
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/slack/permission-prompt.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add src/slack/permission-prompt.ts tests/slack/permission-prompt.test.ts
git commit -m "feat(phase2-E): permission prompt UI (Approve/Deny) + 🔴 interrupt support"
```

Note: The `reaction_added` handler for 🔴 and the `permission_approve`/`permission_deny` action handlers are wired in Task 18 (Integration).

---

## Chunk 6: Phase 2-D — Home Tab Redesign

### Task 14: Rewrite Home Tab block builders

**Files:**
- Modify: `src/slack/block-builder.ts`
- Modify: `tests/slack/block-builder.test.ts`

- [ ] **Step 1: Write tests for new buildHomeTabBlocks**

```typescript
// Add to tests/slack/block-builder.test.ts
import { buildHomeTabBlocks } from '../../src/slack/block-builder.js';

describe('buildHomeTabBlocks (phase2)', () => {
  const defaultParams = {
    model: 'sonnet',
    directoryId: 'myapp',
    directories: [
      { id: 'myapp', name: 'myapp', path: '/home/user/myapp' },
      { id: 'other', name: 'other', path: '/home/user/other' },
    ],
    activeSessions: [
      { cliSessionId: 's1', name: 'fix-auth-bug', lastActiveAt: '2026-03-16T10:00:00Z', model: 'sonnet', status: 'active' as const },
    ],
    endedSessions: [
      { cliSessionId: 's2', name: 'refactor-api', lastActiveAt: '2026-03-16T08:00:00Z', model: 'opus', status: 'ended' as const },
    ],
    page: 0,
    totalPages: 1,
  };

  it('includes header section', () => {
    const blocks = buildHomeTabBlocks(defaultParams);
    const header = blocks.find((b: any) => b.type === 'header');
    expect(header).toBeDefined();
  });

  it('includes model static_select', () => {
    const blocks = buildHomeTabBlocks(defaultParams);
    const modelSection = blocks.find((b: any) =>
      b.accessory?.action_id === 'home_set_default_model'
    );
    expect(modelSection).toBeDefined();
  });

  it('includes directory static_select', () => {
    const blocks = buildHomeTabBlocks(defaultParams);
    const dirSection = blocks.find((b: any) =>
      b.accessory?.action_id === 'home_set_directory'
    );
    expect(dirSection).toBeDefined();
  });

  it('includes usage guide section', () => {
    const blocks = buildHomeTabBlocks(defaultParams);
    const guideBlock = blocks.find((b: any) =>
      b.text?.text?.includes('Usage Guide')
    );
    expect(guideBlock).toBeDefined();
  });

  it('includes active session with Open button', () => {
    const blocks = buildHomeTabBlocks(defaultParams);
    const sessionBlock = blocks.find((b: any) =>
      b.text?.text?.includes('fix-auth-bug')
    );
    expect(sessionBlock).toBeDefined();
  });

  it('includes ended session', () => {
    const blocks = buildHomeTabBlocks(defaultParams);
    const endedBlock = blocks.find((b: any) =>
      b.text?.text?.includes('refactor-api')
    );
    expect(endedBlock).toBeDefined();
  });

  it('stays within 100 block limit', () => {
    const blocks = buildHomeTabBlocks(defaultParams);
    expect(blocks.length).toBeLessThanOrEqual(100);
  });

  it('includes pagination when totalPages > 1', () => {
    const blocks = buildHomeTabBlocks({ ...defaultParams, totalPages: 3, page: 1 });
    const paginationBlock = blocks.find((b: any) =>
      b.elements?.some((e: any) => e.action_id === 'session_page_next')
    );
    expect(paginationBlock).toBeDefined();
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `npx vitest run tests/slack/block-builder.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement buildHomeTabBlocks**

Layout: header → status bar (model + dir) → settings (model dropdown, directory dropdown) → usage guide → divider → active sessions (with Open button) → divider → ended sessions → pagination.

Block budget: fixed 13 + sessions 20/page + pagination 1 = 34/100.

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/slack/block-builder.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/slack/block-builder.ts tests/slack/block-builder.test.ts
git commit -m "feat(phase2-D): Home Tab block builders — settings, guide, session list, pagination"
```

---

### Task 15: Rewrite HomeTabHandler with stores and action handlers

**Files:**
- Modify: `src/slack/home-tab.ts`
- Create: `src/slack/action-handler.ts`
- Modify: `tests/slack/home-tab.test.ts`
- Create: `tests/slack/action-handler.test.ts`

- [ ] **Step 1: Write tests for HomeTabHandler**

```typescript
// tests/slack/home-tab.test.ts — rewrite
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HomeTabHandler } from '../../src/slack/home-tab.js';

describe('HomeTabHandler (phase2)', () => {
  let handler: HomeTabHandler;
  let mockClient: any;
  let mockUserPrefStore: any;
  let mockSessionIndexStore: any;
  let mockProjectStore: any;

  beforeEach(() => {
    mockClient = { views: { publish: vi.fn().mockResolvedValue({ ok: true }) } };
    mockUserPrefStore = {
      get: vi.fn().mockReturnValue({ defaultModel: 'sonnet', activeDirectoryId: null }),
    };
    mockSessionIndexStore = {
      getActive: vi.fn().mockReturnValue([]),
      getEnded: vi.fn().mockReturnValue([]),
      listByDirectory: vi.fn().mockReturnValue([]),
    };
    mockProjectStore = {
      getProjects: vi.fn().mockReturnValue([
        { name: 'myapp', path: '/home/user/myapp' },
      ]),
    };
    handler = new HomeTabHandler(mockClient, mockUserPrefStore, mockSessionIndexStore, mockProjectStore);
  });

  it('publishes home tab with correct user preferences', async () => {
    await handler.publishHomeTab('U001');
    expect(mockClient.views.publish).toHaveBeenCalledOnce();
    expect(mockUserPrefStore.get).toHaveBeenCalledWith('U001');
  });

  it('filters sessions by active directory', async () => {
    mockUserPrefStore.get.mockReturnValue({ defaultModel: 'sonnet', activeDirectoryId: 'myapp' });
    await handler.publishHomeTab('U001');
    expect(mockSessionIndexStore.listByDirectory).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Write tests for ActionHandler**

```typescript
// tests/slack/action-handler.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ActionHandler } from '../../src/slack/action-handler.js';

describe('ActionHandler', () => {
  let handler: ActionHandler;
  let mockUserPrefStore: any;
  let mockCoordinator: any;
  let mockHomeTab: any;

  beforeEach(() => {
    mockUserPrefStore = {
      setModel: vi.fn(),
      setDirectory: vi.fn(),
    };
    mockCoordinator = {
      broadcastControl: vi.fn(),
    };
    mockHomeTab = {
      publishHomeTab: vi.fn().mockResolvedValue(undefined),
    };
    handler = new ActionHandler(mockUserPrefStore, mockCoordinator, mockHomeTab);
  });

  describe('handleSetDefaultModel', () => {
    it('updates preference and broadcasts to alive sessions', async () => {
      await handler.handleSetDefaultModel('U001', 'opus');
      expect(mockUserPrefStore.setModel).toHaveBeenCalledWith('U001', 'opus');
      expect(mockCoordinator.broadcastControl).toHaveBeenCalledWith({
        type: 'control', subtype: 'set_model', model: 'opus',
      });
      expect(mockHomeTab.publishHomeTab).toHaveBeenCalledWith('U001');
    });
  });

  describe('handleSetDirectory', () => {
    it('updates preference and refreshes home tab', async () => {
      await handler.handleSetDirectory('U001', 'dir-123');
      expect(mockUserPrefStore.setDirectory).toHaveBeenCalledWith('U001', 'dir-123');
      expect(mockHomeTab.publishHomeTab).toHaveBeenCalledWith('U001');
    });
  });
});
```

- [ ] **Step 3: Run tests to verify failure**

Run: `npx vitest run tests/slack/home-tab.test.ts tests/slack/action-handler.test.ts`
Expected: FAIL

- [ ] **Step 4: Implement HomeTabHandler with store integration**

Rewrite `src/slack/home-tab.ts` to accept UserPreferenceStore, SessionIndexStore, ProjectStore. Build blocks via `buildHomeTabBlocks()` with user prefs and filtered sessions.

- [ ] **Step 5: Implement ActionHandler**

```typescript
// src/slack/action-handler.ts
import type { UserPreferenceStore } from '../store/user-preference-store.js';
import type { SessionCoordinator } from '../bridge/session-coordinator.js';
import type { HomeTabHandler } from './home-tab.js';

export class ActionHandler {
  constructor(
    private readonly userPrefStore: UserPreferenceStore,
    private readonly coordinator: SessionCoordinator,
    private readonly homeTab: HomeTabHandler,
  ) {}

  async handleSetDefaultModel(userId: string, model: string): Promise<void> {
    this.userPrefStore.setModel(userId, model);
    this.coordinator.broadcastControl({ type: 'control', subtype: 'set_model', model });
    await this.homeTab.publishHomeTab(userId);
  }

  async handleSetDirectory(userId: string, directoryId: string): Promise<void> {
    this.userPrefStore.setDirectory(userId, directoryId);
    await this.homeTab.publishHomeTab(userId);
  }
}
```

- [ ] **Step 6: Run tests**

Run: `npx vitest run tests/slack/home-tab.test.ts tests/slack/action-handler.test.ts`
Expected: ALL PASS

- [ ] **Step 7: Commit**

```bash
git add src/slack/home-tab.ts src/slack/action-handler.ts tests/slack/home-tab.test.ts tests/slack/action-handler.test.ts
git commit -m "feat(phase2-D): Home Tab handler + ActionHandler — model/directory selection, session list"
```

---

## Chunk 7: Phase 2-G — History Restoration

### Task 16: Create HistoryPoster

**Files:**
- Create: `src/bridge/history-poster.ts`
- Test: `tests/bridge/history-poster.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/bridge/history-poster.test.ts
import { describe, it, expect, vi } from 'vitest';
import { parseTurnsFromJsonl, formatTurnForSlack } from '../../src/bridge/history-poster.js';

describe('parseTurnsFromJsonl', () => {
  it('extracts user and assistant turns', () => {
    const lines = [
      JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: 'Hello' }] } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Hi there' }] } }),
    ].join('\n');

    const turns = parseTurnsFromJsonl(lines);
    expect(turns).toHaveLength(1);
    expect(turns[0].userText).toBe('Hello');
    expect(turns[0].assistantText).toBe('Hi there');
  });

  it('limits to 15 most recent turns', () => {
    const lines: string[] = [];
    for (let i = 0; i < 20; i++) {
      lines.push(JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: `Q${i}` }] } }));
      lines.push(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: `A${i}` }] } }));
    }
    const turns = parseTurnsFromJsonl(lines.join('\n'));
    expect(turns).toHaveLength(15);
    expect(turns[0].userText).toBe('Q5'); // Skips first 5
  });

  it('summarizes tool use as one-liner', () => {
    const lines = [
      JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: 'Read file' }] } }),
      JSON.stringify({ type: 'assistant', message: { content: [
        { type: 'tool_use', name: 'Read', input: { file_path: 'src/index.ts' } },
        { type: 'text', text: 'Here is the file' },
      ] } }),
    ].join('\n');

    const turns = parseTurnsFromJsonl(lines);
    expect(turns[0].assistantText).toContain('Read');
    expect(turns[0].assistantText).toContain('src/index.ts');
  });

  it('skips malformed JSON lines', () => {
    const lines = [
      'not json',
      JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: 'Hello' }] } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Hi' }] } }),
    ].join('\n');
    const turns = parseTurnsFromJsonl(lines);
    expect(turns).toHaveLength(1);
  });

  it('returns empty array for empty input', () => {
    expect(parseTurnsFromJsonl('')).toHaveLength(0);
  });
});

describe('formatTurnForSlack', () => {
  it('bundles user and assistant into single message', () => {
    const text = formatTurnForSlack({
      userText: 'Fix the bug',
      assistantText: 'I fixed auth.ts',
      turnIndex: 0,
    });
    expect(text).toContain('Fix the bug');
    expect(text).toContain('I fixed auth.ts');
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `npx vitest run tests/bridge/history-poster.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement HistoryPoster**

```typescript
// src/bridge/history-poster.ts
import { logger } from '../utils/logger.js';

export interface Turn {
  userText: string;
  assistantText: string;
}

const MAX_TURNS = 15;

export function parseTurnsFromJsonl(content: string): Turn[] {
  const lines = content.split('\n').filter(Boolean);
  const turns: Turn[] = [];
  let currentUser: string | null = null;

  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (entry.type === 'user') {
        currentUser = extractText(entry.message?.content);
      } else if (entry.type === 'assistant' && currentUser !== null) {
        const assistantText = extractAssistantText(entry.message?.content);
        turns.push({ userText: currentUser, assistantText });
        currentUser = null;
      }
    } catch {
      // Skip malformed lines
    }
  }

  return turns.slice(-MAX_TURNS);
}

function extractText(content: any[]): string {
  if (!Array.isArray(content)) return '';
  return content
    .filter((c: any) => c.type === 'text')
    .map((c: any) => c.text)
    .join('\n');
}

function extractAssistantText(content: any[]): string {
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const c of content) {
    if (c.type === 'text') {
      parts.push(c.text);
    } else if (c.type === 'tool_use') {
      const input = c.input || {};
      const summary = Object.values(input)[0] || '';
      parts.push(`🔧 ${c.name}: ${String(summary).slice(0, 80)}`);
    }
  }
  return parts.join('\n');
}

export function formatTurnForSlack(params: {
  userText: string;
  assistantText: string;
  turnIndex: number;
}): string {
  return `*User:*\n${params.userText}\n\n*Assistant:*\n${params.assistantText}`;
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/bridge/history-poster.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add src/bridge/history-poster.ts tests/bridge/history-poster.test.ts
git commit -m "feat(phase2-G): HistoryPoster — JSONL parsing, turn extraction, bundled formatting"
```

---

## Chunk 8: Integration + Cleanup

### Task 17: Add keep_alive timer to PersistentSession

**Files:**
- Modify: `src/bridge/persistent-session.ts`
- Modify: `tests/bridge/persistent-session.test.ts`

- [ ] **Step 1: Write test for keep_alive**

```typescript
// Add to tests/bridge/persistent-session.test.ts
it('sends keep_alive control message periodically when idle', () => {
  session.spawn();
  mockProc.stdout.emit('data', Buffer.from(
    JSON.stringify({ type: 'system', subtype: 'init' }) + '\n'
  ));
  expect(session.state).toBe('idle');

  // Advance 5 minutes
  vi.advanceTimersByTime(5 * 60 * 1000);
  expect(mockProc.stdin.write).toHaveBeenCalledWith(
    JSON.stringify({ type: 'control', subtype: 'keep_alive' }) + '\n'
  );
});
```

- [ ] **Step 2: Add keep_alive timer in PersistentSession**

Start a 5-minute repeating interval in `startIdleTimer()`. Send `{"type":"control","subtype":"keep_alive"}` every 5 minutes while idle. Clear on `sendPrompt()` or `end()`.

- [ ] **Step 3: Run tests**

Run: `npx vitest run tests/bridge/persistent-session.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/bridge/persistent-session.ts tests/bridge/persistent-session.test.ts
git commit -m "feat(phase2-A): keep_alive timer — periodic control message during idle"
```

---

### Task 18: Integration — Wire everything in index.ts

**Files:**
- Modify: `src/index.ts` — major rewrite

- [ ] **Step 1: Remove old code**

Delete: ProcessManager import/usage, old `onPrompt` handler that uses Executor.spawn(), old `onCommand` handler, updateAnchor, anchor message posting.

- [ ] **Step 2: Initialize new components**

```typescript
import { UserPreferenceStore } from './store/user-preference-store.js';
import { SessionIndexStore } from './store/session-index-store.js';
import { SessionCoordinator } from './bridge/session-coordinator.js';
import { HomeTabHandler } from './slack/home-tab.js';
import { ActionHandler } from './slack/action-handler.js';
import { parsePermissionAction } from './slack/permission-prompt.js';

const userPrefStore = new UserPreferenceStore(config.dataDir);
const sessionIndexStore = new SessionIndexStore(config.dataDir);
const coordinator = new SessionCoordinator({
  maxAlivePerUser: config.maxConcurrentPerUser,
  maxAliveGlobal: config.maxConcurrentGlobal,
});
const homeTabHandler = new HomeTabHandler(app.client, userPrefStore, sessionIndexStore, projectStore);
const actionHandler = new ActionHandler(userPrefStore, coordinator, homeTabHandler);
```

- [ ] **Step 3: Rewrite message handler flow**

```typescript
// On message:
// 1. parseCommand(sanitizedText)
// 2. bot_command → bridgeCommands.handle(command, ...)
// 3. passthrough/plain_text → resolveSession → sendPrompt or enqueue
//
// resolveSession:
//   threadTs → sessionIndexStore.findByThreadTs()
//   If found → coordinator.getSession(sessionId)
//     If idle → sendPrompt
//     If processing → enqueue in session queue (with ⏳ reaction)
//     If dead → respawn via getOrCreateSession(isResume: true)
//   If not found → new session:
//     crypto.randomUUID() → sessionId
//     coordinator.getOrCreateSession(...)
//     sessionIndexStore.register(...)
//     Post ephemeral thread header
```

- [ ] **Step 4: Wire streaming output → Slack messages**

```typescript
// After session is obtained, listen for messages:
session.on('message', (event) => {
  if (event.type === 'assistant') {
    // Buffer text, throttled chat.update for streaming
    // Reset text buffer on each new turn (when state goes idle→processing)
  }
  if (event.type === 'result') {
    // Post final response with footer
    // Update reactions (🧠 → ✅)
    // Update sessionIndexStore
  }
});
```

- [ ] **Step 5: Register Home Tab actions**

```typescript
app.action('home_set_default_model', async ({ ack, body }) => {
  await ack();
  const value = body.actions[0].selected_option.value;
  await actionHandler.handleSetDefaultModel(body.user.id, value);
});

app.action('home_set_directory', async ({ ack, body }) => {
  await ack();
  const value = body.actions[0].selected_option.value;
  await actionHandler.handleSetDirectory(body.user.id, value);
});

app.action('open_session', async ({ ack, body, client }) => {
  await ack();
  // HistoryPoster flow: post marker, parse JSONL, post turns, register in index
});

app.action('session_page_prev', async ({ ack, body }) => { ... });
app.action('session_page_next', async ({ ack, body }) => { ... });
```

- [ ] **Step 6: Register reaction_added handler for 🔴 interrupt**

```typescript
app.event('reaction_added', async ({ event }) => {
  if (event.reaction !== 'red_circle') return;
  const entry = sessionIndexStore.findByThreadTs(event.item.ts);
  if (!entry) return;
  const session = coordinator.getSession(entry.cliSessionId);
  if (session && session.state === 'processing') {
    session.sendControl({ type: 'control', subtype: 'interrupt' });
  }
});
```

- [ ] **Step 7: Register permission prompt action handlers**

```typescript
app.action('permission_approve', async ({ ack, body, action }) => {
  await ack();
  const { toolUseId, allowed } = parsePermissionAction(action.value);
  // Find session by threadTs, send can_use_tool control message
  const entry = sessionIndexStore.findByThreadTs(body.message.thread_ts);
  if (entry) {
    const session = coordinator.getSession(entry.cliSessionId);
    session?.sendControl({ type: 'control', subtype: 'can_use_tool', tool_use_id: toolUseId, allowed });
  }
});

app.action('permission_deny', async ({ ack, body, action }) => {
  await ack();
  const { toolUseId, allowed } = parsePermissionAction(action.value);
  const entry = sessionIndexStore.findByThreadTs(body.message.thread_ts);
  if (entry) {
    const session = coordinator.getSession(entry.cliSessionId);
    session?.sendControl({ type: 'control', subtype: 'can_use_tool', tool_use_id: toolUseId, allowed });
  }
});
```

- [ ] **Step 8: Run full test suite**

Run: `npx vitest run`
Expected: ALL PASS

- [ ] **Step 9: Commit**

```bash
git commit -m "feat(phase2): wire integration — SessionCoordinator, persistent stores, new thread UX"
```

---

### Task 19: Remove dead code and clean up

**Files:**
- Delete: `src/bridge/process-manager.ts`
- Modify: `src/types.ts` — remove `anchorCollapsed` from `SessionMetadata`
- Modify: `src/store/session-store.ts` — remove UUIDv5 (`threadTsToSessionId`), remove `anchorCollapsed` init
- Modify: `src/slack/block-builder.ts` — remove `buildAnchorBlocks`, `buildCollapsedAnchorBlocks`
- Delete: `tests/bridge/process-manager.test.ts`
- Update: `tests/slack/block-builder.test.ts` — remove anchor block tests
- Update: `tests/store/session-store.test.ts` — remove UUIDv5 tests

- [ ] **Step 1: Delete process-manager files**

```bash
rm src/bridge/process-manager.ts tests/bridge/process-manager.test.ts
```

- [ ] **Step 2: Remove anchorCollapsed from types.ts and session-store.ts**

In `src/types.ts`, remove `anchorCollapsed: boolean` from `SessionMetadata`.
In `src/store/session-store.ts`, remove UUIDv5 import and `threadTsToSessionId()` method, remove `anchorCollapsed` from `create()` defaults.

- [ ] **Step 3: Remove buildAnchorBlocks/buildCollapsedAnchorBlocks from block-builder.ts**

- [ ] **Step 4: Update tests to remove references to deleted code**

- [ ] **Step 5: Run full test suite**

Run: `npx vitest run`
Expected: ALL PASS

- [ ] **Step 6: Commit**

```bash
git commit -m "chore(phase2): remove anchor messages, process-manager, UUIDv5 — dead code cleanup"
```

---

## Execution Order Summary

| Order | Task | Phase | Dependencies |
|-------|------|-------|-------------|
| 1 | Task 1: Types | 2-A | — |
| 2 | Task 4: UserPreferenceStore | 2-C | — (parallel with 1) |
| 3 | Task 5: SessionIndexStore | 2-C | — (parallel with 1) |
| 4 | Task 6: dataDir config | 2-C | — |
| 5 | Task 2: PersistentSession | 2-A | Task 1 |
| 6 | Task 3: executor replay flag | 2-A | Task 1 |
| 7 | Task 7: command-parser rewrite | 2-B | — |
| 8 | Task 8: bridge-commands rewrite | 2-B | Task 7 |
| 9 | Task 9: MessageQueue | 2-F | — |
| 10 | Task 10: SessionCoordinator | 2-F | Task 2, 9 |
| 11 | Task 11: ReactionManager update | 2-E | — |
| 12 | Task 12: Response footer/header/streaming | 2-E | — |
| 13 | Task 13: Permission prompt + interrupt | 2-E | Task 10 |
| 14 | Task 14: Home Tab blocks | 2-D | Task 4, 5 |
| 15 | Task 15: HomeTab handler + ActionHandler | 2-D | Task 14 |
| 16 | Task 16: HistoryPoster | 2-G | Task 5, 15 |
| 17 | Task 17: keep_alive timer | 2-A | Task 2 |
| 18 | Task 18: Integration wiring | ALL | All above |
| 19 | Task 19: Dead code cleanup | — | Task 18 |
