// tests/bridge/session-coordinator-limits.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { SessionCoordinator } from '../../src/bridge/session-coordinator.js';

vi.mock('../../src/bridge/persistent-session.js', () => {
  return {
    PersistentSession: vi.fn().mockImplementation(function (params: any) {
      const emitter = new EventEmitter() as any;
      emitter.sessionId = params.sessionId;
      emitter.model = params.model;
      emitter._state = 'not_started';
      Object.defineProperty(emitter, 'state', { get: () => emitter._state });
      emitter.spawn = vi.fn(() => {
        emitter._state = 'idle';
        emitter.emit('stateChange', 'not_started', 'idle');
      });
      emitter.sendPrompt = vi.fn();
      emitter.sendControl = vi.fn();
      emitter.end = vi.fn(() => {
        emitter._state = 'dead';
        emitter.emit('stateChange', 'idle', 'dead');
      });
      emitter.kill = vi.fn();
      return emitter;
    }),
  };
});

describe('SessionCoordinator limits', () => {
  let coordinator: SessionCoordinator;

  beforeEach(() => {
    coordinator = new SessionCoordinator({ maxAlivePerUser: 1, maxAliveGlobal: 3 });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('enforces per-user limit (default 1)', async () => {
    await coordinator.getOrCreateSession({
      sessionId: 's1', userId: 'u1', model: 'sonnet', projectPath: '/a', isResume: false,
    });
    expect(coordinator.getAliveCountForUser('u1')).toBe(1);

    await coordinator.getOrCreateSession({
      sessionId: 's2', userId: 'u1', model: 'sonnet', projectPath: '/b', isResume: false,
    });
    // s1 should have been ended, s2 is alive
    expect(coordinator.getAliveCountForUser('u1')).toBe(1);
  });

  it('respects maxAliveOverride per session', async () => {
    await coordinator.getOrCreateSession({
      sessionId: 's1', userId: 'ch1', model: 'sonnet', projectPath: '/a', isResume: false, maxAliveOverride: 3,
    });
    await coordinator.getOrCreateSession({
      sessionId: 's2', userId: 'ch1', model: 'sonnet', projectPath: '/b', isResume: false, maxAliveOverride: 3,
    });
    await coordinator.getOrCreateSession({
      sessionId: 's3', userId: 'ch1', model: 'sonnet', projectPath: '/c', isResume: false, maxAliveOverride: 3,
    });

    expect(coordinator.getAliveCountForUser('ch1')).toBe(3);
  });

  it('enforces global limit', async () => {
    await coordinator.getOrCreateSession({
      sessionId: 's1', userId: 'u1', model: 'sonnet', projectPath: '/a', isResume: false,
    });
    await coordinator.getOrCreateSession({
      sessionId: 's2', userId: 'u2', model: 'sonnet', projectPath: '/b', isResume: false,
    });
    await coordinator.getOrCreateSession({
      sessionId: 's3', userId: 'u3', model: 'sonnet', projectPath: '/c', isResume: false,
    });

    expect(coordinator.getAliveCount()).toBe(3);

    // 4th session should trigger global enforcement
    await coordinator.getOrCreateSession({
      sessionId: 's4', userId: 'u4', model: 'sonnet', projectPath: '/d', isResume: false,
    });

    expect(coordinator.getAliveCount()).toBeLessThanOrEqual(3);
  });

  it('cleans up dead entries from map', async () => {
    const s1 = await coordinator.getOrCreateSession({
      sessionId: 's1', userId: 'u1', model: 'sonnet', projectPath: '/a', isResume: false,
    });

    // Manually kill it
    s1.end();

    // Create new session — cleanupDead should remove s1
    await coordinator.getOrCreateSession({
      sessionId: 's2', userId: 'u2', model: 'sonnet', projectPath: '/b', isResume: false,
    });

    // s1 should be cleaned up
    expect(coordinator.getSession('s1')).toBeUndefined();
    expect(coordinator.getSession('s2')).toBeDefined();
  });
});
