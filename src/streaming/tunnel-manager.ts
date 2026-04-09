import { spawn, execSync, ChildProcess } from 'child_process';
import { createConnection } from 'net';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { logger } from '../utils/logger.js';

const MAX_TUNNELS = 5;
const TUNNEL_TIMEOUT_MS = 15000;
const TUNNEL_URL_REGEX = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

// PID file to track our own cloudflared processes across restarts
const PID_FILE = path.join(os.tmpdir(), 'claude-slack-pipe-tunnel-pids.json');

interface TunnelEntry {
  process: ChildProcess;
  url: string | undefined;
  port: number;
  createdAt: number;
}

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

  constructor() {
    this.cleanupOwnOrphans();
  }

  /** Kill only cloudflared processes that WE started in a previous session (tracked via PID file) */
  private cleanupOwnOrphans(): void {
    try {
      const data = fs.readFileSync(PID_FILE, 'utf-8');
      const pids: number[] = JSON.parse(data);
      let cleaned = 0;
      for (const pid of pids) {
        // Verify this PID is actually a cloudflared process before killing (guards against PID reuse)
        try {
          const output = execSync(`ps -p ${pid} -o command=`, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
          if (!output.includes('cloudflared')) continue;
        } catch {
          // Process doesn't exist — skip
          continue;
        }
        try {
          // Graceful shutdown first, then force kill after 2s
          process.kill(pid, 'SIGTERM');
          setTimeout(() => {
            try { process.kill(pid, 'SIGKILL'); } catch { /* already dead */ }
          }, 2000);
          cleaned++;
        } catch {
          // Already dead — normal
        }
      }
      if (cleaned > 0) {
        logger.info(`Cleaned up ${cleaned} orphaned cloudflared process(es) from previous session`);
      }
    } catch {
      // PID file doesn't exist or is invalid — no orphans to clean
    }
    // Reset PID file for this session
    this.savePidFile();
  }

  /** Persist our owned PIDs so next startup can clean them up */
  private savePidFile(): void {
    const pids = [...this.tunnels.values()]
      .map((e) => e.process.pid)
      .filter((pid): pid is number => pid !== undefined);
    try {
      fs.writeFileSync(PID_FILE, JSON.stringify(pids), 'utf-8');
    } catch {
      // Non-critical — orphan cleanup just won't work next time
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

  /** Return ports that have active tunnels with resolved URLs */
  getActivePorts(): number[] {
    return [...this.tunnels.entries()]
      .filter(([, entry]) => entry.url)
      .map(([port]) => port);
  }

  stopTunnel(port: number): void {
    const entry = this.tunnels.get(port);
    if (entry) {
      entry.process.kill();
      this.tunnels.delete(port);
      this.savePidFile();
      logger.info(`Tunnel stopped for port ${port}`);
    }
  }

  stopAll(): void {
    for (const [port] of this.tunnels) {
      this.stopTunnel(port);
    }
    // Clean up PID file — no orphans to track
    try { fs.unlinkSync(PID_FILE); } catch { /* ignore */ }
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
      this.savePidFile();
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
      this.savePidFile();

      const timeout = setTimeout(() => {
        if (!entry.url) {
          logger.warn(`Tunnel timeout for port ${port} after ${TUNNEL_TIMEOUT_MS}ms`);
          // Kill the timed-out process to avoid zombie
          proc.kill();
          this.tunnels.delete(port);
          this.savePidFile();
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
        this.savePidFile();
        clearTimeout(timeout);
        resolve('');
      });

      proc.on('exit', (code) => {
        logger.warn(`cloudflared exited (code ${code}) for port ${port}, tunnel will be re-created on next use`);
        this.tunnels.delete(port);
        this.savePidFile();
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
