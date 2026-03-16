// tests/bridge/persistent-session.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

import { spawn } from 'node:child_process';
import { PersistentSession } from '../../src/bridge/persistent-session.js';

const mockedSpawn = vi.mocked(spawn);

function createMockProcess() {
  const proc = new EventEmitter() as any;
  proc.pid = 12345;
  proc.kill = vi.fn();
  proc.stdin = { write: vi.fn(), end: vi.fn(), destroyed: false };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  return proc;
}

describe('PersistentSession', () => {
  let session: PersistentSession;
  let mockProc: ReturnType<typeof createMockProcess>;

  beforeEach(() => {
    vi.useFakeTimers();
    mockedSpawn.mockClear();
    mockProc = createMockProcess();
    mockedSpawn.mockReturnValue(mockProc as any);
    session = new PersistentSession({
      sessionId: 'test-session-id',
      model: 'sonnet',
      projectPath: '/tmp/test-project',
      budgetUsd: 1.0,
      isResume: false,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('starts in not_started state', () => {
    expect(session.state).toBe('not_started');
  });

  it('transitions to starting on spawn()', () => {
    session.spawn();
    expect(session.state).toBe('starting');
    expect(mockedSpawn).toHaveBeenCalledOnce();
  });

  it('spawns with correct CLI args', () => {
    session.spawn();
    const args = mockedSpawn.mock.calls[0][1] as string[];
    expect(args).toContain('-p');
    expect(args).toContain('--input-format');
    expect(args).toContain('stream-json');
    expect(args).toContain('--output-format');
    expect(args).toContain('stream-json');
    expect(args).toContain('--verbose');
    expect(args).toContain('--model');
    expect(args).toContain('sonnet');
    expect(args).toContain('--session-id');
    expect(args).toContain('test-session-id');
  });

  it('uses -r flag for resume', () => {
    const resumeSession = new PersistentSession({
      sessionId: 'resume-id',
      model: 'opus',
      projectPath: '/tmp/test',
      budgetUsd: 1.0,
      isResume: true,
    });
    resumeSession.spawn();
    const args = mockedSpawn.mock.calls[0][1] as string[];
    expect(args).toContain('-r');
    expect(args).toContain('resume-id');
    expect(args).not.toContain('--session-id');
  });

  it('transitions to idle on system init event', () => {
    session.spawn();
    const stateChanges: string[] = [];
    session.on('stateChange', (_from: string, to: string) => stateChanges.push(to));

    mockProc.stdout.emit('data', Buffer.from(
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'test-session-id' }) + '\n'
    ));

    expect(session.state).toBe('idle');
    expect(stateChanges).toContain('idle');
  });

  it('transitions to processing on sendPrompt()', () => {
    session.spawn();
    mockProc.stdout.emit('data', Buffer.from(
      JSON.stringify({ type: 'system', subtype: 'init' }) + '\n'
    ));
    expect(session.state).toBe('idle');

    session.sendPrompt('Hello');
    expect(session.state).toBe('processing');
    expect(mockProc.stdin.write).toHaveBeenCalledWith(
      JSON.stringify({ type: 'user_message', content: 'Hello' }) + '\n'
    );
  });

  it('throws if sendPrompt called when not idle', () => {
    session.spawn();
    expect(() => session.sendPrompt('Hello')).toThrow();
  });

  it('transitions back to idle on result event', () => {
    session.spawn();
    mockProc.stdout.emit('data', Buffer.from(
      JSON.stringify({ type: 'system', subtype: 'init' }) + '\n'
    ));
    session.sendPrompt('Hello');
    expect(session.state).toBe('processing');

    mockProc.stdout.emit('data', Buffer.from(
      JSON.stringify({ type: 'result', result: 'Done', total_cost_usd: 0.01 }) + '\n'
    ));
    expect(session.state).toBe('idle');
  });

  it('emits message events for each JSON line', () => {
    session.spawn();
    const messages: any[] = [];
    session.on('message', (msg: any) => messages.push(msg));

    mockProc.stdout.emit('data', Buffer.from(
      JSON.stringify({ type: 'system', subtype: 'init' }) + '\n' +
      JSON.stringify({ type: 'assistant', subtype: 'text', text: 'Hi' }) + '\n'
    ));

    expect(messages).toHaveLength(2);
    expect(messages[0].type).toBe('system');
    expect(messages[1].type).toBe('assistant');
  });

  it('handles idle timeout', () => {
    session.spawn();
    mockProc.stdout.emit('data', Buffer.from(
      JSON.stringify({ type: 'system', subtype: 'init' }) + '\n'
    ));
    expect(session.state).toBe('idle');

    vi.advanceTimersByTime(10 * 60 * 1000);
    expect(mockProc.stdin.end).toHaveBeenCalled();
    expect(session.state).toBe('ending');
  });

  it('resets idle timer on sendPrompt', () => {
    session.spawn();
    mockProc.stdout.emit('data', Buffer.from(
      JSON.stringify({ type: 'system', subtype: 'init' }) + '\n'
    ));

    vi.advanceTimersByTime(9 * 60 * 1000);
    session.sendPrompt('Hello');
    vi.advanceTimersByTime(9 * 60 * 1000);
    expect(session.state).toBe('processing');
  });

  it('transitions to dead on process exit', () => {
    session.spawn();
    mockProc.emit('exit', 0, null);
    expect(session.state).toBe('dead');
  });

  it('transitions to dead on process crash', () => {
    session.spawn();
    mockProc.stdout.emit('data', Buffer.from(
      JSON.stringify({ type: 'system', subtype: 'init' }) + '\n'
    ));
    session.sendPrompt('Hello');

    const errors: Error[] = [];
    session.on('error', (err: Error) => errors.push(err));
    mockProc.emit('exit', 1, null);

    expect(session.state).toBe('dead');
    expect(errors).toHaveLength(1);
  });

  it('end() closes stdin gracefully', () => {
    session.spawn();
    mockProc.stdout.emit('data', Buffer.from(
      JSON.stringify({ type: 'system', subtype: 'init' }) + '\n'
    ));
    session.end();
    expect(mockProc.stdin.end).toHaveBeenCalled();
    expect(session.state).toBe('ending');
  });

  it('kill() sends SIGTERM then SIGKILL after grace period', () => {
    session.spawn();
    session.kill();
    expect(mockProc.kill).toHaveBeenCalledWith('SIGTERM');

    vi.advanceTimersByTime(5000);
    expect(mockProc.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('sendControl() writes control message to stdin', () => {
    session.spawn();
    mockProc.stdout.emit('data', Buffer.from(
      JSON.stringify({ type: 'system', subtype: 'init' }) + '\n'
    ));

    session.sendControl({ type: 'control', subtype: 'set_model', model: 'opus' });
    expect(mockProc.stdin.write).toHaveBeenCalledWith(
      JSON.stringify({ type: 'control', subtype: 'set_model', model: 'opus' }) + '\n'
    );
  });

  it('sends keep_alive control message periodically when idle', () => {
    session.spawn();
    mockProc.stdout.emit('data', Buffer.from(
      JSON.stringify({ type: 'system', subtype: 'init' }) + '\n'
    ));
    expect(session.state).toBe('idle');

    // Advance 5 minutes
    vi.advanceTimersByTime(5 * 60 * 1000);
    expect(mockProc.stdin.write).toHaveBeenCalledWith(
      JSON.stringify({ type: 'control', subtype: 'keep_alive' }) + '\n'
    );
  });

  it('stops keep_alive when processing', () => {
    session.spawn();
    mockProc.stdout.emit('data', Buffer.from(
      JSON.stringify({ type: 'system', subtype: 'init' }) + '\n'
    ));
    session.sendPrompt('Hello');

    // Clear mock calls from sendPrompt
    mockProc.stdin.write.mockClear();

    // Advance 5 minutes - should NOT send keep_alive while processing
    vi.advanceTimersByTime(5 * 60 * 1000);

    // The only write should NOT be a keep_alive
    const keepAliveCalls = mockProc.stdin.write.mock.calls.filter(
      (call: any[]) => call[0].includes('keep_alive')
    );
    expect(keepAliveCalls).toHaveLength(0);
  });
});
