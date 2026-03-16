import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BridgeCommandHandler } from '../../src/slack/bridge-commands.js';
import { SessionStore } from '../../src/store/session-store.js';

describe('BridgeCommandHandler', () => {
  let sessionStore: SessionStore;
  let mockClient: any;
  let handler: BridgeCommandHandler;

  beforeEach(() => {
    sessionStore = new SessionStore();
    mockClient = {
      chat: {
        postMessage: vi.fn().mockResolvedValue({ ok: true }),
        update: vi.fn().mockResolvedValue({ ok: true }),
      },
    };
    handler = new BridgeCommandHandler(sessionStore, mockClient);
  });

  describe('handleHelp', () => {
    it('should post help message', async () => {
      await handler.handleHelp('D123', '1.000');

      expect(mockClient.chat.postMessage).toHaveBeenCalledTimes(1);
      const args = mockClient.chat.postMessage.mock.calls[0][0];
      expect(args.thread_ts).toBe('1.000');
      expect(args.text).toContain('cc /');
    });
  });

  describe('handleStatus', () => {
    it('should show session status when session exists', async () => {
      sessionStore.create({
        threadTs: '1.000',
        dmChannelId: 'D123',
        projectPath: '/dev/app',
        name: 'test session',
        model: 'sonnet',
      });

      await handler.handleStatus('D123', '1.000');

      expect(mockClient.chat.postMessage).toHaveBeenCalledTimes(1);
      const args = mockClient.chat.postMessage.mock.calls[0][0];
      expect(args.text).toContain('test session');
    });

    it('should show no active session message', async () => {
      await handler.handleStatus('D123', '1.000');

      expect(mockClient.chat.postMessage).toHaveBeenCalledTimes(1);
      const args = mockClient.chat.postMessage.mock.calls[0][0];
      expect(args.text).toContain('No active session');
    });
  });

  describe('handleEnd', () => {
    it('should end active session', async () => {
      sessionStore.create({
        threadTs: '1.000',
        dmChannelId: 'D123',
        projectPath: '/dev/app',
        name: 'test session',
        model: 'sonnet',
      });

      await handler.handleEnd('D123', '1.000');

      const session = sessionStore.findByThreadTs('1.000');
      expect(session?.status).toBe('ended');
      expect(mockClient.chat.postMessage).toHaveBeenCalledTimes(1);
    });

    it('should show error when no session to end', async () => {
      await handler.handleEnd('D123', '1.000');

      expect(mockClient.chat.postMessage).toHaveBeenCalledTimes(1);
      const args = mockClient.chat.postMessage.mock.calls[0][0];
      expect(args.text).toContain('No active session');
    });
  });
});
