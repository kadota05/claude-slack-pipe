// src/streaming/stream-processor.ts
import { logger } from '../utils/logger.js';
import { getToolOneLiner } from './tool-formatter.js';
import { convertMarkdownToMrkdwn } from './markdown-converter.js';
import { GroupTracker } from './group-tracker.js';
import { TunnelManager } from './tunnel-manager.js';
import { extractLocalUrls, rewriteLocalUrls } from './localhost-rewriter.js';
import type {
  SlackAction,
  ProcessedActions,
  Block,
  BundleAction,
} from './types.js';

interface StreamProcessorConfig {
  channel: string;
  threadTs: string;
  sessionId: string;
  tunnelManager?: TunnelManager;
}

export class StreamProcessor {
  private readonly config: StreamProcessorConfig;
  private readonly groupTracker: GroupTracker;
  private readonly tunnelManager?: TunnelManager;
  private textBuffer = '';
  private textMessageTs: string | null = null;
  private mainToolUseCount = 0;

  constructor(config: StreamProcessorConfig) {
    this.config = config;
    this.groupTracker = new GroupTracker();
    this.tunnelManager = config.tunnelManager;
  }

  async processEvent(event: any): Promise<ProcessedActions> {
    const parentToolUseId = event.parent_tool_use_id || null;
    const result: ProcessedActions = { bundleActions: [] };

    if (event.type === 'assistant' && event.message?.content) {
      this.handleAssistant(event.message.content, parentToolUseId, result);
    } else if (event.type === 'user' && event.message?.content) {
      this.handleUser(event.message.content, parentToolUseId, result);
    } else if (event.type === 'result') {
      await this.handleResult(event, result);
    }

    return result;
  }

  registerBundleMessageTs(bundleId: string, messageTs: string): void {
    this.groupTracker.registerBundleMessageTs(bundleId, messageTs);
  }

  registerTextMessageTs(messageTs: string): void {
    this.textMessageTs = messageTs;
  }

  setAgentId(agentId: string): void {
    this.groupTracker.setAgentId(agentId);
  }

  getActiveGroupData() {
    return this.groupTracker.getActiveGroupData();
  }

  getAccumulatedText(): string {
    return this.textBuffer;
  }

  reset(): void {
    this.textBuffer = '';
    this.textMessageTs = null;
    this.mainToolUseCount = 0;
  }

  dispose(): void {
    // No timers or listeners to clean up in v2
  }

  private handleAssistant(content: any[], parentToolUseId: string | null, result: ProcessedActions): void {
    for (const block of content) {
      if (block.type === 'thinking') {
        // Skip child thinking — internal to subagent
        if (parentToolUseId) continue;
        const actions = this.groupTracker.handleThinking(block.thinking);
        result.bundleActions.push(...actions);
      } else if (block.type === 'tool_use') {
        this.handleToolUse(block, parentToolUseId, result);
      } else if (block.type === 'text' && block.text) {
        // Skip child text — internal to subagent
        if (parentToolUseId) continue;
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
      result.bundleActions.push(...actions);
      return;
    }

    // Agent tool = new subagent
    if (toolName === 'Agent') {
      this.mainToolUseCount++;
      const description = String(input.description || input.prompt || 'SubAgent');
      const actions = this.groupTracker.handleSubagentStart(toolUseId, description);
      result.bundleActions.push(...actions);
      return;
    }

    // Normal tool
    this.mainToolUseCount++;
    const actions = this.groupTracker.handleToolUse(toolUseId, toolName, input);
    result.bundleActions.push(...actions);
  }

  private handleText(text: string, result: ProcessedActions): void {
    this.textBuffer += text;

    if (this.tunnelManager) {
      const localUrls = extractLocalUrls(text);
      for (const { port } of localUrls) {
        // Fire-and-forget: start tunnel in parallel
        this.tunnelManager.startTunnel(port);
      }
    }

    // Buffer short text — don't post or collapse yet.
    // Short intermediate text (e.g. "まず確認してみます。") before tool_use
    // would otherwise collapse the bundle too early and split ToolSearch →
    // MCP tool sequences into separate bundles.
    if (!this.textMessageTs && this.textBuffer.length < 100) {
      return;
    }

    // Text is being posted — collapse the active bundle now
    const collapseActions = this.groupTracker.handleTextStart(this.config.sessionId);
    result.bundleActions.push(...collapseActions);

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
      result.bundleActions.push(...actions);
      return;
    }

    // Try subagent complete first (toolUseId matches the Agent tool's id)
    // Check if active group is a subagent with matching agentToolUseId before calling
    const activeGroup = this.groupTracker.getActiveGroupData();
    if (activeGroup && activeGroup.category === 'subagent' && activeGroup.agentToolUseId === toolUseId) {
      // Extract agentId before handleSubagentComplete moves the group to completed
      const agentIdMatch = resultText.match(/agentId:\s*([\w]+)/);
      if (agentIdMatch) {
        this.groupTracker.setAgentId(agentIdMatch[1]);
      }
      const subagentActions = this.groupTracker.handleSubagentComplete(toolUseId, resultText, 0);
      result.bundleActions.push(...subagentActions);
      return;
    }

    // Normal tool result — GroupTracker calculates durationMs internally from tool.startTime
    const actions = this.groupTracker.handleToolResult(toolUseId, resultText, isError);
    result.bundleActions.push(...actions);
  }

  private async handleResult(event: any, result: ProcessedActions): Promise<void> {
    // Flush any active group
    const flushActions = this.groupTracker.flushActiveBundle(this.config.sessionId);
    result.bundleActions.push(...flushActions);

    // Rewrite localhost URLs to tunnel URLs before final text conversion
    if (this.tunnelManager && this.textBuffer) {
      const localUrls = extractLocalUrls(this.textBuffer);
      if (localUrls.length > 0) {
        const urlMap = new Map<string, string>();
        await Promise.all(
          localUrls.map(async ({ url, port }) => {
            const tunnelUrl = await this.tunnelManager!.startTunnel(port);
            if (tunnelUrl) {
              const parsed = new URL(url);
              const path = parsed.pathname + parsed.search + parsed.hash;
              urlMap.set(url, tunnelUrl + (path === '/' ? '' : path));
            }
          })
        );
        this.textBuffer = rewriteLocalUrls(this.textBuffer, urlMap);
      }
    }

    // Finalize text — post or update depending on whether already posted
    if (this.textBuffer) {
      const converted = convertMarkdownToMrkdwn(this.textBuffer);
      const blocks = this.buildTextBlocks(converted, true);

      if (this.textMessageTs) {
        // Already posted — update with final content
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
      } else {
        // Never posted (was buffered) — post now as final text
        result.textAction = {
          type: 'postMessage',
          priority: 1,
          channel: this.config.channel,
          threadTs: this.config.threadTs,
          blocks,
          text: this.textBuffer.slice(0, 100),
          metadata: { messageType: 'text' },
        };
      }
    }

    result.resultEvent = event;
    result.mainApiCallCount = this.mainToolUseCount + 1;
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
