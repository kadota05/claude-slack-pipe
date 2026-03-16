import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import type { ClaudeResultOutput, ModelChoice } from '../types.js';
import { ExecutionError } from '../utils/errors.js';
import { sanitizeOutput } from '../utils/sanitizer.js';
import { logger } from '../utils/logger.js';

// ============================================================
// Pure functions
// ============================================================

export interface BuildArgsSession {
  sessionId: string;
  projectPath: string;
  model: ModelChoice;
}

export interface BuildArgsOptions {
  budgetUsd?: number;
}

const MODEL_MAP: Record<ModelChoice, string> = {
  opus: 'claude-opus-4-20250514',
  sonnet: 'claude-sonnet-4-20250514',
  haiku: 'claude-haiku-3-20250314',
};

export function buildClaudeArgs(
  session: BuildArgsSession,
  isResume: boolean,
  opts?: BuildArgsOptions,
): string[] {
  const args: string[] = ['-p', '--output-format', 'json'];

  if (isResume) {
    args.push('--resume', session.sessionId);
  }

  args.push('--model', MODEL_MAP[session.model]);

  if (opts?.budgetUsd !== undefined) {
    args.push('--max-turns-cost', String(opts.budgetUsd));
  }

  return args;
}

export function parseClaudeResult(stdout: string): ClaudeResultOutput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new ExecutionError('Failed to parse claude output as JSON', {
      sessionId: 'unknown',
      stderr: `Invalid JSON: ${stdout.slice(0, 200)}`,
    });
  }

  const obj = parsed as Record<string, unknown>;
  if (obj.type !== 'result' || typeof obj.session_id !== 'string' || typeof obj.result !== 'string') {
    throw new ExecutionError('Claude output missing required fields', {
      sessionId: String(obj.session_id ?? 'unknown'),
      stderr: `Unexpected shape: ${JSON.stringify(obj).slice(0, 200)}`,
    });
  }

  return {
    type: 'result',
    subtype: (obj.subtype as 'success' | 'error') ?? 'success',
    result: obj.result as string,
    session_id: obj.session_id as string,
    total_cost_usd: (obj.total_cost_usd as number) ?? 0,
    duration_ms: (obj.duration_ms as number) ?? 0,
    stop_reason: (obj.stop_reason as string) ?? 'end_turn',
  };
}

// ============================================================
// Executor class
// ============================================================

export interface ExecutorConfig {
  claudeExecutable: string;
}

export interface ExecuteResult {
  output: ClaudeResultOutput;
  rawStdout: string;
  rawStderr: string;
}

export class Executor {
  private readonly config: ExecutorConfig;

  constructor(config: ExecutorConfig) {
    this.config = config;
  }

  spawn(
    session: BuildArgsSession,
    prompt: string,
    isResume: boolean,
    opts?: BuildArgsOptions,
  ): { process: ChildProcess; result: Promise<ExecuteResult> } {
    const args = buildClaudeArgs(session, isResume, opts);

    logger.debug('Spawning claude process', {
      executable: this.config.claudeExecutable,
      args,
      cwd: session.projectPath,
    });

    const child = spawn(this.config.claudeExecutable, args, {
      cwd: session.projectPath,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    const result = new Promise<ExecuteResult>((resolve, reject) => {
      let stdout = '';
      let stderr = '';

      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });

      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      child.on('error', (err) => {
        reject(
          new ExecutionError(`Failed to spawn claude: ${err.message}`, {
            sessionId: session.sessionId,
            stderr: sanitizeOutput(stderr),
          }),
        );
      });

      child.on('exit', (code) => {
        const sanitizedStderr = sanitizeOutput(stderr);

        if (code !== 0) {
          reject(
            new ExecutionError(`claude exited with code ${code}`, {
              sessionId: session.sessionId,
              exitCode: code,
              stderr: sanitizedStderr,
            }),
          );
          return;
        }

        try {
          const output = parseClaudeResult(stdout);
          resolve({
            output,
            rawStdout: stdout,
            rawStderr: sanitizedStderr,
          });
        } catch (err) {
          reject(err);
        }
      });

      // Send prompt via stdin
      child.stdin?.write(prompt);
      child.stdin?.end();
    });

    return { process: child, result };
  }
}
