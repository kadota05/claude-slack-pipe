import { spawn, ChildProcess } from 'child_process';
import { logger } from '../utils/logger.js';

const MAX_TUNNELS = 5;
const TUNNEL_TIMEOUT_MS = 8000;
const TUNNEL_URL_REGEX = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

interface TunnelEntry {
  process: ChildProcess;
  url: string | undefined;
  port: number;
  createdAt: number;
}

export class TunnelManager {
  private tunnels = new Map<number, TunnelEntry>();
  private pending = new Map<number, Promise<string>>();

  startTunnel(port: number): Promise<string> {
    // Return existing tunnel URL
    const existing = this.tunnels.get(port);
    if (existing?.url) return Promise.resolve(existing.url);

    // Return pending tunnel
    const pendingPromise = this.pending.get(port);
    if (pendingPromise) return pendingPromise;

    // Enforce max tunnel limit
    if (this.tunnels.size >= MAX_TUNNELS) {
      this.evictOldest();
    }

    const promise = this.spawnTunnel(port);
    this.pending.set(port, promise);
    promise.finally(() => this.pending.delete(port));
    return promise;
  }

  getTunnelUrl(port: number): string | undefined {
    return this.tunnels.get(port)?.url;
  }

  stopTunnel(port: number): void {
    const entry = this.tunnels.get(port);
    if (entry) {
      entry.process.kill();
      this.tunnels.delete(port);
      logger.info(`Tunnel stopped for port ${port}`);
    }
  }

  stopAll(): void {
    for (const [port] of this.tunnels) {
      this.stopTunnel(port);
    }
  }

  private spawnTunnel(port: number): Promise<string> {
    return new Promise((resolve) => {
      const proc = spawn('cloudflared', ['tunnel', '--url', `localhost:${port}`], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const entry: TunnelEntry = {
        process: proc,
        url: undefined,
        port,
        createdAt: Date.now(),
      };
      this.tunnels.set(port, entry);

      const timeout = setTimeout(() => {
        if (!entry.url) {
          logger.warn(`Tunnel timeout for port ${port} after ${TUNNEL_TIMEOUT_MS}ms`);
          resolve(''); // Resolve empty so rewriter skips this URL
        }
      }, TUNNEL_TIMEOUT_MS);

      proc.stderr?.on('data', (data: Buffer) => {
        const line = data.toString();
        const match = line.match(TUNNEL_URL_REGEX);
        if (match && !entry.url) {
          entry.url = match[0];
          clearTimeout(timeout);
          logger.info(`Tunnel established: localhost:${port} -> ${entry.url}`);
          resolve(entry.url);
        }
      });

      proc.on('error', (err) => {
        logger.error(`cloudflared error for port ${port}: ${err.message}`);
        this.tunnels.delete(port);
        clearTimeout(timeout);
        resolve(''); // Graceful fallback
      });

      proc.on('exit', (code) => {
        if (entry.url) {
          // Process died after URL was established — clean up for re-creation
          logger.warn(`cloudflared exited (code ${code}) for port ${port}, tunnel will be re-created on next use`);
          this.tunnels.delete(port);
        }
      });
    });
  }

  private evictOldest(): void {
    let oldestPort: number | undefined;
    let oldestTime = Infinity;
    for (const [port, entry] of this.tunnels) {
      if (entry.createdAt < oldestTime) {
        oldestTime = entry.createdAt;
        oldestPort = port;
      }
    }
    if (oldestPort !== undefined) {
      this.stopTunnel(oldestPort);
    }
  }
}
