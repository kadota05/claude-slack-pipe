// src/streaming/tool-formatter.ts

type Block = Record<string, unknown>;

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
        text: `:hourglass_flowing_sand: \`${toolName}\` ${escapeMarkdown(oneLiner)}`,
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
  const icon = isError ? ':x:' : ':white_check_mark:';
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
