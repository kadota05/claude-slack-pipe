// ============================================================
// 5.1 Session Metadata
// ============================================================

export type ModelChoice = 'opus' | 'sonnet' | 'haiku';

export interface SessionMetadata {
  sessionId: string;
  threadTs: string;
  dmChannelId: string;
  projectPath: string;
  name: string;
  model: ModelChoice;
  status: 'active' | 'ended';
  startTime: Date;
  totalCost: number;
  turnCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  lastActiveAt: Date;
}

// ============================================================
// 5.3 Stream Processing (see src/streaming/types.ts)
// ============================================================

export type { StreamProcessorState, ToolUseTracker } from './streaming/types.js';

// ============================================================
// 5.4 Command Parser (see src/slack/command-parser.ts for ParsedCommand)
// ============================================================

// ============================================================
// 5.5 Project / Session Info
// ============================================================

export interface ProjectInfo {
  id: string;
  projectPath: string;       // Claude metadata dir: ~/.claude/projects/<encoded>
  workingDirectory: string;   // Actual project CWD decoded from id
  sessionCount: number;
  lastModified: Date;
}

export interface SessionInfoLight {
  sessionId: string;
  updatedAt: Date;
  sizeBytes: number;
}

export interface SessionInfo {
  sessionId: string;
  projectId: string;
  firstPrompt: string | null;
  lastPrompt: string | null;
  customTitle: string | null;
  createdAt: Date;
  updatedAt: Date;
  fileSizeBytes: number;
}

// ============================================================
// 5.6 JSONL Session Log Types
// ============================================================

export interface BaseEntry {
  parentUuid: string | null;
  isSidechain: boolean;
  userType: 'external' | 'internal';
  cwd: string;
  sessionId: string;
  version: string;
  uuid: string;
  timestamp: string;
  gitBranch?: string;
  isMeta?: boolean;
  agentId?: string;
  isCompactSummary?: boolean;
  logicalParentUuid?: string;
  slug?: string;
}

export interface ThinkingContent {
  type: 'thinking';
  thinking: string;
  signature: string;
}

export interface TextContent {
  type: 'text';
  text: string;
}

export interface ToolUseContent {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
  caller?: string;
}

export interface ToolResultContent {
  type: 'tool_result';
  tool_use_id: string;
  content: string | Array<unknown>;
}

export interface ImageContent {
  type: 'image';
  source: { type: string; media_type: string; data: string };
}

export interface DocumentContent {
  type: 'document';
  source: { type: string; media_type: string; data: string };
}

export type AssistantContentBlock = ThinkingContent | TextContent | ToolUseContent;
export type UserContentBlock = string | TextContent | ToolResultContent | ImageContent | DocumentContent;

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  cache_creation?: {
    ephemeral_5m_input_tokens: number;
    ephemeral_1h_input_tokens: number;
  };
  service_tier?: string;
  inference_geo?: string;
}

export interface AssistantMessage {
  model: string;
  id: string;
  type: 'message';
  role: 'assistant';
  content: AssistantContentBlock[];
  stop_reason: 'end_turn' | 'tool_use' | 'max_tokens' | null;
  stop_sequence: string | null;
  usage: TokenUsage;
}

export interface UserMessage {
  role: 'user';
  content: string | UserContentBlock[];
}

export interface UserEntry extends BaseEntry {
  type: 'user';
  message: UserMessage;
}

export interface AssistantEntry extends BaseEntry {
  type: 'assistant';
  message: AssistantMessage;
  requestId?: string;
  isApiErrorMessage?: boolean;
}

export interface TurnDurationEntry extends BaseEntry {
  type: 'system';
  subtype: 'turn_duration';
  durationMs: number;
}

export interface CompactBoundaryEntry extends BaseEntry {
  type: 'system';
  subtype: 'compact_boundary';
  content: string;
  level: string;
  compactMetadata?: {
    trigger: 'manual' | 'auto';
    preTokens: number;
  };
}

export interface StopHookSummaryEntry extends BaseEntry {
  type: 'system';
  subtype: 'stop_hook_summary';
  hookCount: number;
  hookInfos: unknown[];
  preventedContinuation: boolean;
}

export interface LocalCommandEntry extends BaseEntry {
  type: 'system';
  subtype: 'local_command';
  content: string;
  level: string;
}

export interface ApiErrorEntry extends BaseEntry {
  type: 'system';
  subtype: 'api_error';
  statusCode: number;
  requestId?: string;
}

export type SystemEntry =
  | TurnDurationEntry
  | CompactBoundaryEntry
  | StopHookSummaryEntry
  | LocalCommandEntry
  | ApiErrorEntry;

export interface ProgressEntry extends BaseEntry {
  type: 'progress';
  data: {
    type: 'hook_progress' | 'agent_progress' | 'bash_progress' | 'waiting_for_task';
    [key: string]: unknown;
  };
  toolUseID?: string;
  parentToolUseID?: string;
}

export interface FileHistorySnapshotEntry {
  type: 'file-history-snapshot';
  messageId: string;
  snapshot: {
    messageId: string;
    trackedFileBackups: Record<string, unknown>;
    timestamp: string;
  };
  isSnapshotUpdate: boolean;
}

export interface QueueOperationEntry {
  type: 'queue-operation';
  operation: 'enqueue' | 'dequeue' | 'remove' | 'popAll';
  timestamp: string;
  sessionId: string;
  content?: string | unknown[];
}

export interface SummaryEntry {
  type: 'summary';
  summary: string;
  leafUuid: string;
}

export interface CustomTitleEntry {
  type: 'custom-title';
  customTitle: string;
  sessionId: string;
}

export interface AgentNameEntry {
  type: 'agent-name';
  agentName: string;
  sessionId: string;
}

export type SessionLogEntry =
  | UserEntry
  | AssistantEntry
  | SystemEntry
  | ProgressEntry
  | FileHistorySnapshotEntry
  | QueueOperationEntry
  | SummaryEntry
  | CustomTitleEntry
  | AgentNameEntry;

// ============================================================
// 5.7 Session File Metadata
// ============================================================

export interface CostBreakdown {
  totalUsd: number;
  inputCostUsd: number;
  outputCostUsd: number;
  cacheCreationCostUsd: number;
  cacheReadCostUsd: number;
}

export interface TokenSummary {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}

export interface SessionMeta {
  sessionId: string;
  projectPath: string;
  firstUserMessage: string;
  messageCount: number;
  firstTimestamp: string;
  lastTimestamp: string;
  totalCost: CostBreakdown;
  totalTokens: TokenSummary;
  modelName: string | null;
  version: string;
  slug?: string;
}

// ============================================================
// 5.8 CLI --output-format json Output
// ============================================================

export interface ClaudeResultOutput {
  type: 'result';
  subtype: 'success' | 'error';
  result: string;
  session_id: string;
  total_cost_usd: number;
  duration_ms: number;
  stop_reason: string;
}

// ============================================================
// 5.9 Active Session File
// ============================================================

export interface ActiveSessionFile {
  pid: number;
  sessionId: string;
  cwd: string;
  startedAt: number;
}

// ============================================================
// Security Config
// ============================================================

export interface SecurityConfig {
  allowedUserIds: string[];
  allowedTeamIds: string[];
  adminUserIds: string[];
}

// ============================================================
// Phase 2: Persistent Process Types
// ============================================================

export type SessionState = 'not_started' | 'starting' | 'idle' | 'processing' | 'ending' | 'dead';

export interface SessionStartParams {
  sessionId: string;
  model: string;
  projectPath: string;
  isResume: boolean;
  bridgeContext?: string;
}

export interface ControlMessage {
  type: 'control';
  subtype: 'set_model' | 'interrupt' | 'can_use_tool' | 'keep_alive' | 'set_permission_mode';
  [key: string]: unknown;
}

export interface StdinUserMessage {
  type: 'user';
  message: {
    role: 'user';
    content: Array<{ type: 'text'; text: string }>;
  };
}

export type StdinMessage = ControlMessage | StdinUserMessage;

export interface StreamEvent {
  type: 'assistant' | 'system' | 'user' | 'result';
  subtype?: string;
  [key: string]: unknown;
}

export interface ResultEvent extends StreamEvent {
  type: 'result';
  result?: string;
  total_cost_usd?: number;
  duration_ms?: number;
  usage?: TokenUsage;
  session_id?: string;
}

export interface SystemInitEvent extends StreamEvent {
  type: 'system';
  subtype: 'init';
  session_id?: string;
}

// ============================================================
// Phase 2: User Preferences
// ============================================================

export interface UserPreferences {
  defaultModel: string;
  activeDirectoryId: string | null;
  starredDirectoryIds: string[];
}

export interface UserPreferenceFile {
  version: 1;
  users: Record<string, UserPreferences>;
}

// ============================================================
// Phase 2: Session Index Types
// ============================================================

export interface SessionIndexEntry {
  cliSessionId: string;
  threadTs: string;
  channelId: string;
  userId: string;
  projectPath: string;
  name: string;
  model: string;
  status: 'active' | 'ended';
  createdAt: string; // ISO
  lastActiveAt: string; // ISO
}

export interface SessionIndexFile {
  version: 1;
  sessions: Record<string, SessionIndexEntry>; // keyed by cliSessionId
}

// ============================================================
// Recent Session (Home Tab)
// ============================================================

export interface RecentSession {
  sessionId: string;
  projectPath: string;
  mtime: Date;
  firstPrompt: string;
  firstPromptPreview: string;
}
