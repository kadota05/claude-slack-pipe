// src/bridge/persistent-session.ts
import { EventEmitter } from 'node:events';
import { spawn, type ChildProcess } from 'node:child_process';
import { logger } from '../utils/logger.js';
import type {
  SessionStartParams,
  SessionState,
  StdinMessage,
  ControlMessage,
  StreamEvent,
} from '../types.js';

const IDLE_TIMEOUT_MS = 10 * 60 * 1000;
const KILL_GRACE_MS = 5_000;

export class PersistentSession extends EventEmitter {
  readonly sessionId: string;
  private _state: SessionState = 'not_started';
  private process: ChildProcess | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private killTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly params: SessionStartParams;
  private stdoutBuffer = '';

  constructor(params: SessionStartParams) {
    super();
    this.sessionId = params.sessionId;
    this.params = params;
  }

  get state(): SessionState {
    return this._state;
  }

  spawn(): void {
    if (this._state !== 'not_started' && this._state !== 'dead') {
      throw new Error(`Cannot spawn in state: ${this._state}`);
    }
    this.transition('starting');

    const executable = process.env.CLAUDE_EXECUTABLE || 'claude';
    const args = this.buildArgs();

    logger.info(`Spawning persistent session ${this.sessionId}`, { args: args.join(' ') });

    this.process = spawn(executable, args, {
      cwd: this.params.projectPath,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    this.process.stdout!.on('data', (chunk: Buffer) => this.handleStdout(chunk));
    this.process.stderr!.on('data', (chunk: Buffer) => {
      logger.debug(`[${this.sessionId}] stderr: ${chunk.toString()}`);
    });
    this.process.on('exit', (code, signal) => this.handleExit(code, signal));
    this.process.on('error', (err) => this.handleProcessError(err));
  }

  sendPrompt(prompt: string): void {
    if (this._state !== 'idle') {
      throw new Error(`Cannot send prompt in state: ${this._state}`);
    }
    this.clearIdleTimer();
    this.writeStdin({ type: 'user_message', content: prompt });
    this.transition('processing');
  }

  sendControl(msg: ControlMessage): void {
    if (!this.process || this.process.stdin!.destroyed) {
      logger.warn(`Cannot send control to ${this.sessionId}: no active process`);
      return;
    }
    this.writeStdin(msg);
  }

  end(): void {
    if (this._state === 'dead' || this._state === 'ending' || this._state === 'not_started') {
      return;
    }
    this.clearIdleTimer();
    this.transition('ending');
    if (this.process && !this.process.stdin!.destroyed) {
      this.process.stdin!.end();
    }
  }

  kill(): void {
    if (!this.process) return;
    this.clearIdleTimer();
    this.process.kill('SIGTERM');
    this.killTimer = setTimeout(() => {
      if (this.process) {
        this.process.kill('SIGKILL');
      }
    }, KILL_GRACE_MS);
  }

  private buildArgs(): string[] {
    const args = [
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--model', this.params.model,
      '--max-budget-usd', String(this.params.budgetUsd),
    ];

    if (this.params.isResume) {
      args.push('-r', this.params.sessionId);
    } else {
      args.push('--session-id', this.params.sessionId);
    }

    return args;
  }

  private writeStdin(msg: StdinMessage): void {
    if (this.process && !this.process.stdin!.destroyed) {
      this.process.stdin!.write(JSON.stringify(msg) + '\n');
    }
  }

  private handleStdout(chunk: Buffer): void {
    this.stdoutBuffer += chunk.toString();
    const lines = this.stdoutBuffer.split('\n');
    this.stdoutBuffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const event: StreamEvent = JSON.parse(line);
        this.handleEvent(event);
      } catch {
        logger.debug(`[${this.sessionId}] non-JSON stdout: ${line}`);
      }
    }
  }

  private handleEvent(event: StreamEvent): void {
    this.emit('message', event);

    if (event.type === 'system' && event.subtype === 'init') {
      this.transition('idle');
      this.startIdleTimer();
    } else if (event.type === 'result') {
      this.transition('idle');
      this.startIdleTimer();
    }
  }

  private handleExit(code: number | null, signal: string | null): void {
    if (this.killTimer) {
      clearTimeout(this.killTimer);
      this.killTimer = null;
    }
    this.clearIdleTimer();

    const wasProcessing = this._state === 'processing';
    this.transition('dead');

    if (wasProcessing || (code !== null && code !== 0)) {
      this.emit('error', new Error(
        `Process exited unexpectedly: code=${code}, signal=${signal}`
      ));
    }

    this.process = null;
  }

  private handleProcessError(err: Error): void {
    logger.error(`[${this.sessionId}] process error`, { error: err.message });
    this.emit('error', err);
  }

  private transition(to: SessionState): void {
    const from = this._state;
    this._state = to;
    this.emit('stateChange', from, to);
    logger.debug(`[${this.sessionId}] ${from} → ${to}`);
  }

  private startIdleTimer(): void {
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      logger.info(`[${this.sessionId}] idle timeout — ending session`);
      this.end();
    }, IDLE_TIMEOUT_MS);
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }
}
