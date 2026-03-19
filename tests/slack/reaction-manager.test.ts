import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ReactionManager } from '../../src/slack/reaction-manager.js';

function createMockClient() {
  return {
    reactions: {
      add: vi.fn().mockResolvedValue({ ok: true }),
      remove: vi.fn().mockResolvedValue({ ok: true }),
    },
  };
}

describe('ReactionManager (phase2)', () => {
  let rm: ReactionManager;
  let client: ReturnType<typeof createMockClient>;

  beforeEach(() => {
    vi.useFakeTimers();
    client = createMockClient();
    rm = new ReactionManager(client as any);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('addSpawning', () => {
    it('adds hourglass_flowing_sand reaction', async () => {
      await rm.addSpawning('C001', '123');
      expect(client.reactions.add).toHaveBeenCalledWith({
        channel: 'C001', timestamp: '123', name: 'hourglass_flowing_sand',
      });
    });
  });

  describe('replaceWithProcessing', () => {
    it('removes hourglass and adds brain', async () => {
      await rm.replaceWithProcessing('test-session', 'C001', '123');
      expect(client.reactions.remove).toHaveBeenCalledWith({
        channel: 'C001', timestamp: '123', name: 'hourglass_flowing_sand',
      });
      expect(client.reactions.add).toHaveBeenCalledWith({
        channel: 'C001', timestamp: '123', name: 'brain',
      });
    });
  });

  describe('replaceWithDone', () => {
    it('removes brain and adds check mark', async () => {
      await rm.replaceWithDone('test-session', 'C001', '123');
      expect(client.reactions.remove).toHaveBeenCalledWith({
        channel: 'C001', timestamp: '123', name: 'brain',
      });
      expect(client.reactions.add).toHaveBeenCalledWith({
        channel: 'C001', timestamp: '123', name: 'white_check_mark',
      });
    });

    it('does NOT auto-remove check mark after 3 seconds', async () => {
      await rm.replaceWithDone('test-session', 'C001', '123');
      client.reactions.remove.mockClear();
      vi.advanceTimersByTime(5000);
      await vi.runAllTimersAsync();
      expect(client.reactions.remove).not.toHaveBeenCalledWith({
        channel: 'C001', timestamp: '123', name: 'white_check_mark',
      });
    });
  });

  describe('replaceWithProcessing clears previous checkmark', () => {
    it('removes previous checkmark when starting new processing', async () => {
      await rm.replaceWithDone('test-session', 'C001', '100');
      client.reactions.remove.mockClear();
      client.reactions.add.mockClear();
      await rm.replaceWithProcessing('test-session', 'C001', '200');
      expect(client.reactions.remove).toHaveBeenCalledWith({
        channel: 'C001', timestamp: '100', name: 'white_check_mark',
      });
      expect(client.reactions.add).toHaveBeenCalledWith({
        channel: 'C001', timestamp: '200', name: 'brain',
      });
    });

    it('works when there is no previous checkmark', async () => {
      await rm.replaceWithProcessing('test-session', 'C001', '200');
      expect(client.reactions.add).toHaveBeenCalledWith({
        channel: 'C001', timestamp: '200', name: 'brain',
      });
    });
  });

  describe('addQueued', () => {
    it('adds hourglass_flowing_sand reaction', async () => {
      await rm.addQueued('C001', '123');
      expect(client.reactions.add).toHaveBeenCalledWith({
        channel: 'C001', timestamp: '123', name: 'hourglass_flowing_sand',
      });
    });
  });

  describe('session-scoped lastDone', () => {
    it('replaceWithProcessing only clears checkmark from same session', async () => {
      await rm.replaceWithDone('session-A', 'C001', '100');
      client.reactions.remove.mockClear();
      client.reactions.add.mockClear();
      await rm.replaceWithProcessing('session-B', 'C001', '200');
      expect(client.reactions.remove).not.toHaveBeenCalledWith({
        channel: 'C001', timestamp: '100', name: 'white_check_mark',
      });
    });

    it('replaceWithProcessing clears checkmark from same session', async () => {
      await rm.replaceWithDone('session-A', 'C001', '100');
      client.reactions.remove.mockClear();
      client.reactions.add.mockClear();
      await rm.replaceWithProcessing('session-A', 'C001', '200');
      expect(client.reactions.remove).toHaveBeenCalledWith({
        channel: 'C001', timestamp: '100', name: 'white_check_mark',
      });
    });

    it('cleanupSession removes session entry from map', async () => {
      await rm.replaceWithDone('session-A', 'C001', '100');
      rm.cleanupSession('session-A');
      client.reactions.remove.mockClear();
      await rm.replaceWithProcessing('session-A', 'C001', '200');
      expect(client.reactions.remove).not.toHaveBeenCalledWith({
        channel: 'C001', timestamp: '100', name: 'white_check_mark',
      });
    });
  });
});
