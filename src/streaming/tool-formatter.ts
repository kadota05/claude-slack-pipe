// src/streaming/tool-formatter.ts

import type { Block } from './types.js';
import { DECORATION_ICONS } from './notification-text.js';

export function getToolOneLiner(toolName: string, input: Record<string, unknown>): string {
  const stripLeadingSlash = (p: string) => p.replace(/^\//, '');

  switch (toolName) {
    case 'Read':
      return stripLeadingSlash(String(input.file_path || ''));
    case 'Edit':
    case 'Write':
      return stripLeadingSlash(String(input.file_path || ''));
    case 'Bash':
      return truncate(String(input.command || ''), 60);
    case 'Grep':
      return `${input.pattern || ''}${input.path ? ' in ' + input.path : ''}`;
    case 'Glob':
      return String(input.pattern || '');
    case 'Agent':
      return truncate(String(input.prompt || input.description || ''), 60);
    default:
      return toolName;
  }
}

export function buildToolRunningBlocks(toolName: string, oneLiner: string): Block[] {
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `${DECORATION_ICONS.tool} \`${toolName}\` ${escapeMarkdown(oneLiner)}`,
      },
    },
    {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: '実行中...' }],
    },
  ];
}

export function buildToolCompletedBlocks(
  toolName: string,
  resultSummary: string,
  durationMs: number,
  isError = false,
  toolUseId?: string,
): Block[] {
  const icon = isError ? DECORATION_ICONS.error : DECORATION_ICONS.completed;
  const durationStr = `${(durationMs / 1000).toFixed(1)}s`;

  const sectionBlock: Block = {
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: `${icon} \`${toolName}\` ${escapeMarkdown(resultSummary)}`,
    },
  };

  // Add detail button if toolUseId provided
  if (toolUseId) {
    sectionBlock.accessory = {
      type: 'button',
      text: { type: 'plain_text', text: '詳細' },
      action_id: `view_tool_detail:${toolUseId}`,
    };
  }

  return [
    sectionBlock,
    {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `完了 (${durationStr})` }],
    },
  ];
}

export function buildThinkingBlocks(thinkingText: string): Block[] {
  const snippet = truncate(thinkingText.trim(), 200);
  return [
    {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: ':thought_balloon: *思考中...*' }],
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `_${escapeMarkdown(snippet)}_` },
    },
  ];
}

export function getToolResultSummary(toolName: string, result: string, isError: boolean): string {
  if (isError) return truncate(result, 80);

  switch (toolName) {
    case 'Read': {
      const lineCount = result.split('\n').length;
      return `${lineCount}行`;
    }
    case 'Bash': {
      const lines = result.split('\n').filter(l => l.trim());
      if (lines.length === 0) return '(no output)';
      return truncate(lines[0], 60);
    }
    case 'Grep': {
      const matches = result.split('\n').filter(l => l.trim());
      return `${matches.length}件`;
    }
    case 'Glob': {
      const files = result.split('\n').filter(l => l.trim());
      return `${files.length}ファイル`;
    }
    default:
      return truncate(result.split('\n')[0] || '完了', 60);
  }
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + '...';
}

function escapeMarkdown(s: string): string {
  return s
    .replace(/[`]/g, "'")
    .replace(/[*]/g, '∗')
    .replace(/[_]/g, '＿')
    .replace(/[~]/g, '∼');
}

// --- Live display blocks (context blocks for thin/grey appearance) ---

interface LiveToolInfo {
  toolName: string;
  oneLiner: string;
  status: 'running' | 'completed' | 'error';
  durationMs?: number;
}

interface LiveStepInfo {
  toolName: string;
  oneLiner: string;
  status: 'running' | 'completed' | 'error';
}

export function buildThinkingLiveBlocks(texts: string[]): Block[] {
  const blocks: Block[] = [
    {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: ':thought_balloon: _思考中..._' }],
    },
  ];
  for (const text of texts) {
    const snippet = truncate(text.trim(), 200);
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `_${escapeMarkdown(snippet)}_` }],
    });
  }
  return blocks;
}

export function buildToolGroupLiveBlocks(tools: LiveToolInfo[]): Block[] {
  const lines: string[] = [];
  for (const tool of tools) {
    const icon = tool.status === 'completed' ? DECORATION_ICONS.completed
      : tool.status === 'error' ? DECORATION_ICONS.error
      : DECORATION_ICONS.tool;
    const duration = tool.durationMs != null ? ` (${(tool.durationMs / 1000).toFixed(1)}s)` : '';
    const suffix = tool.status === 'running' ? ' — 実行中...' : duration;
    lines.push(`${icon} \`${tool.toolName}\` ${escapeMarkdown(tool.oneLiner)}${suffix}`);
  }
  return buildContextBlocksFromLines(lines);
}

export function buildSubagentLiveBlocks(description: string, steps: LiveStepInfo[]): Block[] {
  const headerBlock: Block = {
    type: 'context',
    elements: [{ type: 'mrkdwn', text: `:robot_face: *SubAgent:* _${escapeMarkdown(truncate(description, 60))}_ — 実行中...` }],
  };
  const stepLines: string[] = [];
  for (const step of steps) {
    const icon = step.status === 'completed' ? DECORATION_ICONS.completed
      : step.status === 'error' ? DECORATION_ICONS.error : DECORATION_ICONS.tool;
    stepLines.push(`  ${icon} \`${step.toolName}\` ${escapeMarkdown(step.oneLiner)}`);
  }
  const stepBlocks = buildContextBlocksFromLines(stepLines);
  return [headerBlock, ...stepBlocks];
}

function buildContextBlocksFromLines(lines: string[]): Block[] {
  const blocks: Block[] = [];
  for (let i = 0; i < lines.length; i += 10) {
    const chunk = lines.slice(i, i + 10);
    blocks.push({
      type: 'context',
      elements: chunk.map(line => ({ type: 'mrkdwn', text: line })),
    });
  }
  if (blocks.length === 0) {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: '実行中...' }],
    });
  }
  return blocks;
}

// --- Collapsed display blocks (1-line summary + detail button) ---

interface ToolCountSummary {
  toolName: string;
  count: number;
}

export function buildThinkingCollapsedBlocks(count: number, groupId: string): Block[] {
  const countStr = count > 1 ? ` (${count}回)` : '';
  return [
    {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `:thought_balloon: 思考完了${countStr}` }],
    },
    {
      type: 'actions',
      elements: [{
        type: 'button',
        text: { type: 'plain_text', text: '詳細を見る' },
        action_id: `view_group_detail:${groupId}`,
      }],
    },
  ];
}

export function buildToolGroupCollapsedBlocks(
  tools: ToolCountSummary[], totalDurationMs: number, groupId: string,
): Block[] {
  const toolStr = tools.map(t => `${t.toolName} × ${t.count}`).join(', ');
  const durationStr = `${(totalDurationMs / 1000).toFixed(1)}s`;
  return [
    {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `:wrench: ${toolStr} 完了 (${durationStr})` }],
    },
    {
      type: 'actions',
      elements: [{
        type: 'button',
        text: { type: 'plain_text', text: '詳細を見る' },
        action_id: `view_group_detail:${groupId}`,
      }],
    },
  ];
}

export function buildSubagentCollapsedBlocks(
  description: string, totalDurationMs: number, groupId: string,
): Block[] {
  const durationStr = `${(totalDurationMs / 1000).toFixed(1)}s`;
  return [
    {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `:robot_face: SubAgent: "${escapeMarkdown(truncate(description, 40))}" 完了 (${durationStr})` }],
    },
    {
      type: 'actions',
      elements: [{
        type: 'button',
        text: { type: 'plain_text', text: '詳細を見る' },
        action_id: `view_group_detail:${groupId}`,
      }],
    },
  ];
}

interface BundleCollapsedConfig {
  thinkingCount: number;
  toolCount: number;
  toolDurationMs: number;
  subagentCount: number;
  subagentDurationMs: number;
  sessionId: string;
  bundleIndex: number;
  bundleKey: string;
}

export function buildBundleCollapsedBlocks(config: BundleCollapsedConfig): Block[] {
  const parts: string[] = [];

  // Fixed order: 💭 → 🔧 → 🤖, only present categories
  if (config.thinkingCount > 0) {
    parts.push(`💭×${config.thinkingCount}`);
  }
  if (config.toolCount > 0) {
    const durationStr = `${(config.toolDurationMs / 1000).toFixed(1)}s`;
    parts.push(`🔧×${config.toolCount} (${durationStr})`);
  }
  if (config.subagentCount > 0) {
    const durationStr = `${(config.subagentDurationMs / 1000).toFixed(1)}s`;
    parts.push(`🤖×${config.subagentCount} (${durationStr})`);
  }

  return [
    {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: parts.join('  ') }],
    },
    {
      type: 'actions',
      elements: [{
        type: 'button',
        text: { type: 'plain_text', text: '詳細を見る' },
        action_id: `view_bundle:${config.sessionId}:${config.bundleKey}`,
      }],
    },
  ];
}
