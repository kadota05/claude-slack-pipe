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
  const blocks: Block[] = [];

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
  const blocks: Block[] = [];

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
  const blocks: Block[] = [];

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
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `:wrench: \`${step.toolName}\` ${step.oneLiner || ''}`,
        },
      });
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

export function buildBundleDetailModal(entries: BundleEntry[], sessionId: string, bundleKey: string): any {
  const blocks: Block[] = [];
  const buttons: Block[] = [];
  let thinkingIndex = 0;

  for (const entry of entries) {
    if (entry.type === 'thinking') {
      const preview = truncate(entry.texts.join(' '), 40);
      buttons.push({
        type: 'button',
        text: { type: 'plain_text', text: truncate(`💭 ${preview}`, 72) },
        action_id: `view_thinking_detail:${sessionId}:${bundleKey}:${thinkingIndex}`,
      });
      thinkingIndex++;
    } else if (entry.type === 'tool') {
      const durationStr = `${(entry.durationMs / 1000).toFixed(1)}s`;
      buttons.push({
        type: 'button',
        text: { type: 'plain_text', text: truncate(`🔧 ${entry.toolName} ${entry.oneLiner} (${durationStr})`, 72) },
        action_id: `view_tool_detail:${sessionId}:${entry.toolUseId}`,
      });
    } else if (entry.type === 'subagent') {
      const durationStr = `${(entry.durationMs / 1000).toFixed(1)}s`;
      buttons.push({
        type: 'button',
        text: { type: 'plain_text', text: truncate(`🤖 SubAgent: "${entry.description}" (${durationStr})`, 72) },
        action_id: `view_subagent_detail:${sessionId}:${entry.toolUseId}`,
      });
    }
  }

  // Split buttons into actions blocks (max 25 per block)
  for (let i = 0; i < buttons.length; i += 25) {
    blocks.push({
      type: 'actions',
      elements: buttons.slice(i, i + 25),
    });
  }

  return {
    type: 'modal',
    title: { type: 'plain_text', text: 'アクション詳細' },
    close: { type: 'plain_text', text: '閉じる' },
    blocks: blocks.slice(0, 100),
  };
}

const LINES_PER_CHUNK = 100;

export function buildFileContentModal(filePath: string, content: string): any {
  const blocks: Block[] = [];
  const fileName = filePath.split('/').pop() || filePath;

  // Use plain_text to avoid all mrkdwn escaping issues with file content
  const parts = splitContent(content, 2950);
  for (const part of parts) {
    blocks.push({
      type: 'section',
      text: { type: 'plain_text', text: part },
    });
  }

  return {
    type: 'modal',
    title: { type: 'plain_text', text: truncate(fileName, 24) },
    close: { type: 'plain_text', text: '閉じる' },
    blocks: blocks.slice(0, 100),
  };
}

export function buildFileChunksModal(filePath: string, totalLines: number): any {
  const blocks: Block[] = [];
  const fileName = filePath.split('/').pop() || filePath;

  blocks.push({
    type: 'section',
    text: { type: 'mrkdwn', text: `:page_facing_up: \`${filePath}\` (${totalLines}行)` },
  });
  blocks.push({ type: 'divider' });

  const buttons: any[] = [];
  for (let start = 1; start <= totalLines; start += LINES_PER_CHUNK) {
    const end = Math.min(start + LINES_PER_CHUNK - 1, totalLines);
    const index = buttons.length;
    buttons.push({
      type: 'button',
      text: { type: 'plain_text', text: `${start}-${end}行` },
      action_id: `view_file_chunk:${index}`,
      value: `${filePath}:${start}:${end}`,
    });
  }

  for (let i = 0; i < buttons.length; i += 25) {
    blocks.push({
      type: 'actions',
      elements: buttons.slice(i, i + 25),
    });
  }

  return {
    type: 'modal',
    title: { type: 'plain_text', text: truncate(fileName, 24) },
    close: { type: 'plain_text', text: '閉じる' },
    blocks: blocks.slice(0, 100),
  };
}

export function buildFileChunkModal(filePath: string, content: string, startLine: number, endLine: number): any {
  const blocks: Block[] = [];
  const fileName = filePath.split('/').pop() || filePath;

  const parts = splitContent(content, 2950);
  for (const part of parts) {
    blocks.push({
      type: 'section',
      text: { type: 'plain_text', text: part },
    });
  }

  return {
    type: 'modal',
    title: { type: 'plain_text', text: truncate(`${fileName} ${startLine}-${endLine}`, 24) },
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
  return s.slice(0, max - 1) + '…';
}
