# Claude Code Slack Bridge MVP Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Slack DM + スレッドベースでClaude Code CLIを操作できる最小限のブリッジを構築する

**Architecture:** TypeScript + Bolt for JS + Socket Mode。claude -p を都度起動し、DM内のスレッドで1セッション=1スレッドとして対話。.claude/projects/から自動でプロジェクト検出。SQLiteなし、インメモリ管理。

**Tech Stack:** TypeScript, @slack/bolt, child_process (spawn), uuid (v5), winston

---

## Dependencies between Tasks

```
Phase 0 (Foundation):
  Task 1 (project init) → all other tasks
  Task 2 (config) → Task 5, 6
  Task 3 (types) → Task 6, 7, and all Phase 1 tasks
  Task 4 (logger + errors) → Task 5, 6, 7
  Task 5 (bolt app) → Task 6, Phase 1
  Task 6 (auth + rate limiter) → Phase 1 Task 8
  Task 7 (sanitizer) → Phase 1 Task 5, 8

Phase 1 (MVP):
  Task 8 (project-store) → Task 13, 17
  Task 9 (session-store) → Task 10
  Task 10 (session-manager) → Task 15
  Task 11 (process-manager) → Task 12
  Task 12 (executor) → Task 15
  Task 13 (command-parser) → Task 15, 20
  Task 14 (block-builder) → Task 16, 17, 19, 20
  Task 15 (event-handler) → Task 18
  Task 16 (response-builder) → Task 15
  Task 17 (home-tab) → standalone
  Task 18 (reaction-manager) → standalone
  Task 19 (error-display) → standalone
  Task 20 (cc /status, /end, /help) → standalone
```

---

## Chunk 1: Project Foundation (Tasks 1-4)

### Task 1: Project Initialization

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.env.example`, `src/index.ts`

- [ ] **Step 1: Initialize project and install dependencies**

Run:
```bash
cd claude-slack-bridge
npm init -y
npm install @slack/bolt winston zod uuid dotenv
npm install -D typescript vitest @types/node @types/uuid tsx
```

- [ ] **Step 2: Create tsconfig.json**

Create `tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "lib": ["ES2022"],
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "tests"]
}
```

- [ ] **Step 3: Create vitest.config.ts**

Create `vitest.config.ts`:
```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/index.ts'],
    },
  },
});
```

- [ ] **Step 4: Create .env.example**

Create `.env.example`:
```bash
# === Slack ===
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...

# === Security ===
ALLOWED_USER_IDS=
ALLOWED_TEAM_IDS=
ADMIN_USER_IDS=

# === Claude Code ===
CLAUDE_EXECUTABLE=claude
CLAUDE_PROJECTS_DIR=~/.claude/projects

# === Limits ===
MAX_CONCURRENT_PER_USER=1
MAX_CONCURRENT_GLOBAL=3
DEFAULT_TIMEOUT_MS=300000
MAX_TIMEOUT_MS=1800000
DEFAULT_BUDGET_USD=1.0
MAX_BUDGET_USD=10.0

# === Logging ===
LOG_LEVEL=info
```

- [ ] **Step 5: Update package.json scripts**

Add to `package.json`:
```json
{
  "scripts": {
    "build": "tsc",
    "start": "node dist/index.js",
    "dev": "tsx watch src/index.ts",
    "test": "vitest run",
    "test:watch": "vitest",
    "lint": "tsc --noEmit"
  }
}
```

- [ ] **Step 6: Create minimal src/index.ts**

Create `src/index.ts`:
```typescript
import { config } from './config.js';
import { logger } from './utils/logger.js';

async function main(): Promise<void> {
  logger.info('Claude Code Slack Bridge starting...', {
    logLevel: config.logLevel,
  });
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
```

- [ ] **Step 7: Verify project compiles**

Run: `npx tsc --noEmit` (after Task 2-4 complete)

- [ ] **Step 8: Commit**

---

### Task 2: Config (.env + config.ts)

**Files:**
- Create: `src/config.ts`
- Test: `tests/config.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/config.test.ts`:
```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

describe('loadConfig', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('should load config from environment variables', async () => {
    process.env.SLACK_BOT_TOKEN = 'xoxb-test-token';
    process.env.SLACK_APP_TOKEN = 'xapp-test-token';
    process.env.LOG_LEVEL = 'debug';
    process.env.MAX_CONCURRENT_PER_USER = '2';
    process.env.DEFAULT_BUDGET_USD = '5.0';

    // Dynamic import to pick up env changes
    const { loadConfig } = await import('../src/config.js');
    const cfg = loadConfig();

    expect(cfg.slackBotToken).toBe('xoxb-test-token');
    expect(cfg.slackAppToken).toBe('xapp-test-token');
    expect(cfg.logLevel).toBe('debug');
    expect(cfg.maxConcurrentPerUser).toBe(2);
    expect(cfg.defaultBudgetUsd).toBe(5.0);
  });

  it('should use defaults when optional env vars are missing', async () => {
    process.env.SLACK_BOT_TOKEN = 'xoxb-test';
    process.env.SLACK_APP_TOKEN = 'xapp-test';

    const { loadConfig } = await import('../src/config.js');
    const cfg = loadConfig();

    expect(cfg.maxConcurrentPerUser).toBe(1);
    expect(cfg.maxConcurrentGlobal).toBe(3);
    expect(cfg.defaultTimeoutMs).toBe(300_000);
    expect(cfg.maxTimeoutMs).toBe(1_800_000);
    expect(cfg.defaultBudgetUsd).toBe(1.0);
    expect(cfg.maxBudgetUsd).toBe(10.0);
    expect(cfg.logLevel).toBe('info');
    expect(cfg.claudeExecutable).toBe('claude');
  });

  it('should parse comma-separated user/team IDs', async () => {
    process.env.SLACK_BOT_TOKEN = 'xoxb-test';
    process.env.SLACK_APP_TOKEN = 'xapp-test';
    process.env.ALLOWED_USER_IDS = 'U111,U222,U333';
    process.env.ALLOWED_TEAM_IDS = 'T111';
    process.env.ADMIN_USER_IDS = 'U111';

    const { loadConfig } = await import('../src/config.js');
    const cfg = loadConfig();

    expect(cfg.allowedUserIds).toEqual(['U111', 'U222', 'U333']);
    expect(cfg.allowedTeamIds).toEqual(['T111']);
    expect(cfg.adminUserIds).toEqual(['U111']);
  });

  it('should throw on missing required env vars', async () => {
    delete process.env.SLACK_BOT_TOKEN;
    delete process.env.SLACK_APP_TOKEN;

    const { loadConfig } = await import('../src/config.js');
    expect(() => loadConfig()).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/config.test.ts --reporter=verbose`
Expected: FAIL

- [ ] **Step 3: Write minimal implementation**

Create `src/config.ts`:
```typescript
import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

function parseCommaSeparated(value: string | undefined): string[] {
  if (!value || value.trim() === '') return [];
  return value.split(',').map((s) => s.trim()).filter(Boolean);
}

const configSchema = z.object({
  slackBotToken: z.string().min(1),
  slackAppToken: z.string().min(1),
  allowedUserIds: z.array(z.string()),
  allowedTeamIds: z.array(z.string()),
  adminUserIds: z.array(z.string()),
  claudeExecutable: z.string().default('claude'),
  claudeProjectsDir: z.string(),
  maxConcurrentPerUser: z.number().int().positive(),
  maxConcurrentGlobal: z.number().int().positive(),
  defaultTimeoutMs: z.number().int().positive(),
  maxTimeoutMs: z.number().int().positive(),
  defaultBudgetUsd: z.number().positive(),
  maxBudgetUsd: z.number().positive(),
  logLevel: z.enum(['error', 'warn', 'info', 'debug']),
});

export type AppConfig = z.infer<typeof configSchema>;

export function loadConfig(): AppConfig {
  const raw = {
    slackBotToken: process.env.SLACK_BOT_TOKEN,
    slackAppToken: process.env.SLACK_APP_TOKEN,
    allowedUserIds: parseCommaSeparated(process.env.ALLOWED_USER_IDS),
    allowedTeamIds: parseCommaSeparated(process.env.ALLOWED_TEAM_IDS),
    adminUserIds: parseCommaSeparated(process.env.ADMIN_USER_IDS),
    claudeExecutable: process.env.CLAUDE_EXECUTABLE || 'claude',
    claudeProjectsDir: process.env.CLAUDE_PROJECTS_DIR || '~/.claude/projects',
    maxConcurrentPerUser: Number(process.env.MAX_CONCURRENT_PER_USER || '1'),
    maxConcurrentGlobal: Number(process.env.MAX_CONCURRENT_GLOBAL || '3'),
    defaultTimeoutMs: Number(process.env.DEFAULT_TIMEOUT_MS || '300000'),
    maxTimeoutMs: Number(process.env.MAX_TIMEOUT_MS || '1800000'),
    defaultBudgetUsd: Number(process.env.DEFAULT_BUDGET_USD || '1.0'),
    maxBudgetUsd: Number(process.env.MAX_BUDGET_USD || '10.0'),
    logLevel: (process.env.LOG_LEVEL as AppConfig['logLevel']) || 'info',
  };

  return configSchema.parse(raw);
}

export const config = loadConfig();
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/config.test.ts --reporter=verbose`
Expected: PASS

- [ ] **Step 5: Commit**

---

### Task 3: Types (types.ts)

**Files:**
- Create: `src/types.ts`

- [ ] **Step 1: Write the type definitions file**

Create `src/types.ts`:
```typescript
import type { ChildProcess } from 'node:child_process';

// ============================================================
// 5.1 Session Metadata
// ============================================================

export type ModelChoice = 'opus' | 'sonnet' | 'haiku';

export interface SessionMetadata {
  sessionId: string;
  threadTs: string;
  dmChannelId: string;
  projectPath: string;
  name: string;
  model: ModelChoice;
  status: 'active' | 'ended';
  startTime: Date;
  totalCost: number;
  turnCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  lastActiveAt: Date;
  anchorCollapsed: boolean;
}

// ============================================================
// 5.2 Process Management
// ============================================================

export interface ProcessManagerConfig {
  maxConcurrentPerUser: number;
  maxConcurrentGlobal: number;
  defaultTimeoutMs: number;
  maxTimeoutMs: number;
  defaultBudgetUsd: number;
  maxBudgetUsd: number;
}

export interface ManagedProcess {
  sessionId: string;
  userId: string;
  channelId: string;
  projectId: string;
  process: ChildProcess;
  startedAt: Date;
  timeoutTimer: NodeJS.Timeout;
  status: 'running' | 'completing' | 'cancelled' | 'timed-out';
  budgetUsd: number;
}

// ============================================================
// 5.3 Stream Processing (Phase 2, stubs only for MVP)
// ============================================================

export type ProcessingPhase =
  | 'idle'
  | 'thinking'
  | 'tool_input'
  | 'tool_running'
  | 'sub_agent'
  | 'completed'
  | 'error';

export interface StreamProcessorState {
  phase: ProcessingPhase;
  progressMessageTs: string | null;
  steps: ToolUseStep[];
  currentText: string;
  currentToolUse: {
    id: string;
    name: string;
    inputJson: string;
  } | null;
  subAgentSteps: Map<string, ToolUseStep[]>;
  startTime: number;
  lastThinkingSnippet: string;
}

export interface ToolUseStep {
  index: number;
  toolName: string;
  toolUseId: string;
  input: Record<string, unknown>;
  output?: Record<string, unknown>;
  error?: string;
  status: 'running' | 'completed' | 'error';
  startTime: number;
  endTime?: number;
  parentToolUseId: string | null;
}

export interface ToolUseSummary {
  toolName: string;
  status: 'running' | 'completed' | 'error';
  oneLiner: string;
  detailBlocks: unknown[];
}

// ============================================================
// 5.4 Command Parser
// ============================================================

export interface ParsedCommand {
  type: 'claude_command' | 'bridge_command' | 'plain_text';
  command?: string;
  args?: string;
  rawText: string;
}

// ============================================================
// 5.5 Project / Session Info
// ============================================================

export interface ProjectInfo {
  id: string;
  projectPath: string;
  sessionCount: number;
  lastModified: Date;
}

export interface SessionInfoLight {
  sessionId: string;
  updatedAt: Date;
  sizeBytes: number;
}

export interface SessionInfo {
  sessionId: string;
  projectId: string;
  firstPrompt: string | null;
  lastPrompt: string | null;
  customTitle: string | null;
  createdAt: Date;
  updatedAt: Date;
  fileSizeBytes: number;
}

// ============================================================
// 5.6 JSONL Session Log Types
// ============================================================

export interface BaseEntry {
  parentUuid: string | null;
  isSidechain: boolean;
  userType: 'external' | 'internal';
  cwd: string;
  sessionId: string;
  version: string;
  uuid: string;
  timestamp: string;
  gitBranch?: string;
  isMeta?: boolean;
  agentId?: string;
  isCompactSummary?: boolean;
  logicalParentUuid?: string;
  slug?: string;
}

export interface ThinkingContent {
  type: 'thinking';
  thinking: string;
  signature: string;
}

export interface TextContent {
  type: 'text';
  text: string;
}

export interface ToolUseContent {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
  caller?: string;
}

export interface ToolResultContent {
  type: 'tool_result';
  tool_use_id: string;
  content: string | Array<unknown>;
}

export interface ImageContent {
  type: 'image';
  source: { type: string; media_type: string; data: string };
}

export interface DocumentContent {
  type: 'document';
  source: { type: string; media_type: string; data: string };
}

export type AssistantContentBlock = ThinkingContent | TextContent | ToolUseContent;
export type UserContentBlock = string | TextContent | ToolResultContent | ImageContent | DocumentContent;

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  cache_creation?: {
    ephemeral_5m_input_tokens: number;
    ephemeral_1h_input_tokens: number;
  };
  service_tier?: string;
  inference_geo?: string;
}

export interface AssistantMessage {
  model: string;
  id: string;
  type: 'message';
  role: 'assistant';
  content: AssistantContentBlock[];
  stop_reason: 'end_turn' | 'tool_use' | 'max_tokens' | null;
  stop_sequence: string | null;
  usage: TokenUsage;
}

export interface UserMessage {
  role: 'user';
  content: string | UserContentBlock[];
}

export interface UserEntry extends BaseEntry {
  type: 'user';
  message: UserMessage;
}

export interface AssistantEntry extends BaseEntry {
  type: 'assistant';
  message: AssistantMessage;
  requestId?: string;
  isApiErrorMessage?: boolean;
}

export interface TurnDurationEntry extends BaseEntry {
  type: 'system';
  subtype: 'turn_duration';
  durationMs: number;
}

export interface CompactBoundaryEntry extends BaseEntry {
  type: 'system';
  subtype: 'compact_boundary';
  content: string;
  level: string;
  compactMetadata?: {
    trigger: 'manual' | 'auto';
    preTokens: number;
  };
}

export interface StopHookSummaryEntry extends BaseEntry {
  type: 'system';
  subtype: 'stop_hook_summary';
  hookCount: number;
  hookInfos: unknown[];
  preventedContinuation: boolean;
}

export interface LocalCommandEntry extends BaseEntry {
  type: 'system';
  subtype: 'local_command';
  content: string;
  level: string;
}

export interface ApiErrorEntry extends BaseEntry {
  type: 'system';
  subtype: 'api_error';
  statusCode: number;
  requestId?: string;
}

export type SystemEntry =
  | TurnDurationEntry
  | CompactBoundaryEntry
  | StopHookSummaryEntry
  | LocalCommandEntry
  | ApiErrorEntry;

export interface ProgressEntry extends BaseEntry {
  type: 'progress';
  data: {
    type: 'hook_progress' | 'agent_progress' | 'bash_progress' | 'waiting_for_task';
    [key: string]: unknown;
  };
  toolUseID?: string;
  parentToolUseID?: string;
}

export interface FileHistorySnapshotEntry {
  type: 'file-history-snapshot';
  messageId: string;
  snapshot: {
    messageId: string;
    trackedFileBackups: Record<string, unknown>;
    timestamp: string;
  };
  isSnapshotUpdate: boolean;
}

export interface QueueOperationEntry {
  type: 'queue-operation';
  operation: 'enqueue' | 'dequeue' | 'remove' | 'popAll';
  timestamp: string;
  sessionId: string;
  content?: string | unknown[];
}

export interface SummaryEntry {
  type: 'summary';
  summary: string;
  leafUuid: string;
}

export interface CustomTitleEntry {
  type: 'custom-title';
  customTitle: string;
  sessionId: string;
}

export interface AgentNameEntry {
  type: 'agent-name';
  agentName: string;
  sessionId: string;
}

export type SessionLogEntry =
  | UserEntry
  | AssistantEntry
  | SystemEntry
  | ProgressEntry
  | FileHistorySnapshotEntry
  | QueueOperationEntry
  | SummaryEntry
  | CustomTitleEntry
  | AgentNameEntry;

// ============================================================
// 5.7 Session File Metadata
// ============================================================

export interface CostBreakdown {
  totalUsd: number;
  inputCostUsd: number;
  outputCostUsd: number;
  cacheCreationCostUsd: number;
  cacheReadCostUsd: number;
}

export interface TokenSummary {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}

export interface SessionMeta {
  sessionId: string;
  projectPath: string;
  firstUserMessage: string;
  messageCount: number;
  firstTimestamp: string;
  lastTimestamp: string;
  totalCost: CostBreakdown;
  totalTokens: TokenSummary;
  modelName: string | null;
  version: string;
  slug?: string;
}

// ============================================================
// 5.8 CLI --output-format json Output
// ============================================================

export interface ClaudeResultOutput {
  type: 'result';
  subtype: 'success' | 'error';
  result: string;
  session_id: string;
  total_cost_usd: number;
  duration_ms: number;
  stop_reason: string;
}

// ============================================================
// 5.9 Active Session File
// ============================================================

export interface ActiveSessionFile {
  pid: number;
  sessionId: string;
  cwd: string;
  startedAt: number;
}

// ============================================================
// Security Config
// ============================================================

export interface SecurityConfig {
  allowedUserIds: string[];
  allowedTeamIds: string[];
  adminUserIds: string[];
}
```

- [ ] **Step 2: Verify types compile**

Run: `npx tsc --noEmit`
Expected: PASS (no errors)

- [ ] **Step 3: Commit**

---

### Task 4: Logger + Errors

**Files:**
- Create: `src/utils/logger.ts`, `src/utils/errors.ts`
- Test: `tests/utils/errors.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/utils/errors.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import {
  BridgeError,
  AuthError,
  RateLimitError,
  SessionError,
  ProcessError,
  ExecutionError,
  SlackApiError,
} from '../../src/utils/errors.js';

describe('BridgeError', () => {
  it('should create error with code and context', () => {
    const err = new BridgeError('something failed', 'UNKNOWN_ERROR', {
      sessionId: 'abc',
    });
    expect(err.message).toBe('something failed');
    expect(err.code).toBe('UNKNOWN_ERROR');
    expect(err.context).toEqual({ sessionId: 'abc' });
    expect(err).toBeInstanceOf(Error);
  });
});

describe('AuthError', () => {
  it('should create auth error with userId', () => {
    const err = new AuthError('not allowed', { userId: 'U123' });
    expect(err.code).toBe('AUTH_DENIED');
    expect(err.context).toEqual({ userId: 'U123' });
  });
});

describe('RateLimitError', () => {
  it('should include retryAfterMs', () => {
    const err = new RateLimitError('too fast', { userId: 'U123' });
    expect(err.code).toBe('RATE_LIMITED');
  });
});

describe('SessionError', () => {
  it('should create session not found error', () => {
    const err = SessionError.notFound('sess-123');
    expect(err.code).toBe('SESSION_NOT_FOUND');
    expect(err.context).toEqual({ sessionId: 'sess-123' });
  });

  it('should create session already ended error', () => {
    const err = SessionError.alreadyEnded('sess-123');
    expect(err.code).toBe('SESSION_ENDED');
  });
});

describe('ProcessError', () => {
  it('should create concurrency limit error', () => {
    const err = ProcessError.concurrencyLimit('U123', 1);
    expect(err.code).toBe('CONCURRENCY_LIMIT');
  });

  it('should create timeout error', () => {
    const err = ProcessError.timeout('sess-123', 300000);
    expect(err.code).toBe('PROCESS_TIMEOUT');
  });
});

describe('ExecutionError', () => {
  it('should include exitCode and stderr', () => {
    const err = new ExecutionError('cli failed', {
      sessionId: 'abc',
      exitCode: 1,
      stderr: 'error output',
    });
    expect(err.code).toBe('EXECUTION_FAILED');
    expect(err.context.exitCode).toBe(1);
  });
});

describe('SlackApiError', () => {
  it('should wrap slack api errors', () => {
    const err = new SlackApiError('chat.update failed', {
      method: 'chat.update',
      slackError: 'not_authed',
    });
    expect(err.code).toBe('SLACK_API_ERROR');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/utils/errors.test.ts --reporter=verbose`
Expected: FAIL

- [ ] **Step 3: Write implementation for errors.ts**

Create `src/utils/errors.ts`:
```typescript
export type ErrorCode =
  | 'UNKNOWN_ERROR'
  | 'AUTH_DENIED'
  | 'RATE_LIMITED'
  | 'SESSION_NOT_FOUND'
  | 'SESSION_ENDED'
  | 'CONCURRENCY_LIMIT'
  | 'PROCESS_TIMEOUT'
  | 'EXECUTION_FAILED'
  | 'SLACK_API_ERROR'
  | 'INVALID_COMMAND'
  | 'PROJECT_NOT_FOUND';

export class BridgeError extends Error {
  constructor(
    message: string,
    public readonly code: ErrorCode,
    public readonly context: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'BridgeError';
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      context: this.context,
    };
  }
}

export class AuthError extends BridgeError {
  constructor(message: string, context: Record<string, unknown> = {}) {
    super(message, 'AUTH_DENIED', context);
    this.name = 'AuthError';
  }
}

export class RateLimitError extends BridgeError {
  constructor(message: string, context: Record<string, unknown> = {}) {
    super(message, 'RATE_LIMITED', context);
    this.name = 'RateLimitError';
  }
}

export class SessionError extends BridgeError {
  constructor(
    message: string,
    code: ErrorCode,
    context: Record<string, unknown> = {},
  ) {
    super(message, code, context);
    this.name = 'SessionError';
  }

  static notFound(sessionId: string): SessionError {
    return new SessionError(
      `Session not found: ${sessionId}`,
      'SESSION_NOT_FOUND',
      { sessionId },
    );
  }

  static alreadyEnded(sessionId: string): SessionError {
    return new SessionError(
      `Session already ended: ${sessionId}`,
      'SESSION_ENDED',
      { sessionId },
    );
  }
}

export class ProcessError extends BridgeError {
  constructor(
    message: string,
    code: ErrorCode,
    context: Record<string, unknown> = {},
  ) {
    super(message, code, context);
    this.name = 'ProcessError';
  }

  static concurrencyLimit(userId: string, limit: number): ProcessError {
    return new ProcessError(
      `Concurrency limit reached for user ${userId} (max: ${limit})`,
      'CONCURRENCY_LIMIT',
      { userId, limit },
    );
  }

  static timeout(sessionId: string, timeoutMs: number): ProcessError {
    return new ProcessError(
      `Process timed out after ${timeoutMs}ms for session ${sessionId}`,
      'PROCESS_TIMEOUT',
      { sessionId, timeoutMs },
    );
  }
}

export class ExecutionError extends BridgeError {
  constructor(
    message: string,
    context: Record<string, unknown> & {
      sessionId: string;
      exitCode?: number | null;
      stderr?: string;
    },
  ) {
    super(message, 'EXECUTION_FAILED', context);
    this.name = 'ExecutionError';
  }
}

export class SlackApiError extends BridgeError {
  constructor(
    message: string,
    context: Record<string, unknown> & {
      method: string;
      slackError?: string;
    },
  ) {
    super(message, 'SLACK_API_ERROR', context);
    this.name = 'SlackApiError';
  }
}
```

- [ ] **Step 4: Write implementation for logger.ts**

Create `src/utils/logger.ts`:
```typescript
import winston from 'winston';

const LOG_LEVEL = process.env.LOG_LEVEL || 'info';

export const logger = winston.createLogger({
  level: LOG_LEVEL,
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
    winston.format.errors({ stack: true }),
    winston.format.json(),
  ),
  defaultMeta: { service: 'claude-slack-bridge' },
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.printf(({ timestamp, level, message, ...meta }) => {
          const metaStr = Object.keys(meta).length > 1
            ? ` ${JSON.stringify(meta, null, 0)}`
            : '';
          return `${timestamp} [${level}] ${message}${metaStr}`;
        }),
      ),
    }),
  ],
});
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/utils/errors.test.ts --reporter=verbose`
Expected: PASS

- [ ] **Step 6: Commit**

---

## Chunk 2: Auth, Bolt, Sanitizer (Tasks 5-7)

### Task 5: Bolt App Initialization + Socket Mode

**Files:**
- Create: `src/app.ts`

- [ ] **Step 1: Write Bolt app setup**

Create `src/app.ts`:
```typescript
import { App, LogLevel } from '@slack/bolt';
import { config } from './config.js';
import { logger } from './utils/logger.js';

const logLevelMap: Record<string, LogLevel> = {
  error: LogLevel.ERROR,
  warn: LogLevel.WARN,
  info: LogLevel.INFO,
  debug: LogLevel.DEBUG,
};

export function createApp(): App {
  const app = new App({
    token: config.slackBotToken,
    appToken: config.slackAppToken,
    socketMode: true,
    logLevel: logLevelMap[config.logLevel] || LogLevel.INFO,
  });

  logger.info('Bolt app created with Socket Mode');
  return app;
}

export async function startApp(app: App): Promise<void> {
  await app.start();
  logger.info('Bolt app started successfully');
}
```

- [ ] **Step 2: Update src/index.ts to use app**

Update `src/index.ts`:
```typescript
import { createApp, startApp } from './app.js';
import { logger } from './utils/logger.js';

async function main(): Promise<void> {
  const app = createApp();

  // Register handlers will go here in later tasks

  await startApp(app);
  logger.info('Claude Code Slack Bridge is running');

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info(`Received ${signal}, shutting down...`);
    await app.stop();
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  logger.error('Fatal error', { error: err });
  process.exit(1);
});
```

- [ ] **Step 3: Verify compilation**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 4: Commit**

---

### Task 6: Auth Middleware + Rate Limiter

**Files:**
- Create: `src/middleware/auth.ts`, `src/middleware/rate-limiter.ts`
- Test: `tests/middleware/auth.test.ts`, `tests/middleware/rate-limiter.test.ts`

- [ ] **Step 1: Write auth failing test**

Create `tests/middleware/auth.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { AuthMiddleware } from '../../src/middleware/auth.js';

describe('AuthMiddleware', () => {
  it('should allow all users when allowlist is empty', () => {
    const auth = new AuthMiddleware({
      allowedUserIds: [],
      allowedTeamIds: [],
      adminUserIds: [],
    });
    expect(auth.isAllowed('U_ANY', 'T_ANY')).toBe(true);
  });

  it('should deny user not in allowlist', () => {
    const auth = new AuthMiddleware({
      allowedUserIds: ['U111', 'U222'],
      allowedTeamIds: [],
      adminUserIds: [],
    });
    expect(auth.isAllowed('U999', 'T_ANY')).toBe(false);
  });

  it('should allow user in allowlist', () => {
    const auth = new AuthMiddleware({
      allowedUserIds: ['U111', 'U222'],
      allowedTeamIds: [],
      adminUserIds: [],
    });
    expect(auth.isAllowed('U111', 'T_ANY')).toBe(true);
  });

  it('should allow user when team matches', () => {
    const auth = new AuthMiddleware({
      allowedUserIds: [],
      allowedTeamIds: ['T111'],
      adminUserIds: [],
    });
    expect(auth.isAllowed('U_ANY', 'T111')).toBe(true);
    expect(auth.isAllowed('U_ANY', 'T999')).toBe(false);
  });

  it('should identify admin users', () => {
    const auth = new AuthMiddleware({
      allowedUserIds: [],
      allowedTeamIds: [],
      adminUserIds: ['U_ADMIN'],
    });
    expect(auth.isAdmin('U_ADMIN')).toBe(true);
    expect(auth.isAdmin('U_OTHER')).toBe(false);
  });

  it('should allow admin even if not in user allowlist', () => {
    const auth = new AuthMiddleware({
      allowedUserIds: ['U111'],
      allowedTeamIds: [],
      adminUserIds: ['U_ADMIN'],
    });
    expect(auth.isAllowed('U_ADMIN', 'T_ANY')).toBe(true);
  });
});
```

- [ ] **Step 2: Write rate limiter failing test**

Create `tests/middleware/rate-limiter.test.ts`:
```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RateLimiter } from '../../src/middleware/rate-limiter.js';

describe('RateLimiter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should allow requests under the limit', () => {
    const limiter = new RateLimiter({ maxRequests: 10, windowMs: 60_000 });
    for (let i = 0; i < 10; i++) {
      expect(limiter.check('U123').allowed).toBe(true);
    }
  });

  it('should block requests over the limit', () => {
    const limiter = new RateLimiter({ maxRequests: 3, windowMs: 60_000 });
    limiter.check('U123');
    limiter.check('U123');
    limiter.check('U123');
    const result = limiter.check('U123');
    expect(result.allowed).toBe(false);
    expect(result.retryAfterMs).toBeGreaterThan(0);
  });

  it('should reset after window expires', () => {
    const limiter = new RateLimiter({ maxRequests: 2, windowMs: 60_000 });
    limiter.check('U123');
    limiter.check('U123');
    expect(limiter.check('U123').allowed).toBe(false);

    vi.advanceTimersByTime(60_001);
    expect(limiter.check('U123').allowed).toBe(true);
  });

  it('should track users independently', () => {
    const limiter = new RateLimiter({ maxRequests: 1, windowMs: 60_000 });
    expect(limiter.check('U111').allowed).toBe(true);
    expect(limiter.check('U222').allowed).toBe(true);
    expect(limiter.check('U111').allowed).toBe(false);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run tests/middleware/ --reporter=verbose`
Expected: FAIL

- [ ] **Step 4: Write auth implementation**

Create `src/middleware/auth.ts`:
```typescript
import type { SecurityConfig } from '../types.js';
import { logger } from '../utils/logger.js';

export class AuthMiddleware {
  private readonly allowedUserIds: Set<string>;
  private readonly allowedTeamIds: Set<string>;
  private readonly adminUserIds: Set<string>;
  private readonly hasUserRestrictions: boolean;
  private readonly hasTeamRestrictions: boolean;

  constructor(securityConfig: SecurityConfig) {
    this.allowedUserIds = new Set(securityConfig.allowedUserIds);
    this.allowedTeamIds = new Set(securityConfig.allowedTeamIds);
    this.adminUserIds = new Set(securityConfig.adminUserIds);
    this.hasUserRestrictions = this.allowedUserIds.size > 0;
    this.hasTeamRestrictions = this.allowedTeamIds.size > 0;
  }

  isAllowed(userId: string, teamId?: string): boolean {
    if (this.adminUserIds.has(userId)) {
      return true;
    }

    if (!this.hasUserRestrictions && !this.hasTeamRestrictions) {
      return true;
    }

    if (this.hasUserRestrictions && this.allowedUserIds.has(userId)) {
      return true;
    }

    if (this.hasTeamRestrictions && teamId && this.allowedTeamIds.has(teamId)) {
      return true;
    }

    logger.warn('Auth denied', { userId, teamId });
    return false;
  }

  isAdmin(userId: string): boolean {
    return this.adminUserIds.has(userId);
  }
}
```

- [ ] **Step 5: Write rate limiter implementation**

Create `src/middleware/rate-limiter.ts`:
```typescript
import { logger } from '../utils/logger.js';

export interface RateLimiterConfig {
  maxRequests: number;
  windowMs: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterMs?: number;
}

interface UserWindow {
  timestamps: number[];
  windowStart: number;
}

export class RateLimiter {
  private readonly windows: Map<string, UserWindow> = new Map();
  private readonly maxRequests: number;
  private readonly windowMs: number;

  constructor(config: RateLimiterConfig) {
    this.maxRequests = config.maxRequests;
    this.windowMs = config.windowMs;
  }

  check(userId: string): RateLimitResult {
    const now = Date.now();
    let window = this.windows.get(userId);

    if (!window || now - window.windowStart > this.windowMs) {
      window = { timestamps: [], windowStart: now };
      this.windows.set(userId, window);
    }

    // Remove expired timestamps
    window.timestamps = window.timestamps.filter(
      (ts) => now - ts < this.windowMs,
    );

    if (window.timestamps.length >= this.maxRequests) {
      const oldestInWindow = window.timestamps[0];
      const retryAfterMs = this.windowMs - (now - oldestInWindow);
      logger.debug('Rate limited', { userId, retryAfterMs });
      return {
        allowed: false,
        remaining: 0,
        retryAfterMs: Math.max(retryAfterMs, 0),
      };
    }

    window.timestamps.push(now);
    return {
      allowed: true,
      remaining: this.maxRequests - window.timestamps.length,
    };
  }

  reset(userId: string): void {
    this.windows.delete(userId);
  }
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run tests/middleware/ --reporter=verbose`
Expected: PASS

- [ ] **Step 7: Commit**

---

### Task 7: Sanitizer

**Files:**
- Create: `src/utils/sanitizer.ts`
- Test: `tests/utils/sanitizer.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/utils/sanitizer.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { sanitizeUserInput, sanitizeOutput } from '../../src/utils/sanitizer.js';

describe('sanitizeUserInput', () => {
  it('should replace user mentions with placeholder', () => {
    expect(sanitizeUserInput('Hello <@U12345>!')).toBe(
      'Hello [user-mention]!',
    );
  });

  it('should replace channel references', () => {
    expect(sanitizeUserInput('See <#C12345|general>')).toBe(
      'See [channel]',
    );
  });

  it('should extract URLs from Slack formatting', () => {
    expect(sanitizeUserInput('Visit <https://example.com|Example>')).toBe(
      'Visit https://example.com',
    );
  });

  it('should extract plain URLs from Slack formatting', () => {
    expect(sanitizeUserInput('Visit <https://example.com>')).toBe(
      'Visit https://example.com',
    );
  });

  it('should handle multiple replacements', () => {
    const input = 'Hey <@U111>, check <#C222|dev> and <https://example.com>';
    const expected = 'Hey [user-mention], check [channel] and https://example.com';
    expect(sanitizeUserInput(input)).toBe(expected);
  });

  it('should pass through normal text unchanged', () => {
    expect(sanitizeUserInput('normal text')).toBe('normal text');
  });
});

describe('sanitizeOutput', () => {
  it('should redact Anthropic API keys', () => {
    const input = 'Key: sk-ant-api03-abcdefghijklmnopqrstuvwxyz';
    expect(sanitizeOutput(input)).toContain('sk-***REDACTED***');
  });

  it('should redact Slack bot tokens', () => {
    const input = 'Token: xoxb-123-456-abc';
    expect(sanitizeOutput(input)).toContain('xoxb-***REDACTED***');
  });

  it('should redact Slack app tokens', () => {
    const input = 'Token: xapp-1-A02-123';
    expect(sanitizeOutput(input)).toContain('xapp-***REDACTED***');
  });

  it('should redact OpenAI API keys', () => {
    const input = 'Key: sk-proj-abcdefghijklmnopqrstuvwxyz';
    expect(sanitizeOutput(input)).toContain('sk-***REDACTED***');
  });

  it('should handle multiple secrets in one string', () => {
    const input = 'bot: xoxb-123-456 app: xapp-1-A-123';
    const result = sanitizeOutput(input);
    expect(result).not.toContain('xoxb-123');
    expect(result).not.toContain('xapp-1-A');
  });

  it('should pass through safe text unchanged', () => {
    expect(sanitizeOutput('hello world')).toBe('hello world');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/utils/sanitizer.test.ts --reporter=verbose`
Expected: FAIL

- [ ] **Step 3: Write implementation**

Create `src/utils/sanitizer.ts`:
```typescript
/**
 * Sanitize user input from Slack before passing to Claude Code.
 * Normalizes Slack-specific formatting (mentions, channels, URLs).
 */
export function sanitizeUserInput(input: string): string {
  return input
    .replace(/<@[A-Z0-9]+>/g, '[user-mention]')
    .replace(/<#[A-Z0-9]+\|[^>]+>/g, '[channel]')
    .replace(/<(https?:\/\/[^|>]+)(\|[^>]+)?>/g, '$1');
}

/**
 * Sanitize output before sending to Slack.
 * Masks API keys, tokens, and other secrets.
 */
export function sanitizeOutput(output: string): string {
  return output
    .replace(/(sk-[a-zA-Z0-9_-]{20,})/g, 'sk-***REDACTED***')
    .replace(/(xoxb-[a-zA-Z0-9-]+)/g, 'xoxb-***REDACTED***')
    .replace(/(xapp-[a-zA-Z0-9-]+)/g, 'xapp-***REDACTED***');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/utils/sanitizer.test.ts --reporter=verbose`
Expected: PASS

- [ ] **Step 5: Commit**

---

## Chunk 3: Stores + Session Manager (Tasks 8-10)

### Task 8: ProjectStore

**Files:**
- Create: `src/store/project-store.ts`
- Test: `tests/store/project-store.test.ts`

**Depends on:** Task 3 (types)

- [ ] **Step 1: Write the failing test**

Create `tests/store/project-store.test.ts`:
```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ProjectStore } from '../../src/store/project-store.js';

vi.mock('node:fs');

const mockFs = vi.mocked(fs);

describe('ProjectStore', () => {
  const testProjectsDir = '/home/user/.claude/projects';

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('should list projects from .claude/projects directory', () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readdirSync.mockReturnValue([
      { name: '-Users-user-dev-webapp', isDirectory: () => true, isFile: () => false },
      { name: '-Users-user-dev-api', isDirectory: () => true, isFile: () => false },
    ] as unknown as fs.Dirent[]);

    // For each project dir, list session files
    mockFs.readdirSync.mockImplementation((dirPath: fs.PathLike) => {
      const p = dirPath.toString();
      if (p === testProjectsDir) {
        return [
          { name: '-Users-user-dev-webapp', isDirectory: () => true, isFile: () => false },
          { name: '-Users-user-dev-api', isDirectory: () => true, isFile: () => false },
        ] as unknown as fs.Dirent[];
      }
      // Session files inside project dir
      return [
        { name: 'abc-123.jsonl', isDirectory: () => false, isFile: () => true },
      ] as unknown as fs.Dirent[];
    });

    mockFs.statSync.mockReturnValue({
      mtimeMs: Date.now(),
      mtime: new Date(),
      size: 1024,
      isFile: () => true,
      isDirectory: () => false,
    } as unknown as fs.Stats);

    const store = new ProjectStore(testProjectsDir);
    const projects = store.getProjects();

    expect(projects.length).toBe(2);
    expect(projects[0].id).toBe('-Users-user-dev-webapp');
    expect(projects[0].sessionCount).toBe(1);
  });

  it('should use TTL cache and not re-scan within 30 seconds', () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readdirSync.mockReturnValue([] as unknown as fs.Dirent[]);

    const store = new ProjectStore(testProjectsDir);
    store.getProjects();
    store.getProjects();

    // readdirSync called only once for the base dir scan
    expect(mockFs.readdirSync).toHaveBeenCalledTimes(1);
  });

  it('should refresh cache after TTL expires', () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readdirSync.mockReturnValue([] as unknown as fs.Dirent[]);

    const store = new ProjectStore(testProjectsDir);
    store.getProjects();

    vi.advanceTimersByTime(31_000);
    store.getProjects();

    expect(mockFs.readdirSync).toHaveBeenCalledTimes(2);
  });

  it('should return empty array when projects dir does not exist', () => {
    mockFs.existsSync.mockReturnValue(false);

    const store = new ProjectStore(testProjectsDir);
    const projects = store.getProjects();

    expect(projects).toEqual([]);
  });

  it('should resolve project path from first session cwd', () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readdirSync.mockImplementation((dirPath: fs.PathLike) => {
      const p = dirPath.toString();
      if (p === testProjectsDir) {
        return [
          { name: '-Users-user-dev-webapp', isDirectory: () => true, isFile: () => false },
        ] as unknown as fs.Dirent[];
      }
      return [
        { name: 'sess1.jsonl', isDirectory: () => false, isFile: () => true },
      ] as unknown as fs.Dirent[];
    });

    mockFs.statSync.mockReturnValue({
      mtimeMs: Date.now(),
      mtime: new Date(),
      size: 512,
      isFile: () => true,
      isDirectory: () => false,
    } as unknown as fs.Stats);

    // Mock reading first line for cwd
    mockFs.readFileSync.mockReturnValue(
      '{"type":"user","cwd":"/Users/user/dev/webapp","sessionId":"s1","message":{"role":"user","content":"hi"}}\n'
    );

    const store = new ProjectStore(testProjectsDir);
    const resolved = store.resolveProjectPath('-Users-user-dev-webapp');

    expect(resolved).toBe('/Users/user/dev/webapp');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/store/project-store.test.ts --reporter=verbose`
Expected: FAIL

- [ ] **Step 3: Write implementation**

Create `src/store/project-store.ts`:
```typescript
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ProjectInfo, SessionInfoLight } from '../types.js';
import { logger } from '../utils/logger.js';

export class ProjectStore {
  private cache: { data: ProjectInfo[]; fetchedAt: number } | null = null;
  private readonly CACHE_TTL_MS = 30_000;
  private readonly pathCache: Map<string, string> = new Map();

  constructor(private readonly projectsDir: string) {}

  getProjects(): ProjectInfo[] {
    if (this.cache && Date.now() - this.cache.fetchedAt < this.CACHE_TTL_MS) {
      return this.cache.data;
    }

    const projects = this.scanProjects();
    this.cache = { data: projects, fetchedAt: Date.now() };
    return projects;
  }

  invalidateCache(): void {
    this.cache = null;
  }

  getSessionFiles(projectId: string): SessionInfoLight[] {
    const projectDir = path.join(this.projectsDir, projectId);
    if (!fs.existsSync(projectDir)) return [];

    try {
      const entries = fs.readdirSync(projectDir, { withFileTypes: true });
      const sessions: SessionInfoLight[] = [];

      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith('.jsonl')) {
          const filePath = path.join(projectDir, entry.name);
          const stat = fs.statSync(filePath);
          sessions.push({
            sessionId: entry.name.replace('.jsonl', ''),
            updatedAt: stat.mtime,
            sizeBytes: stat.size,
          });
        }
      }

      return sessions.sort(
        (a, b) => b.updatedAt.getTime() - a.updatedAt.getTime(),
      );
    } catch (err) {
      logger.error('Failed to list session files', { projectId, error: err });
      return [];
    }
  }

  resolveProjectPath(projectId: string): string | null {
    const cached = this.pathCache.get(projectId);
    if (cached) return cached;

    const projectDir = path.join(this.projectsDir, projectId);
    if (!fs.existsSync(projectDir)) return null;

    try {
      const entries = fs.readdirSync(projectDir, { withFileTypes: true });
      const firstJsonl = entries.find(
        (e) => e.isFile() && e.name.endsWith('.jsonl'),
      );
      if (!firstJsonl) return null;

      const filePath = path.join(projectDir, firstJsonl.name);
      const content = fs.readFileSync(filePath, 'utf-8');
      const firstLine = content.split('\n')[0];
      if (!firstLine) return null;

      const parsed = JSON.parse(firstLine);
      if (parsed.cwd) {
        this.pathCache.set(projectId, parsed.cwd);
        return parsed.cwd;
      }
    } catch (err) {
      logger.debug('Failed to resolve project path', { projectId, error: err });
    }

    return null;
  }

  private scanProjects(): ProjectInfo[] {
    if (!fs.existsSync(this.projectsDir)) {
      logger.warn('Projects directory not found', { path: this.projectsDir });
      return [];
    }

    try {
      const entries = fs.readdirSync(this.projectsDir, { withFileTypes: true });
      const projects: ProjectInfo[] = [];

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        const projectDir = path.join(this.projectsDir, entry.name);
        const sessions = this.countSessionFiles(projectDir);
        const lastModified = this.getLastModified(projectDir);
        const projectPath = this.resolveProjectPath(entry.name) || entry.name;

        projects.push({
          id: entry.name,
          projectPath,
          sessionCount: sessions,
          lastModified,
        });
      }

      return projects.sort(
        (a, b) => b.lastModified.getTime() - a.lastModified.getTime(),
      );
    } catch (err) {
      logger.error('Failed to scan projects', { error: err });
      return [];
    }
  }

  private countSessionFiles(projectDir: string): number {
    try {
      const entries = fs.readdirSync(projectDir, { withFileTypes: true });
      return entries.filter(
        (e) => e.isFile() && e.name.endsWith('.jsonl'),
      ).length;
    } catch {
      return 0;
    }
  }

  private getLastModified(projectDir: string): Date {
    try {
      const stat = fs.statSync(projectDir);
      return stat.mtime;
    } catch {
      return new Date(0);
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/store/project-store.test.ts --reporter=verbose`
Expected: PASS

- [ ] **Step 5: Commit**

---

### Task 9: SessionStore

**Files:**
- Create: `src/store/session-store.ts`
- Test: `tests/store/session-store.test.ts`

**Depends on:** Task 3 (types)

- [ ] **Step 1: Write the failing test**

Create `tests/store/session-store.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { SessionStore } from '../../src/store/session-store.js';

describe('SessionStore', () => {
  it('should generate deterministic session ID from thread_ts', () => {
    const store = new SessionStore();
    const id1 = store.threadTsToSessionId('1710567000.000100');
    const id2 = store.threadTsToSessionId('1710567000.000100');
    expect(id1).toBe(id2);
    expect(id1).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('should generate different IDs for different thread_ts', () => {
    const store = new SessionStore();
    const id1 = store.threadTsToSessionId('1710567000.000100');
    const id2 = store.threadTsToSessionId('1710567000.000200');
    expect(id1).not.toBe(id2);
  });

  it('should create and retrieve session metadata', () => {
    const store = new SessionStore();
    const session = store.create({
      threadTs: '1710567000.000100',
      dmChannelId: 'D123',
      projectPath: '/Users/user/dev/webapp',
      name: 'webapp: implement auth',
      model: 'sonnet',
    });

    expect(session.status).toBe('active');
    expect(session.model).toBe('sonnet');
    expect(session.turnCount).toBe(0);

    const retrieved = store.get(session.sessionId);
    expect(retrieved).toEqual(session);
  });

  it('should find session by thread_ts', () => {
    const store = new SessionStore();
    const session = store.create({
      threadTs: '1710567000.000100',
      dmChannelId: 'D123',
      projectPath: '/dev/app',
      name: 'test session',
      model: 'opus',
    });

    const found = store.findByThreadTs('1710567000.000100');
    expect(found?.sessionId).toBe(session.sessionId);
  });

  it('should return undefined for unknown session', () => {
    const store = new SessionStore();
    expect(store.get('nonexistent')).toBeUndefined();
    expect(store.findByThreadTs('999.000')).toBeUndefined();
  });

  it('should update session fields', () => {
    const store = new SessionStore();
    const session = store.create({
      threadTs: '1710567000.000100',
      dmChannelId: 'D123',
      projectPath: '/dev/app',
      name: 'test',
      model: 'opus',
    });

    store.update(session.sessionId, {
      model: 'haiku',
      totalCost: 0.05,
      turnCount: 3,
    });

    const updated = store.get(session.sessionId);
    expect(updated?.model).toBe('haiku');
    expect(updated?.totalCost).toBe(0.05);
    expect(updated?.turnCount).toBe(3);
  });

  it('should end session', () => {
    const store = new SessionStore();
    const session = store.create({
      threadTs: '1710567000.000100',
      dmChannelId: 'D123',
      projectPath: '/dev/app',
      name: 'test',
      model: 'opus',
    });

    store.end(session.sessionId);
    const ended = store.get(session.sessionId);
    expect(ended?.status).toBe('ended');
  });

  it('should list active sessions', () => {
    const store = new SessionStore();
    store.create({
      threadTs: '1.000',
      dmChannelId: 'D1',
      projectPath: '/a',
      name: 'a',
      model: 'opus',
    });
    const s2 = store.create({
      threadTs: '2.000',
      dmChannelId: 'D1',
      projectPath: '/b',
      name: 'b',
      model: 'opus',
    });

    store.end(s2.sessionId);

    const active = store.getActiveSessions();
    expect(active.length).toBe(1);
    expect(active[0].name).toBe('a');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/store/session-store.test.ts --reporter=verbose`
Expected: FAIL

- [ ] **Step 3: Write implementation**

Create `src/store/session-store.ts`:
```typescript
import { v5 as uuidv5 } from 'uuid';
import type { SessionMetadata, ModelChoice } from '../types.js';
import { logger } from '../utils/logger.js';

const BRIDGE_NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';

export interface CreateSessionParams {
  threadTs: string;
  dmChannelId: string;
  projectPath: string;
  name: string;
  model: ModelChoice;
}

export class SessionStore {
  private sessions: Map<string, SessionMetadata> = new Map();
  private threadTsIndex: Map<string, string> = new Map();

  threadTsToSessionId(threadTs: string): string {
    return uuidv5(threadTs, BRIDGE_NAMESPACE);
  }

  create(params: CreateSessionParams): SessionMetadata {
    const sessionId = this.threadTsToSessionId(params.threadTs);
    const now = new Date();

    const session: SessionMetadata = {
      sessionId,
      threadTs: params.threadTs,
      dmChannelId: params.dmChannelId,
      projectPath: params.projectPath,
      name: params.name,
      model: params.model,
      status: 'active',
      startTime: now,
      totalCost: 0,
      turnCount: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      lastActiveAt: now,
      anchorCollapsed: false,
    };

    this.sessions.set(sessionId, session);
    this.threadTsIndex.set(params.threadTs, sessionId);

    logger.info('Session created', { sessionId, projectPath: params.projectPath });
    return session;
  }

  get(sessionId: string): SessionMetadata | undefined {
    return this.sessions.get(sessionId);
  }

  findByThreadTs(threadTs: string): SessionMetadata | undefined {
    const sessionId = this.threadTsIndex.get(threadTs);
    if (!sessionId) return undefined;
    return this.sessions.get(sessionId);
  }

  update(
    sessionId: string,
    updates: Partial<Omit<SessionMetadata, 'sessionId' | 'threadTs' | 'dmChannelId'>>,
  ): SessionMetadata | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;

    const updated = { ...session, ...updates, lastActiveAt: new Date() };
    this.sessions.set(sessionId, updated);
    return updated;
  }

  end(sessionId: string): SessionMetadata | undefined {
    return this.update(sessionId, { status: 'ended' });
  }

  getActiveSessions(): SessionMetadata[] {
    return Array.from(this.sessions.values()).filter(
      (s) => s.status === 'active',
    );
  }

  getAllSessions(): SessionMetadata[] {
    return Array.from(this.sessions.values());
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/store/session-store.test.ts --reporter=verbose`
Expected: PASS

- [ ] **Step 5: Commit**

---

### Task 10: SessionManager

**Files:**
- Create: `src/bridge/session-manager.ts`
- Test: `tests/bridge/session-manager.test.ts`

**Depends on:** Task 9 (session-store)

- [ ] **Step 1: Write the failing test**

Create `tests/bridge/session-manager.test.ts`:
```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SessionManager } from '../../src/bridge/session-manager.js';
import { SessionStore } from '../../src/store/session-store.js';
import { ProjectStore } from '../../src/store/project-store.js';

describe('SessionManager', () => {
  let sessionStore: SessionStore;
  let projectStore: ProjectStore;
  let manager: SessionManager;

  beforeEach(() => {
    sessionStore = new SessionStore();
    projectStore = {
      getProjects: vi.fn().mockReturnValue([
        { id: '-Users-user-dev-webapp', projectPath: '/Users/user/dev/webapp', sessionCount: 5, lastModified: new Date() },
      ]),
      resolveProjectPath: vi.fn().mockReturnValue('/Users/user/dev/webapp'),
    } as unknown as ProjectStore;
    manager = new SessionManager(sessionStore, projectStore);
  });

  it('should create a new session for a new thread', () => {
    const result = manager.resolveOrCreate({
      threadTs: '1710567000.000100',
      dmChannelId: 'D123',
      projectId: '-Users-user-dev-webapp',
      promptText: 'implement authentication',
    });

    expect(result.isNew).toBe(true);
    expect(result.session.status).toBe('active');
    expect(result.session.name).toBe('implement authentication');
    expect(result.session.projectPath).toBe('/Users/user/dev/webapp');
  });

  it('should resume an existing session for a known thread', () => {
    // Create first
    manager.resolveOrCreate({
      threadTs: '1710567000.000100',
      dmChannelId: 'D123',
      projectId: '-Users-user-dev-webapp',
      promptText: 'implement auth',
    });

    // Resolve again
    const result = manager.resolveOrCreate({
      threadTs: '1710567000.000100',
      dmChannelId: 'D123',
      projectId: '-Users-user-dev-webapp',
      promptText: 'add tests',
    });

    expect(result.isNew).toBe(false);
    expect(result.session.name).toBe('implement auth');
  });

  it('should truncate long session names to 30 characters', () => {
    const result = manager.resolveOrCreate({
      threadTs: '1710567000.000100',
      dmChannelId: 'D123',
      projectId: '-Users-user-dev-webapp',
      promptText: 'a very long prompt that exceeds thirty characters definitely',
    });

    expect(result.session.name.length).toBeLessThanOrEqual(33); // 30 + "..."
  });

  it('should end session', () => {
    const { session } = manager.resolveOrCreate({
      threadTs: '1.000',
      dmChannelId: 'D1',
      projectId: '-Users-user-dev-webapp',
      promptText: 'hello',
    });

    const ended = manager.endSession(session.sessionId);
    expect(ended?.status).toBe('ended');
  });

  it('should throw on ending already ended session', () => {
    const { session } = manager.resolveOrCreate({
      threadTs: '1.000',
      dmChannelId: 'D1',
      projectId: '-Users-user-dev-webapp',
      promptText: 'hello',
    });

    manager.endSession(session.sessionId);
    expect(() => manager.endSession(session.sessionId)).toThrow('SESSION_ENDED');
  });

  it('should increment turn count on recordTurn', () => {
    const { session } = manager.resolveOrCreate({
      threadTs: '1.000',
      dmChannelId: 'D1',
      projectId: '-Users-user-dev-webapp',
      promptText: 'hello',
    });

    manager.recordTurn(session.sessionId, { cost: 0.02, inputTokens: 1000, outputTokens: 500 });

    const updated = sessionStore.get(session.sessionId);
    expect(updated?.turnCount).toBe(1);
    expect(updated?.totalCost).toBe(0.02);
    expect(updated?.totalInputTokens).toBe(1000);
    expect(updated?.totalOutputTokens).toBe(500);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/bridge/session-manager.test.ts --reporter=verbose`
Expected: FAIL

- [ ] **Step 3: Write implementation**

Create `src/bridge/session-manager.ts`:
```typescript
import type { SessionMetadata } from '../types.js';
import type { SessionStore } from '../store/session-store.js';
import type { ProjectStore } from '../store/project-store.js';
import { SessionError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

export interface ResolveParams {
  threadTs: string;
  dmChannelId: string;
  projectId: string;
  promptText: string;
}

export interface ResolveResult {
  session: SessionMetadata;
  isNew: boolean;
}

export interface TurnResult {
  cost: number;
  inputTokens: number;
  outputTokens: number;
}

const MAX_SESSION_NAME_LENGTH = 30;

export class SessionManager {
  constructor(
    private readonly sessionStore: SessionStore,
    private readonly projectStore: ProjectStore,
  ) {}

  resolveOrCreate(params: ResolveParams): ResolveResult {
    const existing = this.sessionStore.findByThreadTs(params.threadTs);
    if (existing) {
      logger.debug('Resuming existing session', { sessionId: existing.sessionId });
      return { session: existing, isNew: false };
    }

    const projectPath =
      this.projectStore.resolveProjectPath(params.projectId) || params.projectId;

    let name = params.promptText.trim();
    if (name.length > MAX_SESSION_NAME_LENGTH) {
      name = name.substring(0, MAX_SESSION_NAME_LENGTH) + '...';
    }

    const session = this.sessionStore.create({
      threadTs: params.threadTs,
      dmChannelId: params.dmChannelId,
      projectPath,
      name,
      model: 'sonnet', // default model
    });

    return { session, isNew: true };
  }

  endSession(sessionId: string): SessionMetadata {
    const session = this.sessionStore.get(sessionId);
    if (!session) {
      throw SessionError.notFound(sessionId);
    }
    if (session.status === 'ended') {
      throw SessionError.alreadyEnded(sessionId);
    }

    const ended = this.sessionStore.end(sessionId);
    if (!ended) {
      throw SessionError.notFound(sessionId);
    }

    logger.info('Session ended', { sessionId });
    return ended;
  }

  recordTurn(sessionId: string, result: TurnResult): void {
    const session = this.sessionStore.get(sessionId);
    if (!session) return;

    this.sessionStore.update(sessionId, {
      turnCount: session.turnCount + 1,
      totalCost: session.totalCost + result.cost,
      totalInputTokens: session.totalInputTokens + result.inputTokens,
      totalOutputTokens: session.totalOutputTokens + result.outputTokens,
    });
  }

  getSession(sessionId: string): SessionMetadata | undefined {
    return this.sessionStore.get(sessionId);
  }

  getSessionByThread(threadTs: string): SessionMetadata | undefined {
    return this.sessionStore.findByThreadTs(threadTs);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/bridge/session-manager.test.ts --reporter=verbose`
Expected: PASS

- [ ] **Step 5: Commit**

---

## Chunk 4: Process Manager + Executor (Tasks 11-12)

### Task 11: ProcessManager

**Files:**
- Create: `src/bridge/process-manager.ts`
- Test: `tests/bridge/process-manager.test.ts`

**Depends on:** Task 3 (types)

- [ ] **Step 1: Write the failing test**

Create `tests/bridge/process-manager.test.ts`:
```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { ProcessManager } from '../../src/bridge/process-manager.js';
import type { ProcessManagerConfig } from '../../src/types.js';

function createMockProcess(): EventEmitter & { pid: number; kill: ReturnType<typeof vi.fn>; stdin: null; stdout: EventEmitter; stderr: EventEmitter } {
  const proc = new EventEmitter() as any;
  proc.pid = Math.floor(Math.random() * 100000);
  proc.kill = vi.fn();
  proc.stdin = null;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  return proc;
}

describe('ProcessManager', () => {
  let pm: ProcessManager;
  const testConfig: ProcessManagerConfig = {
    maxConcurrentPerUser: 1,
    maxConcurrentGlobal: 3,
    defaultTimeoutMs: 5000,
    maxTimeoutMs: 30000,
    defaultBudgetUsd: 1.0,
    maxBudgetUsd: 10.0,
  };

  beforeEach(() => {
    vi.useFakeTimers();
    pm = new ProcessManager(testConfig);
  });

  afterEach(() => {
    pm.killAll();
    vi.useRealTimers();
  });

  it('should check if a user can start a new process', () => {
    expect(pm.canStart('U123')).toBe(true);
  });

  it('should register a managed process', () => {
    const proc = createMockProcess();
    pm.register({
      sessionId: 'sess-1',
      userId: 'U123',
      channelId: 'D123',
      projectId: 'proj-1',
      process: proc as any,
    });

    expect(pm.canStart('U123')).toBe(false);
    expect(pm.getRunningCount()).toBe(1);
  });

  it('should enforce per-user concurrency limit', () => {
    const proc = createMockProcess();
    pm.register({
      sessionId: 'sess-1',
      userId: 'U123',
      channelId: 'D123',
      projectId: 'proj-1',
      process: proc as any,
    });

    expect(pm.canStart('U123')).toBe(false);
    expect(pm.canStart('U456')).toBe(true);
  });

  it('should enforce global concurrency limit', () => {
    for (let i = 0; i < 3; i++) {
      const proc = createMockProcess();
      pm.register({
        sessionId: `sess-${i}`,
        userId: `U${i}`,
        channelId: `D${i}`,
        projectId: 'proj',
        process: proc as any,
      });
    }

    expect(pm.canStart('U_NEW')).toBe(false);
    expect(pm.getRunningCount()).toBe(3);
  });

  it('should remove process on exit', () => {
    const proc = createMockProcess();
    pm.register({
      sessionId: 'sess-1',
      userId: 'U123',
      channelId: 'D123',
      projectId: 'proj-1',
      process: proc as any,
    });

    expect(pm.getRunningCount()).toBe(1);
    proc.emit('exit', 0, null);
    expect(pm.getRunningCount()).toBe(0);
  });

  it('should timeout process after configured duration', () => {
    const proc = createMockProcess();
    pm.register({
      sessionId: 'sess-1',
      userId: 'U123',
      channelId: 'D123',
      projectId: 'proj-1',
      process: proc as any,
    });

    vi.advanceTimersByTime(5001);
    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('should send SIGKILL after 5s grace period if SIGTERM did not work', () => {
    const proc = createMockProcess();
    pm.register({
      sessionId: 'sess-1',
      userId: 'U123',
      channelId: 'D123',
      projectId: 'proj-1',
      process: proc as any,
    });

    vi.advanceTimersByTime(5001);
    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');

    vi.advanceTimersByTime(5001);
    expect(proc.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('should kill a specific process by sessionId', () => {
    const proc = createMockProcess();
    pm.register({
      sessionId: 'sess-1',
      userId: 'U123',
      channelId: 'D123',
      projectId: 'proj-1',
      process: proc as any,
    });

    pm.kill('sess-1');
    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('should kill all processes on killAll', () => {
    const procs: ReturnType<typeof createMockProcess>[] = [];
    for (let i = 0; i < 2; i++) {
      const proc = createMockProcess();
      procs.push(proc);
      pm.register({
        sessionId: `sess-${i}`,
        userId: `U${i}`,
        channelId: `D${i}`,
        projectId: 'proj',
        process: proc as any,
      });
    }

    pm.killAll();
    procs.forEach((p) => expect(p.kill).toHaveBeenCalledWith('SIGTERM'));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/bridge/process-manager.test.ts --reporter=verbose`
Expected: FAIL

- [ ] **Step 3: Write implementation**

Create `src/bridge/process-manager.ts`:
```typescript
import type { ChildProcess } from 'node:child_process';
import type { ManagedProcess, ProcessManagerConfig } from '../types.js';
import { logger } from '../utils/logger.js';

export interface RegisterParams {
  sessionId: string;
  userId: string;
  channelId: string;
  projectId: string;
  process: ChildProcess;
  timeoutMs?: number;
  budgetUsd?: number;
}

type ProcessEventCallback = (
  sessionId: string,
  event: 'exit' | 'timeout' | 'error',
  detail?: { code?: number | null; signal?: string | null; error?: Error },
) => void;

const SIGTERM_GRACE_MS = 5_000;

export class ProcessManager {
  private processes: Map<string, ManagedProcess> = new Map();
  private onProcessEvent?: ProcessEventCallback;

  constructor(private readonly config: ProcessManagerConfig) {}

  setEventCallback(callback: ProcessEventCallback): void {
    this.onProcessEvent = callback;
  }

  canStart(userId: string): boolean {
    const userCount = this.getUserProcessCount(userId);
    if (userCount >= this.config.maxConcurrentPerUser) return false;
    if (this.processes.size >= this.config.maxConcurrentGlobal) return false;
    return true;
  }

  register(params: RegisterParams): ManagedProcess {
    const timeoutMs = Math.min(
      params.timeoutMs || this.config.defaultTimeoutMs,
      this.config.maxTimeoutMs,
    );
    const budgetUsd = Math.min(
      params.budgetUsd || this.config.defaultBudgetUsd,
      this.config.maxBudgetUsd,
    );

    const timeoutTimer = setTimeout(() => {
      this.handleTimeout(params.sessionId);
    }, timeoutMs);

    const managed: ManagedProcess = {
      sessionId: params.sessionId,
      userId: params.userId,
      channelId: params.channelId,
      projectId: params.projectId,
      process: params.process,
      startedAt: new Date(),
      timeoutTimer,
      status: 'running',
      budgetUsd,
    };

    this.processes.set(params.sessionId, managed);

    params.process.on('exit', (code, signal) => {
      this.handleExit(params.sessionId, code, signal);
    });

    params.process.on('error', (error) => {
      this.handleError(params.sessionId, error);
    });

    logger.info('Process registered', {
      sessionId: params.sessionId,
      userId: params.userId,
      pid: params.process.pid,
      timeoutMs,
      budgetUsd,
    });

    return managed;
  }

  kill(sessionId: string): void {
    const managed = this.processes.get(sessionId);
    if (!managed) return;

    managed.status = 'cancelled';
    managed.process.kill('SIGTERM');

    setTimeout(() => {
      if (this.processes.has(sessionId)) {
        managed.process.kill('SIGKILL');
      }
    }, SIGTERM_GRACE_MS);

    logger.info('Process kill requested', { sessionId });
  }

  killAll(): void {
    for (const [sessionId] of this.processes) {
      this.kill(sessionId);
    }
  }

  getRunningCount(): number {
    return this.processes.size;
  }

  getProcess(sessionId: string): ManagedProcess | undefined {
    return this.processes.get(sessionId);
  }

  private getUserProcessCount(userId: string): number {
    let count = 0;
    for (const mp of this.processes.values()) {
      if (mp.userId === userId) count++;
    }
    return count;
  }

  private handleTimeout(sessionId: string): void {
    const managed = this.processes.get(sessionId);
    if (!managed || managed.status !== 'running') return;

    managed.status = 'timed-out';
    managed.process.kill('SIGTERM');
    logger.warn('Process timed out', { sessionId });

    setTimeout(() => {
      if (this.processes.has(sessionId)) {
        managed.process.kill('SIGKILL');
        logger.warn('Process SIGKILL after grace period', { sessionId });
      }
    }, SIGTERM_GRACE_MS);

    this.onProcessEvent?.(sessionId, 'timeout');
  }

  private handleExit(
    sessionId: string,
    code: number | null,
    signal: string | null,
  ): void {
    const managed = this.processes.get(sessionId);
    if (!managed) return;

    clearTimeout(managed.timeoutTimer);
    this.processes.delete(sessionId);

    logger.info('Process exited', { sessionId, code, signal });
    this.onProcessEvent?.(sessionId, 'exit', { code, signal });
  }

  private handleError(sessionId: string, error: Error): void {
    const managed = this.processes.get(sessionId);
    if (!managed) return;

    clearTimeout(managed.timeoutTimer);
    this.processes.delete(sessionId);

    logger.error('Process error', { sessionId, error: error.message });
    this.onProcessEvent?.(sessionId, 'error', { error });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/bridge/process-manager.test.ts --reporter=verbose`
Expected: PASS

- [ ] **Step 5: Commit**

---

### Task 12: Executor (CLI spawn, --output-format json)

**Files:**
- Create: `src/bridge/executor.ts`
- Test: `tests/bridge/executor.test.ts`

**Depends on:** Task 11 (process-manager), Task 7 (sanitizer)

- [ ] **Step 1: Write the failing test**

Create `tests/bridge/executor.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { buildClaudeArgs, parseClaudeResult } from '../../src/bridge/executor.js';
import type { SessionMetadata } from '../../src/types.js';

describe('buildClaudeArgs', () => {
  const baseSession: SessionMetadata = {
    sessionId: 'a1b2c3d4-e5f6-5789-abcd-ef0123456789',
    threadTs: '1710567000.000100',
    dmChannelId: 'D123',
    projectPath: '/Users/user/dev/webapp',
    name: 'test session',
    model: 'sonnet',
    status: 'active',
    startTime: new Date(),
    totalCost: 0,
    turnCount: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    lastActiveAt: new Date(),
    anchorCollapsed: false,
  };

  it('should build args for new session', () => {
    const args = buildClaudeArgs(baseSession, false);

    expect(args).toContain('-p');
    expect(args).toContain('--output-format');
    expect(args).toContain('json');
    expect(args).toContain('--permission-mode');
    expect(args).toContain('bypassPermissions');
    expect(args).toContain('--model');
    expect(args).toContain('sonnet');
    expect(args).toContain('--session-id');
    expect(args).toContain(baseSession.sessionId);
    expect(args).not.toContain('-r');
  });

  it('should build args for resumed session', () => {
    const args = buildClaudeArgs(baseSession, true);

    expect(args).toContain('-r');
    expect(args).toContain(baseSession.sessionId);
    expect(args).not.toContain('--session-id');
  });

  it('should include budget', () => {
    const args = buildClaudeArgs(baseSession, false, { budgetUsd: 5.0 });
    expect(args).toContain('--max-budget-usd');
    expect(args).toContain('5');
  });

  it('should use correct model short name', () => {
    const opusSession = { ...baseSession, model: 'opus' as const };
    const args = buildClaudeArgs(opusSession, false);
    expect(args).toContain('opus');

    const haikuSession = { ...baseSession, model: 'haiku' as const };
    const args2 = buildClaudeArgs(haikuSession, false);
    expect(args2).toContain('haiku');
  });
});

describe('parseClaudeResult', () => {
  it('should parse successful result', () => {
    const json = JSON.stringify({
      type: 'result',
      subtype: 'success',
      result: 'Done! Created auth module.',
      session_id: 'abc-123',
      total_cost_usd: 0.045,
      duration_ms: 32000,
      stop_reason: 'end_turn',
    });

    const result = parseClaudeResult(json);
    expect(result.type).toBe('result');
    expect(result.subtype).toBe('success');
    expect(result.result).toBe('Done! Created auth module.');
    expect(result.total_cost_usd).toBe(0.045);
  });

  it('should parse error result', () => {
    const json = JSON.stringify({
      type: 'result',
      subtype: 'error',
      result: 'ENOENT: no such file',
      session_id: 'abc-123',
      total_cost_usd: 0.001,
      duration_ms: 1500,
      stop_reason: 'error',
    });

    const result = parseClaudeResult(json);
    expect(result.subtype).toBe('error');
  });

  it('should throw on invalid JSON', () => {
    expect(() => parseClaudeResult('not json')).toThrow();
  });

  it('should throw on missing required fields', () => {
    expect(() => parseClaudeResult('{}')).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/bridge/executor.test.ts --reporter=verbose`
Expected: FAIL

- [ ] **Step 3: Write implementation**

Create `src/bridge/executor.ts`:
```typescript
import { spawn } from 'node:child_process';
import type { SessionMetadata, ModelChoice, ClaudeResultOutput } from '../types.js';
import type { ProcessManager } from './process-manager.js';
import { ExecutionError } from '../utils/errors.js';
import { sanitizeOutput } from '../utils/sanitizer.js';
import { logger } from '../utils/logger.js';

export interface ExecuteOptions {
  budgetUsd?: number;
  timeoutMs?: number;
}

export interface ExecuteResult {
  output: ClaudeResultOutput;
  rawStdout: string;
  rawStderr: string;
}

const MODEL_MAP: Record<ModelChoice, string> = {
  opus: 'opus',
  sonnet: 'sonnet',
  haiku: 'haiku',
};

export function buildClaudeArgs(
  session: SessionMetadata,
  isResume: boolean,
  opts?: ExecuteOptions,
): string[] {
  const args = [
    '-p',
    '--output-format', 'json',
    '--permission-mode', 'bypassPermissions',
    '--model', MODEL_MAP[session.model],
    '--max-budget-usd', String(opts?.budgetUsd || 1.0),
  ];

  if (isResume) {
    args.push('-r', session.sessionId);
  } else {
    args.push('--session-id', session.sessionId);
  }

  return args;
}

export function parseClaudeResult(stdout: string): ClaudeResultOutput {
  const trimmed = stdout.trim();
  const lines = trimmed.split('\n');
  let lastJsonLine = '';
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line.startsWith('{')) {
      lastJsonLine = line;
      break;
    }
  }

  if (!lastJsonLine) {
    throw new Error(`No JSON found in Claude output: ${trimmed.substring(0, 200)}`);
  }

  const parsed = JSON.parse(lastJsonLine);

  if (!parsed.type || parsed.result === undefined || parsed.session_id === undefined) {
    throw new Error('Invalid Claude result format: missing required fields');
  }

  return parsed as ClaudeResultOutput;
}

export class Executor {
  constructor(
    private readonly processManager: ProcessManager,
    private readonly claudeExecutable: string = 'claude',
  ) {}

  async execute(
    session: SessionMetadata,
    prompt: string,
    userId: string,
    opts?: ExecuteOptions,
  ): Promise<ExecuteResult> {
    const isResume = session.turnCount > 0;
    const args = buildClaudeArgs(session, isResume, opts);

    logger.info('Executing Claude CLI', {
      sessionId: session.sessionId,
      isResume,
      model: session.model,
      promptLength: prompt.length,
    });

    return new Promise<ExecuteResult>((resolve, reject) => {
      const child = spawn(this.claudeExecutable, [...args, prompt], {
        cwd: session.projectPath,
        env: {
          ...process.env,
          CLAUDECODE: undefined,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      this.processManager.register({
        sessionId: session.sessionId,
        userId,
        channelId: session.dmChannelId,
        projectId: session.projectPath,
        process: child,
        timeoutMs: opts?.timeoutMs,
        budgetUsd: opts?.budgetUsd,
      });

      let stdout = '';
      let stderr = '';

      child.stdout!.on('data', (data: Buffer) => {
        stdout += data.toString();
      });

      child.stderr!.on('data', (data: Buffer) => {
        stderr += data.toString();
      });

      child.on('error', (error) => {
        reject(
          new ExecutionError('Failed to spawn Claude CLI', {
            sessionId: session.sessionId,
            exitCode: null,
            stderr: error.message,
          }),
        );
      });

      child.on('exit', (code, signal) => {
        if (code !== 0 && code !== null) {
          reject(
            new ExecutionError(`Claude CLI exited with code ${code}`, {
              sessionId: session.sessionId,
              exitCode: code,
              stderr: sanitizeOutput(stderr),
            }),
          );
          return;
        }

        try {
          const output = parseClaudeResult(stdout);
          resolve({
            output,
            rawStdout: sanitizeOutput(stdout),
            rawStderr: sanitizeOutput(stderr),
          });
        } catch (parseErr) {
          reject(
            new ExecutionError('Failed to parse Claude output', {
              sessionId: session.sessionId,
              exitCode: code,
              stderr: sanitizeOutput(stderr || String(parseErr)),
            }),
          );
        }
      });
    });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/bridge/executor.test.ts --reporter=verbose`
Expected: PASS

- [ ] **Step 5: Commit**

---

## Chunk 5: Command Parser + Block Builder (Tasks 13-14)

### Task 13: CommandParser

**Files:**
- Create: `src/slack/command-parser.ts`
- Test: `tests/slack/command-parser.test.ts`

**Depends on:** Task 3 (types)

- [ ] **Step 1: Write the failing test**

Create `tests/slack/command-parser.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { parseCommand } from '../../src/slack/command-parser.js';

describe('parseCommand', () => {
  it('should parse bridge commands', () => {
    expect(parseCommand('cc /status')).toEqual({
      type: 'bridge_command',
      command: 'status',
      args: undefined,
      rawText: 'cc /status',
    });

    expect(parseCommand('cc /end')).toEqual({
      type: 'bridge_command',
      command: 'end',
      args: undefined,
      rawText: 'cc /end',
    });

    expect(parseCommand('cc /help')).toEqual({
      type: 'bridge_command',
      command: 'help',
      args: undefined,
      rawText: 'cc /help',
    });
  });

  it('should parse bridge commands with args', () => {
    expect(parseCommand('cc /model opus')).toEqual({
      type: 'bridge_command',
      command: 'model',
      args: 'opus',
      rawText: 'cc /model opus',
    });

    expect(parseCommand('cc /rename my new session name')).toEqual({
      type: 'bridge_command',
      command: 'rename',
      args: 'my new session name',
      rawText: 'cc /rename my new session name',
    });
  });

  it('should parse cc /panel as bridge command', () => {
    expect(parseCommand('cc /panel')).toEqual({
      type: 'bridge_command',
      command: 'panel',
      args: undefined,
      rawText: 'cc /panel',
    });
  });

  it('should parse Claude Code forwarded commands', () => {
    expect(parseCommand('cc /commit')).toEqual({
      type: 'claude_command',
      command: 'commit',
      args: undefined,
      rawText: 'cc /commit',
    });

    expect(parseCommand('cc /review-pr 123')).toEqual({
      type: 'claude_command',
      command: 'review-pr',
      args: '123',
      rawText: 'cc /review-pr 123',
    });
  });

  it('should treat unknown cc commands as claude commands', () => {
    expect(parseCommand('cc /some-unknown-cmd arg1 arg2')).toEqual({
      type: 'claude_command',
      command: 'some-unknown-cmd',
      args: 'arg1 arg2',
      rawText: 'cc /some-unknown-cmd arg1 arg2',
    });
  });

  it('should treat plain text as plain_text type', () => {
    expect(parseCommand('implement authentication')).toEqual({
      type: 'plain_text',
      command: undefined,
      args: undefined,
      rawText: 'implement authentication',
    });
  });

  it('should handle case insensitive cc prefix', () => {
    expect(parseCommand('CC /status').type).toBe('bridge_command');
    expect(parseCommand('Cc /help').type).toBe('bridge_command');
  });

  it('should trim whitespace', () => {
    expect(parseCommand('  cc /status  ')).toEqual({
      type: 'bridge_command',
      command: 'status',
      args: undefined,
      rawText: 'cc /status',
    });
  });

  it('should handle text starting with cc but not a command', () => {
    expect(parseCommand('cc is cool')).toEqual({
      type: 'plain_text',
      command: undefined,
      args: undefined,
      rawText: 'cc is cool',
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/slack/command-parser.test.ts --reporter=verbose`
Expected: FAIL

- [ ] **Step 3: Write implementation**

Create `src/slack/command-parser.ts`:
```typescript
import type { ParsedCommand } from '../types.js';

const BRIDGE_COMMANDS = new Set([
  'status',
  'end',
  'help',
  'model',
  'rename',
  'panel',
]);

const CC_COMMAND_REGEX = /^cc\s+\/(\S+)(?:\s+(.+))?$/i;

export function parseCommand(input: string): ParsedCommand {
  const trimmed = input.trim();
  const match = trimmed.match(CC_COMMAND_REGEX);

  if (!match) {
    return {
      type: 'plain_text',
      command: undefined,
      args: undefined,
      rawText: trimmed,
    };
  }

  const command = match[1].toLowerCase();
  const args = match[2]?.trim() || undefined;
  const rawText = `cc /${command}${args ? ` ${args}` : ''}`;

  if (BRIDGE_COMMANDS.has(command)) {
    return { type: 'bridge_command', command, args, rawText };
  }

  return { type: 'claude_command', command, args, rawText };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/slack/command-parser.test.ts --reporter=verbose`
Expected: PASS

- [ ] **Step 5: Commit**

---

### Task 14: BlockBuilder

**Files:**
- Create: `src/slack/block-builder.ts`
- Test: `tests/slack/block-builder.test.ts`

**Depends on:** Task 3 (types)

- [ ] **Step 1: Write the failing test**

Create `tests/slack/block-builder.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import {
  buildAnchorBlocks,
  buildCollapsedAnchorBlocks,
  buildErrorBlocks,
  buildResultBlocks,
} from '../../src/slack/block-builder.js';
import type { SessionMetadata } from '../../src/types.js';

const mockSession: SessionMetadata = {
  sessionId: 'a1b2c3d4-e5f6-5789-abcd-ef0123456789',
  threadTs: '1710567000.000100',
  dmChannelId: 'D123',
  projectPath: '/Users/user/dev/my-webapp',
  name: 'my-webapp: implement auth',
  model: 'opus',
  status: 'active',
  startTime: new Date('2026-03-16T14:30:00Z'),
  totalCost: 0.23,
  turnCount: 5,
  totalInputTokens: 45000,
  totalOutputTokens: 5000,
  lastActiveAt: new Date(),
  anchorCollapsed: false,
};

describe('buildAnchorBlocks', () => {
  it('should return blocks with header, section, context, model select, actions, hint', () => {
    const blocks = buildAnchorBlocks(mockSession);
    expect(blocks.length).toBeGreaterThanOrEqual(6);
    expect(blocks[0].type).toBe('header');
    expect(blocks[0].text.text).toContain('my-webapp: implement auth');
    expect(blocks[1].type).toBe('section');
    expect(blocks[1].text.text).toContain(':large_green_circle:');

    const modelBlock = blocks.find(
      (b: any) => b.type === 'section' && b.accessory?.action_id === 'set_model',
    );
    expect(modelBlock).toBeDefined();
    expect(modelBlock.accessory.initial_option.value).toBe('opus');

    const actionsBlock = blocks.find(
      (b: any) => b.type === 'actions' && b.block_id === 'session_controls',
    );
    expect(actionsBlock).toBeDefined();
    expect(actionsBlock.elements.length).toBe(2);
  });

  it('should show ended status for ended session', () => {
    const endedSession = { ...mockSession, status: 'ended' as const };
    const blocks = buildAnchorBlocks(endedSession);
    expect(blocks[1].text.text).toContain(':white_circle:');
  });
});

describe('buildCollapsedAnchorBlocks', () => {
  it('should return single section with expand button', () => {
    const blocks = buildCollapsedAnchorBlocks(mockSession);
    expect(blocks.length).toBe(1);
    expect(blocks[0].type).toBe('section');
    expect(blocks[0].accessory.action_id).toBe('toggle_anchor');
    expect(blocks[0].accessory.value).toBe('expand');
  });
});

describe('buildErrorBlocks', () => {
  it('should build error message with retry button', () => {
    const blocks = buildErrorBlocks({
      errorMessage: 'ENOENT: no such file or directory',
      sessionId: 'a1b2c3d4',
      exitCode: 1,
      durationSec: 3.2,
      originalPromptHash: 'prompt_hash_123',
    });
    expect(blocks.length).toBeGreaterThanOrEqual(3);
    expect(blocks[0].text.text).toContain(':x:');

    const actionsBlock = blocks.find((b: any) => b.type === 'actions');
    expect(actionsBlock).toBeDefined();
    const retryButton = actionsBlock.elements.find(
      (e: any) => e.action_id === 'retry_prompt',
    );
    expect(retryButton.value).toBe('prompt_hash_123');
  });
});

describe('buildResultBlocks', () => {
  it('should build result message blocks', () => {
    const blocks = buildResultBlocks({
      text: 'Authentication module implemented.',
      durationSec: 32,
      costUsd: 0.045,
      turnCount: 5,
      model: 'claude-sonnet-4-6',
    });
    expect(blocks.length).toBeGreaterThanOrEqual(2);
    expect(blocks[0].type).toBe('section');
    expect(blocks[0].text.text).toContain('Authentication');

    const contextBlock = blocks.find((b: any) => b.type === 'context');
    expect(contextBlock).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/slack/block-builder.test.ts --reporter=verbose`
Expected: FAIL

- [ ] **Step 3: Write implementation**

Create `src/slack/block-builder.ts`:
```typescript
import type { SessionMetadata } from '../types.js';

type Block = Record<string, any>;

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function getTimeAgo(date: Date): string {
  const diffMs = Date.now() - date.getTime();
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  return `${Math.floor(diffHours / 24)}d ago`;
}

export function buildAnchorBlocks(session: SessionMetadata): Block[] {
  const isActive = session.status === 'active';
  const statusEmoji = isActive ? ':large_green_circle:' : ':white_circle:';
  const statusLabel = isActive ? 'Active Session' : 'Session Ended';
  const shortId = session.sessionId.substring(0, 8);
  const startTimeStr = session.startTime.toISOString().replace('T', ' ').substring(0, 16);
  const tokenPct = session.totalInputTokens > 0
    ? Math.round((session.totalInputTokens / 200_000) * 100)
    : 0;

  return [
    {
      type: 'header',
      text: { type: 'plain_text', text: session.name },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `${statusEmoji} *${statusLabel}*\n:file_folder: \`${session.projectPath}\``,
      },
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `Session: \`${shortId}\` | Start: ${startTimeStr} | :moneybag: $${session.totalCost.toFixed(2)}\n:bar_chart: ${session.totalInputTokens.toLocaleString()} / 200,000 tokens (${tokenPct}%)`,
        },
      ],
    },
    { type: 'divider' },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: '*Model*' },
      accessory: {
        type: 'static_select',
        action_id: 'set_model',
        initial_option: {
          text: { type: 'plain_text', text: capitalize(session.model) },
          value: session.model,
        },
        options: [
          { text: { type: 'plain_text', text: 'Opus' }, value: 'opus' },
          { text: { type: 'plain_text', text: 'Sonnet' }, value: 'sonnet' },
          { text: { type: 'plain_text', text: 'Haiku' }, value: 'haiku' },
        ],
      },
    },
    { type: 'divider' },
    {
      type: 'actions',
      block_id: 'session_controls',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Commands' },
          action_id: 'open_command_modal',
          value: shortId,
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: 'End Session' },
          action_id: 'end_session',
          value: shortId,
          confirm: {
            title: { type: 'plain_text', text: 'Confirm' },
            text: { type: 'mrkdwn', text: 'End this session?' },
            confirm: { type: 'plain_text', text: 'End' },
            deny: { type: 'plain_text', text: 'Cancel' },
          },
        },
      ],
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: 'Send a message in this thread to start | `cc /help` for commands',
        },
      ],
    },
  ];
}

export function buildCollapsedAnchorBlocks(session: SessionMetadata): Block[] {
  const statusEmoji = session.status === 'active'
    ? ':large_green_circle:'
    : ':white_circle:';
  const tokenPct = session.totalInputTokens > 0
    ? Math.round((session.totalInputTokens / 200_000) * 100)
    : 0;

  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `${statusEmoji} *${session.name}* | ${capitalize(session.model)} | ${tokenPct}% | $${session.totalCost.toFixed(2)}`,
      },
      accessory: {
        type: 'button',
        text: { type: 'plain_text', text: '\u25BC Expand' },
        action_id: 'toggle_anchor',
        value: 'expand',
      },
    },
  ];
}

export interface ErrorBlocksParams {
  errorMessage: string;
  sessionId: string;
  exitCode?: number | null;
  durationSec?: number;
  originalPromptHash?: string;
}

export function buildErrorBlocks(params: ErrorBlocksParams): Block[] {
  const blocks: Block[] = [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: ':x: *An error occurred*' },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `\`\`\`\n${params.errorMessage}\n\`\`\``,
      },
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `Exit code: ${params.exitCode ?? 'N/A'} | Duration: ${params.durationSec?.toFixed(1) ?? 'N/A'}s | Session: \`${params.sessionId.substring(0, 8)}\``,
        },
      ],
    },
  ];

  if (params.originalPromptHash) {
    blocks.push({
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Retry' },
          action_id: 'retry_prompt',
          value: params.originalPromptHash,
        },
      ],
    });
  }

  return blocks;
}

export interface ResultBlocksParams {
  text: string;
  durationSec: number;
  costUsd: number;
  turnCount: number;
  model: string;
  changedFiles?: string;
}

export function buildResultBlocks(params: ResultBlocksParams): Block[] {
  const blocks: Block[] = [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: params.text },
    },
  ];

  if (params.changedFiles) {
    blocks.push(
      { type: 'divider' },
      {
        type: 'context',
        elements: [
          { type: 'mrkdwn', text: `:file_folder: Changes: ${params.changedFiles}` },
        ],
      },
    );
  }

  blocks.push({
    type: 'context',
    elements: [
      {
        type: 'mrkdwn',
        text: `:stopwatch: ${params.durationSec}s | :moneybag: $${params.costUsd.toFixed(3)} | :arrows_counterclockwise: ${params.turnCount} turns | :bar_chart: Model: ${params.model}`,
      },
    ],
  });

  return blocks;
}

export function buildHomeTabBlocks(
  projects: Array<{ id: string; projectPath: string; sessionCount: number }>,
  activeSessions: Array<{ name: string; sessionId: string; lastActiveAt: Date; threadTs: string; dmChannelId: string }>,
): Block[] {
  const blocks: Block[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: 'Claude Code Bridge' },
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: ':large_green_circle: Bridge Running' },
    },
    { type: 'divider' },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: '*Projects*' },
    },
  ];

  if (projects.length === 0) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: '_No projects found in .claude/projects/_' },
    });
  } else {
    for (const project of projects) {
      const displayName = project.projectPath.split('/').pop() || project.id;
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `:file_folder: *${displayName}*\n\`${project.projectPath}\``,
        },
        accessory: {
          type: 'button',
          text: { type: 'plain_text', text: 'New Session' },
          action_id: 'new_session',
          value: project.id,
        },
      });
    }
  }

  blocks.push({ type: 'divider' });
  blocks.push({
    type: 'section',
    text: { type: 'mrkdwn', text: '*Active Sessions*' },
  });

  if (activeSessions.length === 0) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: '_No active sessions_' },
    });
  } else {
    for (const s of activeSessions) {
      const ago = getTimeAgo(s.lastActiveAt);
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `:large_green_circle: *${s.name}*\nSession: \`${s.sessionId.substring(0, 8)}\` | Last active: ${ago}`,
        },
        accessory: {
          type: 'button',
          text: { type: 'plain_text', text: 'Open Thread' },
          action_id: 'open_thread',
          value: JSON.stringify({ channel: s.dmChannelId, ts: s.threadTs }),
        },
      });
    }
  }

  return blocks;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/slack/block-builder.test.ts --reporter=verbose`
Expected: PASS

- [ ] **Step 5: Commit**

---

## Chunk 6: Event Handler + Response Builder (Tasks 15-16)

### Task 15: EventHandler

**Files:**
- Create: `src/slack/event-handler.ts`
- Test: `tests/slack/event-handler.test.ts`

**Depends on:** Task 10 (session-manager), Task 12 (executor), Task 13 (command-parser)

- [ ] **Step 1: Write the failing test**

Create `tests/slack/event-handler.test.ts`:
```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventRouter, classifyMessage } from '../../src/slack/event-handler.js';

describe('classifyMessage', () => {
  it('should classify bot messages as ignored', () => {
    expect(classifyMessage({ bot_id: 'B123', text: 'hello' })).toBe('ignore');
  });

  it('should classify messages with subtype as ignored', () => {
    expect(classifyMessage({ subtype: 'message_changed', text: 'hi' })).toBe('ignore');
  });

  it('should classify cc commands as command', () => {
    expect(classifyMessage({ text: 'cc /status' })).toBe('command');
    expect(classifyMessage({ text: 'cc /help' })).toBe('command');
    expect(classifyMessage({ text: 'cc /commit' })).toBe('command');
  });

  it('should classify plain text as prompt', () => {
    expect(classifyMessage({ text: 'implement auth feature' })).toBe('prompt');
  });

  it('should classify empty text as ignore', () => {
    expect(classifyMessage({ text: '' })).toBe('ignore');
    expect(classifyMessage({ text: undefined })).toBe('ignore');
  });
});

describe('EventRouter', () => {
  it('should route prompt to session handler', async () => {
    const sessionHandler = vi.fn().mockResolvedValue(undefined);
    const commandHandler = vi.fn().mockResolvedValue(undefined);

    const router = new EventRouter({
      onPrompt: sessionHandler,
      onCommand: commandHandler,
    });

    await router.handleMessage({
      text: 'implement auth',
      user: 'U123',
      channel: 'D123',
      ts: '1.000',
      thread_ts: '1.000',
    });

    expect(sessionHandler).toHaveBeenCalledWith({
      text: 'implement auth',
      userId: 'U123',
      channelId: 'D123',
      messageTs: '1.000',
      threadTs: '1.000',
    });
    expect(commandHandler).not.toHaveBeenCalled();
  });

  it('should route cc command to command handler', async () => {
    const sessionHandler = vi.fn().mockResolvedValue(undefined);
    const commandHandler = vi.fn().mockResolvedValue(undefined);

    const router = new EventRouter({
      onPrompt: sessionHandler,
      onCommand: commandHandler,
    });

    await router.handleMessage({
      text: 'cc /status',
      user: 'U123',
      channel: 'D123',
      ts: '2.000',
      thread_ts: '1.000',
    });

    expect(commandHandler).toHaveBeenCalled();
    expect(sessionHandler).not.toHaveBeenCalled();
  });

  it('should ignore bot messages', async () => {
    const sessionHandler = vi.fn();
    const commandHandler = vi.fn();

    const router = new EventRouter({
      onPrompt: sessionHandler,
      onCommand: commandHandler,
    });

    await router.handleMessage({
      text: 'hello',
      user: 'U123',
      channel: 'D123',
      ts: '1.000',
      bot_id: 'B123',
    });

    expect(sessionHandler).not.toHaveBeenCalled();
    expect(commandHandler).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/slack/event-handler.test.ts --reporter=verbose`
Expected: FAIL

- [ ] **Step 3: Write implementation**

Create `src/slack/event-handler.ts`:
```typescript
import { parseCommand } from './command-parser.js';
import type { ParsedCommand } from '../types.js';
import { logger } from '../utils/logger.js';

export interface SlackMessageEvent {
  text?: string;
  user?: string;
  channel?: string;
  ts?: string;
  thread_ts?: string;
  bot_id?: string;
  subtype?: string;
}

export type MessageClassification = 'command' | 'prompt' | 'ignore';

export function classifyMessage(event: SlackMessageEvent): MessageClassification {
  if (event.bot_id || event.subtype) return 'ignore';
  if (!event.text || event.text.trim() === '') return 'ignore';

  const parsed = parseCommand(event.text);
  if (parsed.type === 'bridge_command' || parsed.type === 'claude_command') {
    return 'command';
  }

  return 'prompt';
}

export interface RoutedPrompt {
  text: string;
  userId: string;
  channelId: string;
  messageTs: string;
  threadTs: string;
}

export interface RoutedCommand {
  parsed: ParsedCommand;
  userId: string;
  channelId: string;
  messageTs: string;
  threadTs: string;
}

export interface EventRouterHandlers {
  onPrompt: (msg: RoutedPrompt) => Promise<void>;
  onCommand: (msg: RoutedCommand) => Promise<void>;
}

export class EventRouter {
  constructor(private readonly handlers: EventRouterHandlers) {}

  async handleMessage(event: SlackMessageEvent): Promise<void> {
    const classification = classifyMessage(event);

    if (classification === 'ignore') {
      logger.debug('Ignoring message', {
        user: event.user,
        botId: event.bot_id,
        subtype: event.subtype,
      });
      return;
    }

    const userId = event.user || '';
    const channelId = event.channel || '';
    const messageTs = event.ts || '';
    const threadTs = event.thread_ts || event.ts || '';

    if (classification === 'command') {
      const parsed = parseCommand(event.text!);
      await this.handlers.onCommand({
        parsed,
        userId,
        channelId,
        messageTs,
        threadTs,
      });
      return;
    }

    await this.handlers.onPrompt({
      text: event.text!,
      userId,
      channelId,
      messageTs,
      threadTs,
    });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/slack/event-handler.test.ts --reporter=verbose`
Expected: PASS

- [ ] **Step 5: Commit**

---

### Task 16: ResponseBuilder

**Files:**
- Create: `src/slack/response-builder.ts`
- Test: `tests/slack/response-builder.test.ts`

**Depends on:** Task 14 (block-builder)

- [ ] **Step 1: Write the failing test**

Create `tests/slack/response-builder.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { splitMessage, splitAtBoundaries } from '../../src/slack/response-builder.js';

describe('splitAtBoundaries', () => {
  it('should not split text under the limit', () => {
    const text = 'Short text.';
    const chunks = splitAtBoundaries(text, 3900);
    expect(chunks).toEqual(['Short text.']);
  });

  it('should split at paragraph boundaries', () => {
    const text = 'Paragraph one.\n\nParagraph two.\n\nParagraph three.';
    const chunks = splitAtBoundaries(text, 25);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join('\n\n')).toContain('Paragraph one');
    expect(chunks.join('\n\n')).toContain('Paragraph three');
  });

  it('should split at markdown headings', () => {
    const text = '## Section 1\nContent 1\n\n## Section 2\nContent 2';
    const chunks = splitAtBoundaries(text, 25);
    expect(chunks.length).toBeGreaterThan(1);
  });

  it('should not split inside code blocks', () => {
    const codeBlock = '```typescript\nconst x = 1;\nconst y = 2;\nconst z = 3;\n```';
    const text = `Before code.\n\n${codeBlock}\n\nAfter code.`;
    const chunks = splitAtBoundaries(text, 40);
    // Code block should remain intact in one chunk
    const blockChunk = chunks.find((c) => c.includes('```typescript'));
    expect(blockChunk).toBeDefined();
    expect(blockChunk).toContain('const z = 3;');
    expect(blockChunk).toContain('```');
  });

  it('should force split at line boundaries as last resort', () => {
    const longLine = 'a'.repeat(100);
    const text = `${longLine}\n${longLine}`;
    const chunks = splitAtBoundaries(text, 120);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
  });
});

describe('splitMessage', () => {
  it('should return single chunk for short messages', () => {
    const result = splitMessage('Hello world');
    expect(result.type).toBe('single');
    expect(result.chunks).toHaveLength(1);
  });

  it('should split long messages into multiple chunks', () => {
    const longText = Array.from({ length: 100 }, (_, i) =>
      `Paragraph ${i + 1}. `.repeat(10)
    ).join('\n\n');

    const result = splitMessage(longText);
    expect(result.chunks.length).toBeGreaterThan(1);
    expect(result.type).toBe('multi');
  });

  it('should recommend file upload for very long messages', () => {
    const veryLong = 'x'.repeat(40_000);
    const result = splitMessage(veryLong);
    expect(result.type).toBe('file_upload');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/slack/response-builder.test.ts --reporter=verbose`
Expected: FAIL

- [ ] **Step 3: Write implementation**

Create `src/slack/response-builder.ts`:
```typescript
const MAX_MESSAGE_TEXT = 3_900;
const FILE_UPLOAD_THRESHOLD = 39_000;

export interface SplitResult {
  type: 'single' | 'multi' | 'file_upload';
  chunks: string[];
}

export function splitMessage(text: string): SplitResult {
  if (text.length <= MAX_MESSAGE_TEXT) {
    return { type: 'single', chunks: [text] };
  }

  if (text.length > FILE_UPLOAD_THRESHOLD) {
    return { type: 'file_upload', chunks: [text] };
  }

  const chunks = splitAtBoundaries(text, MAX_MESSAGE_TEXT);
  return { type: 'multi', chunks };
}

export function splitAtBoundaries(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    const cutPoint = findBestCutPoint(remaining, maxLength);
    chunks.push(remaining.substring(0, cutPoint).trimEnd());
    remaining = remaining.substring(cutPoint).trimStart();
  }

  return chunks.filter((c) => c.length > 0);
}

function findBestCutPoint(text: string, maxLength: number): number {
  const searchRegion = text.substring(0, maxLength);

  // Priority 1: Markdown heading
  const headingMatch = findLastMatch(searchRegion, /\n#{1,3}\s/g);
  if (headingMatch !== -1 && headingMatch > maxLength * 0.3) {
    return headingMatch + 1; // Include the newline
  }

  // Priority 2: Code block end
  const codeBlockEnd = findLastMatch(searchRegion, /\n```\n/g);
  if (codeBlockEnd !== -1 && codeBlockEnd > maxLength * 0.3) {
    // Check we're not splitting inside a code block
    if (!isInsideCodeBlock(searchRegion, codeBlockEnd + 4)) {
      return codeBlockEnd + 4;
    }
  }

  // Priority 3: Empty line (paragraph boundary)
  const emptyLine = findLastMatch(searchRegion, /\n\n/g);
  if (emptyLine !== -1 && emptyLine > maxLength * 0.3) {
    if (!isInsideCodeBlock(searchRegion, emptyLine)) {
      return emptyLine + 2;
    }
  }

  // Priority 4: Sentence end
  const sentenceEnd = findLastMatch(searchRegion, /[.!?\u3002]\s/g);
  if (sentenceEnd !== -1 && sentenceEnd > maxLength * 0.3) {
    if (!isInsideCodeBlock(searchRegion, sentenceEnd)) {
      return sentenceEnd + 2;
    }
  }

  // Priority 5: Any line break
  const lineBreak = searchRegion.lastIndexOf('\n');
  if (lineBreak !== -1 && lineBreak > maxLength * 0.2) {
    return lineBreak + 1;
  }

  // Priority 6: Force split at maxLength
  return maxLength;
}

function findLastMatch(text: string, regex: RegExp): number {
  let lastIndex = -1;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    lastIndex = match.index;
  }
  return lastIndex;
}

function isInsideCodeBlock(text: string, position: number): boolean {
  const beforePos = text.substring(0, position);
  const fenceCount = (beforePos.match(/```/g) || []).length;
  return fenceCount % 2 !== 0; // Odd count means we're inside a code block
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/slack/response-builder.test.ts --reporter=verbose`
Expected: PASS

- [ ] **Step 5: Commit**

---

## Chunk 7: Home Tab, Reactions, Errors, Commands (Tasks 17-20)

### Task 17: Home Tab

**Files:**
- Create: `src/slack/home-tab.ts`
- Test: `tests/slack/home-tab.test.ts`

**Depends on:** Task 8 (project-store), Task 14 (block-builder)

- [ ] **Step 1: Write the failing test**

Create `tests/slack/home-tab.test.ts`:
```typescript
import { describe, it, expect, vi } from 'vitest';
import { HomeTabHandler } from '../../src/slack/home-tab.js';

describe('HomeTabHandler', () => {
  it('should build home tab view with projects and sessions', () => {
    const mockProjectStore = {
      getProjects: vi.fn().mockReturnValue([
        { id: '-Users-user-dev-webapp', projectPath: '/Users/user/dev/webapp', sessionCount: 3, lastModified: new Date() },
      ]),
    };

    const mockSessionStore = {
      getActiveSessions: vi.fn().mockReturnValue([
        {
          sessionId: 'abc-123',
          name: 'webapp: auth',
          lastActiveAt: new Date(),
          threadTs: '1.000',
          dmChannelId: 'D123',
        },
      ]),
    };

    const handler = new HomeTabHandler(
      mockProjectStore as any,
      mockSessionStore as any,
    );

    const blocks = handler.buildHomeView();

    expect(blocks.length).toBeGreaterThan(0);

    // Should have header
    const header = blocks.find((b: any) => b.type === 'header');
    expect(header).toBeDefined();

    // Should have project
    const projectBlock = blocks.find((b: any) =>
      b.text?.text?.includes('webapp'),
    );
    expect(projectBlock).toBeDefined();

    // Should have active session
    const sessionBlock = blocks.find((b: any) =>
      b.text?.text?.includes('webapp: auth'),
    );
    expect(sessionBlock).toBeDefined();
  });

  it('should show empty state when no projects', () => {
    const mockProjectStore = {
      getProjects: vi.fn().mockReturnValue([]),
    };
    const mockSessionStore = {
      getActiveSessions: vi.fn().mockReturnValue([]),
    };

    const handler = new HomeTabHandler(
      mockProjectStore as any,
      mockSessionStore as any,
    );

    const blocks = handler.buildHomeView();
    const emptyBlock = blocks.find((b: any) =>
      b.text?.text?.includes('No projects'),
    );
    expect(emptyBlock).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/slack/home-tab.test.ts --reporter=verbose`
Expected: FAIL

- [ ] **Step 3: Write implementation**

Create `src/slack/home-tab.ts`:
```typescript
import type { ProjectStore } from '../store/project-store.js';
import type { SessionStore } from '../store/session-store.js';
import { buildHomeTabBlocks } from './block-builder.js';
import { logger } from '../utils/logger.js';

type Block = Record<string, any>;

export class HomeTabHandler {
  constructor(
    private readonly projectStore: ProjectStore,
    private readonly sessionStore: SessionStore,
  ) {}

  buildHomeView(): Block[] {
    const projects = this.projectStore.getProjects();
    const activeSessions = this.sessionStore.getActiveSessions();

    return buildHomeTabBlocks(
      projects.map((p) => ({
        id: p.id,
        projectPath: p.projectPath,
        sessionCount: p.sessionCount,
      })),
      activeSessions.map((s) => ({
        name: s.name,
        sessionId: s.sessionId,
        lastActiveAt: s.lastActiveAt,
        threadTs: s.threadTs,
        dmChannelId: s.dmChannelId,
      })),
    );
  }

  async publishHomeTab(
    client: { views: { publish: (args: any) => Promise<any> } },
    userId: string,
  ): Promise<void> {
    try {
      const blocks = this.buildHomeView();
      await client.views.publish({
        user_id: userId,
        view: {
          type: 'home',
          blocks,
        },
      });
      logger.debug('Home tab published', { userId });
    } catch (err) {
      logger.error('Failed to publish home tab', { userId, error: err });
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/slack/home-tab.test.ts --reporter=verbose`
Expected: PASS

- [ ] **Step 5: Commit**

---

### Task 18: Reaction Manager

**Files:**
- Create: `src/slack/reaction-manager.ts`
- Test: `tests/slack/reaction-manager.test.ts`

**Depends on:** Task 15 (event-handler)

- [ ] **Step 1: Write the failing test**

Create `tests/slack/reaction-manager.test.ts`:
```typescript
import { describe, it, expect, vi } from 'vitest';
import { ReactionManager } from '../../src/slack/reaction-manager.js';

describe('ReactionManager', () => {
  function createMockClient() {
    return {
      reactions: {
        add: vi.fn().mockResolvedValue({ ok: true }),
        remove: vi.fn().mockResolvedValue({ ok: true }),
      },
    };
  }

  it('should add processing reaction', async () => {
    const client = createMockClient();
    const rm = new ReactionManager(client as any);

    await rm.addProcessing('D123', '1.000');

    expect(client.reactions.add).toHaveBeenCalledWith({
      channel: 'D123',
      timestamp: '1.000',
      name: 'hourglass_flowing_sand',
    });
  });

  it('should replace processing with success', async () => {
    const client = createMockClient();
    const rm = new ReactionManager(client as any);

    await rm.replaceWithSuccess('D123', '1.000');

    expect(client.reactions.remove).toHaveBeenCalledWith({
      channel: 'D123',
      timestamp: '1.000',
      name: 'hourglass_flowing_sand',
    });
    expect(client.reactions.add).toHaveBeenCalledWith({
      channel: 'D123',
      timestamp: '1.000',
      name: 'white_check_mark',
    });
  });

  it('should replace processing with error', async () => {
    const client = createMockClient();
    const rm = new ReactionManager(client as any);

    await rm.replaceWithError('D123', '1.000');

    expect(client.reactions.remove).toHaveBeenCalledWith({
      channel: 'D123',
      timestamp: '1.000',
      name: 'hourglass_flowing_sand',
    });
    expect(client.reactions.add).toHaveBeenCalledWith({
      channel: 'D123',
      timestamp: '1.000',
      name: 'x',
    });
  });

  it('should not throw on reaction api errors', async () => {
    const client = createMockClient();
    client.reactions.add.mockRejectedValue(new Error('already_reacted'));
    const rm = new ReactionManager(client as any);

    await expect(rm.addProcessing('D123', '1.000')).resolves.not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/slack/reaction-manager.test.ts --reporter=verbose`
Expected: FAIL

- [ ] **Step 3: Write implementation**

Create `src/slack/reaction-manager.ts`:
```typescript
import { logger } from '../utils/logger.js';

interface SlackClient {
  reactions: {
    add: (args: { channel: string; timestamp: string; name: string }) => Promise<any>;
    remove: (args: { channel: string; timestamp: string; name: string }) => Promise<any>;
  };
}

const EMOJI_PROCESSING = 'hourglass_flowing_sand';
const EMOJI_SUCCESS = 'white_check_mark';
const EMOJI_ERROR = 'x';
const EMOJI_WARNING = 'warning';

export class ReactionManager {
  constructor(private readonly client: SlackClient) {}

  async addProcessing(channel: string, timestamp: string): Promise<void> {
    await this.safeAdd(channel, timestamp, EMOJI_PROCESSING);
  }

  async replaceWithSuccess(channel: string, timestamp: string): Promise<void> {
    await this.safeRemove(channel, timestamp, EMOJI_PROCESSING);
    await this.safeAdd(channel, timestamp, EMOJI_SUCCESS);
  }

  async replaceWithError(channel: string, timestamp: string): Promise<void> {
    await this.safeRemove(channel, timestamp, EMOJI_PROCESSING);
    await this.safeAdd(channel, timestamp, EMOJI_ERROR);
  }

  async replaceWithWarning(channel: string, timestamp: string): Promise<void> {
    await this.safeRemove(channel, timestamp, EMOJI_PROCESSING);
    await this.safeAdd(channel, timestamp, EMOJI_WARNING);
  }

  private async safeAdd(
    channel: string,
    timestamp: string,
    name: string,
  ): Promise<void> {
    try {
      await this.client.reactions.add({ channel, timestamp, name });
    } catch (err) {
      logger.debug('Failed to add reaction', { channel, timestamp, name, error: err });
    }
  }

  private async safeRemove(
    channel: string,
    timestamp: string,
    name: string,
  ): Promise<void> {
    try {
      await this.client.reactions.remove({ channel, timestamp, name });
    } catch (err) {
      logger.debug('Failed to remove reaction', { channel, timestamp, name, error: err });
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/slack/reaction-manager.test.ts --reporter=verbose`
Expected: PASS

- [ ] **Step 5: Commit**

---

### Task 19: Error Display + Retry Button

**Files:**
- Create: `src/slack/error-handler.ts`
- Test: `tests/slack/error-handler.test.ts`

**Depends on:** Task 14 (block-builder)

- [ ] **Step 1: Write the failing test**

Create `tests/slack/error-handler.test.ts`:
```typescript
import { describe, it, expect, vi } from 'vitest';
import { ErrorDisplayHandler } from '../../src/slack/error-handler.js';
import { ExecutionError, ProcessError, BridgeError } from '../../src/utils/errors.js';

describe('ErrorDisplayHandler', () => {
  function createMockClient() {
    return {
      chat: {
        postMessage: vi.fn().mockResolvedValue({ ok: true, ts: '2.000' }),
      },
    };
  }

  it('should post execution error with retry button', async () => {
    const client = createMockClient();
    const handler = new ErrorDisplayHandler(client as any);

    const err = new ExecutionError('CLI failed', {
      sessionId: 'abc-123',
      exitCode: 1,
      stderr: 'command not found',
    });

    await handler.displayError({
      error: err,
      channelId: 'D123',
      threadTs: '1.000',
      originalPromptHash: 'hash123',
    });

    expect(client.chat.postMessage).toHaveBeenCalledTimes(1);
    const callArgs = client.chat.postMessage.mock.calls[0][0];
    expect(callArgs.channel).toBe('D123');
    expect(callArgs.thread_ts).toBe('1.000');
    expect(callArgs.blocks.length).toBeGreaterThan(0);
  });

  it('should post process timeout error', async () => {
    const client = createMockClient();
    const handler = new ErrorDisplayHandler(client as any);

    const err = ProcessError.timeout('abc-123', 300000);

    await handler.displayError({
      error: err,
      channelId: 'D123',
      threadTs: '1.000',
    });

    expect(client.chat.postMessage).toHaveBeenCalledTimes(1);
  });

  it('should post generic bridge error', async () => {
    const client = createMockClient();
    const handler = new ErrorDisplayHandler(client as any);

    const err = new BridgeError('something broke', 'UNKNOWN_ERROR');

    await handler.displayError({
      error: err,
      channelId: 'D123',
      threadTs: '1.000',
    });

    expect(client.chat.postMessage).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/slack/error-handler.test.ts --reporter=verbose`
Expected: FAIL

- [ ] **Step 3: Write implementation**

Create `src/slack/error-handler.ts`:
```typescript
import { buildErrorBlocks } from './block-builder.js';
import { BridgeError, ExecutionError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

interface SlackClient {
  chat: {
    postMessage: (args: any) => Promise<any>;
  };
}

export interface DisplayErrorParams {
  error: Error;
  channelId: string;
  threadTs: string;
  originalPromptHash?: string;
}

export class ErrorDisplayHandler {
  constructor(private readonly client: SlackClient) {}

  async displayError(params: DisplayErrorParams): Promise<void> {
    const { error, channelId, threadTs, originalPromptHash } = params;

    let errorMessage: string;
    let sessionId = 'unknown';
    let exitCode: number | null = null;

    if (error instanceof ExecutionError) {
      errorMessage = error.context.stderr as string || error.message;
      sessionId = error.context.sessionId as string || 'unknown';
      exitCode = (error.context.exitCode as number) ?? null;
    } else if (error instanceof BridgeError) {
      errorMessage = error.message;
      sessionId = (error.context.sessionId as string) || 'unknown';
    } else {
      errorMessage = error.message;
    }

    const blocks = buildErrorBlocks({
      errorMessage,
      sessionId,
      exitCode,
      originalPromptHash,
    });

    try {
      await this.client.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs,
        text: `Error: ${errorMessage}`,
        blocks,
      });
    } catch (err) {
      logger.error('Failed to display error in Slack', {
        channelId,
        threadTs,
        error: err,
      });
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/slack/error-handler.test.ts --reporter=verbose`
Expected: PASS

- [ ] **Step 5: Commit**

---

### Task 20: cc /status, cc /end, cc /help Implementation

**Files:**
- Create: `src/slack/bridge-commands.ts`
- Test: `tests/slack/bridge-commands.test.ts`

**Depends on:** Task 13 (command-parser), Task 14 (block-builder), Task 10 (session-manager)

- [ ] **Step 1: Write the failing test**

Create `tests/slack/bridge-commands.test.ts`:
```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BridgeCommandHandler } from '../../src/slack/bridge-commands.js';
import { SessionStore } from '../../src/store/session-store.js';

describe('BridgeCommandHandler', () => {
  let sessionStore: SessionStore;
  let mockClient: any;
  let handler: BridgeCommandHandler;

  beforeEach(() => {
    sessionStore = new SessionStore();
    mockClient = {
      chat: {
        postMessage: vi.fn().mockResolvedValue({ ok: true }),
        update: vi.fn().mockResolvedValue({ ok: true }),
      },
    };
    handler = new BridgeCommandHandler(sessionStore, mockClient);
  });

  describe('handleHelp', () => {
    it('should post help message', async () => {
      await handler.handleHelp('D123', '1.000');

      expect(mockClient.chat.postMessage).toHaveBeenCalledTimes(1);
      const args = mockClient.chat.postMessage.mock.calls[0][0];
      expect(args.thread_ts).toBe('1.000');
      expect(args.text).toContain('cc /');
    });
  });

  describe('handleStatus', () => {
    it('should show session status when session exists', async () => {
      sessionStore.create({
        threadTs: '1.000',
        dmChannelId: 'D123',
        projectPath: '/dev/app',
        name: 'test session',
        model: 'sonnet',
      });

      await handler.handleStatus('D123', '1.000');

      expect(mockClient.chat.postMessage).toHaveBeenCalledTimes(1);
      const args = mockClient.chat.postMessage.mock.calls[0][0];
      expect(args.text).toContain('test session');
    });

    it('should show no active session message', async () => {
      await handler.handleStatus('D123', '1.000');

      expect(mockClient.chat.postMessage).toHaveBeenCalledTimes(1);
      const args = mockClient.chat.postMessage.mock.calls[0][0];
      expect(args.text).toContain('No active session');
    });
  });

  describe('handleEnd', () => {
    it('should end active session', async () => {
      sessionStore.create({
        threadTs: '1.000',
        dmChannelId: 'D123',
        projectPath: '/dev/app',
        name: 'test session',
        model: 'sonnet',
      });

      await handler.handleEnd('D123', '1.000');

      const session = sessionStore.findByThreadTs('1.000');
      expect(session?.status).toBe('ended');
      expect(mockClient.chat.postMessage).toHaveBeenCalledTimes(1);
    });

    it('should show error when no session to end', async () => {
      await handler.handleEnd('D123', '1.000');

      expect(mockClient.chat.postMessage).toHaveBeenCalledTimes(1);
      const args = mockClient.chat.postMessage.mock.calls[0][0];
      expect(args.text).toContain('No active session');
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/slack/bridge-commands.test.ts --reporter=verbose`
Expected: FAIL

- [ ] **Step 3: Write implementation**

Create `src/slack/bridge-commands.ts`:
```typescript
import type { SessionStore } from '../store/session-store.js';
import { logger } from '../utils/logger.js';

interface SlackClient {
  chat: {
    postMessage: (args: any) => Promise<any>;
    update: (args: any) => Promise<any>;
  };
}

export class BridgeCommandHandler {
  constructor(
    private readonly sessionStore: SessionStore,
    private readonly client: SlackClient,
  ) {}

  async handleHelp(channelId: string, threadTs: string): Promise<void> {
    const helpText = [
      '*Claude Code Bridge Commands*',
      '',
      '*Bridge commands:*',
      '`cc /status` - Show current session status',
      '`cc /end` - End the current session',
      '`cc /help` - Show this help message',
      '`cc /model <opus|sonnet|haiku>` - Change model',
      '`cc /rename <name>` - Rename session',
      '`cc /panel` - Toggle anchor panel',
      '',
      '*Claude Code commands (forwarded):*',
      '`cc /commit` - Create a git commit',
      '`cc /review-pr <N>` - Review a pull request',
      '`cc /compact` - Compact context',
      '`cc /clear` - Clear context',
      '`cc /diff` - Show changes',
      '`cc /<any>` - Any Claude Code slash command',
      '',
      '_Send plain text to chat with Claude Code_',
    ].join('\n');

    await this.client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text: helpText,
    });
  }

  async handleStatus(channelId: string, threadTs: string): Promise<void> {
    const session = this.sessionStore.findByThreadTs(threadTs);

    if (!session) {
      await this.client.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs,
        text: 'No active session in this thread.',
      });
      return;
    }

    const statusEmoji = session.status === 'active' ? ':large_green_circle:' : ':white_circle:';
    const statusText = [
      `${statusEmoji} *${session.name}*`,
      '',
      `*Session ID:* \`${session.sessionId.substring(0, 8)}\``,
      `*Project:* \`${session.projectPath}\``,
      `*Model:* ${session.model}`,
      `*Status:* ${session.status}`,
      `*Turns:* ${session.turnCount}`,
      `*Cost:* $${session.totalCost.toFixed(3)}`,
      `*Tokens:* ${session.totalInputTokens.toLocaleString()} in / ${session.totalOutputTokens.toLocaleString()} out`,
      `*Started:* ${session.startTime.toISOString()}`,
    ].join('\n');

    await this.client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text: statusText,
    });
  }

  async handleEnd(channelId: string, threadTs: string): Promise<void> {
    const session = this.sessionStore.findByThreadTs(threadTs);

    if (!session || session.status === 'ended') {
      await this.client.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs,
        text: 'No active session in this thread.',
      });
      return;
    }

    this.sessionStore.end(session.sessionId);

    await this.client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text: `:white_circle: Session *${session.name}* ended.\nTotal cost: $${session.totalCost.toFixed(3)} | Turns: ${session.turnCount}`,
    });

    logger.info('Session ended via cc /end', { sessionId: session.sessionId });
  }

  async dispatch(
    command: string,
    args: string | undefined,
    channelId: string,
    threadTs: string,
  ): Promise<void> {
    switch (command) {
      case 'help':
        return this.handleHelp(channelId, threadTs);
      case 'status':
        return this.handleStatus(channelId, threadTs);
      case 'end':
        return this.handleEnd(channelId, threadTs);
      case 'model':
        return this.handleModel(channelId, threadTs, args);
      case 'rename':
        return this.handleRename(channelId, threadTs, args);
      case 'panel':
        return this.handlePanel(channelId, threadTs);
      default:
        await this.client.chat.postMessage({
          channel: channelId,
          thread_ts: threadTs,
          text: `Unknown bridge command: \`${command}\`. Use \`cc /help\` for available commands.`,
        });
    }
  }

  private async handleModel(
    channelId: string,
    threadTs: string,
    args?: string,
  ): Promise<void> {
    const session = this.sessionStore.findByThreadTs(threadTs);
    if (!session) {
      await this.client.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs,
        text: 'No active session in this thread.',
      });
      return;
    }

    const validModels = ['opus', 'sonnet', 'haiku'] as const;
    const model = args?.trim().toLowerCase();
    if (!model || !validModels.includes(model as any)) {
      await this.client.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs,
        text: `Usage: \`cc /model <opus|sonnet|haiku>\`\nCurrent model: ${session.model}`,
      });
      return;
    }

    this.sessionStore.update(session.sessionId, { model: model as any });
    await this.client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text: `Model changed to *${model}*. Next message will use this model.`,
    });
  }

  private async handleRename(
    channelId: string,
    threadTs: string,
    args?: string,
  ): Promise<void> {
    const session = this.sessionStore.findByThreadTs(threadTs);
    if (!session) {
      await this.client.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs,
        text: 'No active session in this thread.',
      });
      return;
    }

    if (!args || args.trim() === '') {
      await this.client.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs,
        text: `Usage: \`cc /rename <new name>\`\nCurrent name: ${session.name}`,
      });
      return;
    }

    const newName = args.trim().substring(0, 150);
    this.sessionStore.update(session.sessionId, { name: newName });
    await this.client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text: `Session renamed to *${newName}*`,
    });
  }

  private async handlePanel(
    channelId: string,
    threadTs: string,
  ): Promise<void> {
    const session = this.sessionStore.findByThreadTs(threadTs);
    if (!session) {
      await this.client.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs,
        text: 'No active session in this thread.',
      });
      return;
    }

    const collapsed = !session.anchorCollapsed;
    this.sessionStore.update(session.sessionId, { anchorCollapsed: collapsed });
    await this.client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text: `Panel ${collapsed ? 'collapsed' : 'expanded'}.`,
    });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/slack/bridge-commands.test.ts --reporter=verbose`
Expected: PASS

- [ ] **Step 5: Commit**

---

## Final: Integration Wiring

### Task 21: Wire Everything Together in index.ts

**Files:**
- Modify: `src/index.ts`

**Depends on:** All previous tasks

- [ ] **Step 1: Update index.ts to wire all components**

Update `src/index.ts`:
```typescript
import { App } from '@slack/bolt';
import { createApp, startApp } from './app.js';
import { config } from './config.js';
import { logger } from './utils/logger.js';
import { AuthMiddleware } from './middleware/auth.js';
import { RateLimiter } from './middleware/rate-limiter.js';
import { ProjectStore } from './store/project-store.js';
import { SessionStore } from './store/session-store.js';
import { SessionManager } from './bridge/session-manager.js';
import { ProcessManager } from './bridge/process-manager.js';
import { Executor } from './bridge/executor.js';
import { EventRouter } from './slack/event-handler.js';
import { ReactionManager } from './slack/reaction-manager.js';
import { ErrorDisplayHandler } from './slack/error-handler.js';
import { BridgeCommandHandler } from './slack/bridge-commands.js';
import { HomeTabHandler } from './slack/home-tab.js';
import { sanitizeUserInput } from './utils/sanitizer.js';

async function main(): Promise<void> {
  const app = createApp();

  // Initialize stores
  const projectStore = new ProjectStore(config.claudeProjectsDir);
  const sessionStore = new SessionStore();
  const sessionManager = new SessionManager(sessionStore, projectStore);

  // Initialize process management
  const processManager = new ProcessManager({
    maxConcurrentPerUser: config.maxConcurrentPerUser,
    maxConcurrentGlobal: config.maxConcurrentGlobal,
    defaultTimeoutMs: config.defaultTimeoutMs,
    maxTimeoutMs: config.maxTimeoutMs,
    defaultBudgetUsd: config.defaultBudgetUsd,
    maxBudgetUsd: config.maxBudgetUsd,
  });
  const executor = new Executor(processManager, config.claudeExecutable);

  // Initialize middleware
  const auth = new AuthMiddleware({
    allowedUserIds: config.allowedUserIds,
    allowedTeamIds: config.allowedTeamIds,
    adminUserIds: config.adminUserIds,
  });
  const rateLimiter = new RateLimiter({ maxRequests: 10, windowMs: 60_000 });

  // Initialize Slack handlers
  const reactionManager = new ReactionManager(app.client);
  const errorHandler = new ErrorDisplayHandler(app.client);
  const bridgeCommands = new BridgeCommandHandler(sessionStore, app.client);
  const homeTab = new HomeTabHandler(projectStore, sessionStore);

  // Event router
  const router = new EventRouter({
    onPrompt: async (msg) => {
      // Auth + Rate limit check
      if (!auth.isAllowed(msg.userId)) {
        logger.warn('Unauthorized user', { userId: msg.userId });
        return;
      }
      const rateResult = rateLimiter.check(msg.userId);
      if (!rateResult.allowed) {
        await app.client.chat.postMessage({
          channel: msg.channelId,
          thread_ts: msg.threadTs,
          text: `Rate limited. Please wait ${Math.ceil((rateResult.retryAfterMs || 0) / 1000)}s.`,
        });
        return;
      }

      // Concurrency check
      if (!processManager.canStart(msg.userId)) {
        await app.client.chat.postMessage({
          channel: msg.channelId,
          thread_ts: msg.threadTs,
          text: 'You already have a running session. Please wait for it to complete or use `cc /end`.',
        });
        return;
      }

      // Resolve or create session
      // For MVP, use first project as default
      const projects = projectStore.getProjects();
      const defaultProjectId = projects[0]?.id || 'default';

      const { session, isNew } = sessionManager.resolveOrCreate({
        threadTs: msg.threadTs,
        dmChannelId: msg.channelId,
        projectId: defaultProjectId,
        promptText: msg.text,
      });

      // Add processing reaction
      await reactionManager.addProcessing(msg.channelId, msg.messageTs);

      // Execute
      try {
        const sanitizedPrompt = sanitizeUserInput(msg.text);
        const result = await executor.execute(session, sanitizedPrompt, msg.userId, {
          budgetUsd: config.defaultBudgetUsd,
          timeoutMs: config.defaultTimeoutMs,
        });

        // Record turn
        sessionManager.recordTurn(session.sessionId, {
          cost: result.output.total_cost_usd,
          inputTokens: 0, // MVP: not available from json output
          outputTokens: 0,
        });

        // Post result
        await app.client.chat.postMessage({
          channel: msg.channelId,
          thread_ts: msg.threadTs,
          text: result.output.result,
        });

        await reactionManager.replaceWithSuccess(msg.channelId, msg.messageTs);
      } catch (err) {
        await reactionManager.replaceWithError(msg.channelId, msg.messageTs);
        await errorHandler.displayError({
          error: err as Error,
          channelId: msg.channelId,
          threadTs: msg.threadTs,
        });
      }
    },

    onCommand: async (msg) => {
      if (!auth.isAllowed(msg.userId)) return;

      if (msg.parsed.type === 'bridge_command' && msg.parsed.command) {
        await bridgeCommands.dispatch(
          msg.parsed.command,
          msg.parsed.args,
          msg.channelId,
          msg.threadTs,
        );
      } else if (msg.parsed.type === 'claude_command') {
        // Forward as prompt: "/<command> <args>"
        const promptText = `/${msg.parsed.command}${msg.parsed.args ? ` ${msg.parsed.args}` : ''}`;
        await router.handleMessage({
          text: promptText,
          user: msg.userId,
          channel: msg.channelId,
          ts: msg.messageTs,
          thread_ts: msg.threadTs,
        });
      }
    },
  });

  // Register Bolt event handlers
  app.event('message', async ({ event }) => {
    if (event.channel_type !== 'im') return;
    await router.handleMessage(event as any);
  });

  app.event('app_home_opened', async ({ event }) => {
    await homeTab.publishHomeTab(app.client, event.user);
  });

  // Start
  await startApp(app);
  logger.info('Claude Code Slack Bridge is running');

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info(`Received ${signal}, shutting down...`);
    processManager.killAll();
    await app.stop();
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  logger.error('Fatal error', { error: err });
  process.exit(1);
});
```

- [ ] **Step 2: Verify full project compiles**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 3: Run all tests**

Run: `npx vitest run --reporter=verbose`
Expected: All tests PASS

- [ ] **Step 4: Commit**
