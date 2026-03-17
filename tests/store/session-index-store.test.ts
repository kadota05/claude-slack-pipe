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
