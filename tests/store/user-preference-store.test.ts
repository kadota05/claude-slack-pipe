// tests/store/user-preference-store.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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
    expect(prefs.defaultModel).toBe('opus');
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

  it('returns empty starredDirectoryIds for unknown user', () => {
    const prefs = store.get('U_UNKNOWN');
    expect(prefs.starredDirectoryIds).toEqual([]);
  });

  it('toggleStar adds and removes directory', () => {
    store.toggleStar('U001', 'dir-a');
    expect(store.get('U001').starredDirectoryIds).toEqual(['dir-a']);

    store.toggleStar('U001', 'dir-b');
    expect(store.get('U001').starredDirectoryIds).toEqual(['dir-a', 'dir-b']);

    store.toggleStar('U001', 'dir-a');
    expect(store.get('U001').starredDirectoryIds).toEqual(['dir-b']);
  });

  it('toggleStar persists across instances', () => {
    store.toggleStar('U001', 'dir-x');
    const store2 = new UserPreferenceStore(tmpDir);
    expect(store2.get('U001').starredDirectoryIds).toEqual(['dir-x']);
  });

  it('backfills starredDirectoryIds for existing user without it', () => {
    store.setModel('U001', 'haiku');
    const filePath = path.join(tmpDir, 'user-preferences.json');
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    delete data.users['U001'].starredDirectoryIds;
    fs.writeFileSync(filePath, JSON.stringify(data));

    const store2 = new UserPreferenceStore(tmpDir);
    const prefs = store2.get('U001');
    expect(prefs.starredDirectoryIds).toEqual([]);
    expect(prefs.defaultModel).toBe('haiku');
  });
});
