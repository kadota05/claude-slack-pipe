// src/streaming/stream-processor.ts
import { logger } from '../utils/logger.js';
import { getToolOneLiner } from './tool-formatter.js';
import { convertMarkdownToMrkdwn } from './markdown-converter.js';
import { GroupTracker } from './group-tracker.js';
import { TunnelManager, isPortAlive } from './tunnel-manager.js';
import { notifyText } from './notification-text.js';
import { extractLocalUrls, buildLocalhostAccessBlocks } from './localhost-rewriter.js';
import type { LocalUrl } from './localhost-rewriter.js';
import { extractFilePaths } from './file-path-extractor.js';
import { buildFileReferenceBlocks } from './file-reference-blocks.js';
import type { TokenUsage } from '../types.js';
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
  cwd?: string;
  tunnelManager?: TunnelManager;
  onFirstContent?: () => void;
}

export class StreamProcessor {
  private readonly config: StreamProcessorConfig;
  private readonly groupTracker: GroupTracker;
  private readonly tunnelManager?: TunnelManager;
  private textBuffer = '';
  private textMessageTs: string | null = null;
  private lastMainUsage: TokenUsage | null = null;
  private firstContentReceived = false;
  // Accumulate localhost URLs across entire session (survives finalizeCurrentText)
  private discoveredLocalUrls = new Map<string, LocalUrl>();
  // Ports discovered in AI text responses — persists across the session
  private watchedPorts = new Set<number>();
  // Track the message that currently has tunnel buttons (for removal on next response)
  private tunnelButtonMessageTs: string | null = null;
  private tunnelButtonMessageBlocks: Block[] | null = null;

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
      // Track last main-agent usage for context window calculation
      if (!parentToolUseId && event.message.usage) {
        this.lastMainUsage = event.message.usage;
      }
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

  registerTunnelButtonMessage(messageTs: string, blocks: Block[]): void {
    this.tunnelButtonMessageTs = messageTs;
    this.tunnelButtonMessageBlocks = blocks;
  }

  reset(): void {
    this.textBuffer = '';
    this.textMessageTs = null;
    this.lastMainUsage = null;
    this.firstContentReceived = false;
    this.discoveredLocalUrls.clear();
    this.watchedPorts.clear();
    this.tunnelButtonMessageTs = null;
    this.tunnelButtonMessageBlocks = null;
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
      const description = String(input.description || input.prompt || 'SubAgent');
      const actions = this.groupTracker.handleSubagentStart(toolUseId, description);
      result.bundleActions.push(...actions);
      return;
    }

    // Normal tool
    const actions = this.groupTracker.handleToolUse(toolUseId, toolName, input);
    result.bundleActions.push(...actions);
  }

  private handleText(text: string, result: ProcessedActions): void {
    this.textBuffer += text;

    if (this.tunnelManager) {
      // Scan full buffer, not just new chunk — URLs may be split across chunks
      const localUrls = extractLocalUrls(this.textBuffer);
      for (const localUrl of localUrls) {
        this.discoveredLocalUrls.set(localUrl.url, localUrl);
        // Register port for lifecycle tracking (persist across session)
        this.watchedPorts.add(localUrl.port);
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

      const blocks = this.buildTextBlocks(converted);

      // Append localhost access buttons based on watched ports (alive check)
      if (this.tunnelManager && this.watchedPorts.size > 0) {
        // Also register any new URLs from final text
        for (const localUrl of extractLocalUrls(converted)) {
          this.discoveredLocalUrls.set(localUrl.url, localUrl);
          this.watchedPorts.add(localUrl.port);
        }

        // Check which watched ports are alive
        const alivePortUrls: LocalUrl[] = [];
        const portAliveResults = await Promise.all(
          [...this.watchedPorts].map(async (port) => ({
            port,
            alive: await isPortAlive(port),
          }))
        );

        for (const { port, alive } of portAliveResults) {
          if (alive) {
            const urlsForPort = [...this.discoveredLocalUrls.values()].filter(u => u.port === port);
            if (urlsForPort.length > 0) {
              alivePortUrls.push(...urlsForPort);
            } else {
              alivePortUrls.push({ url: `http://localhost:${port}`, host: 'localhost', port });
            }
          }
        }

        if (alivePortUrls.length > 0) {
          const urlMap = new Map<string, string>();
          await Promise.all(
            alivePortUrls.map(async ({ url, port }) => {
              const tunnelUrl = await this.tunnelManager!.startTunnel(port);
              if (tunnelUrl) {
                try {
                  const parsed = new URL(url);
                  const path = parsed.pathname + parsed.search + parsed.hash;
                  urlMap.set(url, tunnelUrl + (path === '/' ? '' : path));
                } catch {
                  urlMap.set(url, tunnelUrl);
                }
              }
            })
          );
          const accessBlocks = buildLocalhostAccessBlocks(alivePortUrls, urlMap);
          const maxAccessBlocks = 50 - blocks.length;
          if (accessBlocks.length > 0 && maxAccessBlocks > 0) {
            blocks.push(...accessBlocks.slice(0, maxAccessBlocks));
          }
        }

        // Generate action to remove tunnel buttons from previous message
        if (this.tunnelButtonMessageTs && this.tunnelButtonMessageBlocks) {
          const cleanBlocks = this.stripTunnelBlocks(this.tunnelButtonMessageBlocks);
          result.removeTunnelButtonAction = {
            type: 'update',
            priority: 3,
            channel: this.config.channel,
            threadTs: this.config.threadTs,
            messageTs: this.tunnelButtonMessageTs,
            blocks: cleanBlocks,
            text: '',
            metadata: { messageType: 'text' },
          };
          // Clear to avoid redundant chat.update on subsequent finalizes
          this.tunnelButtonMessageTs = null;
          this.tunnelButtonMessageBlocks = null;
        }
      }

      // Append file reference buttons
      const filePaths = extractFilePaths(this.textBuffer, this.config.cwd ?? process.cwd());
      if (filePaths.length > 0) {
        const maxFileBlocks = 50 - blocks.length;
        if (maxFileBlocks > 1) {
          const fileBlocks = buildFileReferenceBlocks(filePaths, maxFileBlocks);
          blocks.push(...fileBlocks);
        }
      }

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
    result.lastMainUsage = this.lastMainUsage;
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

  private stripTunnelBlocks(blocks: Block[]): Block[] {
    const result: Block[] = [];
    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i];
      // Skip actions blocks with tunnel_access buttons
      if (block.type === 'actions') {
        const elements = block.elements as any[] | undefined;
        if (elements?.some((e: any) => e.action_id?.startsWith('tunnel_access:'))) {
          continue;
        }
      }
      // Skip context blocks with tunnel warning message
      if (block.type === 'context') {
        const elements = block.elements as any[] | undefined;
        if (elements?.some((e: any) => e.text?.includes('モバイルアクセスリンクを準備できませんでした'))) {
          continue;
        }
      }
      // Skip divider immediately before a tunnel actions block
      if (block.type === 'divider' && i + 1 < blocks.length) {
        const next = blocks[i + 1];
        if (next.type === 'actions') {
          const elements = next.elements as any[] | undefined;
          if (elements?.some((e: any) => e.action_id?.startsWith('tunnel_access:'))) {
            continue;
          }
        }
      }
      result.push(block);
    }
    return result;
  }
}
