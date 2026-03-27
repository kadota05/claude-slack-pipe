# Body Concierge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an independent health/beauty management AI assistant (Body Concierge) that communicates via a dedicated Slack channel, processes meal photos and health data, and provides personalized daily/weekly feedback

**Architecture:** Independent TypeScript project using claude -p oneshot for AI processing. Messages arrive via Bridge Channel Router (standard handler interface). Scheduled jobs (morning/evening/weekly) run via launchd. All data stored as structured JSON files. Personalization via AI-maintained knowledge.md.

**Tech Stack:** TypeScript, tsx, Slack Web API (@slack/web-api), claude -p CLI, launchd, Vitest

**Branch:** `feat/body-concierge`

**Note:** This is a new independent project at `~/dev/body-concierge/`. NOT inside claude-slack-pipe.

---

## File Structure

| Action | Path | Responsibility |
|--------|------|---------------|
| Create | `package.json` | Project dependencies and scripts |
| Create | `tsconfig.json` | TypeScript config |
| Create | `.env` | SLACK_BOT_TOKEN, SLACK_CHANNEL_ID |
| Create | `CLAUDE.md` | Concierge persona and rules for claude -p |
| Create | `src/lib/claude.ts` | claude -p oneshot wrapper |
| Create | `src/lib/data.ts` | Data file read/write utilities |
| Create | `src/lib/slack.ts` | Slack Web API posting |
| Create | `src/lib/classifier.ts` | Input classification (haiku) |
| Create | `src/lib/meal.ts` | Meal recognition + nutrition estimation |
| Create | `src/lib/metrics.ts` | Body metrics extraction |
| Create | `src/lib/interaction.ts` | Question/consultation handler |
| Create | `src/process-message.ts` | CLI entry point for channel handler |
| Create | `src/scheduled/morning.ts` | Morning comment job |
| Create | `src/scheduled/evening.ts` | Evening review + knowledge update |
| Create | `src/scheduled/weekly.ts` | Weekly report + deep knowledge update |
| Create | `src/prompts/classify.md` | Classification prompt template |
| Create | `src/prompts/meal-analysis.md` | Meal analysis prompt template |
| Create | `src/prompts/question.md` | Consultation prompt template |
| Create | `src/prompts/morning.md` | Morning comment prompt template |
| Create | `src/prompts/evening.md` | Evening review prompt template |
| Create | `src/prompts/weekly.md` | Weekly report prompt template |
| Create | `tests/lib/data.test.ts` | Data utility tests |
| Create | `tests/lib/classifier.test.ts` | Classifier tests |
| Create | `tests/lib/meal.test.ts` | Meal processor tests |
| Create | `tests/process-message.test.ts` | CLI integration tests |

---

### Task 1: Project scaffold

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `.env.example`
- Create: `.gitignore`

- [ ] **Step 1: Create project directory**

```bash
mkdir -p ~/dev/body-concierge && cd ~/dev/body-concierge && git init
```

- [ ] **Step 2: Create package.json**

```json
{
  "name": "body-concierge",
  "version": "0.1.0",
  "type": "module",
  "private": true,
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "lint": "tsc --noEmit",
    "process": "tsx src/process-message.ts",
    "morning": "tsx src/scheduled/morning.ts",
    "evening": "tsx src/scheduled/evening.ts",
    "weekly": "tsx src/scheduled/weekly.ts"
  },
  "dependencies": {
    "@slack/web-api": "^7.9.1",
    "dotenv": "^16.4.7",
    "minimist": "^1.2.8"
  },
  "devDependencies": {
    "@types/minimist": "^1.2.5",
    "@types/node": "^22.13.10",
    "typescript": "^5.9.3",
    "tsx": "^4.21.0",
    "vitest": "^4.1.0"
  }
}
```

- [ ] **Step 3: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "rootDir": "src",
    "declaration": true,
    "sourceMap": true
  },
  "include": ["src"],
  "exclude": ["node_modules", "dist", "tests"]
}
```

- [ ] **Step 4: Create vitest.config.ts**

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
```

- [ ] **Step 5: Create .env.example**

```
SLACK_BOT_TOKEN=xoxb-your-token
SLACK_CHANNEL_ID=C0123456789
```

- [ ] **Step 6: Create .gitignore**

```
node_modules/
dist/
.env
data/
```

- [ ] **Step 7: Install dependencies**

```bash
cd ~/dev/body-concierge && npm install && echo "✅ install done"
```

- [ ] **Step 8: Create data directories**

```bash
mkdir -p data/meals data/metrics data/interactions data/weekly && echo "✅ created"
```

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "chore: initial project scaffold for body-concierge"
```

---

### Task 2: CLAUDE.md — Concierge persona

**Files:**
- Create: `CLAUDE.md`

- [ ] **Step 1: Write CLAUDE.md**

```markdown
# ボディコンシェルジュ

## ペルソナ

あなたは専属ボディコンシェルジュです。食事・運動・体調・美容を統合的にマネジメントします。

### トーン
- プロフェッショナルだけど温かい
- 褒める。責めない
- 「ダメ」ではなく「こうするともっと良い」
- 美意識を大切にする：「タンパク質不足です」ではなく「タンパク質不足は肌のハリに出ますよ」

### やること
- 食事の認識と栄養推定
- 体調・体重・運動・睡眠・肌の記録管理
- パーソナライズされたアドバイス（定期コメントで）
- 相談への丁寧な回答
- データからの傾向分析

### やらないこと
- 医学的な診断（体調が悪いときは受診を勧める）
- 記録時のアドバイス（記録はサクッと受けるだけ）
- 説教やネガティブなコメント

## 出力ルール
- 日本語で応答する
- JSON出力を求められた場合は必ず有効なJSONのみを返す（マークダウンコードブロック不可）
- 栄養推定値はあくまで推定であることを前提に、妥当な値を出す
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: add concierge persona definition"
```

---

### Task 3: Data utilities — tests and implementation

**Files:**
- Create: `src/lib/data.ts`
- Create: `tests/lib/data.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/lib/data.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  readJsonFile,
  writeJsonFile,
  appendToMeals,
  updateMetrics,
  appendToInteractions,
  readProfile,
  writeProfile,
  readKnowledge,
  writeKnowledge,
  getDataDir,
} from '../../src/lib/data.js';

describe('data utilities', () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bc-data-'));
    await fs.mkdir(path.join(dataDir, 'meals'), { recursive: true });
    await fs.mkdir(path.join(dataDir, 'metrics'), { recursive: true });
    await fs.mkdir(path.join(dataDir, 'interactions'), { recursive: true });
    process.env.BC_DATA_DIR = dataDir;
  });

  afterEach(async () => {
    await fs.rm(dataDir, { recursive: true, force: true });
    delete process.env.BC_DATA_DIR;
  });

  describe('readJsonFile / writeJsonFile', () => {
    it('writes and reads JSON', async () => {
      const filePath = path.join(dataDir, 'test.json');
      await writeJsonFile(filePath, { hello: 'world' });
      const result = await readJsonFile(filePath);
      expect(result).toEqual({ hello: 'world' });
    });

    it('returns null for missing file', async () => {
      const result = await readJsonFile(path.join(dataDir, 'missing.json'));
      expect(result).toBeNull();
    });
  });

  describe('appendToMeals', () => {
    it('creates new daily file and appends meal', async () => {
      const meal = {
        time: '12:30',
        type: 'lunch' as const,
        description: 'チキンサラダ',
        image: false,
        nutrition: { calories: 350, protein_g: 25, fat_g: 15, carbs_g: 20 },
        source: 'text' as const,
      };

      await appendToMeals(dataDir, '2026-03-27', meal);

      const filePath = path.join(dataDir, 'meals', '2026-03-27.json');
      const data = JSON.parse(await fs.readFile(filePath, 'utf-8'));
      expect(data.date).toBe('2026-03-27');
      expect(data.meals).toHaveLength(1);
      expect(data.meals[0].description).toBe('チキンサラダ');
    });

    it('appends to existing daily file', async () => {
      const meal1 = { time: '08:00', type: 'breakfast' as const, description: 'Toast', image: false, nutrition: { calories: 200, protein_g: 5, fat_g: 8, carbs_g: 30 }, source: 'text' as const };
      const meal2 = { time: '12:00', type: 'lunch' as const, description: 'Ramen', image: false, nutrition: { calories: 600, protein_g: 20, fat_g: 25, carbs_g: 70 }, source: 'text' as const };

      await appendToMeals(dataDir, '2026-03-27', meal1);
      await appendToMeals(dataDir, '2026-03-27', meal2);

      const filePath = path.join(dataDir, 'meals', '2026-03-27.json');
      const data = JSON.parse(await fs.readFile(filePath, 'utf-8'));
      expect(data.meals).toHaveLength(2);
    });
  });

  describe('updateMetrics', () => {
    it('creates new metrics file', async () => {
      await updateMetrics(dataDir, '2026-03-27', { weight_kg: 70 });

      const filePath = path.join(dataDir, 'metrics', '2026-03-27.json');
      const data = JSON.parse(await fs.readFile(filePath, 'utf-8'));
      expect(data.date).toBe('2026-03-27');
      expect(data.weight_kg).toBe(70);
    });

    it('merges into existing metrics', async () => {
      await updateMetrics(dataDir, '2026-03-27', { weight_kg: 70 });
      await updateMetrics(dataDir, '2026-03-27', { exercise: 'ジム 45分' });

      const filePath = path.join(dataDir, 'metrics', '2026-03-27.json');
      const data = JSON.parse(await fs.readFile(filePath, 'utf-8'));
      expect(data.weight_kg).toBe(70);
      expect(data.exercise).toBe('ジム 45分');
    });
  });

  describe('knowledge', () => {
    it('reads and writes knowledge.md', async () => {
      const content = '# パーソナライズ知識\n\n## 食の好み\n- 和食好き';
      await writeKnowledge(dataDir, content);

      const result = await readKnowledge(dataDir);
      expect(result).toBe(content);
    });

    it('returns empty string for missing knowledge', async () => {
      const result = await readKnowledge(dataDir);
      expect(result).toBe('');
    });
  });

  describe('profile', () => {
    it('reads and writes profile', async () => {
      const profile = { age: 30, height_cm: 175, weight_kg: 70, goals: ['減量'] };
      await writeProfile(dataDir, profile);

      const result = await readProfile(dataDir);
      expect(result).toEqual(profile);
    });

    it('returns null for missing profile', async () => {
      const result = await readProfile(dataDir);
      expect(result).toBeNull();
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/dev/body-concierge && npx vitest run tests/lib/data.test.ts --reporter=verbose`
Expected: FAIL — cannot resolve module

- [ ] **Step 3: Implement data.ts**

```typescript
// src/lib/data.ts
import fs from 'node:fs/promises';
import path from 'node:path';

export function getDataDir(): string {
  return process.env.BC_DATA_DIR ?? path.join(process.cwd(), 'data');
}

export async function readJsonFile<T = unknown>(filePath: string): Promise<T | null> {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(content) as T;
  } catch (err: any) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

export async function writeJsonFile(filePath: string, data: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

export interface MealEntry {
  time: string;
  type: 'breakfast' | 'lunch' | 'dinner' | 'snack';
  description: string;
  image: boolean;
  nutrition: {
    calories: number;
    protein_g: number;
    fat_g: number;
    carbs_g: number;
  };
  source: 'photo_analysis' | 'text';
}

interface DailyMeals {
  date: string;
  meals: MealEntry[];
}

export async function appendToMeals(dataDir: string, date: string, meal: MealEntry): Promise<void> {
  const filePath = path.join(dataDir, 'meals', `${date}.json`);
  const existing = await readJsonFile<DailyMeals>(filePath);

  const data: DailyMeals = existing ?? { date, meals: [] };
  data.meals.push(meal);
  await writeJsonFile(filePath, data);
}

export interface MetricsData {
  date?: string;
  weight_kg?: number;
  sleep?: string;
  condition?: string;
  skin?: string;
  exercise?: string;
  water_ml?: number;
}

export async function updateMetrics(dataDir: string, date: string, updates: Partial<MetricsData>): Promise<void> {
  const filePath = path.join(dataDir, 'metrics', `${date}.json`);
  const existing = await readJsonFile<MetricsData>(filePath);

  const data: MetricsData = { ...existing, ...updates, date };
  await writeJsonFile(filePath, data);
}

export interface InteractionEntry {
  time: string;
  type: 'question' | 'goal_change' | 'event_plan' | 'supplement' | 'other';
  input: string;
  response: string;
}

interface DailyInteractions {
  date: string;
  entries: InteractionEntry[];
}

export async function appendToInteractions(dataDir: string, date: string, entry: InteractionEntry): Promise<void> {
  const filePath = path.join(dataDir, 'interactions', `${date}.json`);
  const existing = await readJsonFile<DailyInteractions>(filePath);

  const data: DailyInteractions = existing ?? { date, entries: [] };
  data.entries.push(entry);
  await writeJsonFile(filePath, data);
}

export async function readProfile(dataDir: string): Promise<Record<string, unknown> | null> {
  return readJsonFile(path.join(dataDir, 'profile.json'));
}

export async function writeProfile(dataDir: string, profile: Record<string, unknown>): Promise<void> {
  await writeJsonFile(path.join(dataDir, 'profile.json'), profile);
}

export async function readKnowledge(dataDir: string): Promise<string> {
  try {
    return await fs.readFile(path.join(dataDir, 'knowledge.md'), 'utf-8');
  } catch {
    return '';
  }
}

export async function writeKnowledge(dataDir: string, content: string): Promise<void> {
  await fs.writeFile(path.join(dataDir, 'knowledge.md'), content, 'utf-8');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ~/dev/body-concierge && npx vitest run tests/lib/data.test.ts --reporter=verbose`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
cd ~/dev/body-concierge && git add src/lib/data.ts tests/lib/data.test.ts
git commit -m "feat: add data read/write utilities with tests"
```

---

### Task 4: Claude CLI wrapper

**Files:**
- Create: `src/lib/claude.ts`
- Create: `tests/lib/claude.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/lib/claude.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node:child_process', () => {
  const EventEmitter = require('node:events');
  const { Readable } = require('node:stream');
  return {
    spawn: vi.fn(),
  };
});

import { spawn } from 'node:child_process';
import { callClaude } from '../../src/lib/claude.js';

const mockedSpawn = vi.mocked(spawn);

function mockProcess(stdout: string, exitCode: number) {
  const EventEmitter = require('node:events');
  const { PassThrough } = require('node:stream');
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = { write: vi.fn(), end: vi.fn() };

  setTimeout(() => {
    child.stdout.push(stdout);
    child.stdout.push(null);
    child.emit('exit', exitCode);
  }, 5);

  return child;
}

describe('callClaude', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls claude -p and returns result text', async () => {
    const response = JSON.stringify({
      type: 'result',
      subtype: 'success',
      result: 'Hello from Claude',
    });
    mockedSpawn.mockReturnValue(mockProcess(response, 0) as any);

    const result = await callClaude({ prompt: 'test prompt', model: 'haiku' });

    expect(result).toBe('Hello from Claude');
    expect(mockedSpawn).toHaveBeenCalledWith(
      'claude',
      expect.arrayContaining(['-p', '--model', 'haiku', '--output-format', 'json']),
      expect.anything(),
    );
  });

  it('throws on non-zero exit code', async () => {
    mockedSpawn.mockReturnValue(mockProcess('', 1) as any);

    await expect(callClaude({ prompt: 'fail', model: 'haiku' })).rejects.toThrow();
  });

  it('passes --add-dir when workDir specified', async () => {
    const response = JSON.stringify({ type: 'result', subtype: 'success', result: 'ok' });
    mockedSpawn.mockReturnValue(mockProcess(response, 0) as any);

    await callClaude({ prompt: 'test', model: 'sonnet', workDir: '/tmp/project' });

    expect(mockedSpawn).toHaveBeenCalledWith(
      'claude',
      expect.arrayContaining(['--add-dir', '/tmp/project']),
      expect.anything(),
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/dev/body-concierge && npx vitest run tests/lib/claude.test.ts --reporter=verbose`
Expected: FAIL — cannot resolve module

- [ ] **Step 3: Implement claude.ts**

```typescript
// src/lib/claude.ts
import { spawn } from 'node:child_process';

export interface ClaudeOptions {
  prompt: string;
  model: 'haiku' | 'sonnet' | 'opus';
  workDir?: string;
  allowedTools?: string;
}

export async function callClaude(options: ClaudeOptions): Promise<string> {
  const args = [
    '-p',
    '--model', options.model,
    '--output-format', 'json',
    '--permission-mode', 'bypassPermissions',
  ];

  if (options.workDir) {
    args.push('--add-dir', options.workDir);
  }

  if (options.allowedTools) {
    args.push('--allowedTools', options.allowedTools);
  }

  return new Promise((resolve, reject) => {
    const child = spawn('claude', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        CLAUDECODE: undefined,
        CLAUDE_CODE_ENTRYPOINT: undefined,
      },
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

    child.stdin.write(options.prompt);
    child.stdin.end();

    child.on('exit', (code) => {
      if (code !== 0) {
        reject(new Error(`claude -p exited with code ${code}: ${stderr}`));
        return;
      }
      try {
        const parsed = JSON.parse(stdout);
        if (parsed.type === 'result' && parsed.result) {
          resolve(parsed.result);
        } else {
          reject(new Error(`Unexpected claude response: ${stdout}`));
        }
      } catch {
        reject(new Error(`Failed to parse claude response: ${stdout}`));
      }
    });
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ~/dev/body-concierge && npx vitest run tests/lib/claude.test.ts --reporter=verbose`
Expected: All 3 tests PASS

- [ ] **Step 5: Commit**

```bash
cd ~/dev/body-concierge && git add src/lib/claude.ts tests/lib/claude.test.ts
git commit -m "feat: add claude -p oneshot wrapper with tests"
```

---

### Task 5: Slack posting utility

**Files:**
- Create: `src/lib/slack.ts`

- [ ] **Step 1: Implement slack.ts**

```typescript
// src/lib/slack.ts
import { WebClient } from '@slack/web-api';
import dotenv from 'dotenv';

dotenv.config();

let client: WebClient | null = null;

function getClient(): WebClient {
  if (!client) {
    const token = process.env.SLACK_BOT_TOKEN;
    if (!token) throw new Error('SLACK_BOT_TOKEN not set');
    client = new WebClient(token);
  }
  return client;
}

function getChannelId(): string {
  const id = process.env.SLACK_CHANNEL_ID;
  if (!id) throw new Error('SLACK_CHANNEL_ID not set');
  return id;
}

export async function postMessage(text: string, threadTs?: string): Promise<string> {
  const result = await getClient().chat.postMessage({
    channel: getChannelId(),
    text,
    thread_ts: threadTs,
  });
  return result.ts ?? '';
}

export async function postBlocks(blocks: unknown[], text: string, threadTs?: string): Promise<string> {
  const result = await getClient().chat.postMessage({
    channel: getChannelId(),
    blocks: blocks as any[],
    text, // fallback for notifications
    thread_ts: threadTs,
  });
  return result.ts ?? '';
}
```

- [ ] **Step 2: Commit**

```bash
cd ~/dev/body-concierge && git add src/lib/slack.ts
git commit -m "feat: add Slack posting utility"
```

---

### Task 6: Input classifier

**Files:**
- Create: `src/lib/classifier.ts`
- Create: `src/prompts/classify.md`
- Create: `tests/lib/classifier.test.ts`

- [ ] **Step 1: Create classification prompt template**

```markdown
<!-- src/prompts/classify.md -->
以下のユーザー入力を分類してください。

カテゴリ:
- meal: 食事の報告（写真含む）
- snack: 間食・飲み物の報告
- weight: 体重の報告
- exercise: 運動の報告
- sleep: 睡眠の報告
- condition: 体調の報告
- skin: 肌の状態の報告
- water: 水分摂取の報告
- question: 質問・相談
- goal_change: 目標の変更
- event_plan: イベント・予定の共有

JSONのみ返してください:
{"category": "カテゴリ名"}

ユーザー入力:
__INPUT__

画像あり: __HAS_IMAGE__
```

- [ ] **Step 2: Write failing tests**

```typescript
// tests/lib/classifier.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/lib/claude.js', () => ({
  callClaude: vi.fn(),
}));

import { classifyInput, InputCategory } from '../../src/lib/classifier.js';
import { callClaude } from '../../src/lib/claude.js';

const mockedClaude = vi.mocked(callClaude);

describe('classifyInput', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('classifies meal input', async () => {
    mockedClaude.mockResolvedValue('{"category": "meal"}');
    const result = await classifyInput('チキンサラダ食べた', false);
    expect(result).toBe('meal');
  });

  it('classifies weight input', async () => {
    mockedClaude.mockResolvedValue('{"category": "weight"}');
    const result = await classifyInput('今日69.5kg', false);
    expect(result).toBe('weight');
  });

  it('classifies question input', async () => {
    mockedClaude.mockResolvedValue('{"category": "question"}');
    const result = await classifyInput('最近の傾向どう？', false);
    expect(result).toBe('question');
  });

  it('defaults to meal when image present and category unclear', async () => {
    mockedClaude.mockResolvedValue('{"category": "meal"}');
    const result = await classifyInput('', true);
    expect(result).toBe('meal');
    expect(mockedClaude).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'haiku',
      }),
    );
  });

  it('falls back to question on parse error', async () => {
    mockedClaude.mockResolvedValue('invalid json');
    const result = await classifyInput('test', false);
    expect(result).toBe('question');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd ~/dev/body-concierge && npx vitest run tests/lib/classifier.test.ts --reporter=verbose`
Expected: FAIL

- [ ] **Step 4: Implement classifier.ts**

```typescript
// src/lib/classifier.ts
import fs from 'node:fs/promises';
import path from 'node:path';
import { callClaude } from './claude.js';

export type InputCategory =
  | 'meal' | 'snack' | 'weight' | 'exercise'
  | 'sleep' | 'condition' | 'skin' | 'water'
  | 'question' | 'goal_change' | 'event_plan';

const VALID_CATEGORIES = new Set<InputCategory>([
  'meal', 'snack', 'weight', 'exercise',
  'sleep', 'condition', 'skin', 'water',
  'question', 'goal_change', 'event_plan',
]);

export async function classifyInput(text: string, hasImage: boolean): Promise<InputCategory> {
  const templatePath = path.join(import.meta.dirname, '../prompts/classify.md');
  const template = await fs.readFile(templatePath, 'utf-8');

  const prompt = template
    .replace('__INPUT__', text || '（テキストなし）')
    .replace('__HAS_IMAGE__', hasImage ? 'はい' : 'いいえ');

  try {
    const result = await callClaude({ prompt, model: 'haiku' });
    const parsed = JSON.parse(result);
    const category = parsed.category as InputCategory;
    if (VALID_CATEGORIES.has(category)) {
      return category;
    }
  } catch {
    // Fall through to default
  }

  // Default: if image present assume meal, otherwise question
  return hasImage ? 'meal' : 'question';
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd ~/dev/body-concierge && npx vitest run tests/lib/classifier.test.ts --reporter=verbose`
Expected: All 5 tests PASS

- [ ] **Step 6: Commit**

```bash
cd ~/dev/body-concierge && git add src/lib/classifier.ts src/prompts/classify.md tests/lib/classifier.test.ts
git commit -m "feat: add input classifier with haiku model"
```

---

### Task 7: Meal processor

**Files:**
- Create: `src/lib/meal.ts`
- Create: `src/prompts/meal-analysis.md`
- Create: `tests/lib/meal.test.ts`

- [ ] **Step 1: Create meal analysis prompt**

```markdown
<!-- src/prompts/meal-analysis.md -->
あなたは栄養の専門家です。以下の食事情報から、メニューの認識と栄養推定を行ってください。

ユーザー入力: __INPUT__
画像あり: __HAS_IMAGE__
食事タイプ推定: __MEAL_TYPE__
時刻: __TIME__

以下のJSON形式のみ返してください:
{
  "description": "メニュー名（日本語）",
  "nutrition": {
    "calories": 数値,
    "protein_g": 数値,
    "fat_g": 数値,
    "carbs_g": 数値
  }
}

推定のポイント:
- 一般的な1人前の量を想定
- 写真がある場合は見た目から量を推定
- 不明な場合は保守的に推定
```

- [ ] **Step 2: Write failing tests**

```typescript
// tests/lib/meal.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/lib/claude.js', () => ({
  callClaude: vi.fn(),
}));

vi.mock('../../src/lib/data.js', () => ({
  appendToMeals: vi.fn(),
  getDataDir: vi.fn().mockReturnValue('/tmp/test-data'),
}));

import { processMeal } from '../../src/lib/meal.js';
import { callClaude } from '../../src/lib/claude.js';
import { appendToMeals } from '../../src/lib/data.js';

const mockedClaude = vi.mocked(callClaude);
const mockedAppend = vi.mocked(appendToMeals);

describe('processMeal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('processes text meal and returns formatted response', async () => {
    mockedClaude.mockResolvedValue(JSON.stringify({
      description: 'チキンサラダ',
      nutrition: { calories: 350, protein_g: 25, fat_g: 15, carbs_g: 20 },
    }));

    const result = await processMeal({
      text: 'チキンサラダ食べた',
      imagePath: undefined,
      date: '2026-03-27',
      time: '12:30',
      dataDir: '/tmp/test-data',
    });

    expect(result).toContain('チキンサラダ');
    expect(result).toContain('350');
    expect(mockedAppend).toHaveBeenCalledWith(
      '/tmp/test-data',
      '2026-03-27',
      expect.objectContaining({
        description: 'チキンサラダ',
        type: 'lunch',
        source: 'text',
      }),
    );
  });

  it('marks source as photo_analysis when image provided', async () => {
    mockedClaude.mockResolvedValue(JSON.stringify({
      description: '鮭弁当',
      nutrition: { calories: 600, protein_g: 30, fat_g: 20, carbs_g: 70 },
    }));

    await processMeal({
      text: '',
      imagePath: '/tmp/photo.jpg',
      date: '2026-03-27',
      time: '12:30',
      dataDir: '/tmp/test-data',
    });

    expect(mockedAppend).toHaveBeenCalledWith(
      '/tmp/test-data',
      '2026-03-27',
      expect.objectContaining({
        source: 'photo_analysis',
        image: true,
      }),
    );
  });

  it('handles claude parse error gracefully', async () => {
    mockedClaude.mockResolvedValue('not json');

    const result = await processMeal({
      text: 'something',
      imagePath: undefined,
      date: '2026-03-27',
      time: '12:30',
      dataDir: '/tmp/test-data',
    });

    expect(result).toContain('記録');
    // Should still attempt to save with available info
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd ~/dev/body-concierge && npx vitest run tests/lib/meal.test.ts --reporter=verbose`
Expected: FAIL

- [ ] **Step 4: Implement meal.ts**

```typescript
// src/lib/meal.ts
import fs from 'node:fs/promises';
import path from 'node:path';
import { callClaude } from './claude.js';
import { appendToMeals, type MealEntry } from './data.js';

interface MealProcessParams {
  text: string;
  imagePath?: string;
  date: string;
  time: string;
  dataDir: string;
}

function inferMealType(time: string): MealEntry['type'] {
  const hour = parseInt(time.split(':')[0], 10);
  if (hour < 10) return 'breakfast';
  if (hour < 15) return 'lunch';
  if (hour < 21) return 'dinner';
  return 'snack';
}

export async function processMeal(params: MealProcessParams): Promise<string> {
  const templatePath = path.join(import.meta.dirname, '../prompts/meal-analysis.md');
  const template = await fs.readFile(templatePath, 'utf-8');
  const mealType = inferMealType(params.time);

  const prompt = template
    .replace('__INPUT__', params.text || '（写真を参照）')
    .replace('__HAS_IMAGE__', params.imagePath ? 'はい' : 'いいえ')
    .replace('__MEAL_TYPE__', mealType)
    .replace('__TIME__', params.time);

  // TODO: When image provided, use content blocks with base64 image
  // For now, include image path hint in prompt

  try {
    const result = await callClaude({ prompt, model: 'sonnet' });
    const parsed = JSON.parse(result);

    const meal: MealEntry = {
      time: params.time,
      type: mealType,
      description: parsed.description ?? params.text,
      image: !!params.imagePath,
      nutrition: parsed.nutrition ?? { calories: 0, protein_g: 0, fat_g: 0, carbs_g: 0 },
      source: params.imagePath ? 'photo_analysis' : 'text',
    };

    await appendToMeals(params.dataDir, params.date, meal);

    const n = meal.nutrition;
    return `${meal.description} 🍽 ${n.calories}kcal P${n.protein_g} F${n.fat_g} C${n.carbs_g}`;
  } catch {
    // Fallback: save what we can
    const meal: MealEntry = {
      time: params.time,
      type: mealType,
      description: params.text || '（認識失敗）',
      image: !!params.imagePath,
      nutrition: { calories: 0, protein_g: 0, fat_g: 0, carbs_g: 0 },
      source: params.imagePath ? 'photo_analysis' : 'text',
    };
    await appendToMeals(params.dataDir, params.date, meal);
    return `記録しました: ${params.text || '食事'}（栄養推定は次回の振り返りで）`;
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd ~/dev/body-concierge && npx vitest run tests/lib/meal.test.ts --reporter=verbose`
Expected: All 3 tests PASS

- [ ] **Step 6: Commit**

```bash
cd ~/dev/body-concierge && git add src/lib/meal.ts src/prompts/meal-analysis.md tests/lib/meal.test.ts
git commit -m "feat: add meal processor with nutrition estimation"
```

---

### Task 8: Metrics processor

**Files:**
- Create: `src/lib/metrics.ts`

- [ ] **Step 1: Implement metrics.ts**

```typescript
// src/lib/metrics.ts
import { updateMetrics, type MetricsData } from './data.js';
import { callClaude } from './claude.js';

interface MetricsProcessParams {
  category: 'weight' | 'exercise' | 'sleep' | 'condition' | 'skin' | 'water';
  text: string;
  date: string;
  dataDir: string;
}

export async function processMetrics(params: MetricsProcessParams): Promise<string> {
  const { category, text, date, dataDir } = params;

  // Use haiku for simple extraction
  const prompt = `以下のユーザー入力から${categoryLabel(category)}の情報を抽出してください。
JSONのみ返してください。

カテゴリ: ${category}
入力: ${text}

期待する形式:
${extractionFormat(category)}`;

  try {
    const result = await callClaude({ prompt, model: 'haiku' });
    const parsed = JSON.parse(result);
    await updateMetrics(dataDir, date, parsed);
    return formatResponse(category, parsed);
  } catch {
    // Fallback: save raw text
    const fallback: Partial<MetricsData> = {};
    fallback[category === 'weight' ? 'weight_kg' : category] = text as any;
    await updateMetrics(dataDir, date, fallback);
    return `記録しました: ${text}`;
  }
}

function categoryLabel(cat: string): string {
  const labels: Record<string, string> = {
    weight: '体重', exercise: '運動', sleep: '睡眠',
    condition: '体調', skin: '肌の状態', water: '水分摂取',
  };
  return labels[cat] ?? cat;
}

function extractionFormat(cat: string): string {
  const formats: Record<string, string> = {
    weight: '{"weight_kg": 数値}',
    exercise: '{"exercise": "内容と時間"}',
    sleep: '{"sleep": "時間と質"}',
    condition: '{"condition": "状態"}',
    skin: '{"skin": "状態"}',
    water: '{"water_ml": 数値}',
  };
  return formats[cat] ?? '{}';
}

function formatResponse(cat: string, data: Record<string, unknown>): string {
  switch (cat) {
    case 'weight': return `⚖️ ${data.weight_kg}kg`;
    case 'exercise': return `💪 ${data.exercise}`;
    case 'sleep': return `😴 ${data.sleep}`;
    case 'condition': return `🏥 ${data.condition}`;
    case 'skin': return `✨ ${data.skin}`;
    case 'water': return `💧 ${data.water_ml}ml`;
    default: return `記録しました`;
  }
}
```

- [ ] **Step 2: Commit**

```bash
cd ~/dev/body-concierge && git add src/lib/metrics.ts
git commit -m "feat: add metrics processor for weight/exercise/sleep/etc"
```

---

### Task 9: Interaction handler (question/consultation)

**Files:**
- Create: `src/lib/interaction.ts`
- Create: `src/prompts/question.md`

- [ ] **Step 1: Create question prompt**

```markdown
<!-- src/prompts/question.md -->
あなたは専属ボディコンシェルジュです。以下のデータを踏まえて、ユーザーの質問・相談に答えてください。

## ユーザープロフィール
__PROFILE__

## パーソナライズ知識
__KNOWLEDGE__

## 直近7日の食事ログ
__RECENT_MEALS__

## 直近7日のメトリクス
__RECENT_METRICS__

## ユーザーの質問
__QUESTION__

回答ルール:
- 日本語で回答
- データに基づいた具体的なアドバイス
- 美意識を大切に（健康+見た目の両面で）
- 医療行為はしない、必要なら受診を勧める
- 温かくプロフェッショナルなトーンで
```

- [ ] **Step 2: Implement interaction.ts**

```typescript
// src/lib/interaction.ts
import fs from 'node:fs/promises';
import path from 'node:path';
import { callClaude } from './claude.js';
import { readProfile, readKnowledge, readJsonFile, appendToInteractions, type InteractionEntry } from './data.js';

interface QuestionParams {
  text: string;
  date: string;
  time: string;
  dataDir: string;
}

async function loadRecentData(dataDir: string, date: string, subdir: string, days: number): Promise<string> {
  const results: string[] = [];
  const baseDate = new Date(date);

  for (let i = 0; i < days; i++) {
    const d = new Date(baseDate);
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().split('T')[0];
    const data = await readJsonFile(path.join(dataDir, subdir, `${dateStr}.json`));
    if (data) {
      results.push(JSON.stringify(data, null, 2));
    }
  }

  return results.length > 0 ? results.join('\n---\n') : '（データなし）';
}

export async function handleQuestion(params: QuestionParams): Promise<string> {
  const templatePath = path.join(import.meta.dirname, '../prompts/question.md');
  const template = await fs.readFile(templatePath, 'utf-8');

  const [profile, knowledge, recentMeals, recentMetrics] = await Promise.all([
    readProfile(params.dataDir),
    readKnowledge(params.dataDir),
    loadRecentData(params.dataDir, params.date, 'meals', 7),
    loadRecentData(params.dataDir, params.date, 'metrics', 7),
  ]);

  const prompt = template
    .replace('__PROFILE__', profile ? JSON.stringify(profile, null, 2) : '（未登録）')
    .replace('__KNOWLEDGE__', knowledge || '（まだ蓄積なし）')
    .replace('__RECENT_MEALS__', recentMeals)
    .replace('__RECENT_METRICS__', recentMetrics)
    .replace('__QUESTION__', params.text);

  const response = await callClaude({ prompt, model: 'sonnet' });

  const entry: InteractionEntry = {
    time: params.time,
    type: 'question',
    input: params.text,
    response,
  };
  await appendToInteractions(params.dataDir, params.date, entry);

  return response;
}
```

- [ ] **Step 3: Commit**

```bash
cd ~/dev/body-concierge && git add src/lib/interaction.ts src/prompts/question.md
git commit -m "feat: add question/consultation handler with context injection"
```

---

### Task 10: process-message.ts — CLI entry point

**Files:**
- Create: `src/process-message.ts`

- [ ] **Step 1: Implement process-message.ts**

```typescript
// src/process-message.ts
import minimist from 'minimist';
import dotenv from 'dotenv';
import { classifyInput, type InputCategory } from './lib/classifier.js';
import { processMeal } from './lib/meal.js';
import { processMetrics } from './lib/metrics.js';
import { handleQuestion } from './lib/interaction.js';
import { postMessage } from './lib/slack.js';
import { getDataDir } from './lib/data.js';

dotenv.config();

async function main() {
  const args = minimist(process.argv.slice(2));
  const text: string = args.text ?? '';
  const files: string = args.files ?? '';
  const userId: string = args['user-id'] ?? '';
  const channelId: string = args['channel-id'] ?? '';
  const threadTs: string = args['thread-ts'] ?? '';
  const timestamp: string = args.timestamp ?? '';

  const filePaths = files ? files.split(',').filter(Boolean) : [];
  const hasImage = filePaths.some((f) => /\.(jpg|jpeg|png|gif|webp)$/i.test(f));
  const imagePath = filePaths.find((f) => /\.(jpg|jpeg|png|gif|webp)$/i.test(f));

  const now = new Date();
  const date = now.toISOString().split('T')[0];
  const time = now.toTimeString().slice(0, 5);
  const dataDir = getDataDir();

  // Classify input
  const category = await classifyInput(text, hasImage);

  let response: string;

  const recordCategories: InputCategory[] = ['weight', 'exercise', 'sleep', 'condition', 'skin', 'water'];

  if (category === 'meal' || category === 'snack') {
    response = await processMeal({ text, imagePath, date, time, dataDir });
  } else if (recordCategories.includes(category)) {
    response = await processMetrics({ category: category as any, text, date, dataDir });
  } else {
    // question, goal_change, event_plan — all handled as consultations
    response = await handleQuestion({ text, date, time, dataDir });
  }

  // Post response to Slack
  await postMessage(response, threadTs || undefined);
}

main().catch((err) => {
  console.error('process-message failed:', err);
  process.exit(1);
});
```

- [ ] **Step 2: Commit**

```bash
cd ~/dev/body-concierge && git add src/process-message.ts
git commit -m "feat: add process-message CLI entry point for channel handler"
```

---

### Task 11: Prompt templates for scheduled jobs

**Files:**
- Create: `src/prompts/morning.md`
- Create: `src/prompts/evening.md`
- Create: `src/prompts/weekly.md`

- [ ] **Step 1: Create morning prompt**

```markdown
<!-- src/prompts/morning.md -->
あなたは専属ボディコンシェルジュです。朝のコメントを生成してください。

## ユーザープロフィール
__PROFILE__

## パーソナライズ知識
__KNOWLEDGE__

## 昨日の食事
__YESTERDAY_MEALS__

## 昨日のメトリクス
__YESTERDAY_METRICS__

## 昨日のやり取り
__YESTERDAY_INTERACTIONS__

出力ルール:
- 3-5行で簡潔に
- 昨日のデータを踏まえた今日のフォーカスポイント
- ポジティブなトーン
- 美意識の視点を含める
- 日本語で出力
```

- [ ] **Step 2: Create evening prompt**

```markdown
<!-- src/prompts/evening.md -->
あなたは専属ボディコンシェルジュです。2つのタスクを実行してください。

## タスク1: 1日の振り返りコメント

## ユーザープロフィール
__PROFILE__

## パーソナライズ知識
__KNOWLEDGE__

## 今日の食事
__TODAY_MEALS__

## 今日のメトリクス
__TODAY_METRICS__

## 今日のやり取り
__TODAY_INTERACTIONS__

## 直近7日の食事（傾向把握用）
__WEEK_MEALS__

振り返りコメントのルール:
- 栄養サマリ（kcal, P, F, C）を含める
- 体調との相関があれば言及
- よかった点を必ず含める
- 改善ポイントは「こうするともっと良い」の形で
- 5-10行程度

## タスク2: knowledge.md更新判断

現在のknowledge.mdの内容を見て、今日のデータから追加・修正すべきことがあるか判断してください。

更新の判断基準:
- 新しい食の好み・傾向を発見した
- 既存の記述の確信度が変わった
- 提案への反応で学びがあった

以下のJSON形式で返してください:
{
  "comment": "振り返りコメント（テキスト）",
  "knowledge_update": "更新版knowledge.mdの全文" または null（更新不要の場合）
}
```

- [ ] **Step 3: Create weekly prompt**

```markdown
<!-- src/prompts/weekly.md -->
あなたは専属ボディコンシェルジュです。週間レポートを生成してください。

## ユーザープロフィール
__PROFILE__

## パーソナライズ知識
__KNOWLEDGE__

## 今週の食事（7日分）
__WEEK_MEALS__

## 今週のメトリクス（7日分）
__WEEK_METRICS__

## 今週のやり取り（7日分）
__WEEK_INTERACTIONS__

## 前回の週間レポート
__LAST_WEEKLY__

レポートのルール:
- 1週間の栄養平均
- 体重の推移
- 運動回数
- 良い傾向と改善点
- 来週のフォーカス提案
- 美容面の気づきも含める

knowledge.md更新:
- 新しいパターンがあれば追加
- 確信度の昇格/降格を判断（低→中: 2週連続、中→高: 4週一貫）
- 矛盾する記述があれば解消
- 古い情報を整理
- 200行以内に収める

以下のJSON形式で返してください:
{
  "report": "週間レポート（テキスト）",
  "knowledge_update": "更新版knowledge.mdの全文" または null
}
```

- [ ] **Step 4: Commit**

```bash
cd ~/dev/body-concierge && git add src/prompts/morning.md src/prompts/evening.md src/prompts/weekly.md
git commit -m "docs: add prompt templates for scheduled jobs"
```

---

### Task 12: Scheduled jobs — morning, evening, weekly

**Files:**
- Create: `src/scheduled/morning.ts`
- Create: `src/scheduled/evening.ts`
- Create: `src/scheduled/weekly.ts`

- [ ] **Step 1: Implement morning.ts**

```typescript
// src/scheduled/morning.ts
import fs from 'node:fs/promises';
import path from 'node:path';
import dotenv from 'dotenv';
import { callClaude } from '../lib/claude.js';
import { readProfile, readKnowledge, readJsonFile, getDataDir } from '../lib/data.js';
import { postMessage } from '../lib/slack.js';

dotenv.config({ path: path.join(import.meta.dirname, '../../.env') });

async function main() {
  const dataDir = getDataDir();
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = yesterday.toISOString().split('T')[0];

  const [profile, knowledge, meals, metrics, interactions] = await Promise.all([
    readProfile(dataDir),
    readKnowledge(dataDir),
    readJsonFile(path.join(dataDir, 'meals', `${yesterdayStr}.json`)),
    readJsonFile(path.join(dataDir, 'metrics', `${yesterdayStr}.json`)),
    readJsonFile(path.join(dataDir, 'interactions', `${yesterdayStr}.json`)),
  ]);

  const templatePath = path.join(import.meta.dirname, '../prompts/morning.md');
  const template = await fs.readFile(templatePath, 'utf-8');

  const prompt = template
    .replace('__PROFILE__', profile ? JSON.stringify(profile, null, 2) : '（未登録）')
    .replace('__KNOWLEDGE__', knowledge || '（まだ蓄積なし）')
    .replace('__YESTERDAY_MEALS__', meals ? JSON.stringify(meals, null, 2) : '（記録なし）')
    .replace('__YESTERDAY_METRICS__', metrics ? JSON.stringify(metrics, null, 2) : '（記録なし）')
    .replace('__YESTERDAY_INTERACTIONS__', interactions ? JSON.stringify(interactions, null, 2) : '（なし）');

  const comment = await callClaude({ prompt, model: 'sonnet' });
  await postMessage(`☀️ おはようございます\n\n${comment}`);
}

main().catch((err) => {
  console.error('morning job failed:', err);
  process.exit(1);
});
```

- [ ] **Step 2: Implement evening.ts**

```typescript
// src/scheduled/evening.ts
import fs from 'node:fs/promises';
import path from 'node:path';
import dotenv from 'dotenv';
import { callClaude } from '../lib/claude.js';
import { readProfile, readKnowledge, writeKnowledge, readJsonFile, getDataDir } from '../lib/data.js';
import { postMessage } from '../lib/slack.js';

dotenv.config({ path: path.join(import.meta.dirname, '../../.env') });

async function loadWeekMeals(dataDir: string, endDate: string): Promise<string> {
  const results: string[] = [];
  const base = new Date(endDate);
  for (let i = 0; i < 7; i++) {
    const d = new Date(base);
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().split('T')[0];
    const data = await readJsonFile(path.join(dataDir, 'meals', `${dateStr}.json`));
    if (data) results.push(JSON.stringify(data, null, 2));
  }
  return results.length > 0 ? results.join('\n---\n') : '（データなし）';
}

async function main() {
  const dataDir = getDataDir();
  const todayStr = new Date().toISOString().split('T')[0];

  const [profile, knowledge, meals, metrics, interactions, weekMeals] = await Promise.all([
    readProfile(dataDir),
    readKnowledge(dataDir),
    readJsonFile(path.join(dataDir, 'meals', `${todayStr}.json`)),
    readJsonFile(path.join(dataDir, 'metrics', `${todayStr}.json`)),
    readJsonFile(path.join(dataDir, 'interactions', `${todayStr}.json`)),
    loadWeekMeals(dataDir, todayStr),
  ]);

  const templatePath = path.join(import.meta.dirname, '../prompts/evening.md');
  const template = await fs.readFile(templatePath, 'utf-8');

  const prompt = template
    .replace('__PROFILE__', profile ? JSON.stringify(profile, null, 2) : '（未登録）')
    .replace('__KNOWLEDGE__', knowledge || '（まだ蓄積なし）')
    .replace('__TODAY_MEALS__', meals ? JSON.stringify(meals, null, 2) : '（記録なし）')
    .replace('__TODAY_METRICS__', metrics ? JSON.stringify(metrics, null, 2) : '（記録なし）')
    .replace('__TODAY_INTERACTIONS__', interactions ? JSON.stringify(interactions, null, 2) : '（なし）')
    .replace('__WEEK_MEALS__', weekMeals);

  const result = await callClaude({ prompt, model: 'sonnet' });

  try {
    const parsed = JSON.parse(result);
    await postMessage(`🌙 今日のまとめ\n\n${parsed.comment}`);

    if (parsed.knowledge_update) {
      await writeKnowledge(dataDir, parsed.knowledge_update);
    }
  } catch {
    // If not valid JSON, treat entire result as comment
    await postMessage(`🌙 今日のまとめ\n\n${result}`);
  }
}

main().catch((err) => {
  console.error('evening job failed:', err);
  process.exit(1);
});
```

- [ ] **Step 3: Implement weekly.ts**

```typescript
// src/scheduled/weekly.ts
import fs from 'node:fs/promises';
import path from 'node:path';
import dotenv from 'dotenv';
import { callClaude } from '../lib/claude.js';
import { readProfile, readKnowledge, writeKnowledge, readJsonFile, writeJsonFile, getDataDir } from '../lib/data.js';
import { postMessage } from '../lib/slack.js';

dotenv.config({ path: path.join(import.meta.dirname, '../../.env') });

async function loadWeekData(dataDir: string, endDate: string, subdir: string): Promise<string> {
  const results: string[] = [];
  const base = new Date(endDate);
  for (let i = 0; i < 7; i++) {
    const d = new Date(base);
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().split('T')[0];
    const data = await readJsonFile(path.join(dataDir, subdir, `${dateStr}.json`));
    if (data) results.push(JSON.stringify(data, null, 2));
  }
  return results.length > 0 ? results.join('\n---\n') : '（データなし）';
}

async function getLastWeeklyReport(dataDir: string): Promise<string> {
  const weeklyDir = path.join(dataDir, 'weekly');
  try {
    const files = await fs.readdir(weeklyDir);
    const sorted = files.filter((f) => f.endsWith('.json')).sort().reverse();
    if (sorted.length > 0) {
      const data = await readJsonFile(path.join(weeklyDir, sorted[0]));
      return data ? JSON.stringify(data, null, 2) : '（なし）';
    }
  } catch {
    // Directory may not exist
  }
  return '（初回）';
}

async function main() {
  const dataDir = getDataDir();
  const todayStr = new Date().toISOString().split('T')[0];

  const [profile, knowledge, weekMeals, weekMetrics, weekInteractions, lastWeekly] = await Promise.all([
    readProfile(dataDir),
    readKnowledge(dataDir),
    loadWeekData(dataDir, todayStr, 'meals'),
    loadWeekData(dataDir, todayStr, 'metrics'),
    loadWeekData(dataDir, todayStr, 'interactions'),
    getLastWeeklyReport(dataDir),
  ]);

  const templatePath = path.join(import.meta.dirname, '../prompts/weekly.md');
  const template = await fs.readFile(templatePath, 'utf-8');

  const prompt = template
    .replace('__PROFILE__', profile ? JSON.stringify(profile, null, 2) : '（未登録）')
    .replace('__KNOWLEDGE__', knowledge || '（まだ蓄積なし）')
    .replace('__WEEK_MEALS__', weekMeals)
    .replace('__WEEK_METRICS__', weekMetrics)
    .replace('__WEEK_INTERACTIONS__', weekInteractions)
    .replace('__LAST_WEEKLY__', lastWeekly);

  const result = await callClaude({ prompt, model: 'sonnet' });

  try {
    const parsed = JSON.parse(result);
    await postMessage(`📊 週間レポート\n\n${parsed.report}`);

    // Save weekly report
    await fs.mkdir(path.join(dataDir, 'weekly'), { recursive: true });
    await writeJsonFile(path.join(dataDir, 'weekly', `${todayStr}.json`), {
      date: todayStr,
      report: parsed.report,
    });

    if (parsed.knowledge_update) {
      await writeKnowledge(dataDir, parsed.knowledge_update);
    }
  } catch {
    await postMessage(`📊 週間レポート\n\n${result}`);
  }
}

main().catch((err) => {
  console.error('weekly job failed:', err);
  process.exit(1);
});
```

- [ ] **Step 4: Commit**

```bash
cd ~/dev/body-concierge && git add src/scheduled/
git commit -m "feat: add morning, evening, and weekly scheduled jobs"
```

---

### Task 13: launchd plist files

**Files:**
- Create: `launchd/com.body-concierge.morning.plist`
- Create: `launchd/com.body-concierge.evening.plist`
- Create: `launchd/com.body-concierge.weekly.plist`

- [ ] **Step 1: Create morning plist**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.body-concierge.morning</string>
    <key>ProgramArguments</key>
    <array>
        <string>__HOME__/.nvm/versions/node/__NODE_VERSION__/bin/node</string>
        <string>__HOME__/.nvm/versions/node/__NODE_VERSION__/bin/tsx</string>
        <string>__HOME__/dev/body-concierge/src/scheduled/morning.ts</string>
    </array>
    <key>WorkingDirectory</key>
    <string>__HOME__/dev/body-concierge</string>
    <key>StartCalendarInterval</key>
    <dict>
        <key>Hour</key>
        <integer>7</integer>
        <key>Minute</key>
        <integer>0</integer>
    </dict>
    <key>StandardOutPath</key>
    <string>__HOME__/.claude-slack-pipe/logs/body-concierge-morning.log</string>
    <key>StandardErrorPath</key>
    <string>__HOME__/.claude-slack-pipe/logs/body-concierge-morning.log</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>__HOME__/.nvm/versions/node/__NODE_VERSION__/bin:/usr/local/bin:/usr/bin:/bin</string>
    </dict>
</dict>
</plist>
```

- [ ] **Step 2: Create evening plist** (same structure, Hour=22)

- [ ] **Step 3: Create weekly plist** (same structure, Hour=20, add Weekday=0 for Sunday)

Weekly plist `StartCalendarInterval`:
```xml
<key>StartCalendarInterval</key>
<dict>
    <key>Weekday</key>
    <integer>0</integer>
    <key>Hour</key>
    <integer>20</integer>
    <key>Minute</key>
    <integer>0</integer>
</dict>
```

- [ ] **Step 4: Commit**

```bash
cd ~/dev/body-concierge && git add launchd/
git commit -m "chore: add launchd plist templates for scheduled jobs"
```

---

### Task 14: Slack channel setup and slack-memory registration

**Files:**
- No new files — uses Slack API and writes to `~/.claude-slack-pipe/slack-memory.json`

- [ ] **Step 1: Create Slack channel**

```bash
# Get bot token from claude-slack-pipe .env
source ~/dev/claude-slack-pipe/.env

# Create channel via Slack API
curl -s -X POST https://slack.com/api/conversations.create \
  -H "Authorization: Bearer $SLACK_BOT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name": "body-concierge"}' | jq .
```

Note the `channel.id` from the response.

- [ ] **Step 2: Set .env for body-concierge**

```bash
cd ~/dev/body-concierge
cp .env.example .env
# Edit .env with actual token and channel ID
```

- [ ] **Step 3: Register in slack-memory.json**

```bash
# Create or update ~/.claude-slack-pipe/slack-memory.json
cat > ~/.claude-slack-pipe/slack-memory.json << 'EOF'
[
  {
    "folder": "~/dev/body-concierge",
    "description": "ボディコンシェルジュ",
    "channel": "#body-concierge",
    "channelId": "CHANNEL_ID_HERE",
    "handler": "src/process-message.ts",
    "createdAt": "2026-03-27"
  }
]
EOF
```

- [ ] **Step 4: Post initial message to channel**

Test posting to verify setup:
```bash
cd ~/dev/body-concierge && npx tsx -e "
import { postMessage } from './src/lib/slack.js';
postMessage('はじめまして、あなた専属のボディコンシェルジュです。\n\nまずあなたのことを教えてください：\n・年齢\n・身長・体重\n・目標（減量/増量/維持/肌改善 等）\n・アレルギーや持病があれば\n・運動習慣\n\nテキストで自由に送ってもらえれば、こちらで整理します。').then(() => console.log('✅ posted'));
"
```

- [ ] **Step 5: Commit .env.example update if needed**

```bash
cd ~/dev/body-concierge && git add -A && git status
# Commit any remaining changes
git commit -m "chore: finalize channel setup and slack-memory registration"
```

---

### Task 15: End-to-end verification

- [ ] **Step 1: Run all tests**

```bash
cd ~/dev/body-concierge && npx vitest run --reporter=verbose
```
Expected: All tests PASS

- [ ] **Step 2: Type check**

```bash
cd ~/dev/body-concierge && npx tsc --noEmit && echo "✅ types OK"
```

- [ ] **Step 3: Test process-message manually**

```bash
cd ~/dev/body-concierge && npx tsx src/process-message.ts \
  --text "チキンサラダ食べた" \
  --user-id "U123" \
  --channel-id "C123" \
  --thread-ts "" \
  --timestamp "1711000000"
```
Expected: Classifies as meal, estimates nutrition, posts to Slack

- [ ] **Step 4: Test morning job manually**

```bash
cd ~/dev/body-concierge && npx tsx src/scheduled/morning.ts
```
Expected: Posts morning comment to channel

- [ ] **Step 5: Bridge restart and channel routing test**

Request user to restart Bridge (`cc /restart-bridge`), then send a test message in #body-concierge channel.

- [ ] **Step 6: Final commit**

```bash
cd ~/dev/body-concierge && git add -A
git commit -m "feat: body-concierge v0.1.0 — initial working version"
```
