// src/streaming/session-jsonl-reader.ts
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { logger } from '../utils/logger.js';
import { getToolOneLiner } from './tool-formatter.js';

export interface ToolDetail {
  toolUseId: string;
  toolName: string;
  input: Record<string, unknown>;
  result: string;
  isError: boolean;
}

export type BundleEntry =
  | { type: 'thinking'; texts: string[] }
  | { type: 'tool'; toolUseId: string; toolName: string; oneLiner: string; durationMs: number }
  | { type: 'subagent'; toolUseId: string; description: string; agentId: string; durationMs: number };

export class SessionJsonlReader {
  constructor(private readonly claudeProjectsDir: string) {}

  async readToolDetail(
    projectPath: string,
    sessionId: string,
    toolUseId: string,
  ): Promise<ToolDetail | null> {
    const dirName = this.toProjectDirName(projectPath);
    const filePath = path.join(this.claudeProjectsDir, dirName, `${sessionId}.jsonl`);

    if (!fs.existsSync(filePath)) {
      logger.warn(`Session JSONL not found: ${filePath}`);
      return null;
    }

    try {
      return await this.findToolInFile(filePath, toolUseId);
    } catch (err) {
      logger.error('Failed to read session JSONL', { error: (err as Error).message, filePath });
      return null;
    }
  }

  async readBundle(
    projectPath: string,
    sessionId: string,
    bundleIndex: number,
  ): Promise<BundleEntry[]> {
    const dirName = this.toProjectDirName(projectPath);
    const filePath = path.join(this.claudeProjectsDir, dirName, `${sessionId}.jsonl`);

    if (!fs.existsSync(filePath)) {
      logger.warn(`Session JSONL not found: ${filePath}`);
      return [];
    }

    try {
      return await this.collectBundleEntries(filePath, bundleIndex);
    } catch (err) {
      logger.error('Failed to read session JSONL for bundle', { error: (err as Error).message, filePath });
      return [];
    }
  }

  private async collectBundleEntries(filePath: string, bundleIndex: number): Promise<BundleEntry[]> {
    const stream = fs.createReadStream(filePath);
    const rl = readline.createInterface({ input: stream });

    // Intermediate tracking structures
    const entries: BundleEntry[] = [];
    // Map toolUseId -> index in entries (for tool/subagent entries needing duration update)
    const pendingToolEntries = new Map<string, number>();
    // Map toolUseId -> timestamp (ms) of tool_use creation
    const toolUseTimestamps = new Map<string, number>();
    // Set of toolUseIds that are Agent (subagent) type
    const agentToolUseIds = new Set<string>();

    let textBlockCount = 0;
    let hasActivityInCurrentSegment = false; // tracks whether thinking/tool/subagent appeared before next text
    let textBufferLength = 0; // accumulated text length for bundle boundary check
    let textPosted = false; // mirrors streaming side's textMessageTs — once text is posted, any text triggers boundary
    let lineTimestamp = 0; // use line-order index as proxy for time (no real timestamps in JSONL)

    for await (const line of rl) {
      if (!line.trim()) continue;

      let entry: any;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }

      lineTimestamp++;

      const msg = entry.message;
      if (!msg || !Array.isArray(msg.content)) continue;

      // Skip child events (subagent inner messages)
      // JSONL uses camelCase "parentToolUseID", stream events use snake_case "parent_tool_use_id"
      const isChild = typeof entry.parentToolUseID === 'string'
        || typeof entry.parent_tool_use_id === 'string';
      if (isChild) continue;

      const role = msg.role;

      for (const block of msg.content) {
        if (!block || typeof block !== 'object') continue;

        // Re-evaluate per block so boundary changes from text blocks
        // are reflected for subsequent tool_use blocks in the same line
        const isCollecting = textBlockCount === bundleIndex;

        if (block.type === 'text' && role === 'assistant') {
          const textLen = typeof block.text === 'string' ? block.text.length : 0;
          textBufferLength += textLen;

          // Match streaming side's handleText logic:
          // - Before text is "posted" (textPosted=false): collapse only when textBuffer >= 100
          // - After text is "posted" (textPosted=true): ANY text after activity triggers collapse
          // Streaming side: if (!this.textMessageTs && this.textBuffer.length < 100) return;
          const shouldCollapse = textPosted || textBufferLength >= 100;

          if (hasActivityInCurrentSegment && shouldCollapse) {
            textBlockCount++;
            hasActivityInCurrentSegment = false;
            textPosted = true;
            textBufferLength = 0;
          } else if (!textPosted && textBufferLength >= 100) {
            // Text reaches threshold without prior activity — mark as "posted"
            textPosted = true;
          }
          continue;
        }

        // Mark activity but do NOT reset textBufferLength —
        // streaming side accumulates textBuffer across tool calls
        if (block.type === 'thinking' || block.type === 'tool_use') {
          hasActivityInCurrentSegment = true;
        }

        if (!isCollecting) continue;

        if (block.type === 'thinking') {
          const text = String(block.thinking || '');
          // Merge into last thinking entry if consecutive
          const last = entries[entries.length - 1];
          if (last && last.type === 'thinking') {
            last.texts.push(text);
          } else {
            entries.push({ type: 'thinking', texts: [text] });
          }
        } else if (block.type === 'tool_use') {
          const toolUseId = String(block.id || '');
          const toolName = String(block.name || '');
          const input = (block.input || {}) as Record<string, unknown>;

          toolUseTimestamps.set(toolUseId, lineTimestamp);

          if (toolName === 'Agent') {
            agentToolUseIds.add(toolUseId);
            const description = String(input.prompt || input.description || '');
            const idx = entries.length;
            entries.push({ type: 'subagent', toolUseId, description, agentId: '', durationMs: 0 });
            pendingToolEntries.set(toolUseId, idx);
          } else {
            const oneLiner = getToolOneLiner(toolName, input);
            const idx = entries.length;
            entries.push({ type: 'tool', toolUseId, toolName, oneLiner, durationMs: 0 });
            pendingToolEntries.set(toolUseId, idx);
          }
        } else if (block.type === 'tool_result') {
          const toolUseId = String(block.tool_use_id || '');
          const entryIdx = pendingToolEntries.get(toolUseId);
          if (entryIdx === undefined) continue;

          const startTs = toolUseTimestamps.get(toolUseId) ?? lineTimestamp;
          const durationMs = (lineTimestamp - startTs) * 10; // approximate

          const existing = entries[entryIdx];
          if (existing.type === 'subagent') {
            // Extract agentId from result content
            const resultContent = typeof block.content === 'string'
              ? block.content
              : JSON.stringify(block.content);
            const agentIdMatch = resultContent.match(/agentId:\s*(\S+)/);
            const agentId = agentIdMatch ? agentIdMatch[1] : '';
            entries[entryIdx] = { ...existing, agentId, durationMs };
          } else if (existing.type === 'tool') {
            entries[entryIdx] = { ...existing, durationMs };
          }

          pendingToolEntries.delete(toolUseId);
        }
      }
    }

    return entries;
  }

  private async findToolInFile(filePath: string, toolUseId: string): Promise<ToolDetail | null> {
    const stream = fs.createReadStream(filePath);
    const rl = readline.createInterface({ input: stream });

    let toolName = '';
    let input: Record<string, unknown> = {};
    let foundToolUse = false;

    for await (const line of rl) {
      if (!line.trim()) continue;

      let entry: any;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }

      const msg = entry.message;
      if (!msg || !Array.isArray(msg.content)) continue;

      for (const block of msg.content) {
        if (!block || typeof block !== 'object') continue;

        // Find the tool_use block
        if (block.type === 'tool_use' && block.id === toolUseId) {
          toolName = block.name || '';
          input = block.input || {};
          foundToolUse = true;
        }

        // Find the matching tool_result block
        if (block.type === 'tool_result' && block.tool_use_id === toolUseId && foundToolUse) {
          const resultContent = typeof block.content === 'string'
            ? block.content
            : JSON.stringify(block.content);

          rl.close();
          stream.destroy();

          return {
            toolUseId,
            toolName,
            input,
            result: resultContent,
            isError: block.is_error === true,
          };
        }
      }
    }

    // tool_use found but no result yet
    if (foundToolUse) {
      return { toolUseId, toolName, input, result: '(result not yet available)', isError: false };
    }

    return null;
  }

  private toProjectDirName(projectPath: string): string {
    return projectPath.replace(/\//g, '-');
  }
}
