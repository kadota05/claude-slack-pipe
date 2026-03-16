import { describe, it, expect } from 'vitest';
import type {
  SessionState,
  SessionStartParams,
  ControlMessage,
  StdinUserMessage,
  StdinMessage,
  StreamEvent,
  ResultEvent,
  SystemInitEvent,
} from '../src/types.js';

describe('SessionState type', () => {
  it('should accept all valid states', () => {
    const states: SessionState[] = [
      'not_started', 'starting', 'idle', 'processing', 'ending', 'dead',
    ];
    expect(states).toHaveLength(6);
  });
});

describe('SessionStartParams type', () => {
  it('should accept valid params', () => {
    const params: SessionStartParams = {
      sessionId: 'sess-123',
      model: 'opus',
      projectPath: '/tmp/project',
      budgetUsd: 5.0,
      isResume: false,
    };
    expect(params.sessionId).toBe('sess-123');
    expect(params.isResume).toBe(false);
  });
});

describe('StdinMessage types', () => {
  it('should accept ControlMessage', () => {
    const msg: ControlMessage = {
      type: 'control',
      subtype: 'interrupt',
    };
    expect(msg.type).toBe('control');
    expect(msg.subtype).toBe('interrupt');
  });

  it('should accept StdinUserMessage', () => {
    const msg: StdinUserMessage = {
      type: 'user_message',
      content: 'hello',
    };
    expect(msg.type).toBe('user_message');
  });

  it('should accept both as StdinMessage union', () => {
    const messages: StdinMessage[] = [
      { type: 'control', subtype: 'keep_alive' },
      { type: 'user_message', content: 'test' },
    ];
    expect(messages).toHaveLength(2);
  });
});

describe('StreamEvent types', () => {
  it('should accept a generic StreamEvent', () => {
    const event: StreamEvent = {
      type: 'assistant',
      subtype: 'text',
    };
    expect(event.type).toBe('assistant');
  });

  it('should accept ResultEvent', () => {
    const event: ResultEvent = {
      type: 'result',
      result: 'done',
      total_cost_usd: 0.05,
      duration_ms: 1200,
      usage: { input_tokens: 100, output_tokens: 50 },
      session_id: 'sess-123',
    };
    expect(event.type).toBe('result');
    expect(event.total_cost_usd).toBe(0.05);
  });

  it('should accept SystemInitEvent', () => {
    const event: SystemInitEvent = {
      type: 'system',
      subtype: 'init',
      session_id: 'sess-456',
    };
    expect(event.type).toBe('system');
    expect(event.subtype).toBe('init');
  });
});
