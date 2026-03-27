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

    it('skips entries without handler field', async () => {
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
