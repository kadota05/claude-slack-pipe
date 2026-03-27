import fs from 'node:fs/promises';
import { watch, type FSWatcher } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { logger } from '../utils/logger.js';
import { downloadFilesToTemp } from './file-downloader.js';

export interface ChannelRouteEntry {
  folder: string;
  description: string;
  channel: string;
  channelId: string;
  handler: string;
  createdAt: string;
}

export interface ChannelMessageParams {
  text: string;
  files: Array<{ id: string; name: string; mimetype: string; size: number; url_private_download?: string }>;
  botToken: string;
  userId: string;
  channelId: string;
  threadTs: string;
  timestamp: string;
}

export class ChannelRouter {
  private routes: Map<string, ChannelRouteEntry> = new Map();
  private watcher: FSWatcher | null = null;
  private reloadTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly slackMemoryPath: string) {}

  async load(): Promise<void> {
    try {
      const content = await fs.readFile(this.slackMemoryPath, 'utf-8');
      const entries: unknown[] = JSON.parse(content);
      this.routes.clear();
      for (const entry of entries) {
        const e = entry as Record<string, unknown>;
        if (typeof e.channelId === 'string' && typeof e.handler === 'string' && typeof e.folder === 'string') {
          this.routes.set(e.channelId, entry as ChannelRouteEntry);
        }
      }
      logger.info(`Channel router loaded ${this.routes.size} route(s)`);
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        logger.info('No slack-memory.json found, channel routing disabled');
      } else {
        logger.warn('Failed to load slack-memory.json:', err.message);
      }
      this.routes.clear();
    }
  }

  startWatching(): void {
    try {
      this.watcher = watch(this.slackMemoryPath, () => {
        if (this.reloadTimer) clearTimeout(this.reloadTimer);
        this.reloadTimer = setTimeout(() => {
          logger.info('slack-memory.json changed, reloading routes');
          this.load();
        }, 500);
      });
      logger.info('Watching slack-memory.json for changes');
    } catch {
      logger.info('Cannot watch slack-memory.json (file may not exist yet)');
    }
  }

  stopWatching(): void {
    this.watcher?.close();
    this.watcher = null;
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
  }

  hasRoute(channelId: string): boolean {
    return this.routes.has(channelId);
  }

  getRoute(channelId: string): ChannelRouteEntry | undefined {
    return this.routes.get(channelId);
  }

  private expandTilde(filePath: string): string {
    if (filePath.startsWith('~/')) {
      return path.join(os.homedir(), filePath.slice(2));
    }
    return filePath;
  }

  async dispatch(params: ChannelMessageParams): Promise<void> {
    const route = this.routes.get(params.channelId);
    if (!route) return;

    const folder = this.expandTilde(route.folder);
    const handler = path.join(folder, route.handler);

    let filePaths: string[] = [];
    let tempDir: string | null = null;
    if (params.files.length > 0) {
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ch-router-'));
      filePaths = await downloadFilesToTemp(params.files, params.botToken, tempDir);
    }

    const args = [handler];
    if (params.text) {
      args.push('--text', params.text);
    }
    if (filePaths.length > 0) {
      args.push('--files', filePaths.join(','));
    }
    args.push('--user-id', params.userId);
    args.push('--channel-id', params.channelId);
    args.push('--thread-ts', params.threadTs);
    args.push('--timestamp', params.timestamp);

    logger.info(`Dispatching to ${route.channel}: ${route.description}`);

    // Use project-local tsx (launchd doesn't have PATH to global tsx)
    const tsxBin = path.join(folder, 'node_modules', '.bin', 'tsx');

    const child = spawn(tsxBin, args, {
      cwd: folder,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (data: Buffer) => { stdout += data.toString(); });
    child.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });

    child.on('exit', async (code) => {
      if (code !== 0) {
        logger.error(`Channel handler ${route.channel} exited with code ${code}. stderr: ${stderr}`);
      } else {
        logger.debug(`Channel handler ${route.channel} completed. stdout: ${stdout}`);
      }
      if (tempDir) {
        await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
      }
    });
  }
}
