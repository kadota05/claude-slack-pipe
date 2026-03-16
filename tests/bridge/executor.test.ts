import { describe, it, expect } from 'vitest';
import { buildClaudeArgs, parseClaudeResult } from '../../src/bridge/executor.js';
import type { BuildArgsSession } from '../../src/bridge/executor.js';
import { ExecutionError } from '../../src/utils/errors.js';

const baseSession: BuildArgsSession = {
  sessionId: 'sess-123',
  projectPath: '/home/user/myproject',
  model: 'sonnet',
};

describe('buildClaudeArgs', () => {
  it('should build args for a new session', () => {
    const args = buildClaudeArgs(baseSession, false);

    expect(args).toContain('-p');
    expect(args).toContain('--output-format');
    expect(args).toContain('json');
    expect(args).toContain('--model');
    expect(args).toContain('claude-sonnet-4-20250514');
    expect(args).not.toContain('--resume');
  });

  it('should build args for a resumed session', () => {
    const args = buildClaudeArgs(baseSession, true);

    expect(args).toContain('--resume');
    expect(args).toContain('sess-123');
  });

  it('should include budget when specified', () => {
    const args = buildClaudeArgs(baseSession, false, { budgetUsd: 5.0 });

    expect(args).toContain('--max-turns-cost');
    expect(args).toContain('5');
  });

  it('should map model names correctly', () => {
    const opusArgs = buildClaudeArgs({ ...baseSession, model: 'opus' }, false);
    expect(opusArgs).toContain('claude-opus-4-20250514');

    const haikuArgs = buildClaudeArgs({ ...baseSession, model: 'haiku' }, false);
    expect(haikuArgs).toContain('claude-haiku-3-20250314');

    const sonnetArgs = buildClaudeArgs({ ...baseSession, model: 'sonnet' }, false);
    expect(sonnetArgs).toContain('claude-sonnet-4-20250514');
  });
});

describe('parseClaudeResult', () => {
  it('should parse valid success output', () => {
    const json = JSON.stringify({
      type: 'result',
      subtype: 'success',
      result: 'Hello from Claude',
      session_id: 'sess-abc',
      total_cost_usd: 0.05,
      duration_ms: 1234,
      stop_reason: 'end_turn',
    });

    const result = parseClaudeResult(json);

    expect(result.type).toBe('result');
    expect(result.subtype).toBe('success');
    expect(result.result).toBe('Hello from Claude');
    expect(result.session_id).toBe('sess-abc');
    expect(result.total_cost_usd).toBe(0.05);
    expect(result.duration_ms).toBe(1234);
    expect(result.stop_reason).toBe('end_turn');
  });

  it('should parse error output', () => {
    const json = JSON.stringify({
      type: 'result',
      subtype: 'error',
      result: 'Something went wrong',
      session_id: 'sess-err',
      total_cost_usd: 0,
      duration_ms: 100,
      stop_reason: 'error',
    });

    const result = parseClaudeResult(json);

    expect(result.subtype).toBe('error');
    expect(result.result).toBe('Something went wrong');
  });

  it('should throw on invalid JSON', () => {
    expect(() => parseClaudeResult('not json {')).toThrow(ExecutionError);
  });

  it('should throw on missing required fields', () => {
    const incomplete = JSON.stringify({
      type: 'result',
      // missing session_id and result
    });

    expect(() => parseClaudeResult(incomplete)).toThrow(ExecutionError);
  });
});
