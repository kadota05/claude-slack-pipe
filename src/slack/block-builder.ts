type Block = Record<string, any>;

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function getTimeAgo(date: Date): string {
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

export interface HomeTabV2Params {
  model: string;
  directoryId: string;
  directories: Array<{ id: string; name: string; path: string }>;
  activeSessions: Array<{
    cliSessionId: string;
    name: string;
    lastActiveAt: string;
    model: string;
    status: 'active';
    threadTs: string;
    channelId: string;
  }>;
  endedSessions: Array<{
    cliSessionId: string;
    name: string;
    lastActiveAt: string;
    model: string;
    status: 'ended';
    threadTs: string;
    channelId: string;
  }>;
  page: number;
  totalPages: number;
}

export function buildHomeTabBlocks(params: HomeTabV2Params): Block[] {
  const { model, directoryId, directories, activeSessions, endedSessions, page, totalPages } = params;

  const dirEntry = directories.find(d => d.id === directoryId);
  const dirName = dirEntry?.name ?? directoryId;

  const blocks: Block[] = [
    // 1. Header
    {
      type: 'header',
      text: { type: 'plain_text', text: 'Claude Code Bridge' },
    },
    // 2. Status bar
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `🟢 Bridge Running | Model: ${capitalize(model)} | Dir: ${dirName}`,
        },
      ],
    },
    // 3. Divider
    { type: 'divider' },
    // 4. Model setting
    {
      type: 'section',
      text: { type: 'mrkdwn', text: '*Default Model*' },
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
    // 5. Directory setting (only show if there are directories)
    ...(directories.length > 0 ? [{
      type: 'section' as const,
      text: { type: 'mrkdwn' as const, text: '*Working Directory*' },
      accessory: {
        type: 'static_select' as const,
        action_id: 'home_set_directory',
        ...(directoryId && dirEntry ? {
          initial_option: {
            text: { type: 'plain_text' as const, text: dirEntry.name || directoryId },
            value: directoryId,
          },
        } : {}),
        options: directories.map(d => ({
          text: { type: 'plain_text' as const, text: d.name || d.id },
          value: d.id,
        })),
      },
    }] : []),
    // 6. Divider
    { type: 'divider' },
    // 7. Usage Guide
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '*Usage Guide*\n1. Select a model and directory above\n2. Send a DM to this bot to start a session\n3. Use threads to continue conversations\n4. Use `/claude` slash command for quick tasks',
      },
    },
    // 8. Divider
    { type: 'divider' },
    // 9. Active Sessions header
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `*Active Sessions* (${activeSessions.length})` },
    },
  ];

  // Active session list
  if (activeSessions.length === 0) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: '_No active sessions_' },
    });
  } else {
    for (const s of activeSessions) {
      const ago = getTimeAgo(new Date(s.lastActiveAt));
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `:large_green_circle: *${s.name}*\nModel: ${capitalize(s.model)} | Last active: ${ago}`,
        },
        accessory: {
          type: 'button',
          text: { type: 'plain_text', text: 'Open' },
          action_id: 'open_session',
          value: s.cliSessionId,
        },
      });
    }
  }

  // 10. Divider
  blocks.push({ type: 'divider' });

  // 11. Recent (Ended) sessions header
  blocks.push({
    type: 'section',
    text: { type: 'mrkdwn', text: `*Recent Sessions* (${endedSessions.length})` },
  });

  if (endedSessions.length === 0) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: '_No recent sessions_' },
    });
  } else {
    for (const s of endedSessions) {
      const ago = getTimeAgo(new Date(s.lastActiveAt));
      blocks.push({
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: `:white_circle: *${s.name}* | ${capitalize(s.model)} | ${ago}`,
          },
        ],
      });
    }
  }

  // 12. Pagination
  if (totalPages > 1) {
    const paginationElements: Block[] = [];
    if (page > 0) {
      paginationElements.push({
        type: 'button',
        text: { type: 'plain_text', text: '← Prev' },
        action_id: 'session_page_prev',
        value: String(page - 1),
      });
    }
    paginationElements.push({
      type: 'button',
      text: { type: 'plain_text', text: `Page ${page + 1}/${totalPages}` },
      action_id: 'session_page_noop',
      value: String(page),
    });
    if (page < totalPages - 1) {
      paginationElements.push({
        type: 'button',
        text: { type: 'plain_text', text: 'Next →' },
        action_id: 'session_page_next',
        value: String(page + 1),
      });
    }
    blocks.push({
      type: 'actions',
      elements: paginationElements,
    });
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
  inputTokens: number;
  outputTokens: number;
  contextTokens: number;
  contextWindow: number;
  model: string;
  durationMs: number;
}): any[] {
  const ctxPct = (params.contextTokens / params.contextWindow) * 100;
  const ctxWindowLabel = params.contextWindow >= 1_000_000
    ? `${(params.contextWindow / 1_000_000).toFixed(0)}M`
    : `${(params.contextWindow / 1_000).toFixed(0)}k`;
  const text = `tokens in:${formatTokens(params.inputTokens)} out:${formatTokens(params.outputTokens)} | ctx ${formatTokens(params.contextTokens)}/${ctxWindowLabel}(${ctxPct.toFixed(1)}%) | ${params.model} | ${formatDuration(params.durationMs)}`;
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
