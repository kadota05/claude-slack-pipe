// ============================================================
// Streaming Type Definitions
// ============================================================
import type { TokenUsage } from '../types.js';

// --- SlackAction: Executorに渡すアクション指示 ---

export type SlackActionType = 'postMessage' | 'update' | 'addReaction' | 'removeReaction';

export interface SlackAction {
  type: SlackActionType;
  priority: 1 | 2 | 3 | 4 | 5;
  channel: string;
  threadTs: string;
  blocks?: Record<string, unknown>[];
  text?: string;
  messageTs?: string;
  emoji?: string;
  targetTs?: string;
  metadata: SlackActionMetadata;
}

export interface SlackActionMetadata {
  messageType: 'thinking' | 'tool_use' | 'text' | 'result' | 'subagent' | 'status';
  toolUseId?: string;
  toolName?: string;
}

// --- StreamProcessor State ---

export type StreamPhase = 'idle' | 'thinking' | 'tool_executing' | 'responding' | 'completed';

export interface StreamProcessorState {
  phase: StreamPhase;
  thinkingCount: number;
  lastThinkingText: string | null;
  firstThinkingTs: string | null;
  activeToolUses: Map<string, ToolUseTracker>;
  cumulativeToolCount: number;
  textMessageTs: string | null;
  textBuffer: string;
  turnStartTime: number;
}

export interface ToolUseTracker {
  toolUseId: string;
  toolName: string;
  input: Record<string, unknown>;
  messageTs: string | null;
  startTime: number;
  status: 'running' | 'completed' | 'error';
  result?: string;
  isError?: boolean;
  durationMs?: number;
}

// --- Rate Limit ---

export type SlackApiMethod = 'postMessage' | 'update' | 'addReaction' | 'removeReaction';

export interface RateLimitBucket {
  method: SlackApiMethod;
  limit: number;
  timestamps: number[];
}

export type DegradationLevel = 'NORMAL' | 'CAUTION' | 'THROTTLE' | 'CRITICAL' | 'EMERGENCY';

// --- Executor Result ---

export interface ExecutorResult {
  ok: boolean;
  ts?: string;
  error?: string;
  retryAfterMs?: number;
}

// --- Stream Event (from --include-partial-messages) ---

export interface StreamEventWrapper {
  type: 'stream_event';
  event: StreamEventPayload;
  session_id: string;
  parent_tool_use_id: string | null;
}

export type StreamEventPayload =
  | { type: 'message_start'; message: Record<string, unknown> }
  | { type: 'content_block_start'; index: number; content_block: ContentBlockStart }
  | { type: 'content_block_delta'; index: number; delta: ContentBlockDelta }
  | { type: 'content_block_stop'; index: number }
  | { type: 'message_delta'; delta: Record<string, unknown>; usage?: Record<string, unknown> }
  | { type: 'message_stop' };

export interface ContentBlockStart {
  type: 'thinking' | 'text' | 'tool_use';
  id?: string;       // tool_use only
  name?: string;     // tool_use only
  thinking?: string;
  text?: string;
}

export interface ContentBlockDelta {
  type: 'thinking_delta' | 'text_delta' | 'input_json_delta' | 'signature_delta';
  thinking?: string;
  text?: string;
  partial_json?: string;
  signature?: string;
}

// --- Group Tracking ---

export type GroupCategory = 'thinking' | 'tool' | 'subagent';

export interface GroupToolInfo {
  toolUseId: string;
  toolName: string;
  input: Record<string, unknown>;
  oneLiner: string;
  status: 'running' | 'completed' | 'error';
  startTime: number;   // Date.now() when tool_use received
  durationMs?: number;
  result?: string;
  isError?: boolean;
}

export interface GroupStepInfo {
  toolName: string;
  toolUseId: string;
  oneLiner: string;
  status: 'running' | 'completed' | 'error';
}

export interface ActiveGroup {
  id: string;
  category: GroupCategory;
  messageTs: string | null;
  startTime: number;
  lastUpdateTime: number;

  // thinking
  thinkingTexts: string[];

  // tool
  tools: GroupToolInfo[];

  // subagent
  agentToolUseId?: string;
  agentDescription?: string;
  agentId?: string; // extracted from tool_result for JSONL lookup
  agentSteps: GroupStepInfo[];
}


export interface CompletedGroup {
  category: GroupCategory;
  // thinking
  thinkingTexts?: string[];
  // tool
  tools?: GroupToolInfo[];
  totalDuration?: number;
  // subagent
  agentToolUseId?: string;
  agentDescription?: string;
  agentId?: string;
  agentSteps?: GroupStepInfo[];
  duration?: number;
}

export type BundleAction =
  | { type: 'postMessage'; bundleId: string; bundleIndex: number; blocks: Block[]; text: string }
  | { type: 'update'; bundleId: string; bundleIndex: number; messageTs: string; blocks: Block[]; text: string }
  | { type: 'collapse'; bundleId: string; bundleIndex: number; bundleKey: string; messageTs: string | null; blocks: Block[]; text: string; sessionId?: string };

export interface ProcessedActions {
  bundleActions: BundleAction[];
  textAction?: SlackAction;
  resultEvent?: any;
  lastMainUsage?: TokenUsage | null;
}

// Reusable block type
export type Block = Record<string, unknown>;
