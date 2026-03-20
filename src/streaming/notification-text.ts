// src/streaming/notification-text.ts

/**
 * Decoration icons — used ONLY inside message body blocks.
 * Never overlaps with reaction emojis (hourglass_flowing_sand, brain, white_check_mark).
 */
export const DECORATION_ICONS = {
  completed: '✓',
  error: '✗',
  thinking: ':thought_balloon:',
  tool: ':wrench:',
  subagent: ':robot_face:',
} as const;

interface ToolLike {
  toolName: string;
}

interface CollapsedConfig {
  thinkingCount: number;
  toolCount: number;
  toolDurationMs: number;
  subagentCount: number;
  subagentDurationMs: number;
}

function formatDuration(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

export const notifyText = {
  /** postMessage text for response footer (triggers notification) */
  footer(model: string, durationMs: number): string {
    return `complete ${formatDuration(durationMs)}`;
  },

  /** postMessage/update text for text responses */
  text(buffer: string): string {
    return buffer.slice(0, 100);
  },

  update: {
    thinking(): string {
      return '💭 思考中';
    },

    tools(tools: ToolLike[]): string {
      const names = tools.map(t => t.toolName).join(', ');
      return `🔧 ${names}`;
    },

    collapsed(config: CollapsedConfig): string {
      const parts: string[] = [];
      if (config.thinkingCount > 0) {
        parts.push(`💭×${config.thinkingCount}`);
      }
      if (config.toolCount > 0) {
        parts.push(`🔧×${config.toolCount} (${formatDuration(config.toolDurationMs)})`);
      }
      if (config.subagentCount > 0) {
        parts.push(`🤖×${config.subagentCount} (${formatDuration(config.subagentDurationMs)})`);
      }
      return parts.join('  ');
    },

    pending(): string {
      return '...';
    },
  },
} as const;
