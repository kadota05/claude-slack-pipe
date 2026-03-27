import fs from 'node:fs/promises';
import { watch, type FSWatcher } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { logger } from '../utils/logger.js';
import { downloadFilesToTemp } from './file-downloader.js';
import { convertMarkdownToMrkdwn } from '../streaming/markdown-converter.js';

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

/**
 * Standard output protocol for channel handlers.
 * Handlers write one JSON object per line to stdout.
 * Non-JSON lines are ignored (treated as debug output).
 *
 * Event types:
 *   progress  — transient status (shown as context block, replaced on next progress, deleted on exit)
 *   message   — post a message to the channel thread
 *   error     — post a formatted error message
 */
interface HandlerEvent {
  type: 'progress' | 'message' | 'error';
  text: string;
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

  private async slackReaction(action: 'add' | 'remove', name: string, token: string, channel: string, timestamp: string): Promise<void> {
    try {
      await fetch(`https://slack.com/api/reactions.${action}`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel, name, timestamp }),
      });
    } catch (err: any) {
      logger.warn(`Failed to ${action} reaction ${name}:`, err.message);
    }
  }

  private async slackPostMessage(token: string, channel: string, threadTs: string, text: string, blocks?: unknown[]): Promise<string | null> {
    try {
      const body: Record<string, unknown> = { channel, thread_ts: threadTs, text };
      if (blocks) body.blocks = blocks;
      const resp = await fetch('https://slack.com/api/chat.postMessage', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await resp.json() as { ok: boolean; ts?: string };
      return data.ok ? (data.ts ?? null) : null;
    } catch (err: any) {
      logger.warn('Failed to post message:', err.message);
      return null;
    }
  }

  private async slackUpdateMessage(token: string, channel: string, ts: string, text: string, blocks?: unknown[]): Promise<void> {
    try {
      const body: Record<string, unknown> = { channel, ts, text };
      if (blocks) body.blocks = blocks;
      await fetch('https://slack.com/api/chat.update', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (err: any) {
      logger.warn('Failed to update message:', err.message);
    }
  }

  private async slackDeleteMessage(token: string, channel: string, ts: string): Promise<void> {
    try {
      await fetch('https://slack.com/api/chat.delete', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel, ts }),
      });
    } catch (err: any) {
      logger.warn('Failed to delete message:', err.message);
    }
  }

  /**
   * Process a handler stdout event. Returns new progressTs if changed.
   */
  private async handleEvent(
    event: HandlerEvent,
    params: ChannelMessageParams,
    route: ChannelRouteEntry,
    progressTs: string | null,
  ): Promise<string | null | undefined> {
    const { botToken, channelId, threadTs } = params;

    switch (event.type) {
      case 'progress': {
        const blocks = [{ type: 'context', elements: [{ type: 'mrkdwn', text: event.text }] }];
        if (progressTs) {
          await this.slackUpdateMessage(botToken, channelId, progressTs, event.text, blocks);
          return undefined; // no change to progressTs
        }
        const ts = await this.slackPostMessage(botToken, channelId, threadTs, event.text, blocks);
        return ts; // new progressTs
      }
      case 'message': {
        const mrkdwn = convertMarkdownToMrkdwn(event.text);
        const blocks = [{ type: 'section', text: { type: 'mrkdwn', text: mrkdwn } }];
        await this.slackPostMessage(botToken, channelId, threadTs, mrkdwn, blocks);
        return undefined;
      }
      case 'error': {
        const errText = `:warning: *${route.description}*\n${event.text}`;
        const blocks = [{ type: 'section', text: { type: 'mrkdwn', text: errText } }];
        await this.slackPostMessage(botToken, channelId, threadTs, errText, blocks);
        return undefined;
      }
    }
  }

  private parseHandlerEvent(line: string): HandlerEvent | null {
    try {
      const obj = JSON.parse(line);
      if (obj && typeof obj.type === 'string' && typeof obj.text === 'string') {
        if (['progress', 'message', 'error'].includes(obj.type)) {
          return obj as HandlerEvent;
        }
      }
    } catch {
      // Not JSON — treat as debug output
    }
    return null;
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

    // Processing indicator — same ⏳ pattern as Bridge DM handling
    await this.slackReaction('add', 'hourglass_flowing_sand', params.botToken, params.channelId, params.timestamp);

    // Use project-local tsx (launchd doesn't have PATH to global tsx)
    const tsxBin = path.join(folder, 'node_modules', '.bin', 'tsx');

    const child = spawn(tsxBin, args, {
      cwd: folder,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stderr = '';
    let rawStdout = '';
    let progressTs: string | null = null;
    let stdoutBuf = '';

    child.stdout.on('data', (data: Buffer) => {
      stdoutBuf += data.toString();
      // Process complete lines
      const lines = stdoutBuf.split('\n');
      stdoutBuf = lines.pop() ?? ''; // keep incomplete last line in buffer
      for (const line of lines) {
        if (!line.trim()) continue;
        const event = this.parseHandlerEvent(line);
        if (!event) {
          rawStdout += line + '\n';
          continue;
        }
        // Handle protocol events (fire-and-forget to avoid backpressure)
        this.handleEvent(event, params, route, progressTs).then((newTs) => {
          if (newTs !== undefined) progressTs = newTs;
        }).catch((err) => logger.warn('Event handling error:', err));
      }
    });

    child.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });

    child.on('error', async (err) => {
      logger.error(`Channel handler ${route.channel} spawn error:`, err);
      await this.slackReaction('remove', 'hourglass_flowing_sand', params.botToken, params.channelId, params.timestamp);
      await this.slackReaction('add', 'x', params.botToken, params.channelId, params.timestamp);
      if (progressTs) await this.slackDeleteMessage(params.botToken, params.channelId, progressTs);
      if (tempDir) {
        await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
      }
    });

    child.on('exit', async (code) => {
      // Process any remaining buffered stdout
      if (stdoutBuf.trim()) {
        const event = this.parseHandlerEvent(stdoutBuf);
        if (event) {
          const newTs = await this.handleEvent(event, params, route, progressTs);
          if (newTs !== undefined) progressTs = newTs;
        }
      }

      await this.slackReaction('remove', 'hourglass_flowing_sand', params.botToken, params.channelId, params.timestamp);
      if (progressTs) await this.slackDeleteMessage(params.botToken, params.channelId, progressTs);

      if (code !== 0) {
        logger.error(`Channel handler ${route.channel} exited with code ${code}. stderr: ${stderr}`);
        await this.slackReaction('add', 'x', params.botToken, params.channelId, params.timestamp);
      } else {
        logger.debug(`Channel handler ${route.channel} completed. raw stdout: ${rawStdout}`);
        await this.slackReaction('add', 'white_check_mark', params.botToken, params.channelId, params.timestamp);
      }
      if (tempDir) {
        await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
      }
    });
  }
}
