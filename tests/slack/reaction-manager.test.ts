import { describe, it, expect, vi } from 'vitest';
import { ReactionManager } from '../../src/slack/reaction-manager.js';

describe('ReactionManager', () => {
  function createMockClient() {
    return {
      reactions: {
        add: vi.fn().mockResolvedValue({ ok: true }),
        remove: vi.fn().mockResolvedValue({ ok: true }),
      },
    };
  }

  it('should add processing reaction', async () => {
    const client = createMockClient();
    const rm = new ReactionManager(client as any);

    await rm.addProcessing('D123', '1.000');

    expect(client.reactions.add).toHaveBeenCalledWith({
      channel: 'D123',
      timestamp: '1.000',
      name: 'hourglass_flowing_sand',
    });
  });

  it('should replace processing with success', async () => {
    const client = createMockClient();
    const rm = new ReactionManager(client as any);

    await rm.replaceWithSuccess('D123', '1.000');

    expect(client.reactions.remove).toHaveBeenCalledWith({
      channel: 'D123',
      timestamp: '1.000',
      name: 'hourglass_flowing_sand',
    });
    expect(client.reactions.add).toHaveBeenCalledWith({
      channel: 'D123',
      timestamp: '1.000',
      name: 'white_check_mark',
    });
  });

  it('should replace processing with error', async () => {
    const client = createMockClient();
    const rm = new ReactionManager(client as any);

    await rm.replaceWithError('D123', '1.000');

    expect(client.reactions.remove).toHaveBeenCalledWith({
      channel: 'D123',
      timestamp: '1.000',
      name: 'hourglass_flowing_sand',
    });
    expect(client.reactions.add).toHaveBeenCalledWith({
      channel: 'D123',
      timestamp: '1.000',
      name: 'x',
    });
  });

  it('should not throw on reaction api errors', async () => {
    const client = createMockClient();
    client.reactions.add.mockRejectedValue(new Error('already_reacted'));
    const rm = new ReactionManager(client as any);

    await expect(rm.addProcessing('D123', '1.000')).resolves.not.toThrow();
  });
});
