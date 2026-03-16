import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../utils/logger.js';
import type { SessionIndexEntry, SessionIndexFile } from '../types.js';

const FILE_NAME = 'session-index.json';

export class SessionIndexStore {
  private readonly filePath: string;
  private data: SessionIndexFile;
  private threadIndex: Map<string, string>; // threadTs → cliSessionId

  constructor(dataDir: string) {
    this.filePath = path.join(dataDir, FILE_NAME);
    this.data = this.load();
    this.threadIndex = this.buildThreadIndex();
  }

  register(entry: SessionIndexEntry): void {
    this.data.sessions[entry.cliSessionId] = { ...entry };
    this.threadIndex.set(entry.threadTs, entry.cliSessionId);
    this.save();
  }

  get(cliSessionId: string): SessionIndexEntry | undefined {
    return this.data.sessions[cliSessionId];
  }

  findByThreadTs(threadTs: string): SessionIndexEntry | undefined {
    const id = this.threadIndex.get(threadTs);
    return id ? this.data.sessions[id] : undefined;
  }

  findBySessionId(sessionId: string): SessionIndexEntry | undefined {
    return this.data.sessions[sessionId];
  }

  update(cliSessionId: string, fields: Partial<Pick<SessionIndexEntry, 'status' | 'name' | 'model' | 'lastActiveAt'>>): void {
    const entry = this.data.sessions[cliSessionId];
    if (!entry) return;
    Object.assign(entry, fields);
    this.save();
  }

  listByDirectory(projectPath: string): SessionIndexEntry[] {
    return Object.values(this.data.sessions)
      .filter((e) => e.projectPath === projectPath)
      .sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt));
  }

  getActive(): SessionIndexEntry[] {
    return Object.values(this.data.sessions)
      .filter((e) => e.status === 'active')
      .sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt));
  }

  getEnded(limit = 20): SessionIndexEntry[] {
    return Object.values(this.data.sessions)
      .filter((e) => e.status === 'ended')
      .sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt))
      .slice(0, limit);
  }

  private buildThreadIndex(): Map<string, string> {
    const map = new Map<string, string>();
    for (const [id, entry] of Object.entries(this.data.sessions)) {
      map.set(entry.threadTs, id);
    }
    return map;
  }

  private load(): SessionIndexFile {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf-8');
      return JSON.parse(raw) as SessionIndexFile;
    } catch {
      return { version: 1, sessions: {} };
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
