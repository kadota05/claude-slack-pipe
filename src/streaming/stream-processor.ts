// src/streaming/stream-processor.ts
import { logger } from '../utils/logger.js';
import { getToolOneLiner } from './tool-formatter.js';
import { convertMarkdownToMrkdwn } from './markdown-converter.js';
import { GroupTracker } from './group-tracker.js';
import type {
  SlackAction,
  ProcessedActions,
  Block,
} from './types.js';

interface StreamProcessorConfig {
  channel: string;
  threadTs: string;
}

export class StreamProcessor {
  private readonly config: StreamProcessorConfig;
  private readonly groupTracker: GroupTracker;
  private textBuffer = '';
  private textMessageTs: string | null = null;

  constructor(config: StreamProcessorConfig) {
    this.config = config;
    this.groupTracker = new GroupTracker();
  }

  processEvent(event: any): ProcessedActions {
    const parentToolUseId = event.parent_tool_use_id || null;
    const result: ProcessedActions = { groupActions: [] };

    if (event.type === 'assistant' && event.message?.content) {
      this.handleAssistant(event.message.content, parentToolUseId, result);
    } else if (event.type === 'user' && event.message?.content) {
      this.handleUser(event.message.content, parentToolUseId, result);
    } else if (event.type === 'result') {
      this.handleResult(event, result);
    }

    return result;
  }

  registerGroupMessageTs(groupId: string, messageTs: string): void {
    this.groupTracker.registerMessageTs(groupId, messageTs);
  }

  registerTextMessageTs(messageTs: string): void {
    this.textMessageTs = messageTs;
  }

  setAgentId(groupId: string, agentId: string): void {
    this.groupTracker.setAgentId(groupId, agentId);
  }

  getGroupData(groupId: string) {
    return this.groupTracker.getGroupData(groupId);
  }

  getAccumulatedText(): string {
    return this.textBuffer;
  }

  reset(): void {
    this.textBuffer = '';
    this.textMessageTs = null;
  }

  dispose(): void {
    // No timers or listeners to clean up in v2
  }

  private handleAssistant(content: any[], parentToolUseId: string | null, result: ProcessedActions): void {
    for (const block of content) {
      if (block.type === 'thinking') {
        const actions = this.groupTracker.handleThinking(block.thinking);
        result.groupActions.push(...actions);
      } else if (block.type === 'tool_use') {
        this.handleToolUse(block, parentToolUseId, result);
      } else if (block.type === 'text' && block.text) {
        this.handleText(block.text, result);
      }
    }
  }

  private handleToolUse(block: any, parentToolUseId: string | null, result: ProcessedActions): void {
    const toolUseId = block.id;
    const toolName = block.name;
    const input = block.input || {};

    // Subagent child tool
    if (parentToolUseId) {
      const oneLiner = getToolOneLiner(toolName, input);
      const actions = this.groupTracker.handleSubagentStep(parentToolUseId, toolName, toolUseId, oneLiner);
      result.groupActions.push(...actions);
      return;
    }

    // Agent tool = new subagent
    if (toolName === 'Agent') {
      const description = String(input.description || input.prompt || 'SubAgent');
      const actions = this.groupTracker.handleSubagentStart(toolUseId, description);
      result.groupActions.push(...actions);
      return;
    }

    // Normal tool
    const actions = this.groupTracker.handleToolUse(toolUseId, toolName, input);
    result.groupActions.push(...actions);
  }

  private handleText(text: string, result: ProcessedActions): void {
    // Collapse any active group before text
    const collapseActions = this.groupTracker.handleTextStart();
    result.groupActions.push(...collapseActions);

    this.textBuffer += text;
    const converted = convertMarkdownToMrkdwn(this.textBuffer);
    const blocks = this.buildTextBlocks(converted, false);

    if (!this.textMessageTs) {
      result.textAction = {
        type: 'postMessage',
        priority: 1,
        channel: this.config.channel,
        threadTs: this.config.threadTs,
        blocks,
        text: this.textBuffer.slice(0, 100),
        metadata: { messageType: 'text' },
      };
    } else {
      result.textAction = {
        type: 'update',
        priority: 1,
        channel: this.config.channel,
        threadTs: this.config.threadTs,
        messageTs: this.textMessageTs,
        blocks,
        text: this.textBuffer.slice(0, 100),
        metadata: { messageType: 'text' },
      };
    }
  }

  private handleUser(content: any[], parentToolUseId: string | null, result: ProcessedActions): void {
    for (const block of content) {
      if (typeof block === 'object' && block.type === 'tool_result') {
        this.handleToolResult(block, parentToolUseId, result);
      }
    }
  }

  private handleToolResult(block: any, parentToolUseId: string | null, result: ProcessedActions): void {
    const toolUseId = block.tool_use_id;
    const isError = block.is_error === true
      || (typeof block.content === 'string' && /^(Error|error:|ERROR)/.test(block.content));
    const resultText = typeof block.content === 'string'
      ? block.content
      : JSON.stringify(block.content);

    // Subagent child tool result
    if (parentToolUseId) {
      const actions = this.groupTracker.handleSubagentStepResult(parentToolUseId, toolUseId, isError);
      result.groupActions.push(...actions);
      return;
    }

    // Try subagent complete first (toolUseId matches the Agent tool's id)
    const subagentActions = this.groupTracker.handleSubagentComplete(toolUseId, resultText, 0);
    if (subagentActions.length > 0) {
      // Extract agentId from result text for JSONL lookup
      const agentIdMatch = resultText.match(/agentId:\s*([\w]+)/);
      if (agentIdMatch) {
        const collapsedAction = subagentActions.find(a => a.type === 'collapse');
        if (collapsedAction) {
          this.groupTracker.setAgentId(collapsedAction.groupId, agentIdMatch[1]);
        }
      }
      result.groupActions.push(...subagentActions);
      return;
    }

    // Normal tool result — GroupTracker calculates durationMs internally from tool.startTime
    const actions = this.groupTracker.handleToolResult(toolUseId, resultText, isError);
    result.groupActions.push(...actions);
  }

  private handleResult(event: any, result: ProcessedActions): void {
    // Flush any active group
    const flushActions = this.groupTracker.flushActiveGroup();
    result.groupActions.push(...flushActions);

    // Finalize text
    if (this.textMessageTs && this.textBuffer) {
      const converted = convertMarkdownToMrkdwn(this.textBuffer);
      const blocks = this.buildTextBlocks(converted, true);
      result.textAction = {
        type: 'update',
        priority: 1,
        channel: this.config.channel,
        threadTs: this.config.threadTs,
        messageTs: this.textMessageTs,
        blocks,
        text: this.textBuffer.slice(0, 100),
        metadata: { messageType: 'text' },
      };
    }

    result.resultEvent = event;
  }

  private buildTextBlocks(mrkdwn: string, isComplete: boolean): Block[] {
    const blocks: Block[] = [];
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
}
