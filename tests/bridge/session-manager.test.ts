import { describe, it, expect, beforeEach } from 'vitest';
import { SessionManager } from '../../src/bridge/session-manager.js';
import { SessionStore } from '../../src/store/session-store.js';
import { ProjectStore } from '../../src/store/project-store.js';
import { SessionError } from '../../src/utils/errors.js';

describe('SessionManager', () => {
  let sessionStore: SessionStore;
  let projectStore: ProjectStore;
  let manager: SessionManager;

  beforeEach(() => {
    sessionStore = new SessionStore();
    projectStore = new ProjectStore('/tmp/fake-projects');
    manager = new SessionManager(sessionStore, projectStore);
  });

  it('should create a new session when none exists for threadTs', () => {
    const session = manager.resolveOrCreate({
      threadTs: '1700000000.000001',
      dmChannelId: 'C_DM1',
      projectPath: '/home/user/project',
      name: 'My Session',
      model: 'sonnet',
    });

    expect(session.sessionId).toBeDefined();
    expect(session.status).toBe('active');
    expect(session.name).toBe('My Session');
  });

  it('should resume an existing session for the same threadTs', () => {
    const first = manager.resolveOrCreate({
      threadTs: '1700000000.000002',
      dmChannelId: 'C_DM2',
      projectPath: '/home/user/project',
      name: 'First',
      model: 'sonnet',
    });

    const second = manager.resolveOrCreate({
      threadTs: '1700000000.000002',
      dmChannelId: 'C_DM2',
      projectPath: '/home/user/project',
      name: 'Second',
      model: 'sonnet',
    });

    expect(second.sessionId).toBe(first.sessionId);
    // Name should remain from the first creation
    expect(second.name).toBe('First');
  });

  it('should truncate long names to 30 chars + "..."', () => {
    const longName = 'A'.repeat(50);
    const session = manager.resolveOrCreate({
      threadTs: '1700000000.000003',
      dmChannelId: 'C_DM3',
      projectPath: '/home/user/project',
      name: longName,
      model: 'sonnet',
    });

    expect(session.name).toBe('A'.repeat(30) + '...');
    expect(session.name.length).toBe(33);
  });

  it('should end a session', () => {
    const session = manager.resolveOrCreate({
      threadTs: '1700000000.000004',
      dmChannelId: 'C_DM4',
      projectPath: '/home/user/project',
      name: 'End Me',
      model: 'sonnet',
    });

    const ended = manager.endSession(session.sessionId);
    expect(ended.status).toBe('ended');
  });

  it('should throw on double-end', () => {
    const session = manager.resolveOrCreate({
      threadTs: '1700000000.000005',
      dmChannelId: 'C_DM5',
      projectPath: '/home/user/project',
      name: 'Double End',
      model: 'sonnet',
    });

    manager.endSession(session.sessionId);

    expect(() => manager.endSession(session.sessionId)).toThrow(SessionError);
  });

  it('should record a turn with cost and tokens', () => {
    const session = manager.resolveOrCreate({
      threadTs: '1700000000.000006',
      dmChannelId: 'C_DM6',
      projectPath: '/home/user/project',
      name: 'Record Turn',
      model: 'opus',
    });

    manager.recordTurn(session.sessionId, {
      costUsd: 0.25,
      inputTokens: 1000,
      outputTokens: 500,
    });

    const updated = manager.getSession(session.sessionId);
    expect(updated!.totalCost).toBe(0.25);
    expect(updated!.turnCount).toBe(1);
    expect(updated!.totalInputTokens).toBe(1000);
    expect(updated!.totalOutputTokens).toBe(500);

    manager.recordTurn(session.sessionId, {
      costUsd: 0.10,
      inputTokens: 200,
      outputTokens: 100,
    });

    const updated2 = manager.getSession(session.sessionId);
    expect(updated2!.totalCost).toBeCloseTo(0.35);
    expect(updated2!.turnCount).toBe(2);
    expect(updated2!.totalInputTokens).toBe(1200);
    expect(updated2!.totalOutputTokens).toBe(600);
  });
});
