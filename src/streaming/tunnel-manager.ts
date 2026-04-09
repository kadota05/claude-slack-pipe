import { spawn, execSync, ChildProcess } from 'child_process';
import { createConnection } from 'net';
import { logger } from '../utils/logger.js';

const MAX_TUNNELS = 5;
const TUNNEL_TIMEOUT_MS = 15000;
const TUNNEL_URL_REGEX = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

interface TunnelEntry {
  process: ChildProcess;
  url: string | undefined;
  port: number;
  createdAt: number;
}

const ORPHAN_SCAN_INTERVAL_MS = 60000;
const PORT_CHECK_TIMEOUT_MS = 3000;
const PORT_RETRY_INTERVAL_MS = 2000;
const PORT_RETRY_MAX_ATTEMPTS = 5;

export function isPortAlive(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host: 'localhost' });
    socket.setTimeout(PORT_CHECK_TIMEOUT_MS);
    socket.on('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.on('error', () => {
      resolve(false);
    });
  });
}

/** Retry isPortAlive with intervals for servers that are still starting up */
export async function waitForPort(port: number): Promise<boolean> {
  for (let i = 0; i < PORT_RETRY_MAX_ATTEMPTS; i++) {
    if (await isPortAlive(port)) return true;
    if (i < PORT_RETRY_MAX_ATTEMPTS - 1) {
      await new Promise((r) => setTimeout(r, PORT_RETRY_INTERVAL_MS));
    }
  }
  return false;
}

export class TunnelManager {
  private tunnels = new Map<number, TunnelEntry>();
  private pending = new Map<number, Promise<string>>();
  private orphanTimer: ReturnType<typeof setInterval> | undefined;

  constructor() {
    this.cleanupOrphans();
    this.orphanTimer = setInterval(() => this.killUntracked(), ORPHAN_SCAN_INTERVAL_MS);
  }

  private cleanupOrphans(): void {
    try {
      execSync('pkill -f "cloudflared tunnel --url localhost"', { stdio: 'ignore' });
      logger.info('Cleaned up orphaned cloudflared processes from previous session');
    } catch {
      // No orphaned processes — normal case
    }
  }

  private killUntracked(): void {
    try {
      const output = execSync('pgrep -f "cloudflared tunnel --url localhost"', {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const ownedPids = new Set(
        [...this.tunnels.values()].map((e) => e.process.pid).filter(Boolean),
      );
      const pids = output.trim().split('\n').map(Number).filter(Boolean);
      for (const pid of pids) {
        if (!ownedPids.has(pid)) {
          try {
            process.kill(pid, 'SIGKILL');
            logger.warn(`Killed orphaned cloudflared process: PID ${pid}`);
          } catch {
            // Already dead
          }
        }
      }
    } catch {
      // No cloudflared processes found — normal
    }
  }

  async startTunnel(port: number): Promise<string> {
    // Check if port is actually listening before creating tunnel
    const alive = await isPortAlive(port);
    if (!alive) {
      logger.info(`Port ${port} is not listening, skipping tunnel creation`);
      return '';
    }

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

    const promise = this.spawnTunnelWithRetry(port);
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
    if (this.orphanTimer) {
      clearInterval(this.orphanTimer);
      this.orphanTimer = undefined;
    }
    for (const [port] of this.tunnels) {
      this.stopTunnel(port);
    }
  }

  private async spawnTunnelWithRetry(port: number): Promise<string> {
    const url = await this.spawnTunnel(port);
    if (url) return url;

    // Retry once — clean up failed attempt first
    logger.info(`Retrying tunnel for port ${port}`);
    this.cleanupTunnel(port);
    return this.spawnTunnel(port);
  }

  private cleanupTunnel(port: number): void {
    const entry = this.tunnels.get(port);
    if (entry) {
      entry.process.kill();
      this.tunnels.delete(port);
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
          // Kill the timed-out process to avoid zombie
          proc.kill();
          this.tunnels.delete(port);
          resolve('');
        }
      }, TUNNEL_TIMEOUT_MS);

      proc.stderr?.on('data', (data: Buffer) => {
        const line = data.toString();
        const match = line.match(TUNNEL_URL_REGEX);
        if (match) {
          const newUrl = match[0];
          if (!entry.url) {
            // First URL — resolve the pending promise
            entry.url = newUrl;
            clearTimeout(timeout);
            logger.info(`Tunnel established: localhost:${port} -> ${entry.url}`);
            resolve(entry.url);
          } else if (entry.url !== newUrl) {
            // cloudflared reconnected with a new URL — update cache
            entry.url = newUrl;
            logger.info(`Tunnel URL updated: localhost:${port} -> ${entry.url}`);
          }
        }
      });

      proc.on('error', (err) => {
        logger.error(`cloudflared error for port ${port}: ${err.message}`);
        this.tunnels.delete(port);
        clearTimeout(timeout);
        resolve('');
      });

      proc.on('exit', (code) => {
        logger.warn(`cloudflared exited (code ${code}) for port ${port}, tunnel will be re-created on next use`);
        this.tunnels.delete(port);
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
