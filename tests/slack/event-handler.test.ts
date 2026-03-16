import { describe, it, expect, vi } from 'vitest';
import { EventRouter, classifyMessage } from '../../src/slack/event-handler.js';

describe('classifyMessage', () => {
  it('should classify bot messages as ignored', () => {
    expect(classifyMessage({ bot_id: 'B123', text: 'hello' })).toBe('ignore');
  });

  it('should classify messages with subtype as ignored', () => {
    expect(classifyMessage({ subtype: 'message_changed', text: 'hi' })).toBe('ignore');
  });

  it('should classify cc commands as command', () => {
    expect(classifyMessage({ text: 'cc /status' })).toBe('command');
    expect(classifyMessage({ text: 'cc /help' })).toBe('command');
    expect(classifyMessage({ text: 'cc /commit' })).toBe('command');
  });

  it('should classify plain text as prompt', () => {
    expect(classifyMessage({ text: 'implement auth feature' })).toBe('prompt');
  });

  it('should classify empty text as ignore', () => {
    expect(classifyMessage({ text: '' })).toBe('ignore');
    expect(classifyMessage({ text: undefined })).toBe('ignore');
  });
});

describe('EventRouter', () => {
  it('should route prompt to session handler', async () => {
    const sessionHandler = vi.fn().mockResolvedValue(undefined);
    const commandHandler = vi.fn().mockResolvedValue(undefined);

    const router = new EventRouter({
      onPrompt: sessionHandler,
      onCommand: commandHandler,
    });

    await router.handleMessage({
      text: 'implement auth',
      user: 'U123',
      channel: 'D123',
      ts: '1.000',
      thread_ts: '1.000',
    });

    expect(sessionHandler).toHaveBeenCalledWith({
      text: 'implement auth',
      userId: 'U123',
      channelId: 'D123',
      messageTs: '1.000',
      threadTs: '1.000',
    });
    expect(commandHandler).not.toHaveBeenCalled();
  });

  it('should route cc command to command handler', async () => {
    const sessionHandler = vi.fn().mockResolvedValue(undefined);
    const commandHandler = vi.fn().mockResolvedValue(undefined);

    const router = new EventRouter({
      onPrompt: sessionHandler,
      onCommand: commandHandler,
    });

    await router.handleMessage({
      text: 'cc /status',
      user: 'U123',
      channel: 'D123',
      ts: '2.000',
      thread_ts: '1.000',
    });

    expect(commandHandler).toHaveBeenCalled();
    expect(sessionHandler).not.toHaveBeenCalled();
  });

  it('should ignore bot messages', async () => {
    const sessionHandler = vi.fn();
    const commandHandler = vi.fn();

    const router = new EventRouter({
      onPrompt: sessionHandler,
      onCommand: commandHandler,
    });

    await router.handleMessage({
      text: 'hello',
      user: 'U123',
      channel: 'D123',
      ts: '1.000',
      bot_id: 'B123',
    });

    expect(sessionHandler).not.toHaveBeenCalled();
    expect(commandHandler).not.toHaveBeenCalled();
  });
});
