// src/streaming/stream-processor.ts
import { EventEmitter } from 'node:events';
import { logger } from '../utils/logger.js';
import {
  buildToolRunningBlocks,
  buildToolCompletedBlocks,
  buildThinkingBlocks,
  getToolOneLiner,
  getToolResultSummary,
} from './tool-formatter.js';
import type {
  SlackAction,
  StreamProcessorState,
  ToolUseTracker,
} from './types.js';

interface StreamProcessorConfig {
  channel: string;
  threadTs: string;
}

export class StreamProcessor extends EventEmitter {
  private state: StreamProcessorState;
  private readonly config: StreamProcessorConfig;

  constructor(config: StreamProcessorConfig) {
    super();
    this.config = config;
    this.state = this.createInitialState();
  }

  getState(): Readonly<StreamProcessorState> {
    return this.state;
  }

  processEvent(event: any): void {
    if (event.type === 'assistant' && event.message?.content) {
      this.handleAssistant(event.message.content, event.message.stop_reason);
    } else if (event.type === 'user' && event.message?.content) {
      this.handleUser(event.message.content);
    } else if (event.type === 'result') {
      this.handleResult(event);
    }
  }

  registerMessageTs(toolUseId: string, messageTs: string): void {
    const tracker = this.state.activeToolUses.get(toolUseId);
    if (tracker) {
      tracker.messageTs = messageTs;
    }
  }

  reset(): void {
    this.state = this.createInitialState();
  }

  dispose(): void {
    this.removeAllListeners();
  }

  private handleAssistant(content: any[], stopReason: string | null): void {
    for (const block of content) {
      if (block.type === 'thinking') {
        this.handleThinking(block.thinking);
      } else if (block.type === 'tool_use') {
        this.handleToolUse(block);
      }
      // text blocks: Phase 1 ignores (handled by existing wireSessionOutput)
    }
  }

  private handleThinking(text: string): void {
    this.state.thinkingCount++;
    this.state.lastThinkingText = text;

    if (this.state.thinkingCount === 1) {
      this.emitAction({
        type: 'postMessage',
        priority: 3,
        channel: this.config.channel,
        threadTs: this.config.threadTs,
        blocks: buildThinkingBlocks(text),
        text: '思考中...',
        metadata: { messageType: 'thinking' },
      });
      this.state.phase = 'thinking';
    }
  }

  private handleToolUse(block: any): void {
    const toolUseId = block.id;
    const toolName = block.name;
    const input = block.input || {};

    this.state.cumulativeToolCount++;

    const tracker: ToolUseTracker = {
      toolUseId,
      toolName,
      input,
      messageTs: null,
      startTime: Date.now(),
      status: 'running',
    };
    this.state.activeToolUses.set(toolUseId, tracker);
    this.state.phase = 'tool_executing';

    const oneLiner = getToolOneLiner(toolName, input);

    this.emitAction({
      type: 'postMessage',
      priority: 3,
      channel: this.config.channel,
      threadTs: this.config.threadTs,
      blocks: buildToolRunningBlocks(toolName, oneLiner),
      text: `${toolName}: ${oneLiner}`,
      metadata: {
        messageType: 'tool_use',
        toolUseId,
        toolName,
      },
    });
  }

  private handleUser(content: any[]): void {
    for (const block of content) {
      if (typeof block === 'object' && block.type === 'tool_result') {
        this.handleToolResult(block);
      }
    }
  }

  private handleToolResult(block: any): void {
    const toolUseId = block.tool_use_id;
    const tracker = this.state.activeToolUses.get(toolUseId);
    if (!tracker) {
      logger.warn(`tool_result for unknown tool_use_id: ${toolUseId}`);
      return;
    }

    const durationMs = Date.now() - tracker.startTime;
    // Detect error: is_error flag OR error pattern in content
    const isError = block.is_error === true
      || (typeof block.content === 'string' && /^(Error|error:|ERROR)/.test(block.content));
    const resultText = typeof block.content === 'string'
      ? block.content
      : JSON.stringify(block.content);

    tracker.status = isError ? 'error' : 'completed';
    tracker.durationMs = durationMs;
    tracker.isError = isError;
    tracker.result = resultText;

    if (tracker.messageTs) {
      const resultSummary = getToolResultSummary(tracker.toolName, resultText, isError);
      const oneLiner = getToolOneLiner(tracker.toolName, tracker.input);
      const displayText = `${oneLiner} — ${resultSummary}`;

      this.emitAction({
        type: 'update',
        priority: 3,
        channel: this.config.channel,
        threadTs: this.config.threadTs,
        messageTs: tracker.messageTs,
        blocks: buildToolCompletedBlocks(tracker.toolName, displayText, durationMs, isError),
        text: `${tracker.toolName}: ${displayText}`,
        metadata: {
          messageType: 'tool_use',
          toolUseId,
          toolName: tracker.toolName,
        },
      });
    }
  }

  private handleResult(event: any): void {
    this.state.phase = 'completed';
    // Phase 1: forward result event to existing handler in index.ts
    this.emit('result', event);
  }

  private emitAction(action: SlackAction): void {
    this.emit('action', action);
  }

  private createInitialState(): StreamProcessorState {
    return {
      phase: 'idle',
      thinkingCount: 0,
      lastThinkingText: null,
      firstThinkingTs: null,
      activeToolUses: new Map(),
      cumulativeToolCount: 0,
      textMessageTs: null,
      textBuffer: '',
      turnStartTime: Date.now(),
    };
  }
}
