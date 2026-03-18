# Localhost Tunnel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Claude CLIがlocalhost上に起動したWebアプリを、Cloudflare Quick Tunnel経由で外部デバイスからアクセス可能にし、SlackメッセージにリンクとしてURLを追加する。

**Architecture:** TunnelManagerがcloudflaredプロセスのライフサイクルを管理し、LocalhostRewriterがテキスト変換を担当する。StreamProcessorのhandleText内でURL検知→トンネル先行開始、handleResult内で最終テキスト変換を行う。

**Tech Stack:** TypeScript, cloudflared CLI, child_process (spawn), Slack mrkdwn

**Spec:** `docs/superpowers/specs/2026-03-19-localhost-tunnel-design.md`

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `src/streaming/tunnel-manager.ts` | Create | cloudflaredプロセスの起動・停止・URL取得 |
| `src/streaming/localhost-rewriter.ts` | Create | テキスト内のlocalhost URL検知・変換 |
| `src/streaming/stream-processor.ts` | Modify | handleText内でURL検知→トンネル開始、handleResult内でrewrite適用 |
| `src/index.ts` | Modify | TunnelManagerインスタンス生成、shutdown統合、StreamProcessorへの注入 |
| `tests/streaming/localhost-rewriter.test.ts` | Create | LocalhostRewriterの単体テスト |
| `tests/streaming/tunnel-manager.test.ts` | Create | TunnelManagerの単体テスト |
| `.claude/skills/setup.md` | Modify | `brew install cloudflared` をセットアップ手順に追加 |

---

## Task 1: LocalhostRewriter — URL検知ロジック

**Files:**
- Create: `src/streaming/localhost-rewriter.ts`
- Create: `tests/streaming/localhost-rewriter.test.ts`

### Step 1.1: Write failing test for isPrivateIp helper

- [ ] **Write test**

```typescript
// tests/streaming/localhost-rewriter.test.ts
import { describe, it, expect } from 'vitest';
import { isPrivateIp } from '../../src/streaming/localhost-rewriter.js';

describe('isPrivateIp', () => {
  it('returns true for localhost', () => {
    expect(isPrivateIp('localhost')).toBe(true);
  });

  it('returns true for 127.x.x.x', () => {
    expect(isPrivateIp('127.0.0.1')).toBe(true);
    expect(isPrivateIp('127.255.255.255')).toBe(true);
  });

  it('returns true for 0.0.0.0', () => {
    expect(isPrivateIp('0.0.0.0')).toBe(true);
  });

  it('returns true for 10.x.x.x', () => {
    expect(isPrivateIp('10.0.0.1')).toBe(true);
    expect(isPrivateIp('10.255.255.255')).toBe(true);
  });

  it('returns true for 172.16-31.x.x', () => {
    expect(isPrivateIp('172.16.0.1')).toBe(true);
    expect(isPrivateIp('172.31.255.255')).toBe(true);
    expect(isPrivateIp('172.15.0.1')).toBe(false);
    expect(isPrivateIp('172.32.0.1')).toBe(false);
  });

  it('returns true for 192.168.x.x', () => {
    expect(isPrivateIp('192.168.0.1')).toBe(true);
    expect(isPrivateIp('192.168.1.10')).toBe(true);
  });

  it('returns false for public IPs', () => {
    expect(isPrivateIp('8.8.8.8')).toBe(false);
    expect(isPrivateIp('203.0.113.1')).toBe(false);
  });
});
```

- [ ] **Run test to verify it fails**

Run: `npx vitest run tests/streaming/localhost-rewriter.test.ts`
Expected: FAIL — `isPrivateIp` not found

### Step 1.2: Implement isPrivateIp

- [ ] **Write implementation**

```typescript
// src/streaming/localhost-rewriter.ts

const LOCALHOST_URL_PATTERN =
  /https?:\/\/(localhost|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|0\.0\.0\.0|\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})(:\d+)?[^\s)]*/g;

export function isPrivateIp(host: string): boolean {
  if (host === 'localhost' || host === '0.0.0.0') return true;

  const parts = host.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255)) return false;

  // 127.x.x.x (loopback)
  if (parts[0] === 127) return true;
  // 10.x.x.x
  if (parts[0] === 10) return true;
  // 172.16.0.0 - 172.31.255.255
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
  // 192.168.x.x
  if (parts[0] === 192 && parts[1] === 168) return true;

  return false;
}
```

- [ ] **Run test to verify it passes**

Run: `npx vitest run tests/streaming/localhost-rewriter.test.ts`
Expected: PASS

- [ ] **Commit**

```bash
git add src/streaming/localhost-rewriter.ts tests/streaming/localhost-rewriter.test.ts
git commit -m "feat(tunnel): add isPrivateIp helper for localhost URL detection"
```

### Step 1.3: Write failing test for extractLocalUrls

- [ ] **Write test**

```typescript
// Append to tests/streaming/localhost-rewriter.test.ts
import { extractLocalUrls } from '../../src/streaming/localhost-rewriter.js';

describe('extractLocalUrls', () => {
  it('extracts localhost URL with port', () => {
    const result = extractLocalUrls('Server running at http://localhost:3000');
    expect(result).toEqual([{ url: 'http://localhost:3000', host: 'localhost', port: 3000 }]);
  });

  it('extracts localhost URL without port (defaults to 80)', () => {
    const result = extractLocalUrls('Visit http://localhost');
    expect(result).toEqual([{ url: 'http://localhost', host: 'localhost', port: 80 }]);
  });

  it('extracts URL with path', () => {
    const result = extractLocalUrls('Open http://localhost:5173/dashboard');
    expect(result).toEqual([{ url: 'http://localhost:5173/dashboard', host: 'localhost', port: 5173 }]);
  });

  it('extracts 127.0.0.1 URL', () => {
    const result = extractLocalUrls('http://127.0.0.1:8080/api');
    expect(result).toEqual([{ url: 'http://127.0.0.1:8080/api', host: '127.0.0.1', port: 8080 }]);
  });

  it('extracts private IP URL', () => {
    const result = extractLocalUrls('http://192.168.1.10:3000');
    expect(result).toEqual([{ url: 'http://192.168.1.10:3000', host: '192.168.1.10', port: 3000 }]);
  });

  it('ignores public IP URLs', () => {
    const result = extractLocalUrls('http://8.8.8.8:3000');
    expect(result).toEqual([]);
  });

  it('extracts multiple URLs', () => {
    const result = extractLocalUrls('Frontend: http://localhost:3000 API: http://localhost:8080');
    expect(result).toHaveLength(2);
    expect(result[0].port).toBe(3000);
    expect(result[1].port).toBe(8080);
  });

  it('returns empty for no URLs', () => {
    const result = extractLocalUrls('No URLs here');
    expect(result).toEqual([]);
  });
});
```

- [ ] **Run test to verify it fails**

Run: `npx vitest run tests/streaming/localhost-rewriter.test.ts`
Expected: FAIL — `extractLocalUrls` not found

### Step 1.4: Implement extractLocalUrls

- [ ] **Write implementation**

```typescript
// Add to src/streaming/localhost-rewriter.ts

export interface LocalUrl {
  url: string;
  host: string;
  port: number;
}

export function extractLocalUrls(text: string): LocalUrl[] {
  const results: LocalUrl[] = [];
  const regex = new RegExp(LOCALHOST_URL_PATTERN.source, 'g');

  let match;
  while ((match = regex.exec(text)) !== null) {
    const host = match[1];
    if (!isPrivateIp(host)) continue;

    const port = match[2] ? parseInt(match[2].slice(1), 10) : 80;
    results.push({ url: match[0], host, port });
  }

  return results;
}
```

- [ ] **Run test to verify it passes**

Run: `npx vitest run tests/streaming/localhost-rewriter.test.ts`
Expected: PASS

- [ ] **Commit**

```bash
git add src/streaming/localhost-rewriter.ts tests/streaming/localhost-rewriter.test.ts
git commit -m "feat(tunnel): add extractLocalUrls for detecting local URLs in text"
```

---

## Task 2: LocalhostRewriter — テキスト変換ロジック

**Files:**
- Modify: `src/streaming/localhost-rewriter.ts`
- Modify: `tests/streaming/localhost-rewriter.test.ts`

### Step 2.1: Write failing test for rewriteLocalUrls

- [ ] **Write test**

```typescript
// Append to tests/streaming/localhost-rewriter.test.ts
import { rewriteLocalUrls } from '../../src/streaming/localhost-rewriter.js';

describe('rewriteLocalUrls', () => {
  it('rewrites localhost URL with tunnel URL', () => {
    const urlMap = new Map<string, string>([
      ['http://localhost:3000', 'https://abc123.trycloudflare.com'],
    ]);
    const result = rewriteLocalUrls(
      'Server running at http://localhost:3000',
      urlMap
    );
    expect(result).toBe(
      'Server running at `http://localhost:3000`（<https://abc123.trycloudflare.com|Slackからはこちら>）'
    );
  });

  it('rewrites multiple URLs', () => {
    const urlMap = new Map<string, string>([
      ['http://localhost:3000', 'https://aaa.trycloudflare.com'],
      ['http://localhost:8080', 'https://bbb.trycloudflare.com'],
    ]);
    const result = rewriteLocalUrls(
      'Frontend: http://localhost:3000 API: http://localhost:8080',
      urlMap
    );
    expect(result).toContain('`http://localhost:3000`（<https://aaa.trycloudflare.com|Slackからはこちら>）');
    expect(result).toContain('`http://localhost:8080`（<https://bbb.trycloudflare.com|Slackからはこちら>）');
  });

  it('leaves URL unchanged when no tunnel URL available', () => {
    const urlMap = new Map<string, string>();
    const result = rewriteLocalUrls(
      'Server running at http://localhost:3000',
      urlMap
    );
    expect(result).toBe('Server running at http://localhost:3000');
  });

  it('rewrites URL with path, mapping to base tunnel URL with path', () => {
    const urlMap = new Map<string, string>([
      ['http://localhost:5173/dashboard', 'https://abc123.trycloudflare.com/dashboard'],
    ]);
    const result = rewriteLocalUrls(
      'Open http://localhost:5173/dashboard',
      urlMap
    );
    expect(result).toContain('`http://localhost:5173/dashboard`（<https://abc123.trycloudflare.com/dashboard|Slackからはこちら>）');
  });
});
```

- [ ] **Run test to verify it fails**

Run: `npx vitest run tests/streaming/localhost-rewriter.test.ts`
Expected: FAIL — `rewriteLocalUrls` not found

### Step 2.2: Implement rewriteLocalUrls

- [ ] **Write implementation**

```typescript
// Add to src/streaming/localhost-rewriter.ts

export function rewriteLocalUrls(
  text: string,
  urlMap: Map<string, string>
): string {
  if (urlMap.size === 0) return text;

  // Sort by URL length descending to avoid partial match issues
  // e.g. "http://localhost:3000/path" before "http://localhost:3000"
  const sortedEntries = [...urlMap.entries()].sort(
    (a, b) => b[0].length - a[0].length
  );

  let result = text;
  for (const [originalUrl, tunnelUrl] of sortedEntries) {
    // Replace all occurrences
    result = result.replaceAll(
      originalUrl,
      `\`${originalUrl}\`（<${tunnelUrl}|Slackからはこちら>）`
    );
  }

  return result;
}
```

- [ ] **Run test to verify it passes**

Run: `npx vitest run tests/streaming/localhost-rewriter.test.ts`
Expected: PASS

- [ ] **Commit**

```bash
git add src/streaming/localhost-rewriter.ts tests/streaming/localhost-rewriter.test.ts
git commit -m "feat(tunnel): add rewriteLocalUrls for text transformation"
```

---

## Task 3: TunnelManager — cloudflaredプロセス管理

**Files:**
- Create: `src/streaming/tunnel-manager.ts`
- Create: `tests/streaming/tunnel-manager.test.ts`

### Step 3.1: Write failing test for TunnelManager basics

- [ ] **Write test**

```typescript
// tests/streaming/tunnel-manager.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TunnelManager } from '../../src/streaming/tunnel-manager.js';

// Mock child_process.spawn
vi.mock('child_process', () => {
  const EventEmitter = require('events');

  function createMockProcess() {
    const proc = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.kill = vi.fn();
    proc.pid = 12345;
    return proc;
  }

  return {
    spawn: vi.fn(() => createMockProcess()),
  };
});

import { spawn } from 'child_process';

describe('TunnelManager', () => {
  let manager: TunnelManager;

  beforeEach(() => {
    manager = new TunnelManager();
    vi.clearAllMocks();
  });

  afterEach(() => {
    manager.stopAll();
  });

  it('returns undefined for unknown port', () => {
    expect(manager.getTunnelUrl(3000)).toBeUndefined();
  });

  it('starts cloudflared with correct arguments', () => {
    manager.startTunnel(3000);
    expect(spawn).toHaveBeenCalledWith(
      'cloudflared',
      ['tunnel', '--url', 'localhost:3000'],
      expect.any(Object)
    );
  });

  it('does not start duplicate tunnel for same port', () => {
    manager.startTunnel(3000);
    manager.startTunnel(3000);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('parses tunnel URL from stderr', async () => {
    const promise = manager.startTunnel(3000);
    const mockProc = (spawn as any).mock.results[0].value;

    // Simulate cloudflared stderr output
    mockProc.stderr.emit(
      'data',
      Buffer.from('2026-03-19T00:00:00Z INF |  https://test-tunnel.trycloudflare.com')
    );

    const url = await promise;
    expect(url).toBe('https://test-tunnel.trycloudflare.com');
    expect(manager.getTunnelUrl(3000)).toBe('https://test-tunnel.trycloudflare.com');
  });

  it('stopAll kills all processes', async () => {
    manager.startTunnel(3000);
    manager.startTunnel(8080);
    const proc1 = (spawn as any).mock.results[0].value;
    const proc2 = (spawn as any).mock.results[1].value;

    manager.stopAll();
    expect(proc1.kill).toHaveBeenCalled();
    expect(proc2.kill).toHaveBeenCalled();
  });
});
```

- [ ] **Run test to verify it fails**

Run: `npx vitest run tests/streaming/tunnel-manager.test.ts`
Expected: FAIL — `TunnelManager` not found

### Step 3.2: Implement TunnelManager

- [ ] **Write implementation**

```typescript
// src/streaming/tunnel-manager.ts
import { spawn, ChildProcess } from 'child_process';
import { logger } from '../utils/logger.js';

const MAX_TUNNELS = 5;
const TUNNEL_TIMEOUT_MS = 8000;
const TUNNEL_URL_REGEX = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

interface TunnelEntry {
  process: ChildProcess;
  url: string | undefined;
  port: number;
  createdAt: number;
}

export class TunnelManager {
  private tunnels = new Map<number, TunnelEntry>();
  private pending = new Map<number, Promise<string>>();

  startTunnel(port: number): Promise<string> {
    // Return existing tunnel URL
    const existing = this.tunnels.get(port);
    if (existing?.url) return Promise.resolve(existing.url);

    // Return pending tunnel
    const pendingPromise = this.pending.get(port);
    if (pendingPromise) return pendingPromise;

    // Enforce max tunnel limit
    if (this.tunnels.size >= MAX_TUNNELS) {
      this.evictOldest();
    }

    const promise = this.spawnTunnel(port);
    this.pending.set(port, promise);
    promise.finally(() => this.pending.delete(port));
    return promise;
  }

  getTunnelUrl(port: number): string | undefined {
    return this.tunnels.get(port)?.url;
  }

  stopTunnel(port: number): void {
    const entry = this.tunnels.get(port);
    if (entry) {
      entry.process.kill();
      this.tunnels.delete(port);
      logger.info(`Tunnel stopped for port ${port}`);
    }
  }

  stopAll(): void {
    for (const [port] of this.tunnels) {
      this.stopTunnel(port);
    }
  }

  private spawnTunnel(port: number): Promise<string> {
    return new Promise((resolve) => {
      const proc = spawn('cloudflared', ['tunnel', '--url', `localhost:${port}`], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const entry: TunnelEntry = {
        process: proc,
        url: undefined,
        port,
        createdAt: Date.now(),
      };
      this.tunnels.set(port, entry);

      const timeout = setTimeout(() => {
        if (!entry.url) {
          logger.warn(`Tunnel timeout for port ${port} after ${TUNNEL_TIMEOUT_MS}ms`);
          resolve(''); // Resolve empty so rewriter skips this URL
        }
      }, TUNNEL_TIMEOUT_MS);

      proc.stderr?.on('data', (data: Buffer) => {
        const line = data.toString();
        const match = line.match(TUNNEL_URL_REGEX);
        if (match && !entry.url) {
          entry.url = match[0];
          clearTimeout(timeout);
          logger.info(`Tunnel established: localhost:${port} -> ${entry.url}`);
          resolve(entry.url);
        }
      });

      proc.on('error', (err) => {
        logger.error(`cloudflared error for port ${port}: ${err.message}`);
        this.tunnels.delete(port);
        clearTimeout(timeout);
        resolve(''); // Graceful fallback
      });

      proc.on('exit', (code) => {
        if (entry.url) {
          // Process died after URL was established — clean up for re-creation
          logger.warn(`cloudflared exited (code ${code}) for port ${port}, tunnel will be re-created on next use`);
          this.tunnels.delete(port);
        }
      });
    });
  }

  private evictOldest(): void {
    let oldestPort: number | undefined;
    let oldestTime = Infinity;
    for (const [port, entry] of this.tunnels) {
      if (entry.createdAt < oldestTime) {
        oldestTime = entry.createdAt;
        oldestPort = port;
      }
    }
    if (oldestPort !== undefined) {
      this.stopTunnel(oldestPort);
    }
  }
}
```

- [ ] **Run test to verify it passes**

Run: `npx vitest run tests/streaming/tunnel-manager.test.ts`
Expected: PASS

- [ ] **Commit**

```bash
git add src/streaming/tunnel-manager.ts tests/streaming/tunnel-manager.test.ts
git commit -m "feat(tunnel): add TunnelManager for cloudflared process lifecycle"
```

---

## Task 4: StreamProcessorへの統合

**Files:**
- Modify: `src/streaming/stream-processor.ts` (handleText ~line 136, handleResult ~line 212)
- Modify: `src/index.ts` (TunnelManager instantiation ~line 73, shutdown ~line 811, wireSessionOutput ~line 393)

### Step 4.1: Add TunnelManager to StreamProcessor constructor

- [ ] **Modify StreamProcessor to accept TunnelManager**

In `src/streaming/stream-processor.ts`:
- Import TunnelManager and LocalhostRewriter functions
- Add optional `tunnelManager` to constructor options
- Store as instance property

```typescript
// Add imports at top of stream-processor.ts
import { TunnelManager } from './tunnel-manager.js';
import { extractLocalUrls, rewriteLocalUrls } from './localhost-rewriter.js';

// Add to StreamProcessorConfig interface in stream-processor.ts
tunnelManager?: TunnelManager;

// Store in constructor
this.tunnelManager = config.tunnelManager;
```

- [ ] **Commit**

```bash
git add src/streaming/stream-processor.ts
git commit -m "feat(tunnel): add TunnelManager dependency to StreamProcessor"
```

### Step 4.2: Add URL detection in handleText

- [ ] **Add localhost URL detection in handleText, before textAction generation (~line 136)**

```typescript
// In handleText(), after textBuffer is updated, before convertMarkdownToMrkdwn:
if (this.tunnelManager) {
  const localUrls = extractLocalUrls(this.textBuffer);
  for (const { port } of localUrls) {
    // Fire-and-forget: start tunnel in parallel
    this.tunnelManager.startTunnel(port);
  }
}
```

- [ ] **Commit**

```bash
git add src/streaming/stream-processor.ts
git commit -m "feat(tunnel): detect localhost URLs during streaming and pre-start tunnels"
```

### Step 4.3: Add URL rewriting in handleResult

- [ ] **Change `handleResult` to async and update `processEvent` call site**

`handleResult` is currently synchronous. Change its signature to `private async handleResult(...)`.
Also update `processEvent` (line 31): change `this.handleResult(event)` to `await this.handleResult(event)`.
`processEvent` is already called inside `serialQueue.enqueue(async () => ...)` in `index.ts` (line 435), so adding `await` is safe.

- [ ] **Add rewrite logic in handleResult, before convertMarkdownToMrkdwn (~line 212)**

```typescript
// In handleResult(), before convertMarkdownToMrkdwn is called:
if (this.tunnelManager && this.textBuffer) {
  const localUrls = extractLocalUrls(this.textBuffer);
  if (localUrls.length > 0) {
    // Wait for all tunnels (with timeout built into TunnelManager)
    const urlMap = new Map<string, string>();
    await Promise.all(
      localUrls.map(async ({ url, port }) => {
        const tunnelUrl = await this.tunnelManager!.startTunnel(port);
        if (tunnelUrl) {
          // Use URL constructor for safe path extraction
          const parsed = new URL(url);
          const path = parsed.pathname + parsed.search + parsed.hash;
          urlMap.set(url, tunnelUrl + (path === '/' ? '' : path));
        }
      })
    );
    this.textBuffer = rewriteLocalUrls(this.textBuffer, urlMap);
  }
}
// Then existing: const converted = convertMarkdownToMrkdwn(this.textBuffer);
```

- [ ] **Commit**

```bash
git add src/streaming/stream-processor.ts
git commit -m "feat(tunnel): rewrite localhost URLs with tunnel URLs on result"
```

### Step 4.4: Instantiate TunnelManager in index.ts

- [ ] **Create TunnelManager instance and pass to StreamProcessor**

In `src/index.ts`:

```typescript
// Add import at top
import { TunnelManager } from './streaming/tunnel-manager.js';

// After other top-level instantiations (~line 73):
const tunnelManager = new TunnelManager();

// In wireSessionOutput() (~line 405), pass to StreamProcessor:
const streamProcessor = new StreamProcessor({
  channel: channelId,
  threadTs,
  sessionId: session.sessionId,
  tunnelManager,
});

// In shutdown() (~line 811), add before pidLock.release():
tunnelManager.stopAll();
```

- [ ] **Commit**

```bash
git add src/index.ts
git commit -m "feat(tunnel): wire TunnelManager into Bridge lifecycle"
```

### Step 4.5: Add integration tests for StreamProcessor tunnel behavior

- [ ] **Write integration test in `tests/streaming/stream-processor.test.ts`**

```typescript
// Append to existing test file
import { TunnelManager } from '../../src/streaming/tunnel-manager.js';

describe('StreamProcessor with TunnelManager', () => {
  it('calls startTunnel when text contains localhost URL', () => {
    const mockTunnelManager = {
      startTunnel: vi.fn().mockResolvedValue('https://test.trycloudflare.com'),
      getTunnelUrl: vi.fn(),
      stopTunnel: vi.fn(),
      stopAll: vi.fn(),
    } as unknown as TunnelManager;

    const processor = new StreamProcessor({
      channel: 'C123',
      threadTs: '123.456',
      sessionId: 'test',
      tunnelManager: mockTunnelManager,
    });

    processor.processEvent({
      type: 'assistant',
      subtype: 'text',
      text: 'Server at http://localhost:3000',
    });

    expect(mockTunnelManager.startTunnel).toHaveBeenCalledWith(3000);
  });

  it('does not call startTunnel when no localhost URL in text', () => {
    const mockTunnelManager = {
      startTunnel: vi.fn(),
      getTunnelUrl: vi.fn(),
      stopTunnel: vi.fn(),
      stopAll: vi.fn(),
    } as unknown as TunnelManager;

    const processor = new StreamProcessor({
      channel: 'C123',
      threadTs: '123.456',
      sessionId: 'test',
      tunnelManager: mockTunnelManager,
    });

    processor.processEvent({
      type: 'assistant',
      subtype: 'text',
      text: 'Hello world',
    });

    expect(mockTunnelManager.startTunnel).not.toHaveBeenCalled();
  });

  it('works normally without tunnelManager (backward compat)', () => {
    const processor = new StreamProcessor({
      channel: 'C123',
      threadTs: '123.456',
      sessionId: 'test',
    });

    // Should not throw
    const result = processor.processEvent({
      type: 'assistant',
      subtype: 'text',
      text: 'Server at http://localhost:3000',
    });
    expect(result).toBeDefined();
  });
});
```

- [ ] **Run tests**

Run: `npx vitest run tests/streaming/stream-processor.test.ts`
Expected: PASS

- [ ] **Commit**

```bash
git add tests/streaming/stream-processor.test.ts
git commit -m "test(tunnel): add integration tests for StreamProcessor tunnel behavior"
```

---

## Task 5: セットアップスキル更新

**Files:**
- Modify: `.claude/skills/setup.md`

### Step 5.1: Add cloudflared to setup instructions

- [ ] **Add `brew install cloudflared` to prerequisites section in `.claude/skills/setup.md`**

Add after the existing Node.js / Claude CLI prerequisites:

```markdown
- cloudflared (Cloudflare Tunnel CLI): `brew install cloudflared`
  - localhostで起動したWebアプリを外部デバイスからアクセス可能にするために必要
  - アカウント登録不要
```

- [ ] **Commit**

```bash
git add .claude/skills/setup.md
git commit -m "docs: add cloudflared to setup prerequisites"
```

---

## Task 6: 手動統合テスト

### Step 6.1: cloudflared動作確認

- [ ] **テスト用HTTPサーバーを起動してトンネルを手動テスト**

```bash
# Terminal 1: テストサーバー起動
python3 -m http.server 18080

# Terminal 2: トンネル起動
cloudflared tunnel --url localhost:18080
# → https://xxx.trycloudflare.com が表示されることを確認
# → スマホブラウザでそのURLにアクセスし、ファイル一覧が表示されることを確認
```

### Step 6.2: Bridge統合テスト

- [ ] **Bridgeを再起動してE2Eテスト**

```bash
kill $(cat ~/.claude-slack-pipe/claude-slack-pipe.pid) 2>/dev/null
sleep 2 && caffeinate -i npx tsx src/index.ts
# run_in_background: true で実行すること
```

- [ ] **Slackから以下のプロンプトを送信してテスト**

```
簡単なHTMLページをlocalhost:3000で起動して
```

- [ ] **確認事項**
  - Slackメッセージにバッククォートで囲まれたlocalhost URLが表示される
  - 「Slackからはこちら」のリンクが表示される
  - リンクをタップすると、トンネルURL経由でページが表示される
  - ページの内容をリアルタイムで操作できる
