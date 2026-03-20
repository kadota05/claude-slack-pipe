// src/store/user-preference-store.ts
import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../utils/logger.js';
import type { UserPreferences, UserPreferenceFile } from '../types.js';

const FILE_NAME = 'user-preferences.json';
const DEFAULT_PREFS: UserPreferences = { defaultModel: 'opus', activeDirectoryId: null, starredDirectoryIds: [] };

export class UserPreferenceStore {
  private readonly filePath: string;
  private data: UserPreferenceFile;

  constructor(dataDir: string) {
    this.filePath = path.join(dataDir, FILE_NAME);
    this.data = this.load();
  }

  get(userId: string): UserPreferences {
    const stored = this.data.users[userId];
    return stored ? { ...DEFAULT_PREFS, ...stored } : { ...DEFAULT_PREFS };
  }

  setModel(userId: string, model: string): void {
    this.ensureUser(userId);
    this.data.users[userId].defaultModel = model;
    this.save();
  }

  setDirectory(userId: string, directoryId: string | null): void {
    this.ensureUser(userId);
    this.data.users[userId].activeDirectoryId = directoryId;
    this.save();
  }

  private ensureUser(userId: string): void {
    if (!this.data.users[userId]) {
      this.data.users[userId] = { ...DEFAULT_PREFS, starredDirectoryIds: [] };
    } else if (!this.data.users[userId].starredDirectoryIds) {
      this.data.users[userId].starredDirectoryIds = [];
    }
  }

  toggleStar(userId: string, directoryId: string): void {
    this.ensureUser(userId);
    const prefs = this.data.users[userId];
    const idx = prefs.starredDirectoryIds.indexOf(directoryId);
    if (idx >= 0) {
      prefs.starredDirectoryIds.splice(idx, 1);
    } else {
      prefs.starredDirectoryIds.push(directoryId);
    }
    this.save();
  }

  private load(): UserPreferenceFile {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf-8');
      return JSON.parse(raw) as UserPreferenceFile;
    } catch {
      return { version: 1, users: {} };
    }
  }

  private save(): void {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = this.filePath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.filePath);
  }
}
