import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { logger } from '../utils/logger.js';
import { decodeProjectId } from './project-store.js';
import type { RecentSession } from '../types.js';

const MAX_CANDIDATES = 15;
const MAX_LINES_TO_READ = 20;
const MAX_DISPLAY = 5;
const PREVIEW_LENGTH = 50;

export class RecentSessionScanner {
  constructor(private readonly claudeProjectsDir: string) {}

  async scan(): Promise<RecentSession[]> {
    const candidates = this.collectCandidates();
    if (candidates.length === 0) return [];

    const sessions: RecentSession[] = [];
    for (const c of candidates) {
      const firstPrompt = await this.readFirstUserMessage(c.filePath);
      if (firstPrompt === null) continue;
      const parts = decodeProjectId(c.projectId).split('/').filter(Boolean);
      sessions.push({
        sessionId: c.sessionId,
        projectPath: parts.slice(-2).join('/') || c.projectId,
        mtime: c.mtime,
        firstPrompt,
        firstPromptPreview: firstPrompt.length > PREVIEW_LENGTH
          ? firstPrompt.slice(0, PREVIEW_LENGTH) + '...'
          : firstPrompt,
      });
    }

    return this.filterRecurring(sessions).slice(0, MAX_DISPLAY);
  }

  private collectCandidates(): Array<{
    filePath: string;
    sessionId: string;
    projectId: string;
    mtime: Date;
  }> {
    if (!fs.existsSync(this.claudeProjectsDir)) return [];

    const all: Array<{
      filePath: string;
      sessionId: string;
      projectId: string;
      mtime: Date;
    }> = [];

    try {
      const projectDirs = fs.readdirSync(this.claudeProjectsDir, { withFileTypes: true });
      for (const dir of projectDirs) {
        if (!dir.isDirectory()) continue;
        const projectDir = path.join(this.claudeProjectsDir, dir.name);
        try {
          const files = fs.readdirSync(projectDir);
          for (const f of files) {
            if (!f.endsWith('.jsonl')) continue;
            const filePath = path.join(projectDir, f);
            try {
              const stat = fs.statSync(filePath);
              all.push({
                filePath,
                sessionId: path.basename(f, '.jsonl'),
                projectId: dir.name,
                mtime: new Date(stat.mtimeMs),
              });
            } catch { /* skip unreadable files */ }
          }
        } catch { /* skip unreadable dirs */ }
      }
    } catch {
      return [];
    }

    all.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
    return all.slice(0, MAX_CANDIDATES);
  }

  private async readFirstUserMessage(filePath: string): Promise<string | null> {
    return new Promise((resolve) => {
      try {
        const stream = fs.createReadStream(filePath, { encoding: 'utf-8' });
        const rl = readline.createInterface({ input: stream });
        let lineCount = 0;

        rl.on('line', (line) => {
          lineCount++;
          if (lineCount > MAX_LINES_TO_READ) {
            rl.close();
            stream.destroy();
            return;
          }
          try {
            const entry = JSON.parse(line);
            if (entry.type === 'user' && entry.message?.role === 'user') {
              const content = entry.message.content;
              let text: string | null = null;
              if (typeof content === 'string') {
                text = content;
              } else if (Array.isArray(content)) {
                const textBlock = content.find((b: any) => b.type === 'text');
                text = textBlock?.text || null;
              }
              if (text) {
                rl.close();
                stream.destroy();
                resolve(text.replace(/\n/g, ' ').trim());
                return;
              }
            }
          } catch { /* skip unparseable lines */ }
        });

        rl.on('close', () => resolve(null));
        rl.on('error', () => resolve(null));
        stream.on('error', () => resolve(null));
      } catch {
        resolve(null);
      }
    });
  }

  private filterRecurring(sessions: RecentSession[]): RecentSession[] {
    const promptCounts = new Map<string, number>();
    for (const s of sessions) {
      promptCounts.set(s.firstPrompt, (promptCounts.get(s.firstPrompt) || 0) + 1);
    }
    return sessions.filter(s => (promptCounts.get(s.firstPrompt) || 0) < 2);
  }
}
