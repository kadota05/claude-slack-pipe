# Channel = AI-Native App Implementation Plan (v2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Slack チャネルを AI-Native アプリケーションとして扱い、DM と同じ PersistentSession 基盤でストリーミング UX を提供する

**Architecture:** ChannelRouter を廃止し、チャネルメッセージを DM と同じ PersistentSession パイプラインに統合。cwd をチャネルプロジェクトディレクトリに設定することで Claude CLI が自動的にチャネルの CLAUDE.md と settings.json を読み込む。新規に ChannelProjectManager（init/管理）と ChannelScheduler（定時トリガー）を追加。

**Tech Stack:** TypeScript, Slack Bolt, node-cron, vitest

**Spec:** `docs/superpowers/specs/2026-03-28-channel-as-ai-native-app-design.md`

---

## 検証で発見された問題と対策

| # | 問題 | 対策 | Task |
|---|---|---|---|
| 1 | sessionCreationLocks のキーが event.user のまま | ロックキーを `threadTs` に変更（DM/チャネル共通で安全） | 9 |
| 2 | maxAlivePerUser=1 がチャネル全体に適用 | SessionStartParams に `maxAliveOverride?` 追加、チャネルは3 | 6 |
| 3 | maxAliveGlobal が未実装（既存バグ） | getOrCreateSession にグローバルリミットチェック追加 | 6 |
| 4 | チャネル退出時にスケジューラが止まらない | ChannelScheduler に `stopChannel` メソッド追加 | 5 |
| 5 | 同時トリガー/高頻度トリガーのDoS | per-channel直列化 + 最小間隔1分チェック | 5 |
| 6 | Slack App でイベント購読が必要 | セットアップ手順を Task 0 に追加 | 0 |
| 7 | SessionIndexStore.findByUserId 不在 | channelId フィールドで検索する findActiveByChannelId 追加 | 7 |
| 8 | sessionIndex の userId 不一致 | チャネルセッションは channelId を userId に統一 | 9 |
| 9 | slack-memory.json からの移行パス不在 | 起動時に既存エントリから channel dir を自動作成 | 13 |
| 10 | schedule.json が即時反映されない | セッション終了時にも loadChannel する | 11 |
| 11 | 認証ポリシー | DM と同じ ALLOWED_USER_IDS を適用。非許可ユーザーにはエフェメラル通知 | 9 |
| 12 | entries Map のメモリリーク | dead セッションの定期クリーンアップ | 6 |

---

## File Structure

### New files
| File | Responsibility |
|---|---|
| `src/bridge/channel-project-manager.ts` | init / exists / path 解決 / コンテキスト構築 |
| `src/bridge/channel-scheduler.ts` | schedule.json 監視 + cron トリガー発火 + per-channel直列化 |
| `templates/channel-project/CLAUDE.md` | init 時テンプレート |
| `tests/bridge/channel-project-manager.test.ts` | テスト |
| `tests/bridge/channel-scheduler.test.ts` | テスト |
| `tests/bridge/session-coordinator-limits.test.ts` | リミット拡張のテスト |

### Modified files
| File | Change |
|---|---|
| `src/index.ts` | ルーティング変更、イベントハンドラ追加、スケジューラ統合 |
| `src/bridge/bridge-context.ts` | `discoverSkills` を export |
| `src/bridge/session-coordinator.ts` | グローバルリミット + maxAliveOverride + dead エントリクリーンアップ |
| `src/store/session-index-store.ts` | `findActiveByChannelId` 追加 |
| `src/types.ts` | SessionStartParams に `maxAliveOverride` 追加 |
| `package.json` | node-cron 依存追加 |

### Deleted files
| File | Reason |
|---|---|
| `src/bridge/channel-router.ts` | PersistentSession に統合 |
| `templates/skills/slack-channel-create.md` | bot招待 = init に置き換わり |
| `templates/skills/slack-channel-update.md` | チャネル内対話方式に置き換わり |
| `templates/skills/claude-p-automation-patterns.md` | 外部スクリプト方式廃止 |

---

### Task 0: Slack App イベント購読の追加

**Files:** なし（Slack管理画面の設定）

- [ ] **Step 1: Slack App 管理画面でイベント追加**

[api.slack.com](https://api.slack.com/apps) → 対象アプリ → Event Subscriptions → Bot Events に以下を追加:
- `member_joined_channel`
- `member_left_channel`

Save Changes → アプリを再インストール（ワークスペースへの権限更新）

- [ ] **Step 2: 確認**

Slack App の Bot Token Scopes に `channels:read` が含まれていることを確認。

---

### Task 1: node-cron 依存追加

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install**

Run: `npm install node-cron && npm install -D @types/node-cron`

- [ ] **Step 2: Verify**

Run: `npm ls node-cron`
Expected: `node-cron@x.x.x`

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add node-cron dependency for channel scheduler"
```

---

### Task 2: チャネルプロジェクトテンプレート作成

**Files:**
- Create: `templates/channel-project/CLAUDE.md`

- [ ] **Step 1: Create template**

Run: `mkdir -p templates/channel-project`

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

- [ ] **Step 2: Commit**

```bash
git add templates/channel-project/
git commit -m "feat: add channel project CLAUDE.md template"
```

---

### Task 3: bridge-context.ts から discoverSkills を切り出す

**Files:**
- Modify: `src/bridge/bridge-context.ts`

- [ ] **Step 1: Extract discoverSkills**

`src/bridge/bridge-context.ts` に関数追加し、`buildBridgeContext` 内のスキル読み込みを置き換える:

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
        if (meta) skills.push(meta);
      } catch {
        logger.warn(`Failed to read skill file: ${file}`);
      }
    }
  } catch {
    // skills directory doesn't exist — skip
  }
  return skills;
}
```

`buildBridgeContext` のスキル読み込み部 (line 42-68) を `discoverSkills` 呼び出しに置き換え:

```typescript
const skills = await discoverSkills(path.join(dataDir, 'skills'));
if (skills.length > 0) {
  const skillsList = skills.map(s => `- ${s.name}: ${s.description}`).join('\n');
  parts.push(`[Bridge Skills]\nThe following bridge skills are available for use with the Skill tool:\n\n${skillsList}`);
}
```

- [ ] **Step 2: Run tests**

Run: `npx vitest run`
Expected: All pass

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
    fs.mkdirSync(templatesDir, { recursive: true });
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
      const settings = JSON.parse(fs.readFileSync(path.join(projectPath, '.claude', 'settings.json'), 'utf-8'));
      expect(settings.model).toBe('sonnet');
    });

    it('writes correct initial schedule.json', async () => {
      const projectPath = await manager.init('C_TEST123');
      const schedule = JSON.parse(fs.readFileSync(path.join(projectPath, 'schedule.json'), 'utf-8'));
      expect(schedule.triggers).toEqual([]);
    });

    it('does not overwrite existing project', async () => {
      const projectPath = await manager.init('C_TEST123');
      fs.writeFileSync(path.join(projectPath, 'CLAUDE.md'), 'custom content');
      await manager.init('C_TEST123');
      expect(fs.readFileSync(path.join(projectPath, 'CLAUDE.md'), 'utf-8')).toBe('custom content');
    });
  });

  describe('listChannelIds', () => {
    it('returns empty for no channels', () => {
      expect(manager.listChannelIds()).toEqual([]);
    });

    it('returns channel ids after init', async () => {
      await manager.init('C_AAA');
      await manager.init('C_BBB');
      expect(manager.listChannelIds().sort()).toEqual(['C_AAA', 'C_BBB']);
    });
  });

  describe('buildContext', () => {
    it('returns empty string when no skills', async () => {
      await manager.init('C_TEST123');
      expect(await manager.buildContext('C_TEST123')).toBe('');
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

  getChannelsDir(): string {
    return this.channelsDir;
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

    await fsp.mkdir(path.join(projectPath, 'skills'), { recursive: true });
    await fsp.mkdir(path.join(projectPath, 'mcps'), { recursive: true });
    await fsp.mkdir(path.join(projectPath, '.claude'), { recursive: true });

    // CLAUDE.md from template (only if not exists)
    const claudeMdDest = path.join(projectPath, 'CLAUDE.md');
    if (!fs.existsSync(claudeMdDest)) {
      try {
        const content = await fsp.readFile(path.join(this.templatesDir, 'CLAUDE.md'), 'utf-8');
        await fsp.writeFile(claudeMdDest, content, 'utf-8');
      } catch {
        logger.warn('Channel template CLAUDE.md not found');
      }
    }

    // settings.json (only if not exists)
    const settingsPath = path.join(projectPath, '.claude', 'settings.json');
    if (!fs.existsSync(settingsPath)) {
      await fsp.writeFile(settingsPath, JSON.stringify({ model: 'sonnet' }, null, 2), 'utf-8');
    }

    // schedule.json (only if not exists)
    const schedulePath = path.join(projectPath, 'schedule.json');
    if (!fs.existsSync(schedulePath)) {
      await fsp.writeFile(schedulePath, JSON.stringify({ triggers: [] }, null, 2), 'utf-8');
    }

    logger.info(`Initialized channel project: ${channelId}`);
    return projectPath;
  }

  async buildContext(channelId: string): Promise<string> {
    const projectPath = this.getProjectPath(channelId);
    const skills = await discoverSkills(path.join(projectPath, 'skills'));

    if (skills.length === 0) return '';

    const skillsList = skills.map(s => `- ${s.name}: ${s.description}`).join('\n');
    return `${SLACK_CONTEXT}\n\n[Channel Skills]\nThe following skills are available for use with the Skill tool:\n\n${skillsList}`;
  }
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/bridge/channel-project-manager.test.ts`
Expected: All pass

- [ ] **Step 5: Commit**

```bash
git add src/bridge/channel-project-manager.ts tests/bridge/channel-project-manager.test.ts
git commit -m "feat: add ChannelProjectManager for channel project lifecycle"
```

---

### Task 5: ChannelScheduler 作成（stopChannel + 直列化 + 最小間隔）

**Files:**
- Create: `src/bridge/channel-scheduler.ts`
- Create: `tests/bridge/channel-scheduler.test.ts`

- [ ] **Step 1: Write tests**

Create `tests/bridge/channel-scheduler.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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
    const dir = path.join(tmpDir, 'channels', channelId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'schedule.json'), JSON.stringify({ triggers }));
  }

  describe('loadAll', () => {
    it('loads triggers from all channels', () => {
      writeSchedule('C_AAA', [{ name: 'daily', cron: '0 9 * * *', prompt: 'Report' }]);
      writeSchedule('C_BBB', [{ name: 'weekly', cron: '0 17 * * 5', prompt: 'Review' }]);

      const scheduler = new ChannelScheduler(path.join(tmpDir, 'channels'), async () => {});
      scheduler.loadAll();
      expect(scheduler.jobCount).toBe(2);
      scheduler.stop();
    });

    it('handles empty triggers', () => {
      writeSchedule('C_AAA', []);
      const scheduler = new ChannelScheduler(path.join(tmpDir, 'channels'), async () => {});
      scheduler.loadAll();
      expect(scheduler.jobCount).toBe(0);
      scheduler.stop();
    });

    it('handles missing directory', () => {
      const scheduler = new ChannelScheduler(path.join(tmpDir, 'nonexistent'), async () => {});
      scheduler.loadAll();
      expect(scheduler.jobCount).toBe(0);
      scheduler.stop();
    });

    it('rejects triggers with interval less than 1 minute', () => {
      writeSchedule('C_AAA', [{ name: 'spam', cron: '* * * * *', prompt: 'Too fast' }]);
      const scheduler = new ChannelScheduler(path.join(tmpDir, 'channels'), async () => {});
      scheduler.loadAll();
      expect(scheduler.jobCount).toBe(0); // rejected
      scheduler.stop();
    });
  });

  describe('loadChannel / stopChannel', () => {
    it('replaces existing jobs', () => {
      writeSchedule('C_AAA', [{ name: 'daily', cron: '0 9 * * *', prompt: 'Report' }]);
      const scheduler = new ChannelScheduler(path.join(tmpDir, 'channels'), async () => {});

      scheduler.loadChannel('C_AAA');
      expect(scheduler.jobCount).toBe(1);

      writeSchedule('C_AAA', [
        { name: 'daily', cron: '0 9 * * *', prompt: 'Report' },
        { name: 'weekly', cron: '0 17 * * 5', prompt: 'Review' },
      ]);
      scheduler.loadChannel('C_AAA');
      expect(scheduler.jobCount).toBe(2);
      scheduler.stop();
    });

    it('stopChannel removes all jobs for a channel', () => {
      writeSchedule('C_AAA', [{ name: 'daily', cron: '0 9 * * *', prompt: 'Report' }]);
      writeSchedule('C_BBB', [{ name: 'weekly', cron: '0 17 * * 5', prompt: 'Review' }]);

      const scheduler = new ChannelScheduler(path.join(tmpDir, 'channels'), async () => {});
      scheduler.loadAll();
      expect(scheduler.jobCount).toBe(2);

      scheduler.stopChannel('C_AAA');
      expect(scheduler.jobCount).toBe(1);
      scheduler.stop();
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/bridge/channel-scheduler.test.ts`
Expected: FAIL

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

// Cron expressions that fire more than once per minute
const MIN_INTERVAL_CRON_FIELDS = /^(\*|\d+[,/]\d*)\s/;

function isTooFrequent(cronExpr: string): boolean {
  // Standard 5-field cron: reject if minute field is * (every minute)
  const parts = cronExpr.trim().split(/\s+/);
  if (parts.length < 5) return true;
  const minuteField = parts[0];
  // Reject: *, */1, or any pattern that fires every minute
  if (minuteField === '*' || minuteField === '*/1') return true;
  return false;
}

export class ChannelScheduler {
  private jobs = new Map<string, cron.ScheduledTask[]>();
  private channelLocks = new Map<string, boolean>(); // per-channel execution lock

  constructor(
    private readonly channelsDir: string,
    private readonly onTrigger: (channelId: string, trigger: ScheduleTrigger) => Promise<void>,
  ) {}

  get jobCount(): number {
    let count = 0;
    for (const tasks of this.jobs.values()) count += tasks.length;
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
    for (const id of channelIds) this.loadChannel(id);
    logger.info(`Channel scheduler loaded ${this.jobCount} jobs`);
  }

  loadChannel(channelId: string): void {
    // Stop existing jobs
    const existing = this.jobs.get(channelId);
    if (existing) {
      for (const task of existing) task.stop();
    }

    const schedulePath = path.join(this.channelsDir, channelId, 'schedule.json');
    let config: ScheduleConfig;
    try {
      config = JSON.parse(fs.readFileSync(schedulePath, 'utf-8'));
    } catch {
      this.jobs.set(channelId, []);
      return;
    }

    const tasks: cron.ScheduledTask[] = [];
    for (const trigger of config.triggers) {
      if (!cron.validate(trigger.cron)) {
        logger.warn(`Invalid cron: ${channelId}/${trigger.name}: ${trigger.cron}`);
        continue;
      }
      if (isTooFrequent(trigger.cron)) {
        logger.warn(`Trigger too frequent (min 2 min interval): ${channelId}/${trigger.name}: ${trigger.cron}`);
        continue;
      }

      const task = cron.schedule(trigger.cron, () => {
        // Per-channel serialization: skip if previous trigger still running
        if (this.channelLocks.get(channelId)) {
          logger.warn(`Skipping trigger ${channelId}/${trigger.name}: previous execution still running`);
          return;
        }
        this.channelLocks.set(channelId, true);
        logger.info(`Firing trigger: ${channelId}/${trigger.name}`);
        this.onTrigger(channelId, trigger)
          .catch(err => logger.error(`Trigger failed: ${channelId}/${trigger.name}`, err))
          .finally(() => this.channelLocks.set(channelId, false));
      });

      tasks.push(task);
    }
    this.jobs.set(channelId, tasks);
  }

  stopChannel(channelId: string): void {
    const existing = this.jobs.get(channelId);
    if (existing) {
      for (const task of existing) task.stop();
    }
    this.jobs.delete(channelId);
    this.channelLocks.delete(channelId);
  }

  stop(): void {
    for (const tasks of this.jobs.values()) {
      for (const task of tasks) task.stop();
    }
    this.jobs.clear();
    this.channelLocks.clear();
  }
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/bridge/channel-scheduler.test.ts`
Expected: All pass

- [ ] **Step 5: Commit**

```bash
git add src/bridge/channel-scheduler.ts tests/bridge/channel-scheduler.test.ts
git commit -m "feat: add ChannelScheduler with per-channel serialization and min interval"
```

---

### Task 6: SessionCoordinator 拡張（グローバルリミット + maxAliveOverride + dead クリーンアップ）

**Files:**
- Modify: `src/types.ts`
- Modify: `src/bridge/session-coordinator.ts`
- Create: `tests/bridge/session-coordinator-limits.test.ts`

- [ ] **Step 1: Add maxAliveOverride to SessionStartParams**

`src/types.ts` の `SessionStartParams` に追加:

```typescript
export interface SessionStartParams {
  sessionId: string;
  model: string;
  projectPath: string;
  isResume: boolean;
  bridgeContext?: string;
  maxAliveOverride?: number; // Override per-user limit (e.g., channels use higher limit)
}
```

- [ ] **Step 2: Write tests**

Create `tests/bridge/session-coordinator-limits.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SessionCoordinator } from '../../src/bridge/session-coordinator.js';

// Mock PersistentSession to avoid spawning real processes
vi.mock('../../src/bridge/persistent-session.js', () => ({
  PersistentSession: vi.fn().mockImplementation((params) => {
    let state = 'not_started';
    const listeners: Record<string, Function[]> = {};
    return {
      sessionId: params.sessionId,
      state,
      get model() { return params.model; },
      spawn: vi.fn(() => { state = 'idle'; }),
      end: vi.fn(() => { state = 'dead'; }),
      on: vi.fn((event: string, cb: Function) => {
        if (!listeners[event]) listeners[event] = [];
        listeners[event].push(cb);
      }),
      emit: vi.fn(),
    };
  }),
}));

describe('SessionCoordinator limits', () => {
  let coordinator: SessionCoordinator;

  beforeEach(() => {
    coordinator = new SessionCoordinator({ maxAlivePerUser: 1, maxAliveGlobal: 3 });
  });

  it('enforces global limit', async () => {
    // Create 3 sessions for different users
    await coordinator.getOrCreateSession({ sessionId: 's1', userId: 'u1', model: 'sonnet', projectPath: '/a', isResume: false });
    await coordinator.getOrCreateSession({ sessionId: 's2', userId: 'u2', model: 'sonnet', projectPath: '/b', isResume: false });
    await coordinator.getOrCreateSession({ sessionId: 's3', userId: 'u3', model: 'sonnet', projectPath: '/c', isResume: false });

    // 4th should trigger global enforcement
    await coordinator.getOrCreateSession({ sessionId: 's4', userId: 'u4', model: 'sonnet', projectPath: '/d', isResume: false });
    // s1 (oldest) should have been ended
    expect(coordinator.getAliveCount()).toBeLessThanOrEqual(3);
  });

  it('respects maxAliveOverride per session', async () => {
    // Channel session with override=3
    await coordinator.getOrCreateSession({ sessionId: 's1', userId: 'channel1', model: 'sonnet', projectPath: '/a', isResume: false, maxAliveOverride: 3 });
    await coordinator.getOrCreateSession({ sessionId: 's2', userId: 'channel1', model: 'sonnet', projectPath: '/a', isResume: false, maxAliveOverride: 3 });
    await coordinator.getOrCreateSession({ sessionId: 's3', userId: 'channel1', model: 'sonnet', projectPath: '/a', isResume: false, maxAliveOverride: 3 });

    // All 3 should be alive (overridden from default 1 to 3)
    expect(coordinator.getAliveCountForUser('channel1')).toBe(3);
  });
});
```

- [ ] **Step 3: Implement changes**

`src/bridge/session-coordinator.ts` を修正:

1. `getOrCreateSession` にグローバルリミットチェック追加:

```typescript
async getOrCreateSession(params: SessionStartParams & { userId: string }): Promise<PersistentSession> {
  const existing = this.entries.get(params.sessionId);
  if (existing && existing.session.state !== 'dead') {
    return existing.session;
  }

  // Clean up dead entries periodically
  this.cleanupDead();

  await this.enforceUserLimit(params.userId, params.maxAliveOverride);
  await this.enforceGlobalLimit();

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
```

2. `enforceUserLimit` に `maxAliveOverride` 対応:

```typescript
private async enforceUserLimit(userId: string, maxAliveOverride?: number): Promise<void> {
  const limit = maxAliveOverride ?? this.config.maxAlivePerUser;
  const userSessions: ManagedEntry[] = [];
  for (const entry of this.entries.values()) {
    if (entry.userId === userId && entry.session.state !== 'dead' && entry.session.state !== 'not_started') {
      userSessions.push(entry);
    }
  }
  while (userSessions.length >= limit) {
    const oldest = userSessions.shift()!;
    oldest.session.end();
  }
}
```

3. `enforceGlobalLimit` 追加:

```typescript
private async enforceGlobalLimit(): Promise<void> {
  const alive = this.getAliveCount();
  if (alive < this.config.maxAliveGlobal) return;

  // End oldest sessions until under limit
  const sorted = [...this.entries.values()]
    .filter(e => e.session.state !== 'dead' && e.session.state !== 'not_started')
    .sort((a, b) => {
      // Prefer ending idle sessions over processing ones
      if (a.session.state === 'idle' && b.session.state !== 'idle') return -1;
      if (b.session.state === 'idle' && a.session.state !== 'idle') return 1;
      return 0;
    });

  while (sorted.length >= this.config.maxAliveGlobal) {
    const oldest = sorted.shift()!;
    oldest.session.end();
  }
}
```

4. `cleanupDead` 追加:

```typescript
private cleanupDead(): void {
  for (const [id, entry] of this.entries) {
    if (entry.session.state === 'dead') {
      this.entries.delete(id);
    }
  }
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/bridge/session-coordinator-limits.test.ts`
Expected: All pass

Run: `npx vitest run`
Expected: All pass (no regressions)

- [ ] **Step 5: Commit**

```bash
git add src/types.ts src/bridge/session-coordinator.ts tests/bridge/session-coordinator-limits.test.ts
git commit -m "feat: add global session limit, maxAliveOverride, and dead entry cleanup"
```

---

### Task 7: SessionIndexStore に findActiveByChannelId 追加

**Files:**
- Modify: `src/store/session-index-store.ts`

- [ ] **Step 1: Add method**

`src/store/session-index-store.ts` に追加:

```typescript
findActiveByChannelId(channelId: string): SessionIndexEntry[] {
  return Object.values(this.data.sessions)
    .filter((e) => e.channelId === channelId && e.status === 'active');
}
```

- [ ] **Step 2: Run tests**

Run: `npx vitest run`
Expected: All pass

- [ ] **Step 3: Commit**

```bash
git add src/store/session-index-store.ts
git commit -m "feat: add findActiveByChannelId to SessionIndexStore"
```

---

### Task 8: botUserId の取得

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Resolve bot user ID after app start**

`src/index.ts` の `main()` 内、`app.start()` の後に追加:

```typescript
const authTestResult = await app.client.auth.test();
const botUserId = authTestResult.user_id!;
logger.info(`Bot user ID resolved: ${botUserId}`);
```

- [ ] **Step 2: Commit**

```bash
git add src/index.ts
git commit -m "feat: resolve bot user ID via auth.test for event filtering"
```

---

### Task 9: handleMessage ルーティング変更

**Files:**
- Modify: `src/index.ts`

これが最大の変更。以下の問題を全て解決する:
- チャネルメッセージを PersistentSession に統合
- ロックキーを `threadTs` に変更（レースコンディション対策）
- チャネルセッションの userId を `channelId` に統一
- 認証は ALLOWED_USER_IDS をそのまま適用（非許可→エフェメラル通知）
- DM 固有ロジックのスキップ

- [ ] **Step 1: Import ChannelProjectManager**

`src/index.ts` に import 追加:

```typescript
import { ChannelProjectManager } from './bridge/channel-project-manager.js';
```

`main()` 内に初期化追加:

```typescript
const channelTemplatesDir = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'templates', 'channel-project');
const channelProjectManager = new ChannelProjectManager(config.dataDir, channelTemplatesDir);
```

- [ ] **Step 2: Replace channel routing block (line 208-231)**

現在のチャネルルーティング:
```typescript
if (event.channel_type !== 'im') {
  if (event.channel && channelRouter.hasRoute(event.channel)) { ... }
  return;
}
```

置き換え:
```typescript
const isChannel = event.channel_type !== 'im';

if (isChannel) {
  if (!channelProjectManager.exists(event.channel)) return;
  if (event.bot_id || event.subtype === 'bot_message') return;
}
```

- [ ] **Step 3: Change lock key from userId to threadTs**

現在 (line 423):
```typescript
const prevLock = sessionCreationLocks.get(userId) || Promise.resolve();
...
sessionCreationLocks.set(userId, prevLock.then(() => lockPromise));
```

置き換え:
```typescript
const lockKey = threadTs; // Thread-based lock: safe for both DM and channel
const prevLock = sessionCreationLocks.get(lockKey) || Promise.resolve();
let releaseLock: () => void;
const lockPromise = new Promise<void>((resolve) => { releaseLock = resolve; });
sessionCreationLocks.set(lockKey, prevLock.then(() => lockPromise));
await prevLock;
```

- [ ] **Step 4: Channel-specific auth handling**

既存の auth チェック (line 319) の後に、チャネル用のフィードバック追加:
```typescript
if (!auth.isAllowed(userId)) {
  if (isChannel) {
    // Channel: notify user they're not authorized (ephemeral)
    await app.client.chat.postEphemeral({
      channel: channelId,
      user: userId,
      text: '⛔ このbotを使う権限がありません。',
    });
  }
  logger.warn('Unauthorized user', { userId });
  return;
}
```

- [ ] **Step 5: Channel-specific session creation**

新規セッション作成部分 (line 437-466) を変更:

```typescript
if (!indexEntry) {
  let projectPath: string;
  let sessionModel: string;
  let sessionContext: string | undefined;

  if (isChannel) {
    projectPath = channelProjectManager.getProjectPath(event.channel);
    try {
      const settings = JSON.parse(fs.readFileSync(path.join(projectPath, '.claude', 'settings.json'), 'utf-8'));
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

  const sessionId = crypto.randomUUID();
  session = await coordinator.getOrCreateSession({
    sessionId,
    userId: isChannel ? channelId : userId,
    model: sessionModel,
    projectPath,
    isResume: false,
    bridgeContext: sessionContext,
    maxAliveOverride: isChannel ? 3 : undefined,
  });

  sessionIndexStore.register({
    cliSessionId: sessionId,
    threadTs,
    channelId,
    userId: isChannel ? channelId : userId, // Consistent with coordinator
    projectPath,
    name: text.substring(0, 50),
    model: sessionModel,
    status: 'active',
    createdAt: new Date().toISOString(),
    lastActiveAt: new Date().toISOString(),
  });

  // Thread header (DM only — channel members don't need it)
  if (!isChannel) {
    const headerText = buildThreadHeaderText({ projectPath, model: sessionModel, sessionId });
    await app.client.chat.postEphemeral({ channel: channelId, thread_ts: threadTs, user: userId, text: headerText });
  }

  indexEntry = sessionIndexStore.findByThreadTs(threadTs)!;
}
```

- [ ] **Step 6: Skip DM-specific logic for channels**

1. コマンドパース:
```typescript
const parsed = isChannel
  ? { type: 'plain_text' as const, content: text }
  : parseCommand(text);
```

2. 既存セッションのモデル切替 (line 483-531):
```typescript
if (existingSession && existingSession.state !== 'dead') {
  if (isChannel) {
    session = existingSession;
  } else {
    // Existing DM model-switch logic (unchanged)
    ...
  }
} else {
  session = await coordinator.getOrCreateSession({
    ...
    userId: isChannel ? channelId : userId,
    bridgeContext: isChannel ? await channelProjectManager.buildContext(event.channel) : bridgeContext,
    maxAliveOverride: isChannel ? 3 : undefined,
  });
}
```

- [ ] **Step 7: Register member_joined_channel handler**

`app.event('message', ...)` の近くに追加:

```typescript
app.event('member_joined_channel', async ({ event }) => {
  if (event.user !== botUserId) return;
  const channelId = event.channel;

  if (channelProjectManager.exists(channelId)) {
    await app.client.chat.postMessage({
      channel: channelId,
      text: '👋 既存のプロジェクトを復帰しました。続きから始めましょう。',
    });
    logger.info(`Channel project reactivated: ${channelId}`);
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
    logger.error(`Failed to init channel project: ${channelId}`, err);
    await app.client.chat.postMessage({
      channel: channelId,
      text: '❌ プロジェクトの初期化に失敗しました。',
    });
  }
});
```

- [ ] **Step 8: Run full test suite**

Run: `npx vitest run`
Expected: All pass

- [ ] **Step 9: Commit**

```bash
git add src/index.ts
git commit -m "feat: route channel messages through PersistentSession with session safety fixes"
```

---

### Task 10: ChannelScheduler を index.ts に統合

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Import and initialize**

```typescript
import { ChannelScheduler } from './bridge/channel-scheduler.js';
```

`main()` 内に追加:

```typescript
const channelScheduler = new ChannelScheduler(
  path.join(config.dataDir, 'channels'),
  async (channelId, trigger) => {
    try {
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
        const settings = JSON.parse(fs.readFileSync(path.join(projectPath, '.claude', 'settings.json'), 'utf-8'));
        sessionModel = settings.model || 'sonnet';
      } catch { /* default */ }

      const sessionContext = await channelProjectManager.buildContext(channelId);
      const sessionId = crypto.randomUUID();

      const session = await coordinator.getOrCreateSession({
        sessionId,
        userId: channelId,
        model: sessionModel,
        projectPath,
        isResume: false,
        bridgeContext: sessionContext,
        maxAliveOverride: 3,
      });

      sessionIndexStore.register({
        cliSessionId: sessionId,
        threadTs,
        channelId,
        userId: channelId,
        projectPath,
        name: trigger.name,
        model: sessionModel,
        status: 'active',
        createdAt: new Date().toISOString(),
        lastActiveAt: new Date().toISOString(),
      });

      wireSessionOutput(session, channelId, threadTs, reactionManager, app.client, sessionIndexStore, projectPath);
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
      logger.error(`Trigger failed: ${channelId}/${trigger.name}`, err);
    }
  },
);

channelScheduler.loadAll();
```

- [ ] **Step 2: Reload schedule on session end**

`wireSessionOutput` 内または `coordinator.onIdleCallback` で、チャネルセッション終了時にスケジュールをリロード:

```typescript
// In coordinator.onIdleCallback setup:
coordinator.onIdleCallback = () => {
  // Existing logic...

  // Reload schedules for channel sessions that just became idle
  for (const channelId of channelProjectManager.listChannelIds()) {
    channelScheduler.loadChannel(channelId);
  }
};
```

注意: これは全チャネルをリロードするが、`loadChannel` は高速（JSONファイル1つ読むだけ）なので問題ない。

- [ ] **Step 3: Add scheduler stop to shutdown**

`shutdown()` 関数内に追加:

```typescript
channelScheduler.stop();
```

- [ ] **Step 4: Run full test suite**

Run: `npx vitest run`
Expected: All pass

- [ ] **Step 5: Commit**

```bash
git add src/index.ts
git commit -m "feat: integrate ChannelScheduler with session-end reload"
```

---

### Task 11: member_left_channel ハンドラ追加

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Register handler**

```typescript
app.event('member_left_channel', async ({ event }) => {
  if (event.user !== botUserId) return;
  const channelId = event.channel;
  logger.info(`Bot left channel ${channelId}, deactivating`);

  // End active sessions for this channel
  const activeEntries = sessionIndexStore.findActiveByChannelId(channelId);
  for (const entry of activeEntries) {
    coordinator.endSession(entry.cliSessionId);
    sessionIndexStore.update(entry.cliSessionId, { status: 'ended' });
  }

  // Stop scheduled jobs
  channelScheduler.stopChannel(channelId);

  // Directory preserved for data safety. Re-invite to reactivate.
});
```

- [ ] **Step 2: Run full test suite**

Run: `npx vitest run`
Expected: All pass

- [ ] **Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat: deactivate channel on bot leave with proper scheduler cleanup"
```

---

### Task 12: slack-memory.json 移行 + ChannelRouter 削除

**Files:**
- Modify: `src/index.ts`
- Delete: `src/bridge/channel-router.ts`
- Delete: `templates/skills/slack-channel-create.md`
- Delete: `templates/skills/slack-channel-update.md`
- Delete: `templates/skills/claude-p-automation-patterns.md`

- [ ] **Step 1: Add migration logic**

`main()` 内、channelProjectManager 初期化の後に移行ロジック追加:

```typescript
// Migrate existing channel routes from slack-memory.json
const slackMemoryPath = path.join(config.dataDir, 'slack-memory.json');
try {
  if (fs.existsSync(slackMemoryPath)) {
    const routes = JSON.parse(fs.readFileSync(slackMemoryPath, 'utf-8'));
    for (const route of routes) {
      if (route.channelId && !channelProjectManager.exists(route.channelId)) {
        await channelProjectManager.init(route.channelId);
        logger.info(`Migrated channel route: ${route.channelId} (${route.description})`);
      }
    }
    // Rename to mark as migrated (don't delete — user might want the data)
    fs.renameSync(slackMemoryPath, slackMemoryPath + '.migrated');
    logger.info('slack-memory.json migrated and renamed to .migrated');
  }
} catch (err) {
  logger.warn('Failed to migrate slack-memory.json:', err);
}
```

- [ ] **Step 2: Remove ChannelRouter from index.ts**

1. ChannelRouter の import 文を削除
2. `new ChannelRouter(...)` インスタンス化を削除
3. `channelRouter.startWatching()` を削除
4. その他の `channelRouter` 参照を削除

Run: `grep -n 'channelRouter\|ChannelRouter\|channel-router' src/index.ts`
Expected: No matches

- [ ] **Step 3: Delete files**

```bash
rm src/bridge/channel-router.ts
rm templates/skills/slack-channel-create.md
rm templates/skills/slack-channel-update.md
rm templates/skills/claude-p-automation-patterns.md
rm -f ~/.claude-slack-pipe/skills/slack-channel-create.md
rm -f ~/.claude-slack-pipe/skills/slack-channel-update.md
rm -f ~/.claude-slack-pipe/skills/claude-p-automation-patterns.md
```

- [ ] **Step 4: Remove slack-memory.json references**

Run: `grep -rn 'slack-memory' src/`
Expected: No matches

- [ ] **Step 5: Run full test suite + type check**

Run: `npx vitest run && npx tsc --noEmit`
Expected: All pass, no type errors

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor: remove ChannelRouter, migrate slack-memory.json, delete obsolete skills"
```

---

### Task 13: 手動統合テスト

**Files:** None (verification only)

- [ ] **Step 1: Bridge 再起動をユーザーに依頼**

> コードを変更しました。Slackで `cc /restart-bridge` と送信して再起動してください。

- [ ] **Step 2: チャネル初期化テスト**

1. 新しい Slack チャネルを作成
2. bot を招待
3. ウェルカムメッセージ「✅ AIアプリとして初期化しました」が表示されることを確認
4. `~/.claude-slack-pipe/channels/<channel-id>/` 配下に CLAUDE.md, skills/, mcps/, .claude/settings.json, schedule.json が存在することを確認

- [ ] **Step 3: チャネルでの対話テスト**

1. 初期化されたチャネルでメッセージを送信
2. ストリーミング表示（thinking, tool use, reactions）が動作することを確認
3. スレッド内で会話を継続し、セッションが維持されることを確認

- [ ] **Step 4: 非許可ユーザーテスト**

1. ALLOWED_USER_IDS に入っていないユーザーでチャネルにメッセージを送信
2. エフェメラルで「権限がありません」が表示されることを確認

- [ ] **Step 5: bot再招待テスト**

1. bot をチャネルから退出させる
2. アクティブセッションが終了されることを確認
3. bot を再招待
4. 「既存のプロジェクトを復帰しました」が表示されることを確認
5. 既存の CLAUDE.md が保持されていることを確認

- [ ] **Step 6: DM 回帰テスト**

1. DM でメッセージを送信
2. 従来通り動作することを確認（bridge skills, model switching, /end, /status）

- [ ] **Step 7: 定時トリガーテスト**

1. チャネルの schedule.json を編集して直近2分後のトリガーを設定
2. チャネルでメッセージを送信（schedule reload をトリガー）
3. トリガー発火を確認（スレッド作成、プロンプト実行、ストリーミング表示）

- [ ] **Step 8: 既存チャネル移行テスト（slack-memory.json があった場合）**

1. 起動ログに `Migrated channel route:` が表示されることを確認
2. `slack-memory.json.migrated` が作成されていることを確認
3. 移行されたチャネルで対話できることを確認
