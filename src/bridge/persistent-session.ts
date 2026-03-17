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
const KEEP_ALIVE_INTERVAL_MS = 5 * 60 * 1000;
const KILL_GRACE_MS = 5_000;

export class PersistentSession extends EventEmitter {
  readonly sessionId: string;
  private _state: SessionState = 'not_started';
  private process: ChildProcess | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private keepAliveTimer: ReturnType<typeof setInterval> | null = null;
  private killTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly params: SessionStartParams;
  private stdoutBuffer = '';
  private _hasPendingInitialPrompt = false;
  private _interrupted = false;
  private _killedForModelChange = false;

  constructor(params: SessionStartParams) {
    super();
    this.sessionId = params.sessionId;
    this.params = params;
  }

  get state(): SessionState {
    return this._state;
  }

  get model(): string {
    return this.params.model;
  }

  /** True if the session was intentionally interrupted (not crashed). */
  get wasInterrupted(): boolean {
    return this._interrupted;
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
      env: (() => {
        const env = { ...process.env };
        // Remove nesting detection vars so Claude CLI doesn't refuse to start
        delete env.CLAUDECODE;
        delete env.CLAUDE_CODE_ENTRYPOINT;
        return env;
      })(),
    });

    this.process.stdout!.on('data', (chunk: Buffer) => this.handleStdout(chunk));
    this.process.stderr!.on('data', (chunk: Buffer) => {
      logger.debug(`[${this.sessionId}] stderr: ${chunk.toString()}`);
    });
    this.process.on('exit', (code, signal) => this.handleExit(code, signal));
    this.process.on('error', (err) => this.handleProcessError(err));
  }

  /**
   * Send prompt to an idle session (normal turn).
   */
  sendPrompt(prompt: string): void {
    if (this._state !== 'idle') {
      throw new Error(`Cannot send prompt in state: ${this._state}`);
    }
    this.clearIdleTimer();
    this.writeStdin({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'text', text: prompt }],
      },
    });
    this.transition('processing');
  }

  /**
   * Send the first prompt while the session is still starting.
   * Claude CLI stream-json mode requires a user message on stdin
   * before it emits the system init event.
   */
  sendInitialPrompt(prompt: string): void {
    if (this._state !== 'starting') {
      throw new Error(`sendInitialPrompt only valid in starting state, got: ${this._state}`);
    }
    this._hasPendingInitialPrompt = true;
    this.writeStdin({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'text', text: prompt }],
      },
    });
    logger.info(`[${this.sessionId}] initial prompt written to stdin (before init)`);
  }

  sendControl(msg: ControlMessage): void {
    if (!this.process || this.process.stdin!.destroyed) {
      logger.warn(`Cannot send control to ${this.sessionId}: no active process`);
      return;
    }
    this.writeStdin(msg);
  }

  /**
   * Interrupt the current turn by sending SIGINT to the CLI process.
   * This mirrors pressing Escape/Ctrl+C in the interactive CLI.
   */
  sendInterrupt(): void {
    if (!this.process) {
      logger.warn(`Cannot interrupt ${this.sessionId}: no active process`);
      return;
    }
    if (this._state !== 'processing') {
      logger.warn(`Cannot interrupt ${this.sessionId}: not processing (state=${this._state})`);
      return;
    }
    this._interrupted = true;
    logger.info(`[${this.sessionId}] Sending SIGINT to interrupt current turn`);
    this.process.kill('SIGINT');
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

  /**
   * Kill the session, optionally marking it as a model-change restart
   * so that handleExit does not emit an error event.
   */
  kill(reason?: 'model_change'): void {
    if (!this.process) return;
    if (reason === 'model_change') {
      this._killedForModelChange = true;
    }
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
      '--replay-user-messages',
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
    logger.info(`[${this.sessionId}] event: type=${event.type}, subtype=${event.subtype || 'none'}`);
    this.emit('message', event);

    if (event.type === 'system' && event.subtype === 'init') {
      if (this._hasPendingInitialPrompt) {
        // Initial prompt was already written — CLI is processing it.
        // Skip idle and go straight to processing so new messages get queued.
        this._hasPendingInitialPrompt = false;
        logger.info(`[${this.sessionId}] system init received with pending prompt, transitioning to processing`);
        this.transition('processing');
      } else {
        logger.info(`[${this.sessionId}] system init received, transitioning to idle`);
        this.transition('idle');
        this.startIdleTimer();
      }
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

    if (this._killedForModelChange) {
      // Intentional kill for model change — don't emit error
      logger.info(`[${this.sessionId}] Process exited due to model change`);
    } else if (this._interrupted) {
      // Intentional interrupt via 🔴 reaction — don't emit error
      logger.info(`[${this.sessionId}] Process exited due to user interrupt`);
    } else if (wasProcessing || (code !== null && code !== 0)) {
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
    this.keepAliveTimer = setInterval(() => {
      this.writeStdin({ type: 'control', subtype: 'keep_alive' });
    }, KEEP_ALIVE_INTERVAL_MS);
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = null;
    }
  }
}
