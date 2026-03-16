import type { SessionMetadata, ModelChoice } from '../types.js';
import type { SessionStore } from '../store/session-store.js';
import type { ProjectStore } from '../store/project-store.js';
import { SessionError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

const MAX_NAME_LENGTH = 30;

export interface ResolveOrCreateInput {
  threadTs: string;
  dmChannelId: string;
  projectPath: string;
  name: string;
  model: ModelChoice;
}

export interface RecordTurnInput {
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
}

export class SessionManager {
  constructor(
    private readonly sessionStore: SessionStore,
    private readonly projectStore: ProjectStore,
  ) {}

  resolveOrCreate(input: ResolveOrCreateInput): SessionMetadata {
    const existing = this.sessionStore.findByThreadTs(input.threadTs);
    if (existing) {
      logger.debug('Resuming existing session', { sessionId: existing.sessionId });
      return existing;
    }

    const name = input.name.length > MAX_NAME_LENGTH
      ? input.name.slice(0, MAX_NAME_LENGTH) + '...'
      : input.name;

    return this.sessionStore.create({
      ...input,
      name,
    });
  }

  endSession(sessionId: string): SessionMetadata {
    const session = this.sessionStore.get(sessionId);
    if (!session) {
      throw SessionError.notFound(sessionId);
    }
    if (session.status === 'ended') {
      throw SessionError.alreadyEnded(sessionId);
    }

    this.sessionStore.end(sessionId);
    return session;
  }

  recordTurn(sessionId: string, turn: RecordTurnInput): SessionMetadata {
    const session = this.sessionStore.get(sessionId);
    if (!session) {
      throw SessionError.notFound(sessionId);
    }

    this.sessionStore.update(sessionId, {
      totalCost: session.totalCost + turn.costUsd,
      turnCount: session.turnCount + 1,
      totalInputTokens: session.totalInputTokens + turn.inputTokens,
      totalOutputTokens: session.totalOutputTokens + turn.outputTokens,
    });

    return this.sessionStore.get(sessionId)!;
  }

  getSession(sessionId: string): SessionMetadata | undefined {
    return this.sessionStore.get(sessionId);
  }

  getSessionByThread(threadTs: string): SessionMetadata | undefined {
    return this.sessionStore.findByThreadTs(threadTs);
  }
}
