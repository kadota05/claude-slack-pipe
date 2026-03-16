import type { SessionMetadata } from '../types.js';

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

export function buildAnchorBlocks(session: SessionMetadata): Block[] {
  const isActive = session.status === 'active';
  const statusEmoji = isActive ? ':large_green_circle:' : ':white_circle:';
  const statusLabel = isActive ? 'Active Session' : 'Session Ended';
  const shortId = session.sessionId.substring(0, 8);
  const startTimeStr = session.startTime.toISOString().replace('T', ' ').substring(0, 16);
  const tokenPct = session.totalInputTokens > 0
    ? Math.round((session.totalInputTokens / 200_000) * 100)
    : 0;

  return [
    {
      type: 'header',
      text: { type: 'plain_text', text: session.name },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `${statusEmoji} *${statusLabel}*\n:file_folder: \`${session.projectPath}\``,
      },
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `Session: \`${shortId}\` | Start: ${startTimeStr} | :moneybag: $${session.totalCost.toFixed(2)}\n:bar_chart: ${session.totalInputTokens.toLocaleString()} / 200,000 tokens (${tokenPct}%)`,
        },
      ],
    },
    { type: 'divider' },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: '*Model*' },
      accessory: {
        type: 'static_select',
        action_id: 'set_model',
        initial_option: {
          text: { type: 'plain_text', text: capitalize(session.model) },
          value: session.model,
        },
        options: [
          { text: { type: 'plain_text', text: 'Opus' }, value: 'opus' },
          { text: { type: 'plain_text', text: 'Sonnet' }, value: 'sonnet' },
          { text: { type: 'plain_text', text: 'Haiku' }, value: 'haiku' },
        ],
      },
    },
    { type: 'divider' },
    {
      type: 'actions',
      block_id: 'session_controls',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Commands' },
          action_id: 'open_command_modal',
          value: shortId,
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: 'End Session' },
          action_id: 'end_session',
          value: shortId,
          confirm: {
            title: { type: 'plain_text', text: 'Confirm' },
            text: { type: 'mrkdwn', text: 'End this session?' },
            confirm: { type: 'plain_text', text: 'End' },
            deny: { type: 'plain_text', text: 'Cancel' },
          },
        },
      ],
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: 'Send a message in this thread to start | `cc /help` for commands',
        },
      ],
    },
  ];
}

export function buildCollapsedAnchorBlocks(session: SessionMetadata): Block[] {
  const statusEmoji = session.status === 'active'
    ? ':large_green_circle:'
    : ':white_circle:';
  const tokenPct = session.totalInputTokens > 0
    ? Math.round((session.totalInputTokens / 200_000) * 100)
    : 0;

  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `${statusEmoji} *${session.name}* | ${capitalize(session.model)} | ${tokenPct}% | $${session.totalCost.toFixed(2)}`,
      },
      accessory: {
        type: 'button',
        text: { type: 'plain_text', text: '\u25BC Expand' },
        action_id: 'toggle_anchor',
        value: 'expand',
      },
    },
  ];
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

export function buildHomeTabBlocks(
  projects: Array<{ id: string; projectPath: string; sessionCount: number }>,
  activeSessions: Array<{ name: string; sessionId: string; lastActiveAt: Date; threadTs: string; dmChannelId: string }>,
): Block[] {
  const blocks: Block[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: 'Claude Code Bridge' },
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: ':large_green_circle: Bridge Running' },
    },
    { type: 'divider' },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: '*Projects*' },
    },
  ];

  if (projects.length === 0) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: '_No projects found in .claude/projects/_' },
    });
  } else {
    for (const project of projects) {
      const displayName = project.projectPath.split('/').pop() || project.id;
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `:file_folder: *${displayName}*\n\`${project.projectPath}\``,
        },
        accessory: {
          type: 'button',
          text: { type: 'plain_text', text: 'New Session' },
          action_id: 'new_session',
          value: project.id,
        },
      });
    }
  }

  blocks.push({ type: 'divider' });
  blocks.push({
    type: 'section',
    text: { type: 'mrkdwn', text: '*Active Sessions*' },
  });

  if (activeSessions.length === 0) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: '_No active sessions_' },
    });
  } else {
    for (const s of activeSessions) {
      const ago = getTimeAgo(s.lastActiveAt);
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `:large_green_circle: *${s.name}*\nSession: \`${s.sessionId.substring(0, 8)}\` | Last active: ${ago}`,
        },
        accessory: {
          type: 'button',
          text: { type: 'plain_text', text: 'Open Thread' },
          action_id: 'open_thread',
          value: JSON.stringify({ channel: s.dmChannelId, ts: s.threadTs }),
        },
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
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  model: string;
  durationMs: number;
}): any[] {
  const text = `📊 ${formatTokens(params.inputTokens)}→${formatTokens(params.outputTokens)} tokens | $${params.costUsd.toFixed(3)} | ${params.model} | ${formatDuration(params.durationMs)}`;
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
  return `📋 Session Started\n📁 ${params.projectPath}\nModel: ${params.model} | Session: ${params.sessionId}`;
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
