// src/streaming/stream-processor.ts
import { logger } from '../utils/logger.js';
import { getToolOneLiner } from './tool-formatter.js';
import { convertMarkdownToMrkdwn } from './markdown-converter.js';
import { GroupTracker } from './group-tracker.js';
import { TunnelManager } from './tunnel-manager.js';
import { notifyText } from './notification-text.js';
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
  onFirstContent?: () => void;
}

export class StreamProcessor {
  private readonly config: StreamProcessorConfig;
  private readonly groupTracker: GroupTracker;
  private readonly tunnelManager?: TunnelManager;
  private textBuffer = '';
  private textMessageTs: string | null = null;
  private mainToolUseCount = 0;
  private firstContentReceived = false;

  constructor(config: StreamProcessorConfig) {
    this.config = config;
    this.groupTracker = new GroupTracker();
    this.tunnelManager = config.tunnelManager;
  }

  async processEvent(event: any): Promise<ProcessedActions> {
    // Detect first content for reaction timing (top-level only)
    if (!this.firstContentReceived && !event.parent_tool_use_id) {
      if (event.type === 'assistant' && event.message?.content) {
        const hasContent = event.message.content.some(
          (block: any) => block.type === 'thinking' || block.type === 'text' || block.type === 'tool_use'
        );
        if (hasContent) {
          this.firstContentReceived = true;
          this.config.onFirstContent?.();
        }
      }
    }

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
    this.firstContentReceived = false;
  }

  dispose(): void {
    // No timers or listeners to clean up in v2
  }

  private finalizeCurrentText(): void {
    if (this.textMessageTs) {
      this.textMessageTs = null;
      this.textBuffer = '';
    }
  }

  private handleAssistant(content: any[], parentToolUseId: string | null, result: ProcessedActions): void {
    for (const block of content) {
      if (block.type === 'thinking') {
        // Skip child thinking — internal to subagent
        if (parentToolUseId) continue;
        this.finalizeCurrentText();
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

    // Main tool — finalize any previous text round
    this.finalizeCurrentText();

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
      // Scan full buffer, not just new chunk — URLs may be split across chunks
      const localUrls = extractLocalUrls(this.textBuffer);
      for (const { port } of localUrls) {
        // Fire-and-forget: start tunnel in parallel (deduplication handled by TunnelManager)
        this.tunnelManager.startTunnel(port);
      }
    }

    // Buffer text while subagents are running — flush when they complete
    if (this.groupTracker.hasActiveSubagents()) {
      return;
    }

    // Text is being posted — collapse the active bundle now
    const collapseActions = this.groupTracker.handleTextStart(this.config.sessionId);
    result.bundleActions.push(...collapseActions);

    const converted = convertMarkdownToMrkdwn(this.textBuffer);
    const blocks = this.buildTextBlocks(converted);

    if (!this.textMessageTs) {
      result.textAction = {
        type: 'postMessage',
        priority: 1,
        channel: this.config.channel,
        threadTs: this.config.threadTs,
        blocks,
        text: notifyText.text(this.textBuffer),
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
        text: notifyText.text(this.textBuffer),
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
    // Check activeSubagents Map for matching agentToolUseId
    const activeSubagent = this.groupTracker.getActiveSubagent(toolUseId);
    if (activeSubagent) {
      // Extract agentId before handleSubagentComplete moves the group to completed
      const agentIdMatch = resultText.match(/agentId:\s*([\w]+)/);
      if (agentIdMatch) {
        this.groupTracker.setAgentId(agentIdMatch[1], toolUseId);
      }
      const subagentActions = this.groupTracker.handleSubagentComplete(toolUseId, resultText, 0);
      result.bundleActions.push(...subagentActions);

      // Flush pending text when all subagents complete
      if (!this.groupTracker.hasActiveSubagents() && this.textBuffer) {
        const collapseActions = this.groupTracker.handleTextStart(this.config.sessionId);
        result.bundleActions.push(...collapseActions);
        const converted = convertMarkdownToMrkdwn(this.textBuffer);
        const blocks = this.buildTextBlocks(converted);
        result.textAction = {
          type: 'postMessage',
          priority: 1,
          channel: this.config.channel,
          threadTs: this.config.threadTs,
          blocks,
          text: notifyText.text(this.textBuffer),
          metadata: { messageType: 'text' },
        };
      }
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

    // Finalize text — post or update depending on whether already posted
    if (this.textBuffer) {
      let converted = convertMarkdownToMrkdwn(this.textBuffer);

      // Rewrite localhost URLs AFTER mrkdwn conversion to avoid
      // <url|text> links being stripped by HTML tag removal in converter
      if (this.tunnelManager) {
        const localUrls = extractLocalUrls(converted);
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
          converted = rewriteLocalUrls(converted, urlMap);
        }
      }

      logger.info(`[tunnel-debug] final converted text: ${JSON.stringify(converted.substring(0, 500))}`);
      const blocks = this.buildTextBlocks(converted);

      if (this.textMessageTs) {
        // Already posted — update with final content
        result.textAction = {
          type: 'update',
          priority: 1,
          channel: this.config.channel,
          threadTs: this.config.threadTs,
          messageTs: this.textMessageTs,
          blocks,
          text: notifyText.text(this.textBuffer),
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
          text: notifyText.text(this.textBuffer),
          metadata: { messageType: 'text' },
        };
      }
    }

    result.resultEvent = event;
    result.mainApiCallCount = this.mainToolUseCount + 1;
  }

  private buildTextBlocks(mrkdwn: string): Block[] {
    const blocks: Block[] = [];
    const parts = mrkdwn.match(/.{1,2900}/gs) || [mrkdwn];
    for (const part of parts) {
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: part, verbatim: true },
      });
    }
    return blocks;
  }
}
