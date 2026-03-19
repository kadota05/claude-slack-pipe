type Block = Record<string, any>;

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function getTimeAgo(date: Date): string {
  const diffMs = Date.now() - date.getTime();
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  return `${Math.floor(diffHours / 24)}d ago`;
}

export interface ErrorBlocksParams {
  errorMessage: string;
  sessionId: string;
  exitCode?: number | null;
  durationSec?: number;
  originalPromptHash?: string;
}

export function buildErrorBlocks(params: ErrorBlocksParams): Block[] {
  const blocks: Block[] = [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: ':x: *An error occurred*' },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `\`\`\`\n${params.errorMessage}\n\`\`\``,
      },
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `Exit code: ${params.exitCode ?? 'N/A'} | Duration: ${params.durationSec?.toFixed(1) ?? 'N/A'}s | Session: \`${params.sessionId.substring(0, 8)}\``,
        },
      ],
    },
  ];

  if (params.originalPromptHash) {
    blocks.push({
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Retry' },
          action_id: 'retry_prompt',
          value: params.originalPromptHash,
        },
      ],
    });
  }

  return blocks;
}

export interface ResultBlocksParams {
  text: string;
  durationSec: number;
  costUsd: number;
  turnCount: number;
  model: string;
  changedFiles?: string;
}

export function buildResultBlocks(params: ResultBlocksParams): Block[] {
  const blocks: Block[] = [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: params.text },
    },
  ];

  if (params.changedFiles) {
    blocks.push(
      { type: 'divider' },
      {
        type: 'context',
        elements: [
          { type: 'mrkdwn', text: `:file_folder: Changes: ${params.changedFiles}` },
        ],
      },
    );
  }

  blocks.push({
    type: 'context',
    elements: [
      {
        type: 'mrkdwn',
        text: `:stopwatch: ${params.durationSec}s | :moneybag: $${params.costUsd.toFixed(3)} | :arrows_counterclockwise: ${params.turnCount} turns | :bar_chart: Model: ${params.model}`,
      },
    ],
  });

  return blocks;
}

export interface HomeTabParams {
  model: string;
  directoryId: string;
  directories: Array<{ id: string; name: string; path: string }>;
  recentSessions: Array<{
    timeAgo: string;
    firstPromptPreview: string;
    projectPath: string;
  }>;
}

export function buildHomeTabBlocks(params: HomeTabParams): Block[] {
  const { model, directoryId, directories, recentSessions } = params;

  const blocks: Block[] = [
    // 1. Model selector
    {
      type: 'section',
      text: { type: 'mrkdwn', text: '*Model*' },
      accessory: {
        type: 'static_select',
        action_id: 'home_set_default_model',
        initial_option: {
          text: { type: 'plain_text', text: capitalize(model) },
          value: model,
        },
        options: [
          { text: { type: 'plain_text', text: 'Opus' }, value: 'opus' },
          { text: { type: 'plain_text', text: 'Sonnet' }, value: 'sonnet' },
          { text: { type: 'plain_text', text: 'Haiku' }, value: 'haiku' },
        ],
      },
    },
    // 3. Directory selector
    ...(directories.length > 0 ? [{
      type: 'section' as const,
      text: { type: 'mrkdwn' as const, text: '*Directory*' },
      accessory: {
        type: 'static_select' as const,
        action_id: 'home_set_directory',
        ...(directoryId && directories.find(d => d.id === directoryId) ? {
          initial_option: {
            text: { type: 'plain_text' as const, text: directories.find(d => d.id === directoryId)!.name },
            value: directoryId,
          },
        } : {}),
        options: directories.map(d => ({
          text: { type: 'plain_text' as const, text: d.name || d.id },
          value: d.id,
        })),
      },
    }] : []),
    // 4. Divider
    { type: 'divider' },
    // 5. Recent Sessions header
    {
      type: 'context',
      elements: [
        { type: 'mrkdwn', text: '— *Recent Sessions* —' },
      ],
    },
  ];

  // 6. Recent session entries
  if (recentSessions.length === 0) {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: '_No recent sessions_' }],
    });
  } else {
    for (let i = 0; i < recentSessions.length; i++) {
      const s = recentSessions[i];
      if (i > 0) {
        blocks.push({ type: 'divider' });
      }
      blocks.push({
        type: 'context',
        elements: [
          { type: 'mrkdwn', text: `*${s.firstPromptPreview}*\n:clock1: ${s.timeAgo}  |  :file_folder: ${s.projectPath}` },
        ],
      });
    }
  }

  return blocks;
}

function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function formatDuration(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

export function buildResponseFooter(params: {
  contextUsed: number;
  contextWindow: number;
  model: string;
  durationMs: number;
  isApproximate?: boolean;
}): any[] {
  const capped = Math.min(params.contextUsed, params.contextWindow);
  const ctxPct = (capped / params.contextWindow) * 100;
  const ctxWindowLabel = params.contextWindow >= 1_000_000
    ? `${(params.contextWindow / 1_000_000).toFixed(0)}M`
    : `${(params.contextWindow / 1_000).toFixed(0)}k`;
  const approx = params.isApproximate ? '~' : '';
  const text = `ctx ${approx}${formatTokens(capped)}/${ctxWindowLabel}(${ctxPct.toFixed(1)}%) | ${params.model} | ${formatDuration(params.durationMs)}`;
  return [{
    type: 'context',
    elements: [{ type: 'mrkdwn', text }],
  }];
}

export function buildThreadHeaderText(params: {
  projectPath: string;
  model: string;
  sessionId: string;
}): string {
  return `*Session Started*\nDir: \`${params.projectPath}\`\nID: \`${params.sessionId}\``;
}

export function buildStreamingBlocks(params: {
  text: string;
  isComplete: boolean;
}): any[] {
  const blocks: any[] = [];
  if (params.text) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: params.text.slice(0, 3000) },
    });
  }
  if (!params.isComplete) {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: '⏳ _応答中..._' }],
    });
  }
  return blocks;
}
