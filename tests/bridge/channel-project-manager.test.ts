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
