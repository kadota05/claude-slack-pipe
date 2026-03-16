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
import { convertMarkdownToMrkdwn } from './markdown-converter.js';
import { BatchAggregator } from './batch-aggregator.js';
import { SubagentTracker } from './subagent-tracker.js';
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
  private batchAggregator: BatchAggregator;
  private subagentTracker: SubagentTracker;

  constructor(config: StreamProcessorConfig) {
    super();
    this.config = config;
    this.state = this.createInitialState();
    this.subagentTracker = new SubagentTracker();
    this.batchAggregator = new BatchAggregator({
      windowMs: 1500,
      maxWaitMs: 3000,
      onFlush: (batch) => this.handleBatchFlush(batch),
    });
  }

  getState(): Readonly<StreamProcessorState> {
    return this.state;
  }

  processEvent(event: any): void {
    const parentToolUseId = event.parent_tool_use_id || null;

    if (event.type === 'assistant' && event.message?.content) {
      this.handleAssistant(event.message.content, event.message.stop_reason, parentToolUseId);
    } else if (event.type === 'user' && event.message?.content) {
      this.handleUser(event.message.content, parentToolUseId);
    } else if (event.type === 'result') {
      this.handleResult(event);
    }
    // stream_event: ignored (--include-partial-messages disabled)
  }

  registerMessageTs(toolUseId: string, messageTs: string): void {
    const tracker = this.state.activeToolUses.get(toolUseId);
    if (tracker) {
      tracker.messageTs = messageTs;
    }
    if (this.subagentTracker.isSubagent(toolUseId)) {
      this.subagentTracker.setMessageTs(toolUseId, messageTs);
    }
  }

  /**
   * Register the Slack message ts for the text message.
   * Called by index.ts after executor posts the text message.
   */
  registerTextMessageTs(messageTs: string): void {
    this.state.textMessageTs = messageTs;
  }

  getAccumulatedText(): string {
    return this.state.textBuffer;
  }

  reset(): void {
    this.batchAggregator.dispose();
    this.batchAggregator = new BatchAggregator({
      windowMs: 1500,
      maxWaitMs: 3000,
      onFlush: (batch) => this.handleBatchFlush(batch),
    });
    this.subagentTracker = new SubagentTracker();
    this.state = this.createInitialState();
  }

  dispose(): void {
    this.batchAggregator.dispose();
    this.removeAllListeners();
  }

  private handleAssistant(content: any[], stopReason: string | null, parentToolUseId: string | null): void {
    for (const block of content) {
      if (block.type === 'thinking') {
        this.handleThinking(block.thinking);
      } else if (block.type === 'tool_use') {
        this.handleToolUse(block, parentToolUseId);
      } else if (block.type === 'text' && block.text) {
        this.handleText(block.text);
      }
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

  /**
   * Handle text content block from assistant event.
   * Converts markdown and posts as a new message, or updates existing text message.
   */
  private handleText(text: string): void {
    this.state.textBuffer += text;
    this.state.phase = 'responding';

    const converted = convertMarkdownToMrkdwn(this.state.textBuffer);
    const blocks = this.buildTextBlocks(converted, false);

    if (!this.state.textMessageTs) {
      // First text → post new message
      this.emitAction({
        type: 'postMessage',
        priority: 1,
        channel: this.config.channel,
        threadTs: this.config.threadTs,
        blocks,
        text: this.state.textBuffer.slice(0, 100),
        metadata: { messageType: 'text' },
      });
    } else {
      // Subsequent text → update existing message
      this.emitAction({
        type: 'update',
        priority: 1,
        channel: this.config.channel,
        threadTs: this.config.threadTs,
        messageTs: this.state.textMessageTs,
        blocks,
        text: this.state.textBuffer.slice(0, 100),
        metadata: { messageType: 'text' },
      });
    }
  }

  private handleToolUse(block: any, parentToolUseId: string | null): void {
    const toolUseId = block.id;
    const toolName = block.name;
    const input = block.input || {};

    this.state.cumulativeToolCount++;
    this.batchAggregator.setCumulativeToolCount(this.state.cumulativeToolCount);

    const tracker: ToolUseTracker = {
      toolUseId,
      toolName,
      input,
      messageTs: null,
      startTime: Date.now(),
      status: 'running',
    };
    this.state.activeToolUses.set(toolUseId, tracker);

    const oneLiner = getToolOneLiner(toolName, input);

    // Check if this is a subagent's child tool
    if (parentToolUseId && this.subagentTracker.isChildOf(parentToolUseId)) {
      this.subagentTracker.addStep(parentToolUseId, {
        toolName,
        toolUseId,
        oneLiner,
        status: 'running',
      });
      this.emitSubagentUpdate(parentToolUseId);
      return;
    }

    // Check if this IS an Agent tool (starting a new subagent)
    if (toolName === 'Agent') {
      const description = String(input.prompt || input.description || 'Subagent');
      this.subagentTracker.registerAgent(toolUseId, description);
      this.state.phase = 'tool_executing';

      this.emitAction({
        type: 'postMessage',
        priority: 3,
        channel: this.config.channel,
        threadTs: this.config.threadTs,
        blocks: [
          {
            type: 'section',
            text: { type: 'mrkdwn', text: `:robot_face: *Agent* — ${escapeForMrkdwn(truncate(description, 60))}` },
          },
          {
            type: 'context',
            elements: [{ type: 'mrkdwn', text: '実行中...' }],
          },
        ],
        text: `Agent: ${description}`,
        metadata: { messageType: 'subagent', toolUseId, toolName: 'Agent' },
      });
      return;
    }

    // Normal tool — route through batch aggregator
    this.state.phase = 'tool_executing';
    this.batchAggregator.submit({
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

  private emitSubagentUpdate(agentToolUseId: string): void {
    const messageTs = this.subagentTracker.getMessageTs(agentToolUseId);
    if (!messageTs) return;

    const description = this.subagentTracker.getAgentDescription(agentToolUseId) || 'Subagent';
    const { visibleSteps, hiddenCount } = this.subagentTracker.getDisplaySteps(agentToolUseId, 5);

    const stepLines = visibleSteps.map(step => {
      const icon = step.status === 'completed' ? ':white_check_mark:' : step.status === 'error' ? ':x:' : ':hourglass_flowing_sand:';
      return `${icon} \`${step.toolName}\` ${escapeForMrkdwn(step.oneLiner)}`;
    });

    if (hiddenCount > 0) {
      stepLines.unshift(`_... 他${hiddenCount}ツール完了_`);
    }

    const blocks = [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `:robot_face: *Agent* — ${escapeForMrkdwn(truncate(description, 60))}` },
      },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: stepLines.join('\n') },
      },
      {
        type: 'context',
        elements: [{ type: 'mrkdwn', text: `${visibleSteps.length + hiddenCount}ステップ実行中...` }],
      },
    ];

    this.emitAction({
      type: 'update',
      priority: 4,
      channel: this.config.channel,
      threadTs: this.config.threadTs,
      messageTs,
      blocks,
      text: `Agent: ${description}`,
      metadata: { messageType: 'subagent', toolUseId: agentToolUseId, toolName: 'Agent' },
    });
  }

  private handleUser(content: any[], parentToolUseId: string | null): void {
    for (const block of content) {
      if (typeof block === 'object' && block.type === 'tool_result') {
        this.handleToolResult(block, parentToolUseId);
      }
    }
  }

  private handleToolResult(block: any, parentToolUseId: string | null): void {
    const toolUseId = block.tool_use_id;
    const tracker = this.state.activeToolUses.get(toolUseId);
    if (!tracker) {
      logger.warn(`tool_result for unknown tool_use_id: ${toolUseId}`);
      return;
    }

    const durationMs = Date.now() - tracker.startTime;
    const isError = block.is_error === true
      || (typeof block.content === 'string' && /^(Error|error:|ERROR)/.test(block.content));
    const resultText = typeof block.content === 'string'
      ? block.content
      : JSON.stringify(block.content);

    tracker.status = isError ? 'error' : 'completed';
    tracker.durationMs = durationMs;
    tracker.isError = isError;
    tracker.result = resultText;

    // Check if this is a subagent child tool result
    if (parentToolUseId && this.subagentTracker.isChildOf(parentToolUseId)) {
      this.subagentTracker.updateStepStatus(parentToolUseId, toolUseId, isError ? 'error' : 'completed');
      this.emitSubagentUpdate(parentToolUseId);
      return;
    }

    // Normal tool result — update the tool message
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
        blocks: buildToolCompletedBlocks(tracker.toolName, displayText, durationMs, isError, toolUseId),
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

    // Finalize text message — remove "応答中" indicator
    if (this.state.textMessageTs && this.state.textBuffer) {
      const converted = convertMarkdownToMrkdwn(this.state.textBuffer);
      const blocks = this.buildTextBlocks(converted, true);
      this.emitAction({
        type: 'update',
        priority: 1,
        channel: this.config.channel,
        threadTs: this.config.threadTs,
        messageTs: this.state.textMessageTs,
        blocks,
        text: this.state.textBuffer.slice(0, 100),
        metadata: { messageType: 'text' },
      });
    }

    this.emit('result', event);
  }

  private handleBatchFlush(batch: SlackAction[]): void {
    if (batch.length === 1) {
      this.emitAction(batch[0]);
    } else {
      const mergedBlocks: Record<string, unknown>[] = [];
      const toolNames: string[] = [];
      for (const action of batch) {
        if (action.blocks) mergedBlocks.push(...action.blocks);
        if (action.metadata.toolName) toolNames.push(action.metadata.toolName);
      }
      this.emitAction({
        type: 'postMessage',
        priority: 3,
        channel: this.config.channel,
        threadTs: this.config.threadTs,
        blocks: mergedBlocks,
        text: `${batch.length}ツール実行中: ${toolNames.join(', ')}`,
        metadata: { messageType: 'tool_use' },
      });
    }
  }

  private buildTextBlocks(mrkdwn: string, isComplete: boolean): Record<string, unknown>[] {
    const blocks: Record<string, unknown>[] = [];
    const parts = mrkdwn.match(/.{1,2900}/gs) || [mrkdwn];
    for (const part of parts) {
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: part },
      });
    }
    if (!isComplete) {
      blocks.push({
        type: 'context',
        elements: [{ type: 'mrkdwn', text: ':hourglass_flowing_sand: 応答中...' }],
      });
    }
    return blocks;
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

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + '...';
}

function escapeForMrkdwn(s: string): string {
  return s.replace(/[`]/g, "'");
}
