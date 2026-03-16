import { describe, it, expect, beforeEach } from 'vitest';
import { SessionStore } from '../../src/store/session-store.js';

describe('SessionStore', () => {
  let store: SessionStore;

  beforeEach(() => {
    store = new SessionStore();
  });

  it('should generate deterministic session ID from threadTs', () => {
    const id1 = store.threadTsToSessionId('1234567890.123456');
    const id2 = store.threadTsToSessionId('1234567890.123456');
    expect(id1).toBe(id2);
    // Should be a valid UUID format
    expect(id1).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('should generate different IDs for different threadTs values', () => {
    const id1 = store.threadTsToSessionId('1234567890.111111');
    const id2 = store.threadTsToSessionId('1234567890.222222');
    expect(id1).not.toBe(id2);
  });

  it('should create and retrieve a session', () => {
    const session = store.create({
      threadTs: '1700000000.000001',
      dmChannelId: 'C_DM1',
      projectPath: '/home/user/project',
      name: 'Test Session',
      model: 'sonnet',
    });

    expect(session.sessionId).toBeDefined();
    expect(session.status).toBe('active');
    expect(session.totalCost).toBe(0);

    const retrieved = store.get(session.sessionId);
    expect(retrieved).toEqual(session);
  });

  it('should find session by threadTs', () => {
    const session = store.create({
      threadTs: '1700000000.000002',
      dmChannelId: 'C_DM2',
      projectPath: '/home/user/project',
      name: 'Find Me',
      model: 'opus',
    });

    const found = store.findByThreadTs('1700000000.000002');
    expect(found).toBeDefined();
    expect(found!.sessionId).toBe(session.sessionId);
  });

  it('should return undefined for unknown threadTs', () => {
    const found = store.findByThreadTs('9999999999.999999');
    expect(found).toBeUndefined();
  });

  it('should update session fields', () => {
    const session = store.create({
      threadTs: '1700000000.000003',
      dmChannelId: 'C_DM3',
      projectPath: '/home/user/project',
      name: 'Update Me',
      model: 'haiku',
    });

    store.update(session.sessionId, { totalCost: 0.50, turnCount: 3 });

    const updated = store.get(session.sessionId);
    expect(updated!.totalCost).toBe(0.50);
    expect(updated!.turnCount).toBe(3);
  });

  it('should end a session', () => {
    const session = store.create({
      threadTs: '1700000000.000004',
      dmChannelId: 'C_DM4',
      projectPath: '/home/user/project',
      name: 'End Me',
      model: 'sonnet',
    });

    store.end(session.sessionId);

    const ended = store.get(session.sessionId);
    expect(ended!.status).toBe('ended');
  });

  it('should list only active sessions', () => {
    store.create({
      threadTs: '1700000000.000010',
      dmChannelId: 'C1',
      projectPath: '/p',
      name: 'Active 1',
      model: 'sonnet',
    });
    const s2 = store.create({
      threadTs: '1700000000.000011',
      dmChannelId: 'C2',
      projectPath: '/p',
      name: 'To End',
      model: 'sonnet',
    });
    store.create({
      threadTs: '1700000000.000012',
      dmChannelId: 'C3',
      projectPath: '/p',
      name: 'Active 2',
      model: 'sonnet',
    });

    store.end(s2.sessionId);

    const active = store.getActiveSessions();
    expect(active).toHaveLength(2);
    expect(active.every((s) => s.status === 'active')).toBe(true);
  });
});
