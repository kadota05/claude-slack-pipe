# Channel = AI-Native App Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Slack チャネルを AI-Native アプリケーションとして扱い、DM と同じ PersistentSession 基盤でストリーミング UX を提供する

**Architecture:** ChannelRouter を廃止し、チャネルメッセージを DM と同じ PersistentSession パイプラインに統合。cwd をチャネルプロジェクトディレクトリに設定することで Claude CLI が自動的にチャネルの CLAUDE.md と settings.json を読み込む。新規に ChannelProjectManager（init/管理）と ChannelScheduler（定時トリガー）を追加。

**Tech Stack:** TypeScript, Slack Bolt, node-cron, vitest

**Spec:** `docs/superpowers/specs/2026-03-28-channel-as-ai-native-app-design.md`

---

## File Structure

### New files
| File | Responsibility |
|---|---|
| `src/bridge/channel-project-manager.ts` | チャネルプロジェクトの init / exists / path 解決 / コンテキスト構築 |
| `src/bridge/channel-scheduler.ts` | schedule.json 監視 + cron トリガー発火 |
| `templates/channel-project/CLAUDE.md` | init 時に生成される CLAUDE.md テンプレート |
| `tests/bridge/channel-project-manager.test.ts` | ChannelProjectManager のテスト |
| `tests/bridge/channel-scheduler.test.ts` | ChannelScheduler のテスト |

### Modified files
| File | Change |
|---|---|
| `src/index.ts` | handleMessage のルーティング変更、member_joined_channel ハンドラ追加、ChannelScheduler 起動 |
| `src/bridge/bridge-context.ts` | `buildSkillList` を export して共用 |
| `package.json` | node-cron 依存追加 |

### Deleted files
| File | Reason |
|---|---|
| `src/bridge/channel-router.ts` | PersistentSession に統合のため廃止 |

---

### Task 1: node-cron 依存追加

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install node-cron**

Run: `npm install node-cron && npm install -D @types/node-cron`
Expected: package.json updated, node_modules installed

- [ ] **Step 2: Verify installation**

Run: `npm ls node-cron`
Expected: Shows `node-cron@x.x.x`

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add node-cron dependency for channel scheduler"
```

---

### Task 2: チャネルプロジェクトテンプレート作成

**Files:**
- Create: `templates/channel-project/CLAUDE.md`

- [ ] **Step 1: Create template directory**

Run: `mkdir -p templates/channel-project`

- [ ] **Step 2: Create CLAUDE.md template**

Create `templates/channel-project/CLAUDE.md`:

```markdown
<!-- SYSTEM RULES - この規約セクションは編集禁止 -->
# プロジェクト規約

このディレクトリは1つのAIアプリケーション。
対話を通じて以下の構成を育てていく。

## このファイル（CLAUDE.md）
アプリのコアロジック。
「何者で、何をして、何をしないか」を定義。
この規約セクション以外を自由に編集・拡張する。

## skills/
機能の単位。1ファイル = 1つの機能。
「何を、どういう手順と判断基準でやるか」を
自然言語で記述する。
実際の操作にはツールを使う。
フロントマターに name, description を必須。

## mcps/<ツール名>/
ツールの自作場所。これは最終手段。
組込ツール（Read, Bash, Glob等）や
公開済みMCP（数百種以上存在）を徹底的に
調査し、それでも必要な操作が実現できない
場合にのみ自作する。
1フォルダ = 1ツール名 = 1つの操作群。

## .claude/settings.json
このプロジェクトで使うツールとモデルの設定。
ツール追加は必ずこのファイルに行う。
グローバル設定には絶対に追加しない。

## schedule.json
定時トリガー。
「いつ、何のプロンプトを投入するか」を定義。
bridgeのスケジューラが読んで実行する。

## 育て方の原則
1. 対話でアプリの目的を理解する
2. CLAUDE.mdのアプリ定義に目的とルールを書く
3. 機能が必要になったらskills/にスキルを作る
4. ツールが必要になったら：
   組込ツールで可能か確認
   → 既存MCPを徹底調査
   → それでもなければmcps/に自作
   追加は必ず.claude/settings.jsonへ（PJ限定）
5. 定時実行が必要ならschedule.jsonに追加
<!-- END SYSTEM RULES -->

# アプリ定義
（まだ定義されていません。何を作りたいか教えてください）
```

- [ ] **Step 3: Commit**

```bash
git add templates/channel-project/
git commit -m "feat: add channel project CLAUDE.md template"
```

---

### Task 3: bridge-context.ts からスキルリスト構築を切り出す

**Files:**
- Modify: `src/bridge/bridge-context.ts`
- Test: `tests/bridge/channel-project-manager.test.ts` (Task 4 でまとめてテスト)

- [ ] **Step 1: Extract buildSkillList function**

`src/bridge/bridge-context.ts` の `buildBridgeContext` 内にあるスキルリスト構築ロジックを独立関数として export する。

`src/bridge/bridge-context.ts` に以下を追加:

```typescript
/**
 * Scan a skills directory and return discovered skill metadata.
 */
export async function discoverSkills(skillsDir: string): Promise<SkillMeta[]> {
  const skills: SkillMeta[] = [];
  try {
    const files = await fs.readdir(skillsDir);
    for (const file of files) {
      if (!file.endsWith('.md')) continue;
      try {
        const content = await fs.readFile(path.join(skillsDir, file), 'utf-8');
        const meta = parseFrontmatter(content);
        if (meta) {
          skills.push(meta);
        }
      } catch {
        logger.warn(`Failed to read skill file: ${file}`);
      }
    }
  } catch {
    // skills directory doesn't exist or unreadable — skip
  }
  return skills;
}
```

`buildBridgeContext` 内のスキル読み込み部分を `discoverSkills` の呼び出しに置き換える:

```typescript
export async function buildBridgeContext(dataDir: string): Promise<string> {
  const parts: string[] = [];

  const claudeMdPath = path.join(dataDir, 'CLAUDE.md');
  try {
    const content = await fs.readFile(claudeMdPath, 'utf-8');
    parts.push(content.trim());
  } catch {
    // CLAUDE.md doesn't exist or unreadable — skip
  }

  const skills = await discoverSkills(path.join(dataDir, 'skills'));
  if (skills.length > 0) {
    const skillsList = skills
      .map(s => `- ${s.name}: ${s.description}`)
      .join('\n');
    parts.push(`[Bridge Skills]\nThe following bridge skills are available for use with the Skill tool:\n\n${skillsList}`);
  }

  const result = parts.join('\n\n');

  if (result.length > ARG_MAX_SAFE) {
    logger.warn(`Bridge context exceeds safe ARG_MAX limit (${result.length} bytes), skipping injection`);
    return '';
  }

  return result;
}
```

- [ ] **Step 2: Run existing tests to verify no regression**

Run: `npx vitest run`
Expected: All existing tests pass

- [ ] **Step 3: Commit**

```bash
git add src/bridge/bridge-context.ts
git commit -m "refactor: extract discoverSkills from buildBridgeContext"
```

---

### Task 4: ChannelProjectManager 作成

**Files:**
- Create: `src/bridge/channel-project-manager.ts`
- Create: `tests/bridge/channel-project-manager.test.ts`

- [ ] **Step 1: Write tests**

Create `tests/bridge/channel-project-manager.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ChannelProjectManager } from '../../src/bridge/channel-project-manager.js';

describe('ChannelProjectManager', () => {
  let tmpDir: string;
  let manager: ChannelProjectManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'channel-test-'));
    const templatesDir = path.join(tmpDir, 'templates');
    fs.mkdirSync(path.join(templatesDir), { recursive: true });
    fs.writeFileSync(
      path.join(templatesDir, 'CLAUDE.md'),
      '<!-- SYSTEM RULES -->\n# Test\n<!-- END SYSTEM RULES -->\n\n# アプリ定義\n',
    );
    manager = new ChannelProjectManager(tmpDir, templatesDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('exists', () => {
    it('returns false for non-existent channel', () => {
      expect(manager.exists('C_NONEXIST')).toBe(false);
    });

    it('returns true after init', async () => {
      await manager.init('C_TEST123');
      expect(manager.exists('C_TEST123')).toBe(true);
    });
  });

  describe('init', () => {
    it('creates full directory structure', async () => {
      const projectPath = await manager.init('C_TEST123');

      expect(fs.existsSync(path.join(projectPath, 'CLAUDE.md'))).toBe(true);
      expect(fs.existsSync(path.join(projectPath, 'skills'))).toBe(true);
      expect(fs.existsSync(path.join(projectPath, 'mcps'))).toBe(true);
      expect(fs.existsSync(path.join(projectPath, '.claude', 'settings.json'))).toBe(true);
      expect(fs.existsSync(path.join(projectPath, 'schedule.json'))).toBe(true);
    });

    it('writes correct initial settings.json', async () => {
      const projectPath = await manager.init('C_TEST123');
      const settings = JSON.parse(
        fs.readFileSync(path.join(projectPath, '.claude', 'settings.json'), 'utf-8'),
      );
      expect(settings.model).toBe('sonnet');
    });

    it('writes correct initial schedule.json', async () => {
      const projectPath = await manager.init('C_TEST123');
      const schedule = JSON.parse(
        fs.readFileSync(path.join(projectPath, 'schedule.json'), 'utf-8'),
      );
      expect(schedule.triggers).toEqual([]);
    });

    it('does not overwrite existing project', async () => {
      const projectPath = await manager.init('C_TEST123');
      // Modify CLAUDE.md
      fs.writeFileSync(path.join(projectPath, 'CLAUDE.md'), 'custom content');

      // Init again — should not overwrite
      await manager.init('C_TEST123');
      const content = fs.readFileSync(path.join(projectPath, 'CLAUDE.md'), 'utf-8');
      expect(content).toBe('custom content');
    });
  });

  describe('getProjectPath', () => {
    it('returns correct path', () => {
      const result = manager.getProjectPath('C_TEST123');
      expect(result).toBe(path.join(tmpDir, 'channels', 'C_TEST123'));
    });
  });

  describe('listChannelIds', () => {
    it('returns empty for no channels', () => {
      expect(manager.listChannelIds()).toEqual([]);
    });

    it('returns channel ids after init', async () => {
      await manager.init('C_AAA');
      await manager.init('C_BBB');
      const ids = manager.listChannelIds();
      expect(ids.sort()).toEqual(['C_AAA', 'C_BBB']);
    });
  });

  describe('buildContext', () => {
    it('returns empty string when no skills', async () => {
      await manager.init('C_TEST123');
      const ctx = await manager.buildContext('C_TEST123');
      expect(ctx).toBe('');
    });

    it('returns skill list when skills exist', async () => {
      const projectPath = await manager.init('C_TEST123');
      fs.writeFileSync(
        path.join(projectPath, 'skills', 'test-skill.md'),
        '---\nname: Test Skill\ndescription: A test\n---\n\nBody',
      );
      const ctx = await manager.buildContext('C_TEST123');
      expect(ctx).toContain('Test Skill');
      expect(ctx).toContain('A test');
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/bridge/channel-project-manager.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement ChannelProjectManager**

Create `src/bridge/channel-project-manager.ts`:

```typescript
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { discoverSkills } from './bridge-context.js';
import { logger } from '../utils/logger.js';

const SLACK_CONTEXT = `[Slack Bridge Context]
Accessed through Slack, not terminal.
- Assume the user is on a mobile phone
- Not at the machine — no local interaction possible
- Max 45 chars wide for tables/diagrams/ASCII art`;

export class ChannelProjectManager {
  private readonly channelsDir: string;

  constructor(
    private readonly dataDir: string,
    private readonly templatesDir: string,
  ) {
    this.channelsDir = path.join(dataDir, 'channels');
  }

  getProjectPath(channelId: string): string {
    return path.join(this.channelsDir, channelId);
  }

  exists(channelId: string): boolean {
    return fs.existsSync(this.getProjectPath(channelId));
  }

  listChannelIds(): string[] {
    try {
      return fs.readdirSync(this.channelsDir, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name);
    } catch {
      return [];
    }
  }

  async init(channelId: string): Promise<string> {
    const projectPath = this.getProjectPath(channelId);

    // Create directory structure
    await fsp.mkdir(path.join(projectPath, 'skills'), { recursive: true });
    await fsp.mkdir(path.join(projectPath, 'mcps'), { recursive: true });
    await fsp.mkdir(path.join(projectPath, '.claude'), { recursive: true });

    // Write CLAUDE.md from template (only if not exists)
    const claudeMdDest = path.join(projectPath, 'CLAUDE.md');
    if (!fs.existsSync(claudeMdDest)) {
      const templatePath = path.join(this.templatesDir, 'CLAUDE.md');
      try {
        const content = await fsp.readFile(templatePath, 'utf-8');
        await fsp.writeFile(claudeMdDest, content, 'utf-8');
      } catch {
        logger.warn(`Channel template CLAUDE.md not found at ${templatePath}`);
      }
    }

    // Write settings.json (only if not exists)
    const settingsPath = path.join(projectPath, '.claude', 'settings.json');
    if (!fs.existsSync(settingsPath)) {
      await fsp.writeFile(settingsPath, JSON.stringify({ model: 'sonnet' }, null, 2), 'utf-8');
    }

    // Write schedule.json (only if not exists)
    const schedulePath = path.join(projectPath, 'schedule.json');
    if (!fs.existsSync(schedulePath)) {
      await fsp.writeFile(schedulePath, JSON.stringify({ triggers: [] }, null, 2), 'utf-8');
    }

    logger.info(`Initialized channel project: ${channelId}`);
    return projectPath;
  }

  async buildContext(channelId: string): Promise<string> {
    const projectPath = this.getProjectPath(channelId);
    const skillsDir = path.join(projectPath, 'skills');

    const parts: string[] = [];

    // Slack context (shared between DM and channel)
    parts.push(SLACK_CONTEXT);

    // Channel skills
    const skills = await discoverSkills(skillsDir);
    if (skills.length > 0) {
      const skillsList = skills
        .map(s => `- ${s.name}: ${s.description}`)
        .join('\n');
      parts.push(`[Channel Skills]\nThe following skills are available for use with the Skill tool:\n\n${skillsList}`);
    }

    const result = parts.join('\n\n');
    // Return empty if only slack context (no skills yet)
    return skills.length > 0 ? result : '';
  }
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/bridge/channel-project-manager.test.ts`
Expected: All tests pass

- [ ] **Step 5: Commit**

```bash
git add src/bridge/channel-project-manager.ts tests/bridge/channel-project-manager.test.ts
git commit -m "feat: add ChannelProjectManager for channel project lifecycle"
```

---

### Task 5: ChannelScheduler 作成

**Files:**
- Create: `src/bridge/channel-scheduler.ts`
- Create: `tests/bridge/channel-scheduler.test.ts`

- [ ] **Step 1: Write tests**

Create `tests/bridge/channel-scheduler.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ChannelScheduler, type ScheduleTrigger } from '../../src/bridge/channel-scheduler.js';

describe('ChannelScheduler', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scheduler-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeSchedule(channelId: string, triggers: ScheduleTrigger[]) {
    const channelDir = path.join(tmpDir, 'channels', channelId);
    fs.mkdirSync(channelDir, { recursive: true });
    fs.writeFileSync(
      path.join(channelDir, 'schedule.json'),
      JSON.stringify({ triggers }),
    );
  }

  describe('loadAll', () => {
    it('loads triggers from all channel directories', () => {
      writeSchedule('C_AAA', [
        { name: 'daily', cron: '0 9 * * *', prompt: 'Report' },
      ]);
      writeSchedule('C_BBB', [
        { name: 'weekly', cron: '0 17 * * 5', prompt: 'Review' },
      ]);

      const triggered: Array<{ channelId: string; trigger: ScheduleTrigger }> = [];
      const scheduler = new ChannelScheduler(
        path.join(tmpDir, 'channels'),
        async (channelId, trigger) => { triggered.push({ channelId, trigger }); },
      );

      // loadAll should not throw
      scheduler.loadAll();
      // Verify jobs were registered (2 channels, 1 trigger each)
      expect(scheduler.jobCount).toBe(2);

      scheduler.stop();
    });

    it('handles empty triggers array', () => {
      writeSchedule('C_AAA', []);

      const scheduler = new ChannelScheduler(
        path.join(tmpDir, 'channels'),
        async () => {},
      );

      scheduler.loadAll();
      expect(scheduler.jobCount).toBe(0);

      scheduler.stop();
    });

    it('handles missing channels directory', () => {
      const scheduler = new ChannelScheduler(
        path.join(tmpDir, 'nonexistent'),
        async () => {},
      );

      // Should not throw
      scheduler.loadAll();
      expect(scheduler.jobCount).toBe(0);

      scheduler.stop();
    });
  });

  describe('loadChannel', () => {
    it('replaces existing jobs for a channel', () => {
      writeSchedule('C_AAA', [
        { name: 'daily', cron: '0 9 * * *', prompt: 'Report' },
      ]);

      const scheduler = new ChannelScheduler(
        path.join(tmpDir, 'channels'),
        async () => {},
      );

      scheduler.loadChannel('C_AAA');
      expect(scheduler.jobCount).toBe(1);

      // Update schedule with 2 triggers
      writeSchedule('C_AAA', [
        { name: 'daily', cron: '0 9 * * *', prompt: 'Report' },
        { name: 'weekly', cron: '0 17 * * 5', prompt: 'Review' },
      ]);

      scheduler.loadChannel('C_AAA');
      expect(scheduler.jobCount).toBe(2);

      scheduler.stop();
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/bridge/channel-scheduler.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement ChannelScheduler**

Create `src/bridge/channel-scheduler.ts`:

```typescript
import cron from 'node-cron';
import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../utils/logger.js';

export interface ScheduleTrigger {
  name: string;
  cron: string;
  prompt: string;
}

interface ScheduleConfig {
  triggers: ScheduleTrigger[];
}

export class ChannelScheduler {
  private jobs = new Map<string, cron.ScheduledTask[]>();

  constructor(
    private readonly channelsDir: string,
    private readonly onTrigger: (channelId: string, trigger: ScheduleTrigger) => Promise<void>,
  ) {}

  get jobCount(): number {
    let count = 0;
    for (const tasks of this.jobs.values()) {
      count += tasks.length;
    }
    return count;
  }

  loadAll(): void {
    let channelIds: string[];
    try {
      channelIds = fs.readdirSync(this.channelsDir, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name);
    } catch {
      return;
    }

    for (const channelId of channelIds) {
      this.loadChannel(channelId);
    }

    logger.info(`Channel scheduler loaded ${this.jobCount} jobs across ${channelIds.length} channels`);
  }

  loadChannel(channelId: string): void {
    // Stop existing jobs for this channel
    const existing = this.jobs.get(channelId);
    if (existing) {
      for (const task of existing) {
        task.stop();
      }
    }

    const schedulePath = path.join(this.channelsDir, channelId, 'schedule.json');
    let config: ScheduleConfig;
    try {
      const content = fs.readFileSync(schedulePath, 'utf-8');
      config = JSON.parse(content);
    } catch {
      this.jobs.set(channelId, []);
      return;
    }

    const tasks: cron.ScheduledTask[] = [];

    for (const trigger of config.triggers) {
      if (!cron.validate(trigger.cron)) {
        logger.warn(`Invalid cron expression for ${channelId}/${trigger.name}: ${trigger.cron}`);
        continue;
      }

      const task = cron.schedule(trigger.cron, () => {
        logger.info(`Firing scheduled trigger: ${channelId}/${trigger.name}`);
        this.onTrigger(channelId, trigger).catch(err => {
          logger.error(`Scheduled trigger failed: ${channelId}/${trigger.name}`, err);
        });
      });

      tasks.push(task);
    }

    this.jobs.set(channelId, tasks);
  }

  stop(): void {
    for (const tasks of this.jobs.values()) {
      for (const task of tasks) {
        task.stop();
      }
    }
    this.jobs.clear();
  }
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/bridge/channel-scheduler.test.ts`
Expected: All tests pass

- [ ] **Step 5: Commit**

```bash
git add src/bridge/channel-scheduler.ts tests/bridge/channel-scheduler.test.ts
git commit -m "feat: add ChannelScheduler for cron-based channel triggers"
```

---

### Task 6: member_joined_channel イベントハンドラ追加

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Import ChannelProjectManager and add initialization**

`src/index.ts` の既存の import 群の後に追加:

```typescript
import { ChannelProjectManager } from './bridge/channel-project-manager.js';
```

`main()` 関数内、`migrateTemplates` 呼び出しの後（line ~149 付近）に追加:

```typescript
const channelTemplatesDir = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'templates', 'channel-project');
const channelProjectManager = new ChannelProjectManager(config.dataDir, channelTemplatesDir);
```

- [ ] **Step 2: Register member_joined_channel event handler**

`src/index.ts` の `app.event('message', ...)` 登録の近く（line ~751 付近）に追加:

```typescript
app.event('member_joined_channel', async ({ event }) => {
  // Only react when the bot itself joins
  if (event.user !== botUserId) return;

  const channelId = event.channel;
  if (channelProjectManager.exists(channelId)) {
    logger.info(`Channel project already exists for ${channelId}, skipping init`);
    return;
  }

  try {
    await channelProjectManager.init(channelId);
    await app.client.chat.postMessage({
      channel: channelId,
      text: '✅ AIアプリとして初期化しました。何を作りましょう？',
    });
    logger.info(`Channel project initialized: ${channelId}`);
  } catch (err) {
    logger.error(`Failed to initialize channel project: ${channelId}`, err);
  }
});
```

- [ ] **Step 3: Resolve botUserId**

`src/index.ts` の `main()` 関数内、app 起動後に bot user ID を取得する。既存の `auth.test` 呼び出しの近く（あるいは app.start() の後）に追加:

```typescript
const authTestResult = await app.client.auth.test();
const botUserId = authTestResult.user_id!;
```

注意: `botUserId` が既に別の場所で取得されている場合はそれを再利用する。既存コードを確認して重複しないようにすること。

- [ ] **Step 4: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass

- [ ] **Step 5: Commit**

```bash
git add src/index.ts
git commit -m "feat: auto-init channel project on bot join (member_joined_channel)"
```

---

### Task 7: handleMessage のルーティング変更

**Files:**
- Modify: `src/index.ts`

これが最も大きな変更。handleMessage の冒頭にあるチャネルルーティングを PersistentSession 統合に書き換える。

- [ ] **Step 1: Replace channel routing block**

`src/index.ts` の handleMessage 内、line 208-231 の以下のブロック:

```typescript
if (event.channel_type !== 'im') {
  // Channel message — route via Channel Router
  if (event.channel && channelRouter.hasRoute(event.channel)) {
    // Skip bot's own messages
    if (event.bot_id || event.subtype === 'bot_message') return;

    const slackFiles = (event.files ?? []) as Array<{...}>;

    channelRouter.dispatch({...}).catch((err) => {
      logger.error('Channel dispatch error:', err);
    });
  }
  return;
}
```

これを以下に置き換える:

```typescript
// Resolve mode: DM or Channel
const isChannel = event.channel_type !== 'im';

if (isChannel) {
  // Channel: skip if no project exists, skip bot messages
  if (!channelProjectManager.exists(event.channel)) return;
  if (event.bot_id || event.subtype === 'bot_message') return;
}
```

- [ ] **Step 2: Modify session creation to use channel-specific cwd and context**

handleMessage 内の新規セッション作成部分（line ~435-466）を変更。`projectPath` と context の解決をモード分岐する:

現在のコード（line 437-442 付近）:
```typescript
const prefs = userPrefStore.get(userId);
const projects = projectStore.getProjects();
const activeDir = prefs.activeDirectoryId
  ? projects.find((p) => p.id === prefs.activeDirectoryId)
  : projects[0];
const projectPath = activeDir?.workingDirectory || process.cwd();
```

これを以下に置き換える:

```typescript
let projectPath: string;
let sessionModel: string;
let sessionContext: string | undefined;

if (isChannel) {
  projectPath = channelProjectManager.getProjectPath(event.channel);
  // Read model from channel's settings.json, fallback to sonnet
  try {
    const settings = JSON.parse(
      fs.readFileSync(path.join(projectPath, '.claude', 'settings.json'), 'utf-8'),
    );
    sessionModel = settings.model || 'sonnet';
  } catch {
    sessionModel = 'sonnet';
  }
  sessionContext = await channelProjectManager.buildContext(event.channel);
} else {
  const prefs = userPrefStore.get(userId);
  const projects = projectStore.getProjects();
  const activeDir = prefs.activeDirectoryId
    ? projects.find((p) => p.id === prefs.activeDirectoryId)
    : projects[0];
  projectPath = activeDir?.workingDirectory || process.cwd();
  sessionModel = prefs.defaultModel;
  sessionContext = bridgeContext;
}
```

そして `getOrCreateSession` 呼び出しで `model` と `bridgeContext` を差し替える:

```typescript
session = await coordinator.getOrCreateSession({
  sessionId,
  userId: isChannel ? event.channel : userId,  // Channel: use channelId as userId for session management
  model: sessionModel,
  projectPath,
  isResume: false,
  bridgeContext: sessionContext,
});
```

- [ ] **Step 3: Skip DM-specific logic for channels**

handleMessage 内の以下の DM 固有ロジックをチャネル時にスキップする:

1. **Bot commands** (line 337-416): `/end`, `/status`, `/restart` はDM専用
```typescript
// Parse command (DM only)
const parsed = isChannel
  ? { type: 'plain_text' as const, content: text }
  : parseCommand(text);
```

2. **Model switching on existing sessions** (line 483-531): チャネルではユーザー個人の model preference は使わない
```typescript
if (existingSession && existingSession.state !== 'dead') {
  if (isChannel) {
    session = existingSession;
  } else {
    // Existing DM model-switch logic...
  }
}
```

3. **Thread header ephemeral** (line 468-479): チャネルでは投稿しない（チャネルメンバー全員に見えてしまう）
```typescript
if (!isChannel) {
  const headerText = buildThreadHeaderText({...});
  await app.client.chat.postEphemeral({...});
}
```

- [ ] **Step 4: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass

- [ ] **Step 5: Commit**

```bash
git add src/index.ts
git commit -m "feat: route channel messages through PersistentSession pipeline"
```

---

### Task 8: ChannelScheduler をindex.tsに統合

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Import and initialize ChannelScheduler**

`src/index.ts` に import 追加:

```typescript
import { ChannelScheduler } from './bridge/channel-scheduler.js';
```

`main()` 関数内、channelProjectManager 初期化の後に追加:

```typescript
const channelScheduler = new ChannelScheduler(
  path.join(config.dataDir, 'channels'),
  async (channelId, trigger) => {
    try {
      // Post trigger message to channel (creates a new thread)
      const result = await app.client.chat.postMessage({
        channel: channelId,
        text: `⏰ 定時実行: ${trigger.name}`,
      });

      if (!result.ts) {
        logger.error(`Failed to post trigger message to ${channelId}`);
        return;
      }

      const threadTs = result.ts;
      const projectPath = channelProjectManager.getProjectPath(channelId);

      let sessionModel = 'sonnet';
      try {
        const settings = JSON.parse(
          fs.readFileSync(path.join(projectPath, '.claude', 'settings.json'), 'utf-8'),
        );
        sessionModel = settings.model || 'sonnet';
      } catch { /* use default */ }

      const sessionContext = await channelProjectManager.buildContext(channelId);
      const sessionId = crypto.randomUUID();

      const session = await coordinator.getOrCreateSession({
        sessionId,
        userId: channelId,
        model: sessionModel,
        projectPath,
        isResume: false,
        bridgeContext: sessionContext,
      });

      sessionIndexStore.register({
        cliSessionId: sessionId,
        threadTs,
        channelId,
        userId: 'scheduler',
        projectPath,
        name: trigger.name,
        model: sessionModel,
        status: 'active',
        createdAt: new Date().toISOString(),
        lastActiveAt: new Date().toISOString(),
      });

      wireSessionOutput(session, channelId, threadTs, reactionManager, app.client, sessionIndexStore, projectPath);

      // Send the scheduled prompt
      activeMessageTs.set(session.sessionId, result.ts);
      await reactionManager.addSpawning(channelId, result.ts);
      session.sendInitialPrompt(trigger.prompt);

      await waitForInit(session).catch(async (err) => {
        session.end();
        await app.client.chat.postMessage({
          channel: channelId,
          thread_ts: threadTs,
          text: `❌ 定時実行 "${trigger.name}" の起動に失敗: ${(err as Error).message}`,
        });
      });
    } catch (err) {
      logger.error(`Scheduled trigger failed: ${channelId}/${trigger.name}`, err);
    }
  },
);

channelScheduler.loadAll();
```

- [ ] **Step 2: Reload scheduler when schedule.json changes**

member_joined_channel ハンドラの後に、チャネルプロジェクトの schedule.json が変更された場合にリロードする仕組みを追加。シンプルにするため、チャネルへのメッセージ処理時にリロードする方式（処理頻度が低いため十分）:

handleMessage のチャネル分岐内に追加:

```typescript
if (isChannel) {
  if (!channelProjectManager.exists(event.channel)) return;
  if (event.bot_id || event.subtype === 'bot_message') return;
  // Reload schedule on activity (lazy reload)
  channelScheduler.loadChannel(event.channel);
}
```

- [ ] **Step 3: Add scheduler stop to shutdown**

既存の `shutdown()` 関数内に追加:

```typescript
channelScheduler.stop();
```

- [ ] **Step 4: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass

- [ ] **Step 5: Commit**

```bash
git add src/index.ts
git commit -m "feat: integrate ChannelScheduler for scheduled triggers"
```

---

### Task 9: member_left_channel ハンドラ追加

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Register member_left_channel event handler**

`src/index.ts` の `member_joined_channel` ハンドラの後に追加:

```typescript
app.event('member_left_channel', async ({ event }) => {
  if (event.user !== botUserId) return;

  const channelId = event.channel;
  logger.info(`Bot left channel ${channelId}, deactivating sessions`);

  // End any active sessions for this channel
  // Sessions use channelId as userId in coordinator
  const entries = sessionIndexStore.findByUserId(channelId);
  for (const entry of entries) {
    if (entry.status === 'active') {
      coordinator.endSession(entry.cliSessionId);
      sessionIndexStore.update(entry.cliSessionId, { status: 'ended' });
    }
  }

  // Stop scheduled jobs for this channel
  channelScheduler.loadChannel(channelId);  // reloads with 0 triggers since dir still exists

  // Note: project directory is preserved for data safety.
  // Re-inviting the bot will reactivate the channel.
});
```

注意: `sessionIndexStore.findByUserId` が存在しない場合は、SessionIndexStore に追加するか、全エントリをスキャンする実装にする。実装時に既存 API を確認すること。

- [ ] **Step 2: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass

- [ ] **Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat: deactivate channel sessions on bot leave (member_left_channel)"
```

---

### Task 10: ChannelRouter 削除とクリーンアップ

**Files:**
- Delete: `src/bridge/channel-router.ts`
- Modify: `src/index.ts` (import 削除、初期化コード削除)

- [ ] **Step 1: Remove ChannelRouter import and initialization from index.ts**

`src/index.ts` から以下を削除:

1. ChannelRouter の import 文
2. ChannelRouter のインスタンス化コード（`new ChannelRouter(...)`, `channelRouter.startWatching()` 等）
3. `channelRouter` への残存参照がないことを grep で確認

Run: `grep -n 'channelRouter\|ChannelRouter\|channel-router' src/index.ts`
Expected: No matches

- [ ] **Step 2: Delete channel-router.ts**

Run: `rm src/bridge/channel-router.ts`

- [ ] **Step 3: Remove slack-memory.json references**

`src/index.ts` 内の `slack-memory.json` パスの定義があれば削除する。

Run: `grep -rn 'slack-memory' src/`
Expected: No matches (or only in deleted file)

- [ ] **Step 4: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass

- [ ] **Step 5: Verify build**

Run: `npx tsc --noEmit`
Expected: No type errors

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor: remove ChannelRouter, complete migration to PersistentSession"
```

---

### Task 11: 手動統合テスト

**Files:** None (verification only)

- [ ] **Step 1: Bridge 再起動をユーザーに依頼**

> コードを変更しました。Slackで `cc /restart-bridge` と送信して再起動してください。

- [ ] **Step 2: チャネル初期化テスト**

1. 新しい Slack チャネルを作成
2. bot を招待
3. ウェルカムメッセージが表示されることを確認
4. `~/.claude-slack-pipe/channels/<channel-id>/` が作成されたことを確認

- [ ] **Step 3: チャネルでの対話テスト**

1. 初期化されたチャネルでメッセージを送信
2. ストリーミング表示（thinking, tool use, reactions）が DM と同様に動作することを確認
3. スレッド内で会話を継続し、セッションが維持されることを確認

- [ ] **Step 4: DM 回帰テスト**

1. DM でメッセージを送信
2. 従来通り動作することを確認（bridge skills, model switching, /end, /status）

- [ ] **Step 5: 定時トリガーテスト**

1. チャネルの schedule.json に直近1分後のトリガーを設定
2. トリガー発火を確認（スレッド作成、プロンプト実行、ストリーミング表示）
