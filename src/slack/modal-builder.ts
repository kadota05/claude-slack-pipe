// src/slack/modal-builder.ts
import type { Block } from '../streaming/types.js';

interface ToolModalConfig {
  toolId: string;
  toolName: string;
  input: Record<string, unknown>;
  result: string;
  durationMs: number;
  isError: boolean;
}

export function buildToolModal(config: ToolModalConfig): any {
  const titleText = truncate(`${config.toolName} 詳細`, 24);
  const icon = config.isError ? ':x:' : ':white_check_mark:';
  const durationStr = `${(config.durationMs / 1000).toFixed(1)}s`;

  const blocks: Block[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: config.toolName },
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `*入力:*\n\`\`\`\n${formatInput(config.toolName, config.input)}\n\`\`\`` },
    },
    { type: 'divider' },
    {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `${icon} ${durationStr}` }],
    },
  ];

  const resultParts = splitContent(config.result, 2900);
  for (const [i, part] of resultParts.entries()) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `\`\`\`\n${part}\n\`\`\`` },
    });
    if (i < resultParts.length - 1) {
      blocks.push({ type: 'divider' });
    }
  }

  return {
    type: 'modal',
    title: { type: 'plain_text', text: titleText },
    close: { type: 'plain_text', text: '閉じる' },
    blocks,
  };
}

export function buildThinkingModal(thinkingTexts: string[]): any {
  const blocks: Block[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: '思考詳細' },
    },
  ];

  for (const [i, text] of thinkingTexts.entries()) {
    if (i > 0) {
      blocks.push({ type: 'divider' });
    }

    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `*思考 ${i + 1}*` }],
    });

    const parts = splitContent(text, 2900);
    for (const part of parts) {
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: part },
      });
    }
  }

  return {
    type: 'modal',
    title: { type: 'plain_text', text: '思考詳細' },
    close: { type: 'plain_text', text: '閉じる' },
    blocks: blocks.slice(0, 100),
  };
}

interface ToolGroupModalItem {
  toolUseId: string;
  toolName: string;
  oneLiner: string;
  durationMs: number;
  isError: boolean;
}

export function buildToolGroupModal(tools: ToolGroupModalItem[]): any {
  const blocks: Block[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: 'ツール実行詳細' },
    },
  ];

  for (const tool of tools) {
    const icon = tool.isError ? ':x:' : ':white_check_mark:';
    const durationStr = `${(tool.durationMs / 1000).toFixed(1)}s`;

    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `${icon} \`${tool.toolName}\` ${tool.oneLiner} (${durationStr})`,
      },
      accessory: {
        type: 'button',
        text: { type: 'plain_text', text: '詳細' },
        action_id: `view_tool_detail:${tool.toolUseId}`,
      },
    });
  }

  return {
    type: 'modal',
    title: { type: 'plain_text', text: 'ツール実行詳細' },
    close: { type: 'plain_text', text: '閉じる' },
    blocks: blocks.slice(0, 100),
  };
}

function formatInput(toolName: string, input: Record<string, unknown>): string {
  switch (toolName) {
    case 'Read':
      return String(input.file_path || '');
    case 'Edit':
      return `${input.file_path || ''}\nold: ${truncate(String(input.old_string || ''), 100)}\nnew: ${truncate(String(input.new_string || ''), 100)}`;
    case 'Write':
      return String(input.file_path || '');
    case 'Bash':
      return String(input.command || '');
    case 'Grep':
      return `pattern: ${input.pattern || ''}\npath: ${input.path || '.'}`;
    case 'Glob':
      return `pattern: ${input.pattern || ''}`;
    default:
      return JSON.stringify(input, null, 2).slice(0, 500);
  }
}

function splitContent(content: string, maxPerSection: number): string[] {
  if (content.length <= maxPerSection) return [content];
  const parts: string[] = [];
  for (let i = 0; i < content.length; i += maxPerSection) {
    parts.push(content.slice(i, i + maxPerSection));
  }
  return parts;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + '...';
}
