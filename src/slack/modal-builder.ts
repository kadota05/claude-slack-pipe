// src/slack/modal-builder.ts

interface ToolModalConfig {
  toolId: string;
  toolName: string;
  input: Record<string, unknown>;
  result: string;
  durationMs: number;
  isError: boolean;
}

type Block = Record<string, unknown>;

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
