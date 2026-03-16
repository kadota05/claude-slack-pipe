// src/slack/modal-builder.ts
import type { Block } from '../streaming/types.js';
import type { SubagentConversationFlow } from '../streaming/subagent-jsonl-reader.js';
import type { BundleEntry } from '../streaming/session-jsonl-reader.js';

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
    });
    blocks.push({
      type: 'actions',
      elements: [{
        type: 'button',
        text: { type: 'plain_text', text: '詳細を見る' },
        action_id: `view_tool_detail:${tool.toolUseId}`,
      }],
    });
  }

  return {
    type: 'modal',
    title: { type: 'plain_text', text: 'ツール実行詳細' },
    close: { type: 'plain_text', text: '閉じる' },
    blocks: blocks.slice(0, 100),
  };
}

export function buildSubagentModal(
  description: string,
  flow: SubagentConversationFlow | null,
): any {
  const blocks: Block[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: truncate(`SubAgent: ${description}`, 24) },
    },
  ];

  if (!flow) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: 'SubAgent詳細を取得できませんでした。' },
    });
    return {
      type: 'modal',
      title: { type: 'plain_text', text: 'SubAgent詳細' },
      close: { type: 'plain_text', text: '閉じる' },
      blocks,
    };
  }

  blocks.push({
    type: 'section',
    text: { type: 'mrkdwn', text: `*プロンプト:*\n_${flow.systemPromptSummary}_` },
  });
  blocks.push({ type: 'divider' });

  for (const step of flow.steps) {
    if (step.type === 'tool_use' && step.toolName) {
      const sectionBlock: Block = {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `:wrench: \`${step.toolName}\` ${step.oneLiner || ''}`,
        },
      };
      if (step.toolUseId) {
        sectionBlock.accessory = {
          type: 'button',
          text: { type: 'plain_text', text: '詳細' },
          action_id: `view_tool_detail:${step.toolUseId}`,
        };
      }
      blocks.push(sectionBlock);
    } else if (step.type === 'tool_result') {
      const icon = step.isError ? ':x:' : ':white_check_mark:';
      blocks.push({
        type: 'context',
        elements: [{ type: 'mrkdwn', text: `${icon} ${step.resultSummary || '完了'}` }],
      });
    }
  }

  blocks.push({ type: 'divider' });
  blocks.push({
    type: 'section',
    text: { type: 'mrkdwn', text: `*最終結果:*` },
  });

  const resultParts = splitContent(flow.finalResult, 2900);
  for (const part of resultParts) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: part },
    });
  }

  return {
    type: 'modal',
    title: { type: 'plain_text', text: 'SubAgent詳細' },
    close: { type: 'plain_text', text: '閉じる' },
    blocks: blocks.slice(0, 100),
  };
}

export function buildBundleDetailModal(entries: BundleEntry[], sessionId: string): any {
  const blocks: Block[] = [
    { type: 'header', text: { type: 'plain_text', text: 'アクション詳細' } },
  ];

  for (const [i, entry] of entries.entries()) {
    if (i > 0) blocks.push({ type: 'divider' });

    if (entry.type === 'thinking') {
      const preview = truncate(entry.texts.join(' '), 50);
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: `💭 _${preview}_` },
      });
    } else if (entry.type === 'tool') {
      const durationStr = `${(entry.durationMs / 1000).toFixed(1)}s`;
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: `🔧 \`${entry.toolName}\` ${entry.oneLiner} (${durationStr})` },
        accessory: {
          type: 'button',
          text: { type: 'plain_text', text: '詳細を見る' },
          action_id: `view_tool_detail:${sessionId}:${entry.toolUseId}`,
        },
      });
    } else if (entry.type === 'subagent') {
      const durationStr = `${(entry.durationMs / 1000).toFixed(1)}s`;
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: `🤖 SubAgent: "${entry.description}" (${durationStr})` },
        accessory: {
          type: 'button',
          text: { type: 'plain_text', text: '詳細を見る' },
          action_id: `view_subagent_detail:${sessionId}:${entry.toolUseId}`,
        },
      });
    }
  }

  return {
    type: 'modal',
    title: { type: 'plain_text', text: 'アクション詳細' },
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
