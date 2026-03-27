import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ChannelRouter } from '../../src/bridge/channel-router.js';

// Mock fetch for Slack API calls (reactions, messages)
vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
  json: () => Promise.resolve({ ok: true, ts: '1711000099.000000' }),
}));

// Mock child_process.spawn
vi.mock('node:child_process', () => {
  const EventEmitter = require('node:events');
  return {
    spawn: vi.fn(() => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdin = { write: vi.fn(), end: vi.fn() };
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
    // Re-stub fetch after clearAllMocks
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      json: () => Promise.resolve({ ok: true, ts: '1711000099.000000' }),
    });
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
      '/home/user/dev/body-concierge/node_modules/.bin/tsx',
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
      '/home/user/dev/body-concierge/node_modules/.bin/tsx',
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

  it('adds ⏳ reaction on dispatch and ✅ on success', async () => {
    const entries = [
      {
        folder: '/home/user/dev/test-project',
        description: 'Test',
        channel: '#test',
        channelId: 'C456',
        handler: 'src/handler.ts',
        createdAt: '2026-03-28',
      },
    ];
    await fs.writeFile(memoryPath, JSON.stringify(entries));

    const router = new ChannelRouter(memoryPath);
    await router.load();

    await router.dispatch({
      text: 'test',
      files: [],
      botToken: 'xoxb-test',
      userId: 'U123',
      channelId: 'C456',
      threadTs: '1711000000.000000',
      timestamp: '1711000001.000000',
    });

    // Wait for exit event to fire
    await new Promise((r) => setTimeout(r, 50));

    const fetchCalls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
    const reactionUrls = fetchCalls.map((c: any[]) => c[0]).filter((u: string) => u.includes('reactions'));

    expect(reactionUrls).toContain('https://slack.com/api/reactions.add');
    expect(reactionUrls).toContain('https://slack.com/api/reactions.remove');

    // Check ⏳ was added first
    const addCall = fetchCalls.find((c: any[]) => c[0].includes('reactions.add'));
    const addBody = JSON.parse(addCall[1].body);
    expect(addBody.name).toBe('hourglass_flowing_sand');
  });
});
