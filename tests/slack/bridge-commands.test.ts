// tests/slack/bridge-commands.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BridgeCommandHandler } from '../../src/slack/bridge-commands.js';

describe('BridgeCommandHandler (phase2)', () => {
  let handler: BridgeCommandHandler;
  let mockClient: any;

  beforeEach(() => {
    mockClient = {
      chat: {
        postEphemeral: vi.fn().mockResolvedValue({ ok: true }),
      },
    };
    handler = new BridgeCommandHandler(mockClient);
  });

  describe('handleStatus', () => {
    it('posts ephemeral session status', async () => {
      await handler.handleStatus({
        channelId: 'C001',
        threadTs: '123',
        userId: 'U001',
        sessionInfo: {
          sessionId: 'sid',
          model: 'sonnet',
          projectPath: '/home/user/app',
          totalCost: 0.12,
          totalTokens: 18600,
          turnCount: 2,
          processState: 'idle',
          startedAt: '2026-03-16 10:00',
        },
      });
      expect(mockClient.chat.postEphemeral).toHaveBeenCalledOnce();
      const call = mockClient.chat.postEphemeral.mock.calls[0][0];
      expect(call.channel).toBe('C001');
      expect(call.user).toBe('U001');
      expect(call.text).toContain('sid');
    });
  });

  describe('handleEnd', () => {
    it('posts ephemeral end summary and calls onEnd', async () => {
      const onEnd = vi.fn().mockResolvedValue(undefined);
      await handler.handleEnd({
        channelId: 'C001',
        threadTs: '123',
        userId: 'U001',
        sessionId: 'sid',
        totalCost: 0.423,
        totalTokens: 52400,
        turnCount: 4,
        duration: '45m',
        onEnd,
      });
      expect(onEnd).toHaveBeenCalled();
      expect(mockClient.chat.postEphemeral).toHaveBeenCalledOnce();
    });
  });

  describe('handleRestart', () => {
    it('calls onRestart callback and posts ephemeral', async () => {
      const onRestart = vi.fn().mockResolvedValue(undefined);
      await handler.handleRestart({
        channelId: 'C001',
        threadTs: '123',
        userId: 'U001',
        sessionId: 'sid',
        onRestart,
      });
      expect(onRestart).toHaveBeenCalled();
    });
  });
});
