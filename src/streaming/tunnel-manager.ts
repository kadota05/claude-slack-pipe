import { spawn, ChildProcess } from 'child_process';
import { logger } from '../utils/logger.js';

const MAX_TUNNELS = 5;
const TUNNEL_TIMEOUT_MS = 15000;
// localhost.run outputs URLs like: https://1a65eac44b35b1.lhr.life
const TUNNEL_URL_REGEX = /https:\/\/[a-z0-9]+\.lhr\.life/;

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
      const proc = spawn('ssh', [
        '-o', 'StrictHostKeyChecking=no',
        '-o', 'ServerAliveInterval=30',
        '-o', 'ConnectTimeout=10',
        '-R', `80:localhost:${port}`,
        'nokey@localhost.run',
      ], {
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
          proc.kill();
          this.tunnels.delete(port);
          resolve('');
        }
      }, TUNNEL_TIMEOUT_MS);

      // localhost.run outputs the URL on stdout
      const handleOutput = (data: Buffer) => {
        const line = data.toString();
        const match = line.match(TUNNEL_URL_REGEX);
        if (match) {
          const newUrl = match[0];
          if (!entry.url) {
            entry.url = newUrl;
            clearTimeout(timeout);
            logger.info(`Tunnel established: localhost:${port} -> ${entry.url}`);
            resolve(entry.url);
          } else if (entry.url !== newUrl) {
            entry.url = newUrl;
            logger.info(`Tunnel URL updated: localhost:${port} -> ${entry.url}`);
          }
        }
      };

      proc.stdout?.on('data', handleOutput);
      proc.stderr?.on('data', handleOutput);

      proc.on('error', (err) => {
        logger.error(`SSH tunnel error for port ${port}: ${err.message}`);
        this.tunnels.delete(port);
        clearTimeout(timeout);
        resolve('');
      });

      proc.on('exit', (code) => {
        if (entry.url) {
          logger.warn(`SSH tunnel exited (code ${code}) for port ${port}, tunnel will be re-created on next use`);
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
