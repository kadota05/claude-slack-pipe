// tests/bridge/session-coordinator.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { SessionCoordinator } from '../../src/bridge/session-coordinator.js';

vi.mock('../../src/bridge/persistent-session.js', () => {
  return {
    PersistentSession: vi.fn().mockImplementation(function (params: any) {
      const emitter = new EventEmitter() as any;
      emitter.sessionId = params.sessionId;
      emitter._state = 'not_started';
      Object.defineProperty(emitter, 'state', { get: () => emitter._state });
      emitter.spawn = vi.fn(() => {
        emitter._state = 'starting';
        setTimeout(() => {
          emitter._state = 'idle';
          emitter.emit('stateChange', 'starting', 'idle');
        }, 10);
      });
      emitter.sendPrompt = vi.fn((prompt) => {
        emitter._state = 'processing';
        emitter.emit('stateChange', 'idle', 'processing');
      });
      emitter.sendControl = vi.fn();
      emitter.end = vi.fn(() => {
        emitter._state = 'ending';
        setTimeout(() => {
          emitter._state = 'dead';
          emitter.emit('stateChange', 'ending', 'dead');
        }, 10);
      });
      emitter.kill = vi.fn();
      return emitter;
    }),
  };
});

describe('SessionCoordinator', () => {
  let coordinator: SessionCoordinator;

  beforeEach(() => {
    vi.useFakeTimers();
    coordinator = new SessionCoordinator({
      maxAlivePerUser: 1,
      maxAliveGlobal: 3,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('creates and starts a session on first message', async () => {
    const session = await coordinator.getOrCreateSession({
      sessionId: 's1',
      userId: 'U001',
      model: 'sonnet',
      projectPath: '/tmp/test',
      isResume: false,
    });
    expect(session).toBeDefined();
    expect(session.spawn).toHaveBeenCalled();
  });

  it('returns existing session for same sessionId', async () => {
    const params = {
      sessionId: 's1',
      userId: 'U001',
      model: 'sonnet',
      projectPath: '/tmp/test',
      isResume: false,
    };
    const s1 = await coordinator.getOrCreateSession(params);
    const s2 = await coordinator.getOrCreateSession(params);
    expect(s1).toBe(s2);
  });

  it('ends previous session when user exceeds maxAlivePerUser', async () => {
    const s1 = await coordinator.getOrCreateSession({
      sessionId: 's1',
      userId: 'U001',
      model: 'sonnet',
      projectPath: '/tmp/test',
      isResume: false,
    });
    vi.advanceTimersByTime(20);

    const s2 = await coordinator.getOrCreateSession({
      sessionId: 's2',
      userId: 'U001',
      model: 'sonnet',
      projectPath: '/tmp/test2',
      isResume: false,
    });
    expect(s1.end).toHaveBeenCalled();
  });

  it('getAliveCount returns correct count', async () => {
    await coordinator.getOrCreateSession({
      sessionId: 's1',
      userId: 'U001',
      model: 'sonnet',
      projectPath: '/tmp/test',
      isResume: false,
    });
    expect(coordinator.getAliveCount()).toBe(1);
  });

  it('broadcasts control message to all alive sessions', async () => {
    const s1 = await coordinator.getOrCreateSession({
      sessionId: 's1',
      userId: 'U001',
      model: 'sonnet',
      projectPath: '/tmp/test',
      isResume: false,
    });
    coordinator.broadcastControl({ type: 'control', subtype: 'set_model', model: 'opus' });
    expect(s1.sendControl).toHaveBeenCalledWith({
      type: 'control', subtype: 'set_model', model: 'opus',
    });
  });

  describe('isAllIdle', () => {
    it('should return true when no sessions exist', () => {
      expect(coordinator.isAllIdle()).toBe(true);
    });

    it('should return true when all sessions are dead or idle', async () => {
      const s1 = await coordinator.getOrCreateSession({
        sessionId: 's1',
        userId: 'U001',
        model: 'sonnet',
        projectPath: '/tmp/test',
        isResume: false,
      });
      // Advance timers so spawn() transitions to idle
      vi.advanceTimersByTime(20);
      expect(s1.state).toBe('idle');
      expect(coordinator.isAllIdle()).toBe(true);
    });

    it('should return false when any session is processing', async () => {
      const s1 = await coordinator.getOrCreateSession({
        sessionId: 's1',
        userId: 'U001',
        model: 'sonnet',
        projectPath: '/tmp/test',
        isResume: false,
      });
      vi.advanceTimersByTime(20);
      s1.sendPrompt('hello');
      expect(s1.state).toBe('processing');
      expect(coordinator.isAllIdle()).toBe(false);
    });

    it('should return false when any session is ending', async () => {
      const s1 = await coordinator.getOrCreateSession({
        sessionId: 's1',
        userId: 'U001',
        model: 'sonnet',
        projectPath: '/tmp/test',
        isResume: false,
      });
      vi.advanceTimersByTime(20);
      s1.end();
      expect(s1.state).toBe('ending');
      expect(coordinator.isAllIdle()).toBe(false);
    });

    it('should return false when any session is starting', async () => {
      const s1 = await coordinator.getOrCreateSession({
        sessionId: 's1',
        userId: 'U001',
        model: 'sonnet',
        projectPath: '/tmp/test',
        isResume: false,
      });
      // spawn() sets state to 'starting' immediately
      expect(s1.state).toBe('starting');
      expect(coordinator.isAllIdle()).toBe(false);
    });
  });

  describe('onIdleCallback', () => {
    it('should call onIdleCallback when session transitions to idle', async () => {
      const callback = vi.fn();
      coordinator.onIdleCallback = callback;
      await coordinator.getOrCreateSession({
        sessionId: 's1',
        userId: 'U001',
        model: 'sonnet',
        projectPath: '/tmp/test',
        isResume: false,
      });
      // Advance timers so spawn() transitions starting -> idle
      vi.advanceTimersByTime(20);
      expect(callback).toHaveBeenCalled();
    });
  });
});
