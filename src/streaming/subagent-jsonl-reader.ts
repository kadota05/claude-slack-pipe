// src/streaming/subagent-jsonl-reader.ts
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { logger } from '../utils/logger.js';
import { getToolOneLiner } from './tool-formatter.js';

export interface SubagentConversationFlow {
  agentType: string;
  systemPromptSummary: string;
  steps: Array<{
    type: 'text' | 'tool_use' | 'tool_result';
    text?: string;
    toolName?: string;
    toolUseId?: string;
    input?: Record<string, unknown>;
    oneLiner?: string;
    resultSummary?: string;
    isError?: boolean;
  }>;
  finalResult: string;
  totalDurationMs: number;
}

export class SubagentJsonlReader {
  constructor(private readonly claudeProjectsDir: string) {}

  async read(
    projectPath: string,
    sessionId: string,
    agentId: string,
  ): Promise<SubagentConversationFlow | null> {
    const dirName = this.toProjectDirName(projectPath);
    const filePath = path.join(
      this.claudeProjectsDir,
      dirName,
      sessionId,
      'subagents',
      `agent-${agentId}.jsonl`,
    );

    if (!fs.existsSync(filePath)) {
      logger.warn(`SubAgent JSONL not found: ${filePath}`);
      return null;
    }

    try {
      return await this.parseFile(filePath);
    } catch (err) {
      logger.error('Failed to parse SubAgent JSONL', { error: (err as Error).message, filePath });
      return null;
    }
  }

  private async parseFile(filePath: string): Promise<SubagentConversationFlow> {
    const stream = fs.createReadStream(filePath);
    const rl = readline.createInterface({ input: stream });

    let systemPromptSummary = '';
    const steps: SubagentConversationFlow['steps'] = [];
    let finalResult = '';
    let firstTimestamp: number | null = null;
    let lastTimestamp: number | null = null;
    let agentType = 'general-purpose';
    let isFirstUser = true;

    for await (const line of rl) {
      if (!line.trim()) continue;

      let entry: any;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }

      if (entry.timestamp) {
        const ts = new Date(entry.timestamp).getTime();
        if (!firstTimestamp) firstTimestamp = ts;
        lastTimestamp = ts;
      }

      const msg = entry.message;
      if (!msg) continue;

      if (entry.type === 'user' && isFirstUser) {
        isFirstUser = false;
        const content = typeof msg.content === 'string'
          ? msg.content
          : JSON.stringify(msg.content);
        systemPromptSummary = content.slice(0, 200);
        continue;
      }

      if (msg.role === 'assistant' && Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === 'text' && block.text) {
            finalResult = block.text;
            steps.push({ type: 'text', text: block.text.slice(0, 200) });
          } else if (block.type === 'tool_use') {
            const oneLiner = getToolOneLiner(block.name || '', block.input || {});
            steps.push({
              type: 'tool_use',
              toolName: block.name,
              toolUseId: block.id,
              input: block.input,
              oneLiner,
            });
          }
        }
      }

      if (msg.role === 'user' && Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === 'tool_result') {
            const resultContent = typeof block.content === 'string'
              ? block.content
              : JSON.stringify(block.content);
            steps.push({
              type: 'tool_result',
              toolUseId: block.tool_use_id,
              resultSummary: resultContent.slice(0, 100),
              isError: block.is_error === true,
            });
          }
        }
      }
    }

    const totalDurationMs = (firstTimestamp && lastTimestamp)
      ? lastTimestamp - firstTimestamp
      : 0;

    return {
      agentType,
      systemPromptSummary,
      steps: steps.slice(0, 50),
      finalResult: finalResult.slice(0, 2000),
      totalDurationMs,
    };
  }

  private toProjectDirName(projectPath: string): string {
    return projectPath.replace(/\//g, '-');
  }
}
