import { spawn, type ChildProcess } from 'node:child_process';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { logger } from './logger.js';

/**
 * Watches for macOS network state changes using scutil.
 * Emits 'disconnected' when all external IPs disappear.
 * Emits 'reconnected' when an external IP appears.
 */
export class NetworkWatcher extends EventEmitter {
  private proc: ChildProcess | null = null;
  private stopped = false;
  private restartCount = 0;
  private restartWindowStart = 0;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private lastState: 'connected' | 'disconnected' | null = null;

  start(): void {
    if (this.proc || this.stopped) return;
    this.spawnScutil();
    this.lastState = this.hasExternalIP() ? 'connected' : 'disconnected';
    logger.info(`[NetworkWatcher] Started, initial state: ${this.lastState}`);
  }

  stop(): void {
    this.stopped = true;
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.proc) {
      this.proc.kill();
      this.proc = null;
    }
  }

  private spawnScutil(): void {
    this.proc = spawn('/usr/sbin/scutil', [], {
      stdio: ['pipe', 'pipe', 'ignore'],
    });

    this.proc.stdin!.write('n.add State:/Network/Global/IPv4\n');
    this.proc.stdin!.write('n.add State:/Network/Global/IPv6\n');
    this.proc.stdin!.write('n.watch\n');

    this.proc.stdout!.on('data', (data: Buffer) => {
      const text = data.toString();
      if (text.includes('changed key')) {
        this.onNetworkChange();
      }
    });

    this.proc.on('exit', (code) => {
      this.proc = null;
      if (this.stopped) return;

      const now = Date.now();
      if (now - this.restartWindowStart > 60_000) {
        this.restartCount = 0;
        this.restartWindowStart = now;
      }
      this.restartCount++;

      if (this.restartCount > 5) {
        logger.error('[NetworkWatcher] scutil restarted too many times, disabling');
        return;
      }

      logger.warn(`[NetworkWatcher] scutil exited (code ${code}), restarting in 1s`);
      setTimeout(() => this.spawnScutil(), 1000);
    });
  }

  private onNetworkChange(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      const hasIP = this.hasExternalIP();
      const newState = hasIP ? 'connected' : 'disconnected';

      if (newState === this.lastState) return;
      this.lastState = newState;

      if (newState === 'disconnected') {
        logger.warn('[NetworkWatcher] Network disconnected');
        this.emit('disconnected');
      } else {
        logger.info('[NetworkWatcher] Network reconnected');
        this.emit('reconnected');
      }
    }, 5000);
  }

  private hasExternalIP(): boolean {
    const ifaces = os.networkInterfaces();
    for (const addrs of Object.values(ifaces)) {
      if (!addrs) continue;
      for (const addr of addrs) {
        if (!addr.internal && addr.family === 'IPv4') return true;
      }
    }
    return false;
  }
}
