import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { logger } from '../utils/logger.js';
import { decodeProjectId } from './project-store.js';
import { SLACK_CONTEXT_PREFIX } from '../bridge/slack-context.js';
import type { RecentSession } from '../types.js';

const MAX_CANDIDATES = 15;
const MAX_LINES_TO_READ = 20;
const MAX_DISPLAY = 5;
const PREVIEW_LENGTH = 50;
const RECURRING_PREFIX_LENGTH = 50;

/**
 * Strip Claude Code command XML tags from user messages.
 * Messages from slash commands look like:
 *   <command-message>skill-name</command-message>
 *   <command-name>/skill-name</command-name>
 *   <command-args>actual prompt</command-args>
 * Returns { commandName, body } where body is the user's actual text.
 */
export function stripSlackContext(raw: string): string {
  if (raw.startsWith('[Slack Bridge Context]')) {
    return raw.slice(SLACK_CONTEXT_PREFIX.length).trim();
  }
  return raw;
}

export function stripCommandTags(raw: string): { commandName: string | null; body: string } {
  const nameMatch = raw.match(/<command-name>\/?([^<]+)<\/command-name>/);
  const argsMatch = raw.match(/<command-args>([\s\S]*?)<\/command-args>/);

  if (argsMatch) {
    return {
      commandName: nameMatch?.[1]?.trim() || null,
      body: argsMatch[1].trim(),
    };
  }

  // No command tags — return cleaned text
  const cleaned = raw
    .replace(/<command-message>[^<]*<\/command-message>/g, '')
    .replace(/<command-name>[^<]*<\/command-name>/g, '')
    .trim();
  return { commandName: nameMatch?.[1]?.trim() || null, body: cleaned || raw };
}

export class RecentSessionScanner {
  constructor(private readonly claudeProjectsDir: string) {}

  async scan(): Promise<RecentSession[]> {
    const candidates = this.collectCandidates();
    if (candidates.length === 0) return [];

    const sessions: RecentSession[] = [];
    for (const c of candidates) {
      const rawPrompt = await this.readFirstUserMessage(c.filePath);
      if (rawPrompt === null) continue;
      const stripped = stripSlackContext(rawPrompt);
      const { commandName, body } = stripCommandTags(stripped);
      const firstPrompt = body || rawPrompt;
      const parts = decodeProjectId(c.projectId).split('/').filter(Boolean);

      // Build preview: "[cmd] body..." or just "body..."
      // Strip namespace prefixes (e.g. "superpowers:systematic-debugging" → "systematic-debugging")
      const shortName = commandName?.replace(/^[^:]+:/, '') || commandName;
      const prefix = shortName ? `[${shortName}] ` : '';
      const maxBody = PREVIEW_LENGTH - prefix.length;
      const bodyPreview = body.length > maxBody
        ? body.slice(0, maxBody) + '...'
        : body;
      const firstPromptPreview = prefix + bodyPreview;

      sessions.push({
        sessionId: c.sessionId,
        projectPath: parts.slice(-2).join('/') || c.projectId,
        mtime: c.mtime,
        firstPrompt,
        firstPromptPreview,
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
      let resolved = false;
      const done = (value: string | null) => {
        if (resolved) return;
        resolved = true;
        resolve(value);
      };

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
                done(text.replace(/\n/g, ' ').trim());
                rl.close();
                stream.destroy();
                return;
              }
            }
          } catch { /* skip unparseable lines */ }
        });

        rl.on('close', () => done(null));
        rl.on('error', () => done(null));
        stream.on('error', () => done(null));
      } catch {
        done(null);
      }
    });
  }

  private filterRecurring(sessions: RecentSession[]): RecentSession[] {
    const promptCounts = new Map<string, number>();
    for (const s of sessions) {
      const prefix = s.firstPrompt.slice(0, RECURRING_PREFIX_LENGTH);
      promptCounts.set(prefix, (promptCounts.get(prefix) || 0) + 1);
    }
    return sessions.filter(s => {
      const prefix = s.firstPrompt.slice(0, RECURRING_PREFIX_LENGTH);
      return (promptCounts.get(prefix) || 0) < 2;
    });
  }
}
