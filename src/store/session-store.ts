import { v5 as uuidv5 } from 'uuid';
import type { SessionMetadata, ModelChoice } from '../types.js';
import { logger } from '../utils/logger.js';

const NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';

export interface CreateSessionInput {
  threadTs: string;
  dmChannelId: string;
  projectPath: string;
  name: string;
  model: ModelChoice;
}

export class SessionStore {
  private sessions = new Map<string, SessionMetadata>();

  threadTsToSessionId(threadTs: string): string {
    return uuidv5(threadTs, NAMESPACE);
  }

  create(input: CreateSessionInput): SessionMetadata {
    const sessionId = this.threadTsToSessionId(input.threadTs);
    const now = new Date();

    const session: SessionMetadata = {
      sessionId,
      threadTs: input.threadTs,
      dmChannelId: input.dmChannelId,
      projectPath: input.projectPath,
      name: input.name,
      model: input.model,
      status: 'active',
      startTime: now,
      totalCost: 0,
      turnCount: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      lastActiveAt: now,
      anchorCollapsed: false,
    };

    this.sessions.set(sessionId, session);
    logger.debug('Session created', { sessionId, threadTs: input.threadTs });
    return session;
  }

  get(sessionId: string): SessionMetadata | undefined {
    return this.sessions.get(sessionId);
  }

  findByThreadTs(threadTs: string): SessionMetadata | undefined {
    const sessionId = this.threadTsToSessionId(threadTs);
    return this.sessions.get(sessionId);
  }

  update(sessionId: string, fields: Partial<SessionMetadata>): SessionMetadata | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;

    Object.assign(session, fields, { lastActiveAt: new Date() });
    return session;
  }

  end(sessionId: string): SessionMetadata | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;

    session.status = 'ended';
    session.lastActiveAt = new Date();
    logger.debug('Session ended', { sessionId });
    return session;
  }

  getActiveSessions(): SessionMetadata[] {
    return Array.from(this.sessions.values()).filter((s) => s.status === 'active');
  }
}
