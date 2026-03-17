import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../utils/logger.js';
import type { ProjectInfo, SessionInfoLight } from '../types.js';

/**
 * Decode a Claude CLI project ID back to the actual filesystem path.
 * Claude encodes `/` as `-`, so `-Users-archeco055-dev-claude-slack-pipe`
 * could be `/Users/archeco055/dev/claude-slack-pipe` or other splits.
 * We try all possible splits and return the first one that exists on disk.
 */
export function decodeProjectId(id: string): string {
  // Remove leading '-' which represents the root '/'
  const withoutLeading = id.startsWith('-') ? id.slice(1) : id;
  const segments = withoutLeading.split('-');

  // Try to greedily build the path, checking each candidate against the filesystem
  const result = greedyDecode(segments, '/');
  return result || '/' + withoutLeading.replace(/-/g, '/'); // fallback
}

function greedyDecode(segments: string[], prefix: string): string | null {
  if (segments.length === 0) {
    return fs.existsSync(prefix) ? prefix : null;
  }

  // Try joining progressively more segments with '-' (to handle hyphenated dir names)
  for (let take = segments.length; take >= 1; take--) {
    const dirName = segments.slice(0, take).join('-');
    const candidate = path.join(prefix, dirName);
    if (fs.existsSync(candidate)) {
      if (take === segments.length) return candidate;
      const rest = greedyDecode(segments.slice(take), candidate);
      if (rest) return rest;
    }
  }
  return null;
}

export class ProjectStore {
  private cache: ProjectInfo[] | null = null;
  private cacheTimestamp = 0;
  private readonly ttlMs: number;
  private readonly baseDir: string;

  constructor(baseDir: string, ttlMs = 30_000) {
    this.baseDir = baseDir;
    this.ttlMs = ttlMs;
  }

  getProjects(): ProjectInfo[] {
    const now = Date.now();
    if (this.cache && now - this.cacheTimestamp < this.ttlMs) {
      return this.cache;
    }

    if (!fs.existsSync(this.baseDir)) {
      logger.debug('Projects directory does not exist', { baseDir: this.baseDir });
      this.cache = [];
      this.cacheTimestamp = now;
      return this.cache;
    }

    const entries = fs.readdirSync(this.baseDir, { withFileTypes: true });
    const projects: ProjectInfo[] = entries
      .filter((e) => e.isDirectory())
      .map((e) => {
        const projectPath = path.join(this.baseDir, e.name);
        const sessionFiles = this.getSessionFiles(projectPath);
        const stat = fs.statSync(projectPath);
        return {
          id: e.name,
          projectPath,
          workingDirectory: decodeProjectId(e.name),
          sessionCount: sessionFiles.length,
          lastModified: new Date(stat.mtimeMs),
        };
      });

    this.cache = projects;
    this.cacheTimestamp = now;
    logger.debug('Refreshed project cache', { count: projects.length });
    return projects;
  }

  invalidateCache(): void {
    this.cache = null;
    this.cacheTimestamp = 0;
  }

  getSessionFiles(projectPath: string): SessionInfoLight[] {
    try {
      const files = fs.readdirSync(projectPath) as unknown as string[];
      return files
        .filter((f: string) => f.endsWith('.jsonl'))
        .map((f: string) => {
          const filePath = path.join(projectPath, f);
          const stat = fs.statSync(filePath);
          return {
            sessionId: path.basename(f, '.jsonl'),
            updatedAt: new Date(stat.mtimeMs),
            sizeBytes: stat.size || 0,
          };
        });
    } catch {
      return [];
    }
  }

  resolveProjectPath(cwd: string): string | null {
    // Claude CLI encodes project paths by replacing '/' with '-'
    // e.g., /Users/alice/code/myapp -> -Users-alice-code-myapp
    const encoded = cwd.replace(/\//g, '-');
    const projectPath = path.join(this.baseDir, encoded);

    if (fs.existsSync(projectPath)) {
      return projectPath;
    }

    // Also try scanning projects from cache
    const projects = this.getProjects();
    const match = projects.find((p) => p.id === encoded);
    return match ? match.projectPath : null;
  }
}
