import type { App } from '@slack/bolt';
import type { SocketModeClient } from '@slack/socket-mode';
import { logger } from './logger.js';

const CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const GRACE_PERIOD_MS = 60 * 1000; // 1 minute after start before checking

interface SocketWatchdogOptions {
  app: App;
  shutdown: (signal: string) => Promise<void>;
}

/**
 * Periodically monitors the Socket Mode WebSocket connection health.
 *
 * - Logs isActive(), readyState, and last message event timestamp every 5 minutes.
 * - If isActive() === false after the grace period, triggers a process restart.
 */
export class SocketWatchdog {
  private timer: ReturnType<typeof setInterval> | null = null;
  private startedAt = 0;
  private lastMessageEventAt = 0;
  private readonly app: App;
  private readonly shutdown: (signal: string) => Promise<void>;
  private stopped = false;

  constructor(opts: SocketWatchdogOptions) {
    this.app = opts.app;
    this.shutdown = opts.shutdown;
  }

  /** Call this whenever a message event is received to update the last-seen timestamp. */
  recordMessageEvent(): void {
    this.lastMessageEventAt = Date.now();
  }

  start(): void {
    this.startedAt = Date.now();
    this.lastMessageEventAt = Date.now();
    this.stopped = false;

    this.timer = setInterval(() => {
      this.check().catch((err) => {
        logger.warn('[SocketWatchdog] check failed', { error: err?.message });
      });
    }, CHECK_INTERVAL_MS);
    // Don't let this timer prevent process exit during shutdown
    this.timer.unref();

    logger.info('[SocketWatchdog] Started', {
      checkIntervalMs: CHECK_INTERVAL_MS,
      gracePeriodMs: GRACE_PERIOD_MS,
    });
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  // Bolt's App type doesn't expose receiver as SocketModeReceiver,
  // so we cast through `any` to reach the SocketModeClient instance.
  private getSocketClient(): SocketModeClient | undefined {
    return (this.app as any).receiver?.client as SocketModeClient | undefined;
  }

  private async check(): Promise<void> {
    if (this.stopped) return;

    const socketClient = this.getSocketClient();
    const ws = socketClient?.websocket;

    const isActive = ws?.isActive() ?? null;
    const readyState = ws?.readyState ?? null;
    const msSinceLastMessage = this.lastMessageEventAt
      ? Date.now() - this.lastMessageEventAt
      : null;
    const msSinceStart = Date.now() - this.startedAt;
    const inGracePeriod = msSinceStart < GRACE_PERIOD_MS;

    // Always log the state for observability
    logger.info('[SocketWatchdog] Health check', {
      isActive,
      readyState,
      msSinceLastMessage,
      msSinceStartSec: Math.round(msSinceStart / 1000),
      inGracePeriod,
    });

    // Don't act during grace period (connection may still be establishing)
    if (inGracePeriod) return;

    // websocket property is undefined — SDK may not have initialized or lost its reference
    if (isActive === null) {
      logger.warn('[SocketWatchdog] WebSocket instance is null/undefined after grace period', {
        readyState,
        msSinceLastMessage,
      });
      return;
    }

    // If WebSocket is not active, trigger restart
    if (isActive === false) {
      logger.error('[SocketWatchdog] WebSocket is not active, triggering restart', {
        readyState,
        msSinceLastMessage,
      });
      await this.shutdown('websocket-dead');
    }
  }
}
