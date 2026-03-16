# Streaming Display Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Claude CLIのstream-jsonイベントをリアルタイムでSlackスレッドに可視化する（ツール実行状況、テキストストリーミング、subagent追跡、モーダル詳細表示）

**Architecture:** 4層イベント駆動パイプライン（StreamProcessor → BatchAggregator → SlackActionExecutor → Slack API）。PersistentSessionのstream-json出力を12イベントタイプに分類し、優先度付きキューとRate Limit対応のGraceful Degradationで安全にSlack APIに送信する。

**Tech Stack:** TypeScript, Slack Bolt SDK (@slack/bolt), Vitest, Node.js EventEmitter

---

## File Structure Overview

### New Files (Phase 1)
| File | Responsibility |
|------|---------------|
| `src/streaming/types.ts` | ストリーミング専用型定義（SlackAction, StreamProcessorState, etc.） |
| `src/streaming/stream-processor.ts` | 12イベントタイプの解析・状態管理・SlackAction生成 |
| `src/streaming/tool-formatter.ts` | ツール表示のBlock Kit生成（1行サマリー + 完了更新） |
| `src/streaming/slack-action-executor.ts` | SlackAction実行、Rate Limit追跡、429リトライ |
| `src/streaming/rate-limit-tracker.ts` | スライディングウィンドウによるAPI使用率追跡 |

### New Files (Phase 2)
| File | Responsibility |
|------|---------------|
| `src/streaming/batch-aggregator.ts` | 1.5秒ウィンドウ + 動的バッチサイズでツールをバッチ化 |
| `src/streaming/text-stream-updater.ts` | テキストdelta蓄積 + 2秒間隔chat.update |
| `src/streaming/markdown-converter.ts` | GFM→Slack mrkdwn変換（設計書のTypeScript実装ベース） |
| `src/streaming/priority-queue.ts` | P1-P5優先度キュー |

### New Files (Phase 3)
| File | Responsibility |
|------|---------------|
| `src/streaming/subagent-tracker.ts` | subagentネスト検出 + ステップ蓄積 + 親メッセージ更新 |
| `src/streaming/graceful-degradation.ts` | 5段階Degradation（NORMAL→EMERGENCY） |
| `src/streaming/tool-result-cache.ts` | モーダル用TTLキャッシュ（インメモリ30分/50MB + ディスク） |
| `src/slack/modal-builder.ts` | ツール詳細モーダルのBlock Kit生成 |

### Modified Files
| File | Phase | Changes |
|------|-------|---------|
| `src/types.ts` | 1 | 既存のStreamProcessorState/ToolUseStep/ToolUseSummary（L27-69）を削除し、`src/streaming/types.ts` から re-export。StreamEvent型の拡充。 |
| `src/index.ts` | 1,2,3 | wireSessionOutput → StreamProcessor統合、モーダルアクションハンドラ |
| `src/slack/block-builder.ts` | 1 | ツール表示・thinking表示ブロック追加 |
| `src/slack/action-handler.ts` | 3 | ツール詳細ボタンのアクション処理 |
| `src/slack/reaction-manager.ts` | 1 | 変更なし（既存のbrain/white_check_markをそのまま活用） |

### Test Files
Each new `src/streaming/*.ts` gets a corresponding `tests/streaming/*.test.ts`.
Each new `src/slack/modal-builder.ts` gets `tests/slack/modal-builder.test.ts`.

---

## Chunk 1: P0 Verification

P0検証は実装前に必ず実行する。結果によりStreamProcessorの設計が変わる。

### Task 0.1: P0-1 — parent_tool_use_id の存在確認

**Purpose:** subagentネスト追跡方式の決定。フィールドがあれば直接参照、なければToolStack実装が必要。

- [ ] **Step 1: Agent toolを使うプロンプトでstream-json出力を取得**

```bash
echo 'Use the Agent tool to search for "hello" in the current directory, then tell me the results.' | claude -p --output-format stream-json 2>/dev/null | tee /tmp/p0-1-output.jsonl | head -100
```

- [ ] **Step 2: parent_tool_use_id フィールドを検索**

```bash
grep -i 'parent_tool_use_id\|parentToolUseId\|parent_tool' /tmp/p0-1-output.jsonl && echo "✅ FOUND" || echo "❌ NOT FOUND"
```

- [ ] **Step 3: tool_use イベントの構造を確認**

```bash
cat /tmp/p0-1-output.jsonl | python3 -c "
import json, sys
for line in sys.stdin:
    line = line.strip()
    if not line: continue
    try:
        e = json.loads(line)
        if e.get('type') == 'assistant':
            msg = e.get('message', {})
            for block in msg.get('content', []):
                if block.get('type') == 'tool_use':
                    print(json.dumps(block, indent=2))
    except: pass
"
```

- [ ] **Step 4: 結果を記録**

| 結果 | 採用方針 |
|------|---------|
| 仮説A: `parent_tool_use_id` あり | StreamProcessorで直接参照。ToolStack不要 |
| 仮説B: フラット構造 | ToolStack実装（tool_useスタックで親子関係を推定） |

`docs/superpowers/plans/p0-results.md` に結果を記録する。

### Task 0.2: P0-2 — --include-partial-messages のイベント構造

**Purpose:** テキストストリーミング実装の前提確認。partial=trueのイベントでテキストが単調増加するか、小チャンクで来るか。

- [ ] **Step 1: ベースライン（partial なし）取得**

```bash
echo "Write a haiku about TypeScript" | claude -p --output-format stream-json 2>/dev/null | tee /tmp/p0-2-baseline.jsonl | wc -l && echo "✅ baseline captured"
```

- [ ] **Step 2: partial あり取得**

```bash
echo "Write a haiku about TypeScript" | claude -p --output-format stream-json --include-partial-messages 2>/dev/null | tee /tmp/p0-2-partial.jsonl | wc -l && echo "✅ partial captured"
```

> **Note:** `--include-partial-messages` フラグを追加して比較する。このフラグが認識されない場合は、stream-jsonモードではデフォルトでpartialイベントが含まれる可能性がある。

- [ ] **Step 3: イベント数とテキスト長の推移を比較**

```bash
cat /tmp/p0-2-partial.jsonl | python3 -c "
import json, sys
for i, line in enumerate(sys.stdin):
    line = line.strip()
    if not line: continue
    try:
        e = json.loads(line)
        t = e.get('type', '?')
        sub = e.get('subtype', '')
        partial = e.get('partial', False)
        text_len = 0
        if t == 'assistant':
            for b in e.get('message', {}).get('content', []):
                if b.get('type') == 'text':
                    text_len = len(b.get('text', ''))
        print(f'{i:3d} type={t:10s} sub={sub:15s} partial={partial} text_len={text_len}')
    except: pass
"
```

- [ ] **Step 4: 結果を記録**

| パターン | 説明 | 採用方針 |
|---------|------|---------|
| A: partial=true + 単調増加 | 毎回フルテキスト | そのまま置換表示 |
| B: partial=true + delta | 差分テキスト | 蓄積してから表示 |
| C: partial なし | 完了時のみテキスト | ストリーミング不可、完了時一括表示 |
| D: content_block_delta | 別イベント形式 | delta蓄積方式 |

### Task 0.3: P0-3 — set_model 制御メッセージの動作

**Purpose:** モデル変更がkill+respawnなしで可能か確認。

- [ ] **Step 1: Named pipeでテスト**

```bash
# Terminal 1: Claude CLI起動
mkfifo /tmp/claude-p0-3 2>/dev/null; exec 3>/tmp/claude-p0-3
claude -p --input-format stream-json --output-format stream-json < /tmp/claude-p0-3 | tee /tmp/p0-3-output.jsonl &
CLI_PID=$!
sleep 2

# 最初のプロンプト（sonnet）
echo '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"What model are you? Answer in one word."}]}}' >&3
sleep 5

# set_model送信
echo '{"type":"control","subtype":"set_model","model":"opus"}' >&3
sleep 1

# 2番目のプロンプト
echo '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"What model are you now? Answer in one word."}]}}' >&3
sleep 5

kill $CLI_PID 2>/dev/null
exec 3>&-
rm /tmp/claude-p0-3

echo "✅ Test complete. Checking output..."
grep -i 'sonnet\|opus\|haiku' /tmp/p0-3-output.jsonl | head -10
```

- [ ] **Step 2: 結果を記録**

| 結果 | 採用方針 |
|------|---------|
| 仮説A: モデルが変わる | set_model制御メッセージ採用。kill+respawn不要 |
| 仮説B: 無視される | 既存のkill+respawn方式を維持 |
| 仮説C: エラー | set_model非対応。kill+respawn維持 |

- [ ] **Step 5: P0結果をまとめてコミット**

```bash
git add docs/superpowers/plans/p0-results.md
git commit -m "docs: P0 verification results for streaming display"
```

---

## Chunk 2: Phase 1 — Tool Visualization MVP

**Goal:** ツール実行中の沈黙を解消。各ツールの開始/完了をSlackスレッドに表示する。

**Scope:**
- StreamProcessor（thinking + tool_use + tool_result + result イベントのみ）
- SlackActionExecutor（基本的なAPI呼び出し + Rate Limit追跡）
- ツール表示フォーマッター
- バッチングなし（個別投稿）
- テキストストリーミングなし（完了時一括表示は既存のまま）

### Task 1.1: ストリーミング型定義

**Files:**
- Create: `src/streaming/types.ts`
- Test: なし（型定義のみ）

- [ ] **Step 1: ストリーミング型定義ファイルを作成**

```typescript
// src/streaming/types.ts

// --- SlackAction: Executorに渡すアクション指示 ---

export type SlackActionType = 'postMessage' | 'update' | 'addReaction' | 'removeReaction';

export interface SlackAction {
  type: SlackActionType;
  priority: 1 | 2 | 3 | 4 | 5;
  channel: string;
  threadTs: string;
  // postMessage / update
  blocks?: Record<string, unknown>[];
  text?: string;
  // update
  messageTs?: string;
  // reaction
  emoji?: string;
  targetTs?: string;
  // metadata
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
  messageTs: string | null; // Slack message ts (set after postMessage)
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
  limit: number;       // per minute
  timestamps: number[]; // recent call timestamps
}

export type DegradationLevel = 'NORMAL' | 'CAUTION' | 'THROTTLE' | 'CRITICAL' | 'EMERGENCY';

// --- Executor Result ---

export interface ExecutorResult {
  ok: boolean;
  ts?: string;      // message timestamp (from postMessage/update)
  error?: string;
  retryAfterMs?: number;
}
```

- [ ] **Step 2: src/types.ts から旧ストリーミング型を削除**

`src/types.ts` の L27-69（`ProcessingPhase`, `StreamProcessorState`, `ToolUseStep`, `ToolUseSummary`）を削除する。これらは Phase 2 時代のスタブで、新しい `src/streaming/types.ts` の型に置き換えられる。

```typescript
// src/types.ts に追加（旧型削除後）:
export type { StreamProcessorState, ToolUseTracker } from './streaming/types.js';
```

- [ ] **Step 3: コミット**

```bash
git add src/streaming/types.ts src/types.ts
git commit -m "feat(streaming): add streaming type definitions, remove old stubs"
```

### Task 1.2: Rate Limit Tracker

**Files:**
- Create: `src/streaming/rate-limit-tracker.ts`
- Test: `tests/streaming/rate-limit-tracker.test.ts`

- [ ] **Step 1: テストを書く**

```typescript
// tests/streaming/rate-limit-tracker.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { RateLimitTracker } from '../../src/streaming/rate-limit-tracker.js';

describe('RateLimitTracker', () => {
  let tracker: RateLimitTracker;

  beforeEach(() => {
    vi.useFakeTimers();
    tracker = new RateLimitTracker();
  });

  it('starts at 0% utilization', () => {
    expect(tracker.getUtilization('postMessage')).toBe(0);
  });

  it('tracks calls and calculates utilization', () => {
    // postMessage limit = 20/min
    for (let i = 0; i < 10; i++) {
      tracker.record('postMessage');
    }
    expect(tracker.getUtilization('postMessage')).toBe(0.5); // 10/20
  });

  it('expires old entries after 60 seconds', () => {
    for (let i = 0; i < 10; i++) {
      tracker.record('postMessage');
    }
    expect(tracker.getUtilization('postMessage')).toBe(0.5);

    vi.advanceTimersByTime(61_000);
    expect(tracker.getUtilization('postMessage')).toBe(0);
  });

  it('canProceed returns false when at limit', () => {
    for (let i = 0; i < 20; i++) {
      tracker.record('postMessage');
    }
    expect(tracker.canProceed('postMessage')).toBe(false);
  });

  it('canProceed returns true when under limit', () => {
    for (let i = 0; i < 15; i++) {
      tracker.record('postMessage');
    }
    expect(tracker.canProceed('postMessage')).toBe(true);
  });

  it('getMaxUtilization returns highest across all methods', () => {
    // postMessage: 10/20 = 50%
    for (let i = 0; i < 10; i++) tracker.record('postMessage');
    // update: 40/50 = 80%
    for (let i = 0; i < 40; i++) tracker.record('update');

    expect(tracker.getMaxUtilization()).toBe(0.8);
  });

  it('handles 429 backoff', () => {
    tracker.recordRateLimited('postMessage', 5000);
    expect(tracker.canProceed('postMessage')).toBe(false);

    vi.advanceTimersByTime(5001);
    expect(tracker.canProceed('postMessage')).toBe(true);
  });
});
```

- [ ] **Step 2: テストが失敗することを確認**

```bash
npx vitest run tests/streaming/rate-limit-tracker.test.ts
```
Expected: FAIL — module not found

- [ ] **Step 3: 実装**

```typescript
// src/streaming/rate-limit-tracker.ts
import type { SlackApiMethod } from './types.js';

const WINDOW_MS = 60_000;

const LIMITS: Record<SlackApiMethod, number> = {
  postMessage: 20,
  update: 50,
  addReaction: 20,
  removeReaction: 20,
};

export class RateLimitTracker {
  private buckets: Map<SlackApiMethod, number[]> = new Map();
  private backoffs: Map<SlackApiMethod, number> = new Map(); // method → resume timestamp

  record(method: SlackApiMethod): void {
    const arr = this.buckets.get(method) || [];
    arr.push(Date.now());
    this.buckets.set(method, arr);
  }

  getUtilization(method: SlackApiMethod): number {
    this.prune(method);
    const count = (this.buckets.get(method) || []).length;
    return count / LIMITS[method];
  }

  getMaxUtilization(): number {
    let max = 0;
    for (const method of Object.keys(LIMITS) as SlackApiMethod[]) {
      max = Math.max(max, this.getUtilization(method));
    }
    return max;
  }

  canProceed(method: SlackApiMethod): boolean {
    const backoffUntil = this.backoffs.get(method) || 0;
    if (Date.now() < backoffUntil) return false;
    this.prune(method);
    const count = (this.buckets.get(method) || []).length;
    return count < LIMITS[method];
  }

  recordRateLimited(method: SlackApiMethod, retryAfterMs: number): void {
    this.backoffs.set(method, Date.now() + retryAfterMs);
  }

  private prune(method: SlackApiMethod): void {
    const arr = this.buckets.get(method);
    if (!arr) return;
    const cutoff = Date.now() - WINDOW_MS;
    const pruned = arr.filter(ts => ts > cutoff);
    this.buckets.set(method, pruned);
  }
}
```

- [ ] **Step 4: テストがパスすることを確認**

```bash
npx vitest run tests/streaming/rate-limit-tracker.test.ts
```
Expected: ALL PASS

- [ ] **Step 5: コミット**

```bash
git add src/streaming/rate-limit-tracker.ts tests/streaming/rate-limit-tracker.test.ts
git commit -m "feat(streaming): add RateLimitTracker with sliding window"
```

### Task 1.3: Tool Formatter

**Files:**
- Create: `src/streaming/tool-formatter.ts`
- Test: `tests/streaming/tool-formatter.test.ts`

- [ ] **Step 1: テストを書く**

```typescript
// tests/streaming/tool-formatter.test.ts
import { describe, it, expect } from 'vitest';
import { buildToolRunningBlocks, buildToolCompletedBlocks, buildThinkingBlocks, getToolOneLiner } from '../../src/streaming/tool-formatter.js';

describe('getToolOneLiner', () => {
  it('formats Read tool', () => {
    const result = getToolOneLiner('Read', { file_path: '/src/auth.ts' });
    expect(result).toBe('src/auth.ts');
  });

  it('formats Edit tool', () => {
    const result = getToolOneLiner('Edit', { file_path: '/src/auth.ts', old_string: 'foo' });
    expect(result).toBe('src/auth.ts');
  });

  it('formats Bash tool', () => {
    const result = getToolOneLiner('Bash', { command: 'npm test' });
    expect(result).toBe('npm test');
  });

  it('formats Bash tool with long command', () => {
    const result = getToolOneLiner('Bash', { command: 'a'.repeat(100) });
    expect(result.length).toBeLessThanOrEqual(63); // 60 + '...'
  });

  it('formats Grep tool', () => {
    const result = getToolOneLiner('Grep', { pattern: 'TODO', path: '/src' });
    expect(result).toBe('TODO in /src');
  });

  it('formats Glob tool', () => {
    const result = getToolOneLiner('Glob', { pattern: '**/*.ts' });
    expect(result).toBe('**/*.ts');
  });

  it('formats Write tool', () => {
    const result = getToolOneLiner('Write', { file_path: '/src/new.ts' });
    expect(result).toBe('src/new.ts');
  });

  it('formats Agent tool', () => {
    const result = getToolOneLiner('Agent', { prompt: 'Search for auth code' });
    expect(result).toBe('Search for auth code');
  });

  it('formats unknown tool', () => {
    const result = getToolOneLiner('UnknownTool', { foo: 'bar' });
    expect(result).toBe('UnknownTool');
  });
});

describe('buildToolRunningBlocks', () => {
  it('returns blocks with hourglass icon', () => {
    const blocks = buildToolRunningBlocks('Read', 'src/auth.ts');
    expect(blocks).toHaveLength(2); // section + context
    expect(blocks[0].text.text).toContain(':hourglass_flowing_sand:');
    expect(blocks[0].text.text).toContain('`Read`');
    expect(blocks[0].text.text).toContain('src/auth.ts');
    expect(blocks[1].elements[0].text).toContain('実行中');
  });
});

describe('buildToolCompletedBlocks', () => {
  it('returns blocks with checkmark icon', () => {
    const blocks = buildToolCompletedBlocks('Read', 'src/auth.ts — 247行', 800);
    expect(blocks[0].text.text).toContain(':white_check_mark:');
    expect(blocks[0].text.text).toContain('`Read`');
    expect(blocks[1].elements[0].text).toContain('0.8s');
  });

  it('returns blocks with x icon on error', () => {
    const blocks = buildToolCompletedBlocks('Bash', 'exit code 1', 1200, true);
    expect(blocks[0].text.text).toContain(':x:');
  });
});

describe('buildThinkingBlocks', () => {
  it('returns thinking blocks with snippet', () => {
    const blocks = buildThinkingBlocks('JWT validation strategy...');
    expect(blocks[0].elements[0].text).toContain(':thought_balloon:');
    expect(blocks[1].text.text).toContain('JWT validation');
  });

  it('truncates long thinking text', () => {
    const blocks = buildThinkingBlocks('a'.repeat(500));
    expect(blocks[1].text.text.length).toBeLessThan(300);
  });
});
```

- [ ] **Step 2: テストが失敗することを確認**

```bash
npx vitest run tests/streaming/tool-formatter.test.ts
```

- [ ] **Step 3: 実装**

```typescript
// src/streaming/tool-formatter.ts

type Block = Record<string, unknown>;

/**
 * Generate a one-line summary for a tool invocation.
 */
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

/**
 * Build blocks for a running tool (hourglass state).
 */
export function buildToolRunningBlocks(toolName: string, oneLiner: string): Block[] {
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `:hourglass_flowing_sand: \`${toolName}\` *${escapeMarkdown(oneLiner)}*`,
      },
    },
    {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: '実行中...' }],
    },
  ];
}

/**
 * Build blocks for a completed tool (checkmark or error state).
 */
export function buildToolCompletedBlocks(
  toolName: string,
  resultSummary: string,
  durationMs: number,
  isError = false,
): Block[] {
  const icon = isError ? ':x:' : ':white_check_mark:';
  const durationStr = `${(durationMs / 1000).toFixed(1)}s`;
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `${icon} \`${toolName}\` *${escapeMarkdown(resultSummary)}*`,
      },
    },
    {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `完了 (${durationStr})` }],
    },
  ];
}

/**
 * Build blocks for initial thinking display.
 */
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

/**
 * Generate a short result summary from tool_result content.
 */
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
  // Escape characters that would break Slack mrkdwn in our controlled context
  return s
    .replace(/[`]/g, "'")
    .replace(/[*]/g, '∗')   // fullwidth asterisk to prevent bold
    .replace(/[_]/g, '＿')   // fullwidth underscore to prevent italic
    .replace(/[~]/g, '∼');   // tilde-like to prevent strikethrough
}
```

- [ ] **Step 4: テストがパスすることを確認**

```bash
npx vitest run tests/streaming/tool-formatter.test.ts
```

- [ ] **Step 5: コミット**

```bash
git add src/streaming/tool-formatter.ts tests/streaming/tool-formatter.test.ts
git commit -m "feat(streaming): add tool formatter for Block Kit display"
```

### Task 1.4: Slack Action Executor

**Files:**
- Create: `src/streaming/slack-action-executor.ts`
- Test: `tests/streaming/slack-action-executor.test.ts`

- [ ] **Step 1: テストを書く**

```typescript
// tests/streaming/slack-action-executor.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SlackActionExecutor } from '../../src/streaming/slack-action-executor.js';
import type { SlackAction } from '../../src/streaming/types.js';

function createMockClient() {
  return {
    chat: {
      postMessage: vi.fn().mockResolvedValue({ ok: true, ts: '1234.5678' }),
      update: vi.fn().mockResolvedValue({ ok: true, ts: '1234.5678' }),
    },
    reactions: {
      add: vi.fn().mockResolvedValue({ ok: true }),
      remove: vi.fn().mockResolvedValue({ ok: true }),
    },
  };
}

function makeAction(overrides: Partial<SlackAction> = {}): SlackAction {
  return {
    type: 'postMessage',
    priority: 3,
    channel: 'C123',
    threadTs: 'T123',
    blocks: [{ type: 'section', text: { type: 'mrkdwn', text: 'test' } }],
    text: 'test',
    metadata: { messageType: 'tool_use' },
    ...overrides,
  };
}

describe('SlackActionExecutor', () => {
  let executor: SlackActionExecutor;
  let client: ReturnType<typeof createMockClient>;

  beforeEach(() => {
    client = createMockClient();
    executor = new SlackActionExecutor(client as any);
  });

  it('executes postMessage action', async () => {
    const action = makeAction({ type: 'postMessage' });
    const result = await executor.execute(action);
    expect(result.ok).toBe(true);
    expect(result.ts).toBe('1234.5678');
    expect(client.chat.postMessage).toHaveBeenCalledWith({
      channel: 'C123',
      thread_ts: 'T123',
      blocks: action.blocks,
      text: 'test',
    });
  });

  it('executes update action', async () => {
    const action = makeAction({ type: 'update', messageTs: '1111.2222' });
    const result = await executor.execute(action);
    expect(result.ok).toBe(true);
    expect(client.chat.update).toHaveBeenCalledWith({
      channel: 'C123',
      ts: '1111.2222',
      blocks: action.blocks,
      text: 'test',
    });
  });

  it('executes addReaction action', async () => {
    const action = makeAction({
      type: 'addReaction',
      emoji: 'brain',
      targetTs: '1111.2222',
    });
    const result = await executor.execute(action);
    expect(result.ok).toBe(true);
    expect(client.reactions.add).toHaveBeenCalledWith({
      channel: 'C123',
      timestamp: '1111.2222',
      name: 'brain',
    });
  });

  it('handles API errors gracefully', async () => {
    client.chat.postMessage.mockRejectedValue(new Error('channel_not_found'));
    const action = makeAction();
    const result = await executor.execute(action);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('channel_not_found');
  });

  it('detects 429 and records rate limit', async () => {
    const error = new Error('ratelimited') as any;
    error.data = { headers: { 'retry-after': '5' } };
    error.code = 'slack_webapi_rate_limited';
    client.chat.postMessage.mockRejectedValue(error);

    const action = makeAction();
    const result = await executor.execute(action);
    expect(result.ok).toBe(false);
    expect(result.retryAfterMs).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: テストが失敗することを確認**

```bash
npx vitest run tests/streaming/slack-action-executor.test.ts
```

- [ ] **Step 3: 実装**

```typescript
// src/streaming/slack-action-executor.ts
import { logger } from '../utils/logger.js';
import { RateLimitTracker } from './rate-limit-tracker.js';
import type { SlackAction, SlackApiMethod, ExecutorResult } from './types.js';

const ACTION_TO_METHOD: Record<SlackAction['type'], SlackApiMethod> = {
  postMessage: 'postMessage',
  update: 'update',
  addReaction: 'addReaction',
  removeReaction: 'removeReaction',
};

export class SlackActionExecutor {
  readonly rateLimiter = new RateLimitTracker();

  constructor(private readonly client: any) {}

  async execute(action: SlackAction): Promise<ExecutorResult> {
    const method = ACTION_TO_METHOD[action.type];

    if (!this.rateLimiter.canProceed(method)) {
      logger.warn(`Rate limit would be exceeded for ${method}, skipping`);
      return { ok: false, error: 'rate_limit_preemptive' };
    }

    try {
      const result = await this.callApi(action);
      this.rateLimiter.record(method); // Record AFTER success to avoid over-counting on errors
      return result;
    } catch (err) {
      return this.handleError(err, method);
    }
  }

  private async callApi(action: SlackAction): Promise<ExecutorResult> {
    switch (action.type) {
      case 'postMessage': {
        const resp = await this.client.chat.postMessage({
          channel: action.channel,
          thread_ts: action.threadTs,
          blocks: action.blocks,
          text: action.text || '',
        });
        return { ok: true, ts: resp.ts };
      }
      case 'update': {
        const resp = await this.client.chat.update({
          channel: action.channel,
          ts: action.messageTs,
          blocks: action.blocks,
          text: action.text || '',
        });
        return { ok: true, ts: resp.ts };
      }
      case 'addReaction': {
        await this.client.reactions.add({
          channel: action.channel,
          timestamp: action.targetTs,
          name: action.emoji,
        });
        return { ok: true };
      }
      case 'removeReaction': {
        await this.client.reactions.remove({
          channel: action.channel,
          timestamp: action.targetTs,
          name: action.emoji,
        });
        return { ok: true };
      }
    }
  }

  private handleError(err: unknown, method: SlackApiMethod): ExecutorResult {
    const error = err as any;
    const message = error?.message || String(err);

    // Detect 429 rate limit
    if (error?.code === 'slack_webapi_rate_limited') {
      const retryAfter = parseInt(error?.data?.headers?.['retry-after'] || '30', 10);
      const retryAfterMs = retryAfter * 1000;
      this.rateLimiter.recordRateLimited(method, retryAfterMs);
      logger.warn(`429 rate limited on ${method}, retry after ${retryAfter}s`);
      return { ok: false, error: 'rate_limited', retryAfterMs };
    }

    logger.error(`Slack API error on ${method}`, { error: message });
    return { ok: false, error: message };
  }
}
```

- [ ] **Step 4: テストがパスすることを確認**

```bash
npx vitest run tests/streaming/slack-action-executor.test.ts
```

- [ ] **Step 5: コミット**

```bash
git add src/streaming/slack-action-executor.ts tests/streaming/slack-action-executor.test.ts
git commit -m "feat(streaming): add SlackActionExecutor with rate limit tracking"
```

### Task 1.5: StreamProcessor (Phase 1 — tool events only)

**Files:**
- Create: `src/streaming/stream-processor.ts`
- Test: `tests/streaming/stream-processor.test.ts`

- [ ] **Step 1: テストを書く**

```typescript
// tests/streaming/stream-processor.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { StreamProcessor } from '../../src/streaming/stream-processor.js';
import type { SlackAction } from '../../src/streaming/types.js';

describe('StreamProcessor', () => {
  let processor: StreamProcessor;
  let emittedActions: SlackAction[];

  beforeEach(() => {
    emittedActions = [];
    processor = new StreamProcessor({
      channel: 'C123',
      threadTs: 'T123',
    });
    processor.on('action', (action: SlackAction) => {
      emittedActions.push(action);
    });
  });

  describe('thinking events', () => {
    it('emits postMessage for first thinking', () => {
      processor.processEvent({
        type: 'assistant',
        message: {
          content: [{ type: 'thinking', thinking: 'Analyzing the code...' }],
          stop_reason: null,
        },
      });

      expect(emittedActions).toHaveLength(1);
      expect(emittedActions[0].type).toBe('postMessage');
      expect(emittedActions[0].metadata.messageType).toBe('thinking');
    });

    it('does NOT emit for second thinking', () => {
      // First thinking
      processor.processEvent({
        type: 'assistant',
        message: {
          content: [{ type: 'thinking', thinking: 'First thought' }],
          stop_reason: null,
        },
      });

      // Second thinking
      processor.processEvent({
        type: 'assistant',
        message: {
          content: [{ type: 'thinking', thinking: 'Second thought' }],
          stop_reason: null,
        },
      });

      // Only 1 postMessage (first thinking)
      const thinkingActions = emittedActions.filter(a => a.metadata.messageType === 'thinking');
      expect(thinkingActions).toHaveLength(1);
    });
  });

  describe('tool_use events', () => {
    it('emits postMessage for tool_use', () => {
      processor.processEvent({
        type: 'assistant',
        message: {
          content: [{
            type: 'tool_use',
            id: 'toolu_001',
            name: 'Read',
            input: { file_path: '/src/auth.ts' },
          }],
          stop_reason: 'tool_use',
        },
      });

      expect(emittedActions).toHaveLength(1);
      expect(emittedActions[0].type).toBe('postMessage');
      expect(emittedActions[0].metadata.messageType).toBe('tool_use');
      expect(emittedActions[0].metadata.toolUseId).toBe('toolu_001');
      expect(emittedActions[0].metadata.toolName).toBe('Read');
    });
  });

  describe('tool_result events', () => {
    it('emits update for tool_result', () => {
      // First: tool_use
      processor.processEvent({
        type: 'assistant',
        message: {
          content: [{
            type: 'tool_use',
            id: 'toolu_001',
            name: 'Read',
            input: { file_path: '/src/auth.ts' },
          }],
          stop_reason: 'tool_use',
        },
      });

      // Register the message ts (simulating executor callback)
      processor.registerMessageTs('toolu_001', 'MSG_TS_001');

      // tool_result
      processor.processEvent({
        type: 'user',
        message: {
          content: [{
            type: 'tool_result',
            tool_use_id: 'toolu_001',
            content: 'file contents here\nline2\nline3',
          }],
        },
      });

      const updateActions = emittedActions.filter(a => a.type === 'update');
      expect(updateActions).toHaveLength(1);
      expect(updateActions[0].messageTs).toBe('MSG_TS_001');
    });
  });

  describe('result events', () => {
    it('emits result event (not SlackAction) for result', () => {
      const resultEvents: any[] = [];
      processor.on('result', (event: any) => resultEvents.push(event));

      processor.processEvent({
        type: 'result',
        duration_ms: 5000,
        usage: { input_tokens: 1000, output_tokens: 500 },
        total_cost_usd: 0.05,
      });

      // Phase 1: result is forwarded as event, not as SlackAction
      expect(resultEvents).toHaveLength(1);
      expect(resultEvents[0].duration_ms).toBe(5000);
      // No SlackAction emitted for result in Phase 1
      expect(emittedActions.filter(a => a.metadata.messageType === 'result')).toHaveLength(0);
    });
  });

  describe('mixed content blocks', () => {
    it('handles thinking + tool_use in same message', () => {
      processor.processEvent({
        type: 'assistant',
        message: {
          content: [
            { type: 'thinking', thinking: 'I need to read the file' },
            { type: 'tool_use', id: 'toolu_002', name: 'Read', input: { file_path: '/a.ts' } },
          ],
          stop_reason: 'tool_use',
        },
      });

      // First thinking → postMessage, tool_use → postMessage
      // But second thinking is skipped (buffered), so actually:
      // If this is the first thinking, it gets a postMessage
      // Then tool_use gets a postMessage
      expect(emittedActions.length).toBeGreaterThanOrEqual(1);
      const toolActions = emittedActions.filter(a => a.metadata.messageType === 'tool_use');
      expect(toolActions).toHaveLength(1);
    });
  });

  describe('state tracking', () => {
    it('tracks cumulative tool count', () => {
      for (let i = 0; i < 3; i++) {
        processor.processEvent({
          type: 'assistant',
          message: {
            content: [{
              type: 'tool_use',
              id: `toolu_${i}`,
              name: 'Read',
              input: { file_path: `/file${i}.ts` },
            }],
            stop_reason: 'tool_use',
          },
        });
      }
      expect(processor.getState().cumulativeToolCount).toBe(3);
    });
  });
});
```

- [ ] **Step 2: テストが失敗することを確認**

```bash
npx vitest run tests/streaming/stream-processor.test.ts
```

- [ ] **Step 3: 実装**

```typescript
// src/streaming/stream-processor.ts
import { EventEmitter } from 'node:events';
import { logger } from '../utils/logger.js';
import {
  buildToolRunningBlocks,
  buildToolCompletedBlocks,
  buildThinkingBlocks,
  getToolOneLiner,
  getToolResultSummary,
} from './tool-formatter.js';
import type {
  SlackAction,
  StreamProcessorState,
  ToolUseTracker,
} from './types.js';

interface StreamProcessorConfig {
  channel: string;
  threadTs: string;
}

export class StreamProcessor extends EventEmitter {
  private state: StreamProcessorState;
  private readonly config: StreamProcessorConfig;

  constructor(config: StreamProcessorConfig) {
    super();
    this.config = config;
    this.state = this.createInitialState();
  }

  getState(): Readonly<StreamProcessorState> {
    return this.state;
  }

  /**
   * Process a stream-json event from Claude CLI.
   */
  processEvent(event: any): void {
    if (event.type === 'assistant' && event.message?.content) {
      this.handleAssistant(event.message.content, event.message.stop_reason);
    } else if (event.type === 'user' && event.message?.content) {
      this.handleUser(event.message.content);
    } else if (event.type === 'result') {
      this.handleResult(event);
    }
  }

  /**
   * Register the Slack message ts for a tool_use message (callback from executor).
   */
  registerMessageTs(toolUseId: string, messageTs: string): void {
    const tracker = this.state.activeToolUses.get(toolUseId);
    if (tracker) {
      tracker.messageTs = messageTs;
    }
  }

  private handleAssistant(content: any[], stopReason: string | null): void {
    for (const block of content) {
      if (block.type === 'thinking') {
        this.handleThinking(block.thinking);
      } else if (block.type === 'tool_use') {
        this.handleToolUse(block);
      } else if (block.type === 'text') {
        // Phase 1: text handling is minimal (will be enhanced in Phase 2)
        // For now, just buffer text — the existing wireSessionOutput handles text display
      }
    }
  }

  private handleThinking(text: string): void {
    this.state.thinkingCount++;
    this.state.lastThinkingText = text;

    if (this.state.thinkingCount === 1) {
      // First thinking: emit dedicated message
      this.emitAction({
        type: 'postMessage',
        priority: 3,
        channel: this.config.channel,
        threadTs: this.config.threadTs,
        blocks: buildThinkingBlocks(text),
        text: '思考中...',
        metadata: { messageType: 'thinking' },
      });
      this.state.phase = 'thinking';
    }
    // 2nd+ thinking: just buffer (will be attached to next tool_use in Phase 2)
  }

  private handleToolUse(block: any): void {
    const toolUseId = block.id;
    const toolName = block.name;
    const input = block.input || {};

    this.state.cumulativeToolCount++;

    const tracker: ToolUseTracker = {
      toolUseId,
      toolName,
      input,
      messageTs: null,
      startTime: Date.now(),
      status: 'running',
    };
    this.state.activeToolUses.set(toolUseId, tracker);
    this.state.phase = 'tool_executing';

    const oneLiner = getToolOneLiner(toolName, input);

    this.emitAction({
      type: 'postMessage',
      priority: 3,
      channel: this.config.channel,
      threadTs: this.config.threadTs,
      blocks: buildToolRunningBlocks(toolName, oneLiner),
      text: `${toolName}: ${oneLiner}`,
      metadata: {
        messageType: 'tool_use',
        toolUseId,
        toolName,
      },
    });
  }

  private handleUser(content: any[]): void {
    for (const block of content) {
      if (typeof block === 'object' && block.type === 'tool_result') {
        this.handleToolResult(block);
      }
    }
  }

  private handleToolResult(block: any): void {
    const toolUseId = block.tool_use_id;
    const tracker = this.state.activeToolUses.get(toolUseId);
    if (!tracker) {
      logger.warn(`tool_result for unknown tool_use_id: ${toolUseId}`);
      return;
    }

    const durationMs = Date.now() - tracker.startTime;
    // Note: is_error field existence depends on stream-json format.
    // Fallback: if is_error is missing, check content for error patterns.
    const isError = block.is_error === true
      || (typeof block.content === 'string' && /^(Error|error:|ERROR)/.test(block.content));
    const resultText = typeof block.content === 'string'
      ? block.content
      : JSON.stringify(block.content);

    tracker.status = isError ? 'error' : 'completed';
    tracker.durationMs = durationMs;
    tracker.isError = isError;
    tracker.result = resultText;

    if (tracker.messageTs) {
      const resultSummary = getToolResultSummary(tracker.toolName, resultText, isError);
      const oneLiner = getToolOneLiner(tracker.toolName, tracker.input);
      const displayText = `${oneLiner} — ${resultSummary}`;

      this.emitAction({
        type: 'update',
        priority: 3,
        channel: this.config.channel,
        threadTs: this.config.threadTs,
        messageTs: tracker.messageTs,
        blocks: buildToolCompletedBlocks(tracker.toolName, displayText, durationMs, isError),
        text: `${tracker.toolName}: ${displayText}`,
        metadata: {
          messageType: 'tool_use',
          toolUseId,
          toolName: tracker.toolName,
        },
      });
    }
  }

  private handleResult(event: any): void {
    this.state.phase = 'completed';
    // Phase 1: result handling stays in existing wireSessionOutput code.
    // StreamProcessor only updates internal state here.
    // Phase 2 migration: this method will emit a proper footer action.
    this.emit('result', event);
  }

  /**
   * Reset state for next turn (called after result).
   */
  reset(): void {
    this.state = this.createInitialState();
  }

  /**
   * Dispose all internal timers. Call when session ends.
   */
  dispose(): void {
    // Phase 2: will also dispose TextStreamUpdater and BatchAggregator
    this.removeAllListeners();
  }

  private emitAction(action: SlackAction): void {
    this.emit('action', action);
  }

  private createInitialState(): StreamProcessorState {
    return {
      phase: 'idle',
      thinkingCount: 0,
      lastThinkingText: null,
      firstThinkingTs: null,
      activeToolUses: new Map(),
      cumulativeToolCount: 0,
      textMessageTs: null,
      textBuffer: '',
      turnStartTime: Date.now(),
    };
  }
}
```

- [ ] **Step 4: テストがパスすることを確認**

```bash
npx vitest run tests/streaming/stream-processor.test.ts
```

- [ ] **Step 5: コミット**

```bash
git add src/streaming/stream-processor.ts tests/streaming/stream-processor.test.ts
git commit -m "feat(streaming): add StreamProcessor for tool event handling"
```

### Task 1.6: index.ts 統合 — wireSessionOutput をStreamProcessorに移行

**Files:**
- Modify: `src/index.ts:321-469` (wireSessionOutput function)
- Test: 手動テスト（E2E）

> **Important:** この統合はPhase 1の最重要タスク。既存のテキスト表示ロジックを維持しつつ、ツールイベントの可視化を追加する。

- [ ] **Step 1: wireSessionOutput を StreamProcessor 統合版に書き換え**

既存の `wireSessionOutput` 関数（`src/index.ts:321-469`）を以下の方針で変更する：

1. StreamProcessor を作成し、session の 'message' イベントを StreamProcessor に渡す
2. StreamProcessor の 'action' イベントを SlackActionExecutor で実行
3. tool_use の postMessage 結果の ts を StreamProcessor に registerMessageTs で返す
4. **既存のテキスト表示と result 処理はそのまま維持**（Phase 2 で置き換え）
5. StreamProcessor は tool 関連のイベントのみ処理し、text/result は既存ロジックが処理

```typescript
// Changes to src/index.ts

// Add imports at top:
// import { StreamProcessor } from './streaming/stream-processor.js';
// import { SlackActionExecutor } from './streaming/slack-action-executor.js';

// Inside wireSessionOutput, add StreamProcessor setup:
// const streamProcessor = new StreamProcessor({ channel: channelId, threadTs });
// const executor = new SlackActionExecutor(client);

// Wire StreamProcessor actions to executor:
// streamProcessor.on('action', async (action) => {
//   if (action.metadata.messageType === 'result') return; // handled by existing code
//   const result = await executor.execute(action);
//   if (result.ok && result.ts && action.metadata.toolUseId) {
//     streamProcessor.registerMessageTs(action.metadata.toolUseId, result.ts);
//   }
// });

// In session.on('message'), add StreamProcessor processing BEFORE existing logic:
// streamProcessor.processEvent(event);

// In result handler, add: streamProcessor.reset();
```

具体的な差分は実装時にStreamProcessor統合テストを書いてから適用する。

- [ ] **Step 2: 手動テスト — Slackで動作確認**

```bash
npm run dev
```

Slack DMでプロンプトを送信し、以下を確認：
1. ツール使用時にスレッドに `:hourglass_flowing_sand: Read src/auth.ts` が表示される
2. ツール完了時に `:white_check_mark: Read src/auth.ts — 247行` に更新される
3. 最終テキスト応答は従来通り表示される
4. result フッターは従来通り表示される

- [ ] **Step 3: コミット**

```bash
git add src/index.ts
git commit -m "feat(streaming): integrate StreamProcessor into wireSessionOutput"
```

### Task 1.7: Phase 1 全テスト実行 + リグレッション確認

- [ ] **Step 1: 全テスト実行**

```bash
npx vitest run
```
Expected: ALL PASS

- [ ] **Step 2: TypeScript型チェック**

```bash
npx tsc --noEmit && echo "✅ type check passed"
```

- [ ] **Step 3: Phase 1 完了コミット**

```bash
git add -A
git commit -m "feat(streaming): Phase 1 complete — tool visualization MVP"
```

---

## Chunk 3: Phase 2 — Text Streaming + Batching + Markdown Conversion

**Goal:** テキスト応答を2秒間隔でストリーミング表示。ツールをバッチ化してRate Limit使用を削減。Markdown→mrkdwn変換でフォーマット保持。

**Dependencies:** Phase 1 完了

### Task 2.1: Priority Queue

**Files:**
- Create: `src/streaming/priority-queue.ts`
- Test: `tests/streaming/priority-queue.test.ts`

- [ ] **Step 1: テストを書く**

```typescript
// tests/streaming/priority-queue.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { PriorityQueue } from '../../src/streaming/priority-queue.js';
import type { SlackAction } from '../../src/streaming/types.js';

function makeAction(priority: 1|2|3|4|5, type: string = 'postMessage'): SlackAction {
  return {
    type: type as any,
    priority,
    channel: 'C1',
    threadTs: 'T1',
    text: `p${priority}`,
    metadata: { messageType: 'tool_use' },
  };
}

describe('PriorityQueue', () => {
  let queue: PriorityQueue;

  beforeEach(() => {
    queue = new PriorityQueue();
  });

  it('dequeues highest priority first', () => {
    queue.enqueue(makeAction(3));
    queue.enqueue(makeAction(1));
    queue.enqueue(makeAction(5));

    expect(queue.dequeue()!.priority).toBe(1);
    expect(queue.dequeue()!.priority).toBe(3);
    expect(queue.dequeue()!.priority).toBe(5);
  });

  it('returns null when empty', () => {
    expect(queue.dequeue()).toBeNull();
  });

  it('maintains FIFO within same priority', () => {
    const a1 = makeAction(3);
    a1.text = 'first';
    const a2 = makeAction(3);
    a2.text = 'second';

    queue.enqueue(a1);
    queue.enqueue(a2);

    expect(queue.dequeue()!.text).toBe('first');
    expect(queue.dequeue()!.text).toBe('second');
  });

  it('discardBelow drops low priority items', () => {
    queue.enqueue(makeAction(1));
    queue.enqueue(makeAction(3));
    queue.enqueue(makeAction(4));
    queue.enqueue(makeAction(5));

    const dropped = queue.discardBelow(3);
    expect(dropped).toBe(2); // P4 + P5

    expect(queue.dequeue()!.priority).toBe(1);
    expect(queue.dequeue()!.priority).toBe(3);
    expect(queue.dequeue()).toBeNull();
  });

  it('reports correct size', () => {
    queue.enqueue(makeAction(1));
    queue.enqueue(makeAction(2));
    expect(queue.size).toBe(2);
  });
});
```

- [ ] **Step 2: テスト失敗確認 → 実装**

```typescript
// src/streaming/priority-queue.ts
import type { SlackAction } from './types.js';

export class PriorityQueue {
  private queues: Map<number, SlackAction[]> = new Map([
    [1, []], [2, []], [3, []], [4, []], [5, []],
  ]);

  get size(): number {
    let total = 0;
    for (const q of this.queues.values()) total += q.length;
    return total;
  }

  enqueue(action: SlackAction): void {
    this.queues.get(action.priority)!.push(action);
  }

  dequeue(): SlackAction | null {
    for (let p = 1; p <= 5; p++) {
      const q = this.queues.get(p)!;
      if (q.length > 0) return q.shift()!;
    }
    return null;
  }

  discardBelow(maxPriority: number): number {
    let dropped = 0;
    for (let p = maxPriority + 1; p <= 5; p++) {
      const q = this.queues.get(p)!;
      dropped += q.length;
      this.queues.set(p, []);
    }
    return dropped;
  }
}
```

- [ ] **Step 3: テストパス確認 → コミット**

```bash
npx vitest run tests/streaming/priority-queue.test.ts && echo "✅ PASS"
git add src/streaming/priority-queue.ts tests/streaming/priority-queue.test.ts
git commit -m "feat(streaming): add PriorityQueue for action scheduling"
```

### Task 2.2: Markdown Converter

**Files:**
- Create: `src/streaming/markdown-converter.ts`
- Test: `tests/streaming/markdown-converter.test.ts`

> 設計書（round1-markdown-conversion.md）のTypeScript実装をベースに作成。

- [ ] **Step 1: テストを書く**

```typescript
// tests/streaming/markdown-converter.test.ts
import { describe, it, expect } from 'vitest';
import { convertMarkdownToMrkdwn } from '../../src/streaming/markdown-converter.js';

describe('convertMarkdownToMrkdwn', () => {
  // Headers
  it('converts h1-h6 to bold', () => {
    expect(convertMarkdownToMrkdwn('# Title')).toBe('*Title*');
    expect(convertMarkdownToMrkdwn('## Subtitle')).toBe('*Subtitle*');
    expect(convertMarkdownToMrkdwn('### Deep')).toBe('*Deep*');
  });

  // Bold / Italic
  it('converts **bold** to *bold*', () => {
    expect(convertMarkdownToMrkdwn('**hello**')).toBe('*hello*');
  });

  it('converts *italic* to _italic_', () => {
    expect(convertMarkdownToMrkdwn('*hello*')).toBe('_hello_');
  });

  it('converts ***bolditalic*** to *_bolditalic_*', () => {
    expect(convertMarkdownToMrkdwn('***hello***')).toBe('*_hello_*');
  });

  // Strikethrough
  it('converts ~~text~~ to ~text~', () => {
    expect(convertMarkdownToMrkdwn('~~deleted~~')).toBe('~deleted~');
  });

  // Code blocks
  it('preserves code blocks and strips language', () => {
    const input = '```typescript\nconst x = 1;\n```';
    const expected = '```\nconst x = 1;\n```';
    expect(convertMarkdownToMrkdwn(input)).toBe(expected);
  });

  it('does not transform content inside code blocks', () => {
    const input = '```\n**not bold** *not italic*\n```';
    expect(convertMarkdownToMrkdwn(input)).toBe(input);
  });

  // Inline code
  it('preserves inline code', () => {
    expect(convertMarkdownToMrkdwn('Use `npm install`')).toBe('Use `npm install`');
  });

  it('does not transform inside inline code', () => {
    expect(convertMarkdownToMrkdwn('`**bold**`')).toBe('`**bold**`');
  });

  // Lists
  it('converts unordered list markers to bullets', () => {
    expect(convertMarkdownToMrkdwn('- item 1\n- item 2')).toBe('• item 1\n• item 2');
  });

  it('converts nested lists with indentation', () => {
    expect(convertMarkdownToMrkdwn('- parent\n  - child')).toBe('• parent\n  • child');
  });

  it('converts task lists', () => {
    expect(convertMarkdownToMrkdwn('- [ ] todo\n- [x] done')).toBe('☐ todo\n☑ done');
  });

  // Links
  it('converts [text](url) to <url|text>', () => {
    expect(convertMarkdownToMrkdwn('[Google](https://google.com)')).toBe('<https://google.com|Google>');
  });

  // Images
  it('converts ![alt](url) to link', () => {
    expect(convertMarkdownToMrkdwn('![screenshot](https://img.png)')).toBe('<https://img.png|screenshot>');
  });

  // Horizontal rule
  it('converts --- to visual divider', () => {
    expect(convertMarkdownToMrkdwn('---')).toBe('───────────────');
  });

  // Blockquote
  it('preserves blockquotes', () => {
    expect(convertMarkdownToMrkdwn('> quoted text')).toBe('> quoted text');
  });

  // Tables
  it('converts tables to ASCII table in code block', () => {
    const input = '| A | B |\n|---|---|\n| 1 | 2 |';
    const result = convertMarkdownToMrkdwn(input);
    expect(result).toContain('```');
    expect(result).toContain('A');
    expect(result).toContain('B');
  });

  // HTML
  it('strips HTML tags', () => {
    expect(convertMarkdownToMrkdwn('hello<br>world')).toBe('hello\nworld');
  });

  // Escape chars
  it('removes escape backslashes', () => {
    expect(convertMarkdownToMrkdwn('\\*not italic\\*')).toBe('*not italic*');
  });

  // Incomplete markdown safety
  it('leaves incomplete bold untouched', () => {
    expect(convertMarkdownToMrkdwn('**incomplete')).toBe('**incomplete');
  });

  it('leaves unclosed code block as text', () => {
    const input = '```\nunclosed';
    expect(convertMarkdownToMrkdwn(input)).toBe(input);
  });

  // Combined
  it('handles real Claude response', () => {
    const input = '## Approach\n- **Structure**: 4 categories\n- **Benefit**: comprehensive\n\n| Cat | Count |\n|-----|-------|\n| A   | 20    |';
    const result = convertMarkdownToMrkdwn(input);
    expect(result).toContain('*Approach*');
    expect(result).toContain('• *Structure*');
    expect(result).toContain('```');
  });
});
```

- [ ] **Step 2: テスト失敗確認**

- [ ] **Step 3: 実装（設計書ベース）**

```typescript
// src/streaming/markdown-converter.ts

interface Segment {
  type: 'text' | 'codeblock';
  content: string;
  lang?: string;
}

/**
 * Convert GitHub Flavored Markdown to Slack mrkdwn format.
 * Strategy: Protect code → Convert text segments → Restore.
 * Performance: <1ms for 3000 chars.
 */
export function convertMarkdownToMrkdwn(markdown: string): string {
  const segments = splitCodeBlocks(markdown);
  const converted = segments.map(seg => {
    if (seg.type === 'codeblock') {
      return '```\n' + seg.content + '\n```';
    }
    return convertTextSegment(seg.content);
  });
  return converted.join('');
}

function splitCodeBlocks(markdown: string): Segment[] {
  const segments: Segment[] = [];
  const regex = /^```(\w*)\s*\n([\s\S]*?)^```\s*$/gm;
  let lastIndex = 0;
  let match;

  while ((match = regex.exec(markdown)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ type: 'text', content: markdown.slice(lastIndex, match.index) });
    }
    segments.push({ type: 'codeblock', content: match[2], lang: match[1] });
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < markdown.length) {
    segments.push({ type: 'text', content: markdown.slice(lastIndex) });
  }

  return segments;
}

function convertTextSegment(text: string): string {
  // 1. Protect inline code
  const inlineCodes: string[] = [];
  let result = text.replace(/`([^`\n]+)`/g, (_, code) => {
    inlineCodes.push('`' + code + '`');
    return `\x00IC${inlineCodes.length - 1}\x00`;
  });

  // 2. Protect links (before any other processing)
  const links: string[] = [];
  // Convert [text](url) → Slack <url|text>
  result = result.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, alt, url) => {
    const link = `<${url}|${alt}>`;
    links.push(link);
    return `\x00LK${links.length - 1}\x00`;
  });
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, text, url) => {
    const link = `<${url}|${text}>`;
    links.push(link);
    return `\x00LK${links.length - 1}\x00`;
  });

  // 3. Tables (must be before other line-level transforms)
  result = convertTables(result);

  // 4. Headers: # text → *text*
  result = result.replace(/^#{1,6}\s+(.+)$/gm, '*$1*');

  // 5. Task lists (before unordered list conversion)
  result = result.replace(/^(\s*)- \[ \] (.+)$/gm, '$1☐ $2');
  result = result.replace(/^(\s*)- \[x\] (.+)$/gm, '$1☑ $2');

  // 6. Unordered lists: - item or * item → • item
  result = result.replace(/^(\s*)[-*] (.+)$/gm, '$1• $2');

  // 7. Bold+Italic: ***text*** → *_text_*
  const boldItalics: string[] = [];
  result = result.replace(/\*{3}([^*\n]+?)\*{3}/g, (_, content) => {
    boldItalics.push(`*_${content}_*`);
    return `\x00BI${boldItalics.length - 1}\x00`;
  });

  // 8. Bold: **text** → *text*
  const bolds: string[] = [];
  result = result.replace(/\*{2}([^*\n]+?)\*{2}/g, (_, content) => {
    bolds.push(`*${content}*`);
    return `\x00BD${bolds.length - 1}\x00`;
  });

  // 9. Italic: *text* → _text_ (remaining single *)
  result = result.replace(/(?<!\w)\*([^*\n]+?)\*(?!\w)/g, '_$1_');

  // 10. Strikethrough: ~~text~~ → ~text~
  result = result.replace(/~~([^~\n]+?)~~/g, '~$1~');

  // 11. Horizontal rule
  result = result.replace(/^[-*_]{3,}\s*$/gm, '───────────────');

  // 12. HTML tags
  result = result.replace(/<br\s*\/?>/gi, '\n');
  result = result.replace(/<[^>]+>/g, '');

  // 13. Escape chars
  result = result.replace(/\\([*_~`\[\]])/g, '$1');

  // 14. Restore placeholders
  result = result.replace(/\x00BI(\d+)\x00/g, (_, idx) => boldItalics[Number(idx)]);
  result = result.replace(/\x00BD(\d+)\x00/g, (_, idx) => bolds[Number(idx)]);
  result = result.replace(/\x00LK(\d+)\x00/g, (_, idx) => links[Number(idx)]);
  result = result.replace(/\x00IC(\d+)\x00/g, (_, idx) => inlineCodes[Number(idx)]);

  return result;
}

function convertTables(text: string): string {
  // Match table pattern: header row, separator row, data rows
  const tableRegex = /^(\|.+\|)\n(\|[-| :]+\|)\n((?:\|.+\|\n?)+)/gm;

  return text.replace(tableRegex, (match) => {
    const rows = match.trim().split('\n');
    if (rows.length < 3) return match;

    // Parse rows (skip separator)
    const parsedRows: string[][] = [];
    for (let i = 0; i < rows.length; i++) {
      if (i === 1) continue; // separator row
      const cells = rows[i]
        .replace(/^\||\|$/g, '')
        .split('|')
        .map(c => c.trim());
      parsedRows.push(cells);
    }

    if (parsedRows.length === 0) return match;

    // Calculate column widths
    const colCount = parsedRows[0].length;
    const widths: number[] = new Array(colCount).fill(0);
    for (const row of parsedRows) {
      for (let i = 0; i < colCount; i++) {
        widths[i] = Math.max(widths[i], getDisplayWidth(row[i] || ''));
      }
    }

    // Build ASCII table
    const border = '+' + widths.map(w => '-'.repeat(w + 2)).join('+') + '+';
    const lines = [border];

    for (let r = 0; r < parsedRows.length; r++) {
      const row = parsedRows[r];
      const cells = row.map((cell, i) => {
        const pad = widths[i] - getDisplayWidth(cell);
        return ' ' + cell + ' '.repeat(pad + 1);
      });
      lines.push('|' + cells.join('|') + '|');
      if (r === 0) lines.push(border); // after header
    }
    lines.push(border);

    return '```\n' + lines.join('\n') + '\n```';
  });
}

function getDisplayWidth(str: string): number {
  let width = 0;
  for (const char of str) {
    const code = char.codePointAt(0)!;
    width += isCJK(code) ? 2 : 1;
  }
  return width;
}

function isCJK(code: number): boolean {
  return (
    (code >= 0x4e00 && code <= 0x9fff) ||   // CJK Unified Ideographs
    (code >= 0x3040 && code <= 0x309f) ||   // Hiragana
    (code >= 0x30a0 && code <= 0x30ff) ||   // Katakana
    (code >= 0xff00 && code <= 0xff60) ||   // Fullwidth ASCII
    (code >= 0xac00 && code <= 0xd7af)      // Hangul
  );
}
```

- [ ] **Step 4: テストパス確認 → コミット**

```bash
npx vitest run tests/streaming/markdown-converter.test.ts && echo "✅ PASS"
git add src/streaming/markdown-converter.ts tests/streaming/markdown-converter.test.ts
git commit -m "feat(streaming): add Markdown to Slack mrkdwn converter"
```

### Task 2.3: Batch Aggregator

**Files:**
- Create: `src/streaming/batch-aggregator.ts`
- Test: `tests/streaming/batch-aggregator.test.ts`

- [ ] **Step 1: テストを書く**

```typescript
// tests/streaming/batch-aggregator.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BatchAggregator } from '../../src/streaming/batch-aggregator.js';
import type { SlackAction } from '../../src/streaming/types.js';

function makeToolAction(toolUseId: string): SlackAction {
  return {
    type: 'postMessage',
    priority: 3,
    channel: 'C1',
    threadTs: 'T1',
    blocks: [{ type: 'section', text: { type: 'mrkdwn', text: `tool ${toolUseId}` } }],
    text: `tool ${toolUseId}`,
    metadata: { messageType: 'tool_use', toolUseId },
  };
}

describe('BatchAggregator', () => {
  let aggregator: BatchAggregator;
  let flushedBatches: SlackAction[][];

  beforeEach(() => {
    vi.useFakeTimers();
    flushedBatches = [];
    aggregator = new BatchAggregator({
      windowMs: 1500,
      maxWaitMs: 3000,
      onFlush: (batch) => { flushedBatches.push(batch); },
    });
  });

  it('passes through non-batchable actions immediately', () => {
    const action: SlackAction = {
      type: 'update',
      priority: 3,
      channel: 'C1',
      threadTs: 'T1',
      messageTs: 'M1',
      blocks: [],
      text: '',
      metadata: { messageType: 'tool_use' },
    };
    aggregator.submit(action);
    // update is not batchable → immediate flush
    expect(flushedBatches).toHaveLength(1);
    expect(flushedBatches[0]).toHaveLength(1);
  });

  it('batches tool_use postMessages within window', () => {
    aggregator.submit(makeToolAction('t1'));
    aggregator.submit(makeToolAction('t2'));
    expect(flushedBatches).toHaveLength(0); // still in window

    vi.advanceTimersByTime(1500);
    expect(flushedBatches).toHaveLength(1);
    expect(flushedBatches[0]).toHaveLength(2);
  });

  it('force flushes at maxWaitMs', () => {
    // Keep submitting within window
    aggregator.submit(makeToolAction('t1'));
    vi.advanceTimersByTime(1400);
    aggregator.submit(makeToolAction('t2')); // resets window
    vi.advanceTimersByTime(1400);
    aggregator.submit(makeToolAction('t3')); // resets window again

    // Total elapsed: 2800ms, not yet at 3000ms max
    expect(flushedBatches).toHaveLength(0);

    vi.advanceTimersByTime(200); // 3000ms total
    expect(flushedBatches).toHaveLength(1);
    expect(flushedBatches[0]).toHaveLength(3);
  });

  it('individual posting when cumulativeToolCount < 5', () => {
    aggregator.setCumulativeToolCount(2);
    aggregator.submit(makeToolAction('t1'));

    vi.advanceTimersByTime(1500);
    // Dynamic batch size = 1 (individual) when < 5
    expect(flushedBatches).toHaveLength(1);
    expect(flushedBatches[0]).toHaveLength(1);
  });

  it('batches 3 tools when cumulativeToolCount 5-9', () => {
    aggregator.setCumulativeToolCount(7);
    for (let i = 0; i < 3; i++) {
      aggregator.submit(makeToolAction(`t${i}`));
    }

    vi.advanceTimersByTime(1500);
    expect(flushedBatches).toHaveLength(1);
    expect(flushedBatches[0]).toHaveLength(3);
  });
});
```

- [ ] **Step 2: テスト失敗確認 → 実装**

```typescript
// src/streaming/batch-aggregator.ts
import type { SlackAction } from './types.js';

interface BatchAggregatorConfig {
  windowMs: number;     // 1500ms default
  maxWaitMs: number;    // 3000ms forced flush
  onFlush: (batch: SlackAction[]) => void;
}

export class BatchAggregator {
  private buffer: SlackAction[] = [];
  private windowTimer: ReturnType<typeof setTimeout> | null = null;
  private maxWaitTimer: ReturnType<typeof setTimeout> | null = null;
  private cumulativeToolCount = 0;
  private readonly config: BatchAggregatorConfig;

  constructor(config: BatchAggregatorConfig) {
    this.config = config;
  }

  setCumulativeToolCount(count: number): void {
    this.cumulativeToolCount = count;
  }

  submit(action: SlackAction): void {
    // Only batch tool_use postMessages
    if (!this.isBatchable(action)) {
      this.config.onFlush([action]);
      return;
    }

    this.buffer.push(action);

    // Start max wait timer on first item
    if (this.buffer.length === 1) {
      this.maxWaitTimer = setTimeout(() => this.flush(), this.config.maxWaitMs);
    }

    // Reset window timer on each new item
    if (this.windowTimer) clearTimeout(this.windowTimer);
    this.windowTimer = setTimeout(() => this.flush(), this.config.windowMs);

    // Individual posting when batch size is 1
    const batchSize = this.getDynamicBatchSize();
    if (batchSize === 1) {
      this.flush();
      return;
    }

    // If buffer reaches dynamic batch size, flush immediately
    if (this.buffer.length >= batchSize) {
      this.flush();
    }
  }

  private flush(): void {
    if (this.windowTimer) { clearTimeout(this.windowTimer); this.windowTimer = null; }
    if (this.maxWaitTimer) { clearTimeout(this.maxWaitTimer); this.maxWaitTimer = null; }

    if (this.buffer.length === 0) return;

    const batch = this.buffer.splice(0);
    this.config.onFlush(batch);
  }

  private isBatchable(action: SlackAction): boolean {
    return action.type === 'postMessage' && action.metadata.messageType === 'tool_use';
  }

  private getDynamicBatchSize(): number {
    if (this.cumulativeToolCount < 5) return 1;   // Individual
    if (this.cumulativeToolCount < 10) return 3;
    if (this.cumulativeToolCount < 20) return 5;
    return 8;
  }
}
```

- [ ] **Step 3: テストパス確認 → コミット**

```bash
npx vitest run tests/streaming/batch-aggregator.test.ts && echo "✅ PASS"
git add src/streaming/batch-aggregator.ts tests/streaming/batch-aggregator.test.ts
git commit -m "feat(streaming): add BatchAggregator with dynamic batching"
```

### Task 2.4: Text Stream Updater

**Files:**
- Create: `src/streaming/text-stream-updater.ts`
- Test: `tests/streaming/text-stream-updater.test.ts`

- [ ] **Step 1: テストを書く**

```typescript
// tests/streaming/text-stream-updater.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TextStreamUpdater } from '../../src/streaming/text-stream-updater.js';
import type { SlackAction } from '../../src/streaming/types.js';

describe('TextStreamUpdater', () => {
  let updater: TextStreamUpdater;
  let emittedActions: SlackAction[];

  beforeEach(() => {
    vi.useFakeTimers();
    emittedActions = [];
    updater = new TextStreamUpdater({
      channel: 'C1',
      threadTs: 'T1',
      onAction: (action) => emittedActions.push(action),
      getUpdateUtilization: () => 0.3,
    });
  });

  it('emits postMessage on first text', () => {
    updater.appendText('Hello');
    expect(emittedActions).toHaveLength(1);
    expect(emittedActions[0].type).toBe('postMessage');
  });

  it('does not emit update until interval', () => {
    updater.appendText('Hello');
    updater.setMessageTs('MSG1');
    updater.appendText(' world');
    // No interval elapsed → no update yet (only initial postMessage)
    expect(emittedActions).toHaveLength(1);
  });

  it('emits update after interval', () => {
    updater.appendText('Hello');
    updater.setMessageTs('MSG1');
    updater.appendText(' world');

    vi.advanceTimersByTime(2000);
    // Should have emitted an update
    const updates = emittedActions.filter(a => a.type === 'update');
    expect(updates.length).toBeGreaterThanOrEqual(1);
  });

  it('finalize removes streaming indicator', () => {
    updater.appendText('Hello');
    updater.setMessageTs('MSG1');
    updater.finalize();

    const updates = emittedActions.filter(a => a.type === 'update');
    expect(updates.length).toBeGreaterThanOrEqual(1);
  });

  it('getAccumulatedText returns full text', () => {
    updater.appendText('Hello');
    updater.appendText(' world');
    expect(updater.getAccumulatedText()).toBe('Hello world');
  });
});
```

- [ ] **Step 2: テスト失敗確認 → 実装**

```typescript
// src/streaming/text-stream-updater.ts
import { convertMarkdownToMrkdwn } from './markdown-converter.js';
import type { SlackAction } from './types.js';

interface TextStreamUpdaterConfig {
  channel: string;
  threadTs: string;
  onAction: (action: SlackAction) => void;
  getUpdateUtilization: () => number;
}

export class TextStreamUpdater {
  private textBuffer = '';
  private messageTs: string | null = null;
  private updateTimer: ReturnType<typeof setInterval> | null = null;
  private dirty = false;
  private readonly config: TextStreamUpdaterConfig;

  constructor(config: TextStreamUpdaterConfig) {
    this.config = config;
  }

  appendText(text: string): void {
    this.textBuffer += text;
    this.dirty = true;

    if (!this.messageTs) {
      // First text: postMessage
      const converted = convertMarkdownToMrkdwn(this.textBuffer);
      this.config.onAction({
        type: 'postMessage',
        priority: 1,
        channel: this.config.channel,
        threadTs: this.config.threadTs,
        blocks: this.buildBlocks(converted, false),
        text: this.textBuffer.slice(0, 100),
        metadata: { messageType: 'text' },
      });
      this.startUpdateTimer();
    }
  }

  setMessageTs(ts: string): void {
    this.messageTs = ts;
  }

  getAccumulatedText(): string {
    return this.textBuffer;
  }

  finalize(): void {
    this.stopUpdateTimer();
    if (this.messageTs) {
      const converted = convertMarkdownToMrkdwn(this.textBuffer);
      this.config.onAction({
        type: 'update',
        priority: 1,
        channel: this.config.channel,
        threadTs: this.config.threadTs,
        messageTs: this.messageTs,
        blocks: this.buildBlocks(converted, true),
        text: this.textBuffer.slice(0, 100),
        metadata: { messageType: 'text' },
      });
    }
    this.dirty = false;
  }

  private startUpdateTimer(): void {
    this.scheduleNextUpdate();
  }

  private scheduleNextUpdate(): void {
    this.updateTimer = setTimeout(() => {
      if (this.dirty && this.messageTs) {
        const converted = convertMarkdownToMrkdwn(this.textBuffer);
        this.config.onAction({
          type: 'update',
          priority: 4,
          channel: this.config.channel,
          threadTs: this.config.threadTs,
          messageTs: this.messageTs,
          blocks: this.buildBlocks(converted, false),
          text: this.textBuffer.slice(0, 100),
          metadata: { messageType: 'text' },
        });
        this.dirty = false;
      }
      // Reschedule with dynamically recalculated interval
      this.scheduleNextUpdate();
    }, this.getInterval());
  }

  private stopUpdateTimer(): void {
    if (this.updateTimer) {
      clearTimeout(this.updateTimer);
      this.updateTimer = null;
    }
  }

  dispose(): void {
    this.stopUpdateTimer();
  }

  private getInterval(): number {
    const util = this.config.getUpdateUtilization();
    if (util < 0.4) return 1500;
    if (util < 0.6) return 2000;
    if (util < 0.8) return 3000;
    if (util < 0.9) return 5000;
    return 10000;
  }

  private buildBlocks(mrkdwn: string, isComplete: boolean): Record<string, unknown>[] {
    const blocks: Record<string, unknown>[] = [];
    // Split into 2900-char sections (safety margin for 3000 limit)
    const parts = mrkdwn.match(/.{1,2900}/gs) || [mrkdwn];
    for (const part of parts) {
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: part },
      });
    }
    if (!isComplete) {
      blocks.push({
        type: 'context',
        elements: [{ type: 'mrkdwn', text: ':writing_hand: _入力中..._' }],
      });
    }
    return blocks;
  }
}
```

- [ ] **Step 3: テストパス確認 → コミット**

```bash
npx vitest run tests/streaming/text-stream-updater.test.ts && echo "✅ PASS"
git add src/streaming/text-stream-updater.ts tests/streaming/text-stream-updater.test.ts
git commit -m "feat(streaming): add TextStreamUpdater with interval-based updates"
```

### Task 2.5: StreamProcessor Phase 2拡張 — テキストストリーミング + バッチング統合

**Files:**
- Modify: `src/streaming/stream-processor.ts`
- Modify: `src/index.ts`
- Test: `tests/streaming/stream-processor.test.ts` に追加

- [ ] **Step 1: StreamProcessor にテキストイベント処理を追加**

`handleAssistant` の text block 処理を拡張：
- TextStreamUpdater を内部で使用
- text_delta → appendText
- text complete (stop_reason === 'end_turn') → finalize

- [ ] **Step 2: StreamProcessor に BatchAggregator を統合**

- tool_use アクションを BatchAggregator 経由で emit
- cumulativeToolCount を BatchAggregator と同期

- [ ] **Step 3: index.ts を更新して既存テキスト表示を StreamProcessor に移行**

wireSessionOutput から既存のテキスト表示ロジック（currentBuffer, pendingPost）を削除し、StreamProcessor のテキストストリーミングに完全移行。

- [ ] **Step 4: 全テスト実行**

```bash
npx vitest run && echo "✅ ALL PASS"
```

- [ ] **Step 5: コミット**

```bash
git add src/streaming/stream-processor.ts src/index.ts tests/streaming/stream-processor.test.ts
git commit -m "feat(streaming): Phase 2 — text streaming + batch aggregation"
```

### Task 2.6: Phase 2 全体テスト + リグレッション確認

- [ ] **Step 1: 全テスト + 型チェック**

```bash
npx vitest run && npx tsc --noEmit && echo "✅ Phase 2 complete"
```

- [ ] **Step 2: 手動テスト**

Slack DMで以下を確認：
1. テキスト応答が2秒間隔でストリーミング表示される
2. Markdownフォーマット（太字、リスト、コードブロック）が正しく変換される
3. 5ツール以上の連続実行でバッチ化される
4. Rate Limit エラーが発生しない

- [ ] **Step 3: Phase 2 完了コミット**

```bash
git commit --allow-empty -m "milestone: Phase 2 complete — text streaming + batching + markdown"
```

---

## Chunk 4: Phase 3 — Subagent Display + Graceful Degradation + Modal

**Goal:** subagentの可視化、Rate Limit安全保証、ツール詳細モーダル。

**Dependencies:** Phase 2 完了 + P0-1 結果（parent_tool_use_id の有無）

### Task 3.1: Subagent Tracker

**Files:**
- Create: `src/streaming/subagent-tracker.ts`
- Test: `tests/streaming/subagent-tracker.test.ts`

**Design depends on P0-1 result:**
- If `parent_tool_use_id` exists: 直接参照で親子追跡
- If not: ToolStack（tool_use/tool_result のネスト推定）

- [ ] **Step 1: テストを書く**

```typescript
// tests/streaming/subagent-tracker.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { SubagentTracker } from '../../src/streaming/subagent-tracker.js';

describe('SubagentTracker', () => {
  let tracker: SubagentTracker;

  beforeEach(() => {
    tracker = new SubagentTracker();
  });

  it('registers a subagent when Agent tool is used', () => {
    tracker.registerAgent('toolu_agent1', 'Explore codebase');
    expect(tracker.isSubagent('toolu_agent1')).toBe(true);
    expect(tracker.getAgentCount()).toBe(1);
  });

  it('tracks child tool steps within a subagent', () => {
    tracker.registerAgent('toolu_agent1', 'Explore');
    tracker.addStep('toolu_agent1', {
      toolName: 'Read',
      toolUseId: 'toolu_child1',
      oneLiner: 'src/auth.ts',
      status: 'running',
    });

    const steps = tracker.getSteps('toolu_agent1');
    expect(steps).toHaveLength(1);
    expect(steps[0].toolName).toBe('Read');
  });

  it('returns last N steps for display (fold older)', () => {
    tracker.registerAgent('toolu_agent1', 'Explore');
    for (let i = 0; i < 8; i++) {
      tracker.addStep('toolu_agent1', {
        toolName: 'Read',
        toolUseId: `toolu_c${i}`,
        oneLiner: `file${i}.ts`,
        status: 'completed',
      });
    }

    const display = tracker.getDisplaySteps('toolu_agent1', 5);
    expect(display.visibleSteps).toHaveLength(5);
    expect(display.hiddenCount).toBe(3);
  });
});
```

- [ ] **Step 2: テスト失敗確認 → 実装 → テストパス → コミット**

```bash
git add src/streaming/subagent-tracker.ts tests/streaming/subagent-tracker.test.ts
git commit -m "feat(streaming): add SubagentTracker for nested tool display"
```

### Task 3.2: Graceful Degradation

**Files:**
- Create: `src/streaming/graceful-degradation.ts`
- Test: `tests/streaming/graceful-degradation.test.ts`

- [ ] **Step 1: テストを書く**

```typescript
// tests/streaming/graceful-degradation.test.ts
import { describe, it, expect } from 'vitest';
import { GracefulDegradation } from '../../src/streaming/graceful-degradation.js';
import type { DegradationLevel, SlackAction } from '../../src/streaming/types.js';

describe('GracefulDegradation', () => {
  it('returns NORMAL at low utilization', () => {
    expect(GracefulDegradation.getLevel(0.3)).toBe('NORMAL');
    expect(GracefulDegradation.getLevel(0.59)).toBe('NORMAL');
  });

  it('returns CAUTION at 60-75%', () => {
    expect(GracefulDegradation.getLevel(0.65)).toBe('CAUTION');
  });

  it('returns THROTTLE at 75-85%', () => {
    expect(GracefulDegradation.getLevel(0.8)).toBe('THROTTLE');
  });

  it('returns CRITICAL at 85-95%', () => {
    expect(GracefulDegradation.getLevel(0.9)).toBe('CRITICAL');
  });

  it('returns EMERGENCY at 95%+', () => {
    expect(GracefulDegradation.getLevel(0.96)).toBe('EMERGENCY');
  });

  it('shouldExecute allows P1 in EMERGENCY', () => {
    expect(GracefulDegradation.shouldExecute('EMERGENCY', 1)).toBe(true);
  });

  it('shouldExecute blocks P3+ in EMERGENCY', () => {
    expect(GracefulDegradation.shouldExecute('EMERGENCY', 3)).toBe(false);
  });

  it('shouldExecute blocks P4+ in THROTTLE', () => {
    expect(GracefulDegradation.shouldExecute('THROTTLE', 4)).toBe(false);
    expect(GracefulDegradation.shouldExecute('THROTTLE', 3)).toBe(true);
  });

  it('shouldExecute allows all in NORMAL', () => {
    for (let p = 1; p <= 5; p++) {
      expect(GracefulDegradation.shouldExecute('NORMAL', p as any)).toBe(true);
    }
  });
});
```

- [ ] **Step 2: 実装**

```typescript
// src/streaming/graceful-degradation.ts
import type { DegradationLevel } from './types.js';

// Max allowed priority per degradation level
const MAX_PRIORITY: Record<DegradationLevel, number> = {
  NORMAL: 5,
  CAUTION: 4,     // Skip P5 (non-essential reactions)
  THROTTLE: 3,    // Suppress P4-P5 (streaming updates, low-pri)
  CRITICAL: 2,    // Skip P3+ (thinking, intermediate tools)
  EMERGENCY: 1,   // P1 only (final response + footer)
};

export class GracefulDegradation {
  static getLevel(maxUtilization: number): DegradationLevel {
    if (maxUtilization >= 0.95) return 'EMERGENCY';
    if (maxUtilization >= 0.85) return 'CRITICAL';
    if (maxUtilization >= 0.75) return 'THROTTLE';
    if (maxUtilization >= 0.60) return 'CAUTION';
    return 'NORMAL';
  }

  static shouldExecute(level: DegradationLevel, priority: number): boolean {
    return priority <= MAX_PRIORITY[level];
  }
}
```

- [ ] **Step 3: テストパス → コミット**

```bash
git add src/streaming/graceful-degradation.ts tests/streaming/graceful-degradation.test.ts
git commit -m "feat(streaming): add GracefulDegradation with 5 levels"
```

### Task 3.3: Tool Result Cache

**Files:**
- Create: `src/streaming/tool-result-cache.ts`
- Test: `tests/streaming/tool-result-cache.test.ts`

- [ ] **Step 1: テストを書く**

```typescript
// tests/streaming/tool-result-cache.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ToolResultCache } from '../../src/streaming/tool-result-cache.js';

describe('ToolResultCache', () => {
  let cache: ToolResultCache;

  beforeEach(() => {
    vi.useFakeTimers();
    cache = new ToolResultCache({ ttlMs: 30 * 60 * 1000, maxSizeBytes: 1024 * 1024 });
  });

  it('stores and retrieves tool data', () => {
    cache.set('toolu_001', {
      toolId: 'toolu_001',
      toolName: 'Read',
      input: { file_path: '/a.ts' },
      result: 'file contents',
      durationMs: 500,
      isError: false,
    });

    const data = cache.get('toolu_001');
    expect(data).toBeDefined();
    expect(data!.toolName).toBe('Read');
  });

  it('returns undefined for missing key', () => {
    expect(cache.get('nonexistent')).toBeUndefined();
  });

  it('expires entries after TTL', () => {
    cache.set('toolu_001', {
      toolId: 'toolu_001',
      toolName: 'Read',
      input: {},
      result: 'x',
      durationMs: 100,
      isError: false,
    });

    vi.advanceTimersByTime(31 * 60 * 1000);
    expect(cache.get('toolu_001')).toBeUndefined();
  });

  it('evicts LRU when size exceeded', () => {
    const bigResult = 'x'.repeat(600 * 1024); // 600KB
    cache.set('toolu_001', {
      toolId: 'toolu_001', toolName: 'Read', input: {}, result: bigResult, durationMs: 100, isError: false,
    });
    cache.set('toolu_002', {
      toolId: 'toolu_002', toolName: 'Read', input: {}, result: bigResult, durationMs: 100, isError: false,
    });

    // toolu_001 should have been evicted (total > 1MB)
    expect(cache.get('toolu_001')).toBeUndefined();
    expect(cache.get('toolu_002')).toBeDefined();
  });
});
```

- [ ] **Step 2: 実装 → テストパス → コミット**

```bash
git add src/streaming/tool-result-cache.ts tests/streaming/tool-result-cache.test.ts
git commit -m "feat(streaming): add ToolResultCache with TTL + size eviction"
```

### Task 3.4: Modal Builder

**Files:**
- Create: `src/slack/modal-builder.ts`
- Test: `tests/slack/modal-builder.test.ts`

- [ ] **Step 1: テストを書く**

```typescript
// tests/slack/modal-builder.test.ts
import { describe, it, expect } from 'vitest';
import { buildToolModal } from '../../src/slack/modal-builder.js';

describe('buildToolModal', () => {
  it('builds modal for Read tool', () => {
    const modal = buildToolModal({
      toolId: 'toolu_001',
      toolName: 'Read',
      input: { file_path: '/src/auth.ts' },
      result: 'const x = 1;\nconst y = 2;',
      durationMs: 800,
      isError: false,
    });

    expect(modal.type).toBe('modal');
    expect(modal.title.text).toContain('Read');
    expect(modal.blocks.length).toBeGreaterThan(0);
  });

  it('truncates title to 24 chars', () => {
    const modal = buildToolModal({
      toolId: 'toolu_001',
      toolName: 'Read',
      input: { file_path: '/very/long/path/to/some/deeply/nested/file.ts' },
      result: 'content',
      durationMs: 100,
      isError: false,
    });

    expect(modal.title.text.length).toBeLessThanOrEqual(24);
  });

  it('splits large content into multiple sections', () => {
    const largeResult = 'x'.repeat(6000);
    const modal = buildToolModal({
      toolId: 'toolu_001',
      toolName: 'Bash',
      input: { command: 'cat big.txt' },
      result: largeResult,
      durationMs: 2000,
      isError: false,
    });

    const sections = modal.blocks.filter((b: any) => b.type === 'section');
    expect(sections.length).toBeGreaterThan(1);
  });

  it('shows error styling for error results', () => {
    const modal = buildToolModal({
      toolId: 'toolu_001',
      toolName: 'Bash',
      input: { command: 'exit 1' },
      result: 'command failed',
      durationMs: 100,
      isError: true,
    });

    const text = JSON.stringify(modal.blocks);
    expect(text).toContain(':x:');
  });
});
```

- [ ] **Step 2: 実装**

```typescript
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
    // Header
    {
      type: 'header',
      text: { type: 'plain_text', text: `${config.toolName}` },
    },
    // Input summary
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `*入力:*\n\`\`\`\n${formatInput(config.toolName, config.input)}\n\`\`\`` },
    },
    { type: 'divider' },
    // Status
    {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `${icon} ${durationStr}` }],
    },
  ];

  // Result content — split into 2900-char sections
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
```

- [ ] **Step 3: テストパス → コミット**

```bash
git add src/slack/modal-builder.ts tests/slack/modal-builder.test.ts
git commit -m "feat(streaming): add modal builder for tool detail views"
```

### Task 3.5: Graceful Degradation を SlackActionExecutor に統合

**Files:**
- Modify: `src/streaming/slack-action-executor.ts`
- Test: `tests/streaming/slack-action-executor.test.ts` に追加

- [ ] **Step 1: execute() に degradation チェックを追加**

```typescript
// Before executing, check:
// const level = GracefulDegradation.getLevel(this.rateLimiter.getMaxUtilization());
// if (!GracefulDegradation.shouldExecute(level, action.priority)) {
//   return { ok: false, error: 'degraded_skip' };
// }
```

- [ ] **Step 2: テスト追加 → パス → コミット**

```bash
git add src/streaming/slack-action-executor.ts tests/streaming/slack-action-executor.test.ts
git commit -m "feat(streaming): integrate GracefulDegradation into executor"
```

### Task 3.6: index.ts にモーダルアクションハンドラを追加

**Files:**
- Modify: `src/index.ts`
- Modify: `src/slack/action-handler.ts`

- [ ] **Step 1: view_tool_detail アクションハンドラを追加**

```typescript
// In index.ts, add:
// app.action(/^view_tool_detail:/, async ({ ack, body }) => {
//   await ack();
//   const toolUseId = body.actions[0].action_id.split(':')[1];
//   const cached = toolResultCache.get(toolUseId);
//   if (!cached) return;
//   const modal = buildToolModal(cached);
//   await app.client.views.open({
//     trigger_id: body.trigger_id,
//     view: modal,
//   });
// });
```

- [ ] **Step 2: ツール表示メッセージに「詳細」ボタンを追加**

tool-formatter.ts の buildToolCompletedBlocks に accessory button を追加：
```typescript
// accessory: {
//   type: 'button',
//   text: { type: 'plain_text', text: '詳細' },
//   action_id: `view_tool_detail:${toolUseId}`,
// }
```

- [ ] **Step 3: コミット**

```bash
git add src/index.ts src/slack/action-handler.ts src/streaming/tool-formatter.ts
git commit -m "feat(streaming): add modal detail view for completed tools"
```

### Task 3.7: StreamProcessor に Subagent 統合

**Files:**
- Modify: `src/streaming/stream-processor.ts`

- [ ] **Step 1: Agent tool_use を検出して SubagentTracker に登録**

handleToolUse で toolName === 'Agent' を検出し、独立メッセージとして postMessage。

- [ ] **Step 2: subagent内ツールを親メッセージに chat.update で蓄積**

P0-1 結果に基づき、parent_tool_use_id または ToolStack でネスト判定。
5ステップ以上は折りたたみ（`... 他Nツール完了`）。

- [ ] **Step 3: テスト追加 → パス → コミット**

```bash
git add src/streaming/stream-processor.ts tests/streaming/stream-processor.test.ts
git commit -m "feat(streaming): add subagent tracking to StreamProcessor"
```

### Task 3.8: Phase 3 全体テスト + 最終確認

- [ ] **Step 1: 全テスト + 型チェック**

```bash
npx vitest run && npx tsc --noEmit && echo "✅ Phase 3 complete"
```

- [ ] **Step 2: 手動テスト**

1. Agent tool使用時にsubagentメッセージが表示される
2. subagent内ツールが親メッセージに蓄積される
3. 高負荷時にGraceful Degradationが動作する（P4+がスキップされる）
4. ツール完了後「詳細」ボタンでモーダルが開く
5. モーダルにツール入力/結果が正しく表示される

- [ ] **Step 3: Phase 3 完了コミット**

```bash
git commit --allow-empty -m "milestone: Phase 3 complete — subagent + degradation + modal"
```

---

## Dependency Graph

```
P0 Verification (Task 0.1-0.3)
         │
         ▼
Phase 1: Tool Visualization MVP
  Task 1.1 types ─────────────────────────┐
  Task 1.2 rate-limit-tracker ────────────┤
  Task 1.3 tool-formatter ────────────────┤
         │                                │
         ▼                                │
  Task 1.4 slack-action-executor ◄────────┘
         │
         ▼
  Task 1.5 stream-processor
         │
         ▼
  Task 1.6 index.ts integration
         │
         ▼
  Task 1.7 Phase 1 verification
         │
         ▼
Phase 2: Text Streaming + Batching
  Task 2.1 priority-queue ────────────────┐
  Task 2.2 markdown-converter ────────────┤
         │                                │
         ▼                                │
  Task 2.3 batch-aggregator ◄─────────────┘
  Task 2.4 text-stream-updater ◄──────────┘
         │
         ▼
  Task 2.5 stream-processor Phase 2 expansion
         │
         ▼
  Task 2.6 Phase 2 verification
         │
         ▼
Phase 3: Subagent + Degradation + Modal
  Task 3.1 subagent-tracker ──────────────┐
  Task 3.2 graceful-degradation ──────────┤
  Task 3.3 tool-result-cache ─────────────┤
  Task 3.4 modal-builder ────────────────┤
         │                                │
         ▼                                ▼
  Task 3.5 executor + degradation integration
  Task 3.6 modal action handlers
  Task 3.7 stream-processor subagent integration
         │
         ▼
  Task 3.8 Phase 3 verification
```

## Test Strategy

### Unit Tests (per module)
- **RateLimitTracker**: sliding window計算、429バックオフ
- **ToolFormatter**: 各ツールタイプの1行サマリー、Block Kit構造
- **SlackActionExecutor**: API呼び出しのモック、エラーハンドリング
- **StreamProcessor**: イベント→SlackAction変換、状態遷移
- **PriorityQueue**: 優先度順dequeue、discardBelow
- **MarkdownConverter**: 各構文要素の変換、不完全Markdown安全性
- **BatchAggregator**: ウィンドウタイミング、動的バッチサイズ
- **TextStreamUpdater**: テキスト蓄積、interval更新
- **SubagentTracker**: ネスト検出、ステップ蓄積
- **GracefulDegradation**: レベル判定、shouldExecute
- **ToolResultCache**: TTL、サイズ制限、LRU eviction
- **ModalBuilder**: 各ツールタイプのモーダル構造、大コンテンツ分割

### Mock Strategy
- **Slack API**: `app.client.chat.postMessage` / `chat.update` / `reactions.add` は全てvi.fn()でモック
- **Claude CLI process**: spawn をモック、stdout に JSON 行を emit
- **Timer**: vi.useFakeTimers() で setInterval/setTimeout を制御（バッチング、テキスト更新）
- **Date.now()**: Rate Limit tracker テストで使用

### Integration Tests (手動)
- Slack DMでの実際の動作確認（各Phase完了時）
- Rate Limit安全性の確認（同時セッション）
