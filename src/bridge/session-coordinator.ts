// src/bridge/session-coordinator.ts
import { logger } from '../utils/logger.js';
import { PersistentSession } from './persistent-session.js';
import { MessageQueue } from './message-queue.js';
import type { SessionStartParams, ControlMessage } from '../types.js';

interface CoordinatorConfig {
  maxAlivePerUser: number;
  maxAliveGlobal: number;
}

interface ManagedEntry {
  session: PersistentSession;
  userId: string;
  sessionQueue: MessageQueue;
  crashCount: number;
}

export class SessionCoordinator {
  private readonly config: CoordinatorConfig;
  private readonly entries = new Map<string, ManagedEntry>();
  private readonly globalQueue = new MessageQueue(10, 5 * 60 * 1000);

  onIdleCallback?: () => void;
  onDequeueCallback?: (sessionId: string, messageId: string) => void;

  constructor(config: CoordinatorConfig) {
    this.config = config;
  }

  async getOrCreateSession(params: SessionStartParams & { userId: string }): Promise<PersistentSession> {
    const existing = this.entries.get(params.sessionId);
    if (existing && existing.session.state !== 'dead') {
      return existing.session;
    }

    // Clean up dead entries periodically
    this.cleanupDead();

    await this.enforceUserLimit(params.userId, params.maxAliveOverride);
    await this.enforceGlobalLimit();

    const session = new PersistentSession(params);
    const entry: ManagedEntry = {
      session,
      userId: params.userId,
      sessionQueue: new MessageQueue(5),
      crashCount: 0,
    };

    this.entries.set(params.sessionId, entry);
    this.wireEvents(entry, params);
    session.spawn();

    return session;
  }

  getSession(sessionId: string): PersistentSession | undefined {
    return this.entries.get(sessionId)?.session;
  }

  getSessionQueue(sessionId: string): MessageQueue | undefined {
    return this.entries.get(sessionId)?.sessionQueue;
  }

  getAliveCount(): number {
    let count = 0;
    for (const entry of this.entries.values()) {
      if (entry.session.state !== 'dead' && entry.session.state !== 'not_started') {
        count++;
      }
    }
    return count;
  }

  getAliveCountForUser(userId: string): number {
    let count = 0;
    for (const entry of this.entries.values()) {
      if (entry.userId === userId && entry.session.state !== 'dead' && entry.session.state !== 'not_started') {
        count++;
      }
    }
    return count;
  }

  broadcastControl(msg: ControlMessage): void {
    for (const entry of this.entries.values()) {
      const s = entry.session.state;
      if (s !== 'dead' && s !== 'not_started' && s !== 'ending') {
        entry.session.sendControl(msg);
      }
    }
  }

  endSession(sessionId: string): void {
    const entry = this.entries.get(sessionId);
    if (entry) {
      entry.session.end();
    }
  }

  isAllIdle(): boolean {
    for (const entry of this.entries.values()) {
      const s = entry.session.state;
      if (s === 'processing' || s === 'starting' || s === 'ending') {
        return false;
      }
    }
    return true;
  }

  private async enforceUserLimit(userId: string, maxAliveOverride?: number): Promise<void> {
    const limit = maxAliveOverride ?? this.config.maxAlivePerUser;
    const userSessions: ManagedEntry[] = [];
    for (const entry of this.entries.values()) {
      if (entry.userId === userId && entry.session.state !== 'dead' && entry.session.state !== 'not_started') {
        userSessions.push(entry);
      }
    }

    while (userSessions.length >= limit) {
      const oldest = userSessions.shift()!;
      oldest.session.end();
    }
  }

  private async enforceGlobalLimit(): Promise<void> {
    const alive = this.getAliveCount();
    if (alive < this.config.maxAliveGlobal) return;

    const sorted = [...this.entries.values()]
      .filter(e => e.session.state !== 'dead' && e.session.state !== 'not_started')
      .sort((a, b) => {
        if (a.session.state === 'idle' && b.session.state !== 'idle') return -1;
        if (b.session.state === 'idle' && a.session.state !== 'idle') return 1;
        return 0;
      });

    while (sorted.length >= this.config.maxAliveGlobal) {
      const oldest = sorted.shift()!;
      oldest.session.end();
    }
  }

  private cleanupDead(): void {
    for (const [id, entry] of this.entries) {
      if (entry.session.state === 'dead') {
        this.entries.delete(id);
      }
    }
  }

  private wireEvents(entry: ManagedEntry, params: SessionStartParams & { userId: string }): void {
    const { session } = entry;
    session.on('stateChange', (from: string, to: string) => {
      if (to === 'idle' && !entry.sessionQueue.isEmpty) {
        const next = entry.sessionQueue.dequeue();
        if (next) {
          this.onDequeueCallback?.(session.sessionId, next.id);
          session.sendPrompt(next.prompt);
        }
      }

      if (to === 'dead' && from === 'processing') {
        if (session.wasInterrupted) {
          // User-initiated interrupt — respawn immediately so session is available again
          logger.info(`Session ${session.sessionId} interrupted by user, respawning`);
          session.spawn();
        } else {
          entry.crashCount++;
          if (entry.crashCount <= 3) {
            const delay = Math.pow(2, entry.crashCount - 1) * 1000;
            logger.info(`Auto-respawn ${session.sessionId} in ${delay}ms (crash #${entry.crashCount})`);
            setTimeout(() => {
              session.spawn();
            }, delay);
          } else {
            logger.warn(`Session ${session.sessionId} exceeded crash limit (${entry.crashCount})`);
          }
        }
      }

      if (to === 'idle' && from === 'processing') {
        entry.crashCount = 0;
      }

      if (to === 'idle') {
        this.onIdleCallback?.();
      }
    });
  }
}
