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
      await rm.replaceWithProcessing('C001', '123');
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
      await rm.replaceWithDone('C001', '123');
      expect(client.reactions.remove).toHaveBeenCalledWith({
        channel: 'C001', timestamp: '123', name: 'brain',
      });
      expect(client.reactions.add).toHaveBeenCalledWith({
        channel: 'C001', timestamp: '123', name: 'white_check_mark',
      });
    });

    it('auto-removes check mark after 3 seconds', async () => {
      await rm.replaceWithDone('C001', '123');
      vi.advanceTimersByTime(3000);
      // wait for promise
      await vi.runAllTimersAsync();
      expect(client.reactions.remove).toHaveBeenCalledWith({
        channel: 'C001', timestamp: '123', name: 'white_check_mark',
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
});
