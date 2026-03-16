# Round 2: stream-json リアルタイム表示設計

作成日: 2026-03-16
ベース: Round 1/2 統合設計書 + Agent SDK TypeScript リファレンス

---

## 0. 設計方針

Claude Code Viewer のように**出力をなるべくそのまま表示**しつつ、Slack の制約（4,000文字/message、50ブロック/message、chat.update Tier3 ~50回/分）とモバイル表示の制約を両立する。

**核心**: Agent SDK の `query()` を `includePartialMessages: true` で使い、`SDKMessage` ストリームを直接処理する。CLI の `--output-format stream-json` は Anthropic Messages API の `BetaRawMessageStreamEvent` をラップした形式であり、Agent SDK を使えば型安全にパースできる。

---

## 1. Agent SDK のメッセージ型（stream-json 相当）

`query()` が yield する `SDKMessage` の主要型:

| 型 | 用途 | タイミング |
|----|------|-----------|
| `SDKSystemMessage` (subtype: `init`) | セッション初期化。session_id, model, tools, cwd | 最初の1回 |
| `SDKPartialAssistantMessage` (type: `stream_event`) | ストリーミング中の部分メッセージ。`event` に `BetaRawMessageStreamEvent` を含む | `includePartialMessages: true` 時 |
| `SDKAssistantMessage` | 完成したアシスタントメッセージ。`message.content` にテキスト・ツール使用を含む | ターンごと |
| `SDKUserMessage` | ツール実行結果のユーザーメッセージ（tool_use_result） | ツール実行後 |
| `SDKToolUseSummaryMessage` | ツール使用のサマリー | ツール完了時 |
| `SDKToolProgressMessage` | ツール実行中の進捗 | 長時間ツール実行中 |
| `SDKStatusMessage` | ステータス更新 | 各フェーズ |
| `SDKResultMessage` | 最終結果。total_cost_usd, duration_ms, num_turns | 完了時 |

### 1.1 SDKPartialAssistantMessage 内の BetaRawMessageStreamEvent

`event` フィールドに Anthropic Messages API のストリーミングイベントが入る:

```typescript
// content_block_start: テキストまたはツール使用の開始
{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }
{ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_xxx", name: "Read", input: "" } }

// content_block_delta: テキストの差分またはツール入力のJSON差分
{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "こんにちは" } }
{ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{\"file_" } }

// content_block_stop: ブロック完了
{ type: "content_block_stop", index: 1 }

// message_delta: メッセージ終了情報
{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 42 } }
```

### 1.2 サブエージェントの識別

`SDKPartialAssistantMessage` と `SDKAssistantMessage` には `parent_tool_use_id` フィールドがある:

- `null` → メインエージェントのメッセージ
- `"toolu_xxx"` → 指定された tool_use_id のサブエージェント内のメッセージ

サブエージェント起動は `Agent` ツールの `content_block_start` で検出:
```typescript
{ type: "content_block_start", content_block: { type: "tool_use", name: "Agent", input: "" } }
```

完了した `SDKAssistantMessage` の `message.content` で Agent ツール使用を見ると:
```typescript
{
  type: "tool_use",
  id: "toolu_xxx",
  name: "Agent",
  input: { description: "コードレビュー", prompt: "...", subagent_type: "code-reviewer" }
}
```

---

## 2. スレッド内の表示設計

### 2.1 推奨方式: ハイブリッド（方式C）

**進捗は1メッセージを `chat.update` で逐次更新し、最終結果は別メッセージとして投稿する。**

理由:
- 方式A（1メッセージ更新のみ）: 最終結果が更新の洪水に埋もれる。スレッドの既読管理が破綻
- 方式B（ツールごとに新メッセージ）: 大量のツール呼び出し（10-20回）でスレッドが肥大化。Rate Limit圧迫
- 方式C: 進捗は1メッセージに凝縮、結果は独立メッセージで通知。モバイルでもスレッドが読みやすい

### 2.2 スレッド内メッセージ構成

```
スレッド
├── [ユーザー] 認証機能を実装して
├── [Bot] 📋 進捗メッセージ（chat.update で逐次更新）  ← Message A
│     ├── ステータスヘッダー: "⏳ 処理中... (3/5 ステップ)"
│     ├── ツール使用ログ（折りたたみ形式）
│     └── 現在のアクション表示
└── [Bot] ✅ 結果メッセージ（処理完了後に chat.postMessage） ← Message B
      ├── 応答テキスト本文
      ├── 変更ファイルサマリー
      └── コスト・所要時間フッター
```

### 2.3 Message A: 進捗メッセージの Block Kit 構成

#### 状態1: 処理開始直後

```json
{
  "blocks": [
    {
      "type": "context",
      "elements": [
        {
          "type": "mrkdwn",
          "text": "⏳ *処理中...* | Model: `claude-sonnet-4-6` | Session: `a1b2c3`"
        }
      ]
    },
    {
      "type": "section",
      "text": {
        "type": "mrkdwn",
        "text": "🔄 _思考中..._"
      }
    }
  ]
}
```

#### 状態2: ツール使用中（典型的な中間状態）

```json
{
  "blocks": [
    {
      "type": "context",
      "elements": [
        {
          "type": "mrkdwn",
          "text": "⏳ *処理中...* (ステップ 3/5) | 経過: 12s"
        }
      ]
    },
    {
      "type": "section",
      "text": {
        "type": "mrkdwn",
        "text": "✅ `Read` src/auth/login.ts (247行)\n✅ `Grep` pattern=`validateToken` → 3件\n🔄 `Edit` src/auth/login.ts ..."
      }
    },
    {
      "type": "context",
      "elements": [
        {
          "type": "mrkdwn",
          "text": "💭 _認証ロジックを修正しています..._"
        }
      ]
    },
    {
      "type": "actions",
      "elements": [
        {
          "type": "button",
          "text": { "type": "plain_text", "text": "🔍 詳細を見る" },
          "action_id": "show_progress_detail",
          "value": "session_a1b2c3_step_3"
        }
      ]
    }
  ]
}
```

#### 状態3: サブエージェント実行中

```json
{
  "blocks": [
    {
      "type": "context",
      "elements": [
        {
          "type": "mrkdwn",
          "text": "⏳ *処理中...* (ステップ 4/5) | 経過: 25s"
        }
      ]
    },
    {
      "type": "section",
      "text": {
        "type": "mrkdwn",
        "text": "✅ `Read` src/auth/login.ts (247行)\n✅ `Grep` pattern=`validateToken` → 3件\n✅ `Edit` src/auth/login.ts (+12/-3行)\n🔄 `Agent` code-reviewer: コードレビュー中..."
      }
    },
    {
      "type": "context",
      "elements": [
        {
          "type": "mrkdwn",
          "text": "🤖 _サブエージェント `code-reviewer` が動作中_"
        }
      ]
    },
    {
      "type": "actions",
      "elements": [
        {
          "type": "button",
          "text": { "type": "plain_text", "text": "🔍 詳細を見る" },
          "action_id": "show_progress_detail",
          "value": "session_a1b2c3_step_4"
        }
      ]
    }
  ]
}
```

#### 状態4: 処理完了（Message A の最終状態）

```json
{
  "blocks": [
    {
      "type": "context",
      "elements": [
        {
          "type": "mrkdwn",
          "text": "✅ *完了* | 5ステップ | 32s | $0.045"
        }
      ]
    },
    {
      "type": "section",
      "text": {
        "type": "mrkdwn",
        "text": "✅ `Read` src/auth/login.ts (247行)\n✅ `Grep` pattern=`validateToken` → 3件\n✅ `Edit` src/auth/login.ts (+12/-3行)\n✅ `Agent` code-reviewer → 完了 (2ツール, 8s)\n✅ `Bash` npm test → 成功"
      }
    },
    {
      "type": "actions",
      "elements": [
        {
          "type": "button",
          "text": { "type": "plain_text", "text": "📋 全ログを見る" },
          "action_id": "show_full_log",
          "value": "session_a1b2c3"
        }
      ]
    }
  ]
}
```

### 2.4 Message B: 結果メッセージの Block Kit 構成

```json
{
  "blocks": [
    {
      "type": "section",
      "text": {
        "type": "mrkdwn",
        "text": "認証機能を実装しました。以下の変更を行いました:\n\n1. `src/auth/login.ts` にトークン検証ロジックを追加\n2. `src/auth/middleware.ts` に認証ミドルウェアを作成\n3. テストを追加し、全テストがパスすることを確認\n\n主な変更点:\n• JWT トークンの検証にRS256アルゴリズムを使用\n• リフレッシュトークンのローテーション対応\n• 認証エラー時の統一的なエラーレスポンス"
      }
    },
    {
      "type": "divider"
    },
    {
      "type": "context",
      "elements": [
        {
          "type": "mrkdwn",
          "text": "📁 変更: `src/auth/login.ts` (+12/-3) · `src/auth/middleware.ts` (+45/new) · `tests/auth.test.ts` (+78/new)"
        }
      ]
    },
    {
      "type": "context",
      "elements": [
        {
          "type": "mrkdwn",
          "text": "⏱ 32s | 💰 $0.045 | 🔄 5ターン | 📊 Model: claude-sonnet-4-6"
        }
      ]
    }
  ]
}
```

結果テキストが長い場合（3,000文字超）は Round 1 の3段階分割戦略を適用:
- 3,900文字以下: 1メッセージ
- 3,900〜39,000文字: 複数メッセージに分割
- 39,000文字超: `files.uploadV2` でファイルアップロード

---

## 3. ツール使用の表示設計

### 3.1 インライン表示フォーマット（進捗メッセージ内）

各ツールの1行サマリー:

| ツール | 実行中 | 完了 |
|--------|--------|------|
| Read | `🔄 \`Read\` src/auth/login.ts ...` | `✅ \`Read\` src/auth/login.ts (247行)` |
| Edit | `🔄 \`Edit\` src/auth/login.ts ...` | `✅ \`Edit\` src/auth/login.ts (+12/-3行)` |
| Write | `🔄 \`Write\` src/auth/middleware.ts ...` | `✅ \`Write\` src/auth/middleware.ts (45行, new)` |
| Bash | `🔄 \`Bash\` npm test ...` | `✅ \`Bash\` npm test → 成功 (exit 0)` / `❌ \`Bash\` npm test → 失敗 (exit 1)` |
| Grep | `🔄 \`Grep\` pattern=\`validateToken\` ...` | `✅ \`Grep\` pattern=\`validateToken\` → 3件` |
| Glob | `🔄 \`Glob\` pattern=\`**/*.ts\` ...` | `✅ \`Glob\` pattern=\`**/*.ts\` → 12件` |
| Agent | `🔄 \`Agent\` code-reviewer: レビュー中...` | `✅ \`Agent\` code-reviewer → 完了 (2ツール, 8s)` |
| WebSearch | `🔄 \`WebSearch\` "jwt best practices" ...` | `✅ \`WebSearch\` "jwt best practices" → 5件` |
| WebFetch | `🔄 \`WebFetch\` https://example.com ...` | `✅ \`WebFetch\` https://example.com (12KB)` |

### 3.2 サマリー生成ロジック

```typescript
interface ToolUseSummary {
  toolName: string;
  status: 'running' | 'completed' | 'error';
  oneLiner: string;       // 進捗メッセージ内の1行表示
  detailBlocks: Block[];  // モーダル内の詳細 Block Kit
}

function summarizeToolUse(
  toolName: string,
  input: Record<string, unknown>,
  output?: Record<string, unknown>,
  error?: string,
): ToolUseSummary {
  switch (toolName) {
    case 'Read': {
      const filePath = shortenPath(input.file_path as string);
      if (!output) return { toolName, status: 'running', oneLiner: `🔄 \`Read\` ${filePath} ...`, detailBlocks: [] };
      const numLines = (output as any)?.file?.numLines ?? '?';
      return { toolName, status: 'completed', oneLiner: `✅ \`Read\` ${filePath} (${numLines}行)`, detailBlocks: buildReadDetail(input, output) };
    }
    case 'Edit': {
      const filePath = shortenPath(input.file_path as string);
      if (!output) return { toolName, status: 'running', oneLiner: `🔄 \`Edit\` ${filePath} ...`, detailBlocks: [] };
      const diff = output as any;
      const adds = diff?.gitDiff?.additions ?? '?';
      const dels = diff?.gitDiff?.deletions ?? '?';
      return { toolName, status: 'completed', oneLiner: `✅ \`Edit\` ${filePath} (+${adds}/-${dels}行)`, detailBlocks: buildEditDetail(input, output) };
    }
    case 'Bash': {
      const cmd = truncate(input.command as string, 40);
      if (!output) return { toolName, status: 'running', oneLiner: `🔄 \`Bash\` ${cmd} ...`, detailBlocks: [] };
      const bashOut = output as any;
      const success = !bashOut.interrupted && !error;
      const icon = success ? '✅' : '❌';
      const result = success ? '成功' : '失敗';
      return { toolName, status: success ? 'completed' : 'error', oneLiner: `${icon} \`Bash\` ${cmd} → ${result}`, detailBlocks: buildBashDetail(input, output) };
    }
    case 'Agent': {
      const agentInput = input as any;
      const name = agentInput.subagent_type || agentInput.name || 'subagent';
      const desc = truncate(agentInput.description || '', 30);
      if (!output) return { toolName, status: 'running', oneLiner: `🔄 \`Agent\` ${name}: ${desc}...`, detailBlocks: [] };
      const agentOut = output as any;
      const tools = agentOut.totalToolUseCount ?? '?';
      const duration = agentOut.totalDurationMs ? `${Math.round(agentOut.totalDurationMs / 1000)}s` : '?';
      return { toolName, status: 'completed', oneLiner: `✅ \`Agent\` ${name} → 完了 (${tools}ツール, ${duration})`, detailBlocks: buildAgentDetail(input, output) };
    }
    // Grep, Glob, Write, WebSearch, WebFetch 等も同様のパターン
    default: {
      if (!output) return { toolName, status: 'running', oneLiner: `🔄 \`${toolName}\` ...`, detailBlocks: [] };
      return { toolName, status: 'completed', oneLiner: `✅ \`${toolName}\` 完了`, detailBlocks: [] };
    }
  }
}
```

### 3.3 「詳細を見る」モーダルの Block Kit 構成

ボタンクリック時に `views.open` で表示するモーダル:

```json
{
  "type": "modal",
  "title": { "type": "plain_text", "text": "実行詳細" },
  "blocks": [
    {
      "type": "header",
      "text": { "type": "plain_text", "text": "📋 ステップ 3: Edit src/auth/login.ts" }
    },
    {
      "type": "section",
      "text": {
        "type": "mrkdwn",
        "text": "*ツール:* `Edit`\n*ファイル:* `src/auth/login.ts`\n*変更:* +12行 / -3行"
      }
    },
    {
      "type": "header",
      "text": { "type": "plain_text", "text": "変更内容 (diff)" }
    },
    {
      "type": "section",
      "text": {
        "type": "mrkdwn",
        "text": "```diff\n@@ -45,8 +45,17 @@\n-  const isValid = checkToken(token);\n-  if (!isValid) return false;\n-  return true;\n+  try {\n+    const decoded = jwt.verify(token, publicKey, {\n+      algorithms: ['RS256'],\n+      issuer: 'auth-service',\n+    });\n+    if (decoded.exp < Date.now() / 1000) {\n+      throw new TokenExpiredError();\n+    }\n+    return { valid: true, payload: decoded };\n+  } catch (err) {\n+    logger.warn('Token validation failed', { error: err.message });\n+    return { valid: false, error: err.message };\n+  }\n```"
      }
    }
  ]
}
```

#### Bash ツールの詳細モーダル:

```json
{
  "type": "modal",
  "title": { "type": "plain_text", "text": "実行詳細" },
  "blocks": [
    {
      "type": "header",
      "text": { "type": "plain_text", "text": "🖥 Bash: npm test" }
    },
    {
      "type": "section",
      "text": {
        "type": "mrkdwn",
        "text": "*コマンド:*\n```\nnpm test\n```"
      }
    },
    {
      "type": "section",
      "text": {
        "type": "mrkdwn",
        "text": "*stdout:*\n```\n> my-project@1.0.0 test\n> vitest run\n\n ✓ tests/auth.test.ts (4 tests) 120ms\n ✓ tests/middleware.test.ts (3 tests) 85ms\n\n Tests  7 passed\n Time   1.23s\n```"
      }
    },
    {
      "type": "context",
      "elements": [
        { "type": "mrkdwn", "text": "Exit code: `0` | Duration: 1.5s" }
      ]
    }
  ]
}
```

#### Agent（サブエージェント）の詳細モーダル:

```json
{
  "type": "modal",
  "title": { "type": "plain_text", "text": "実行詳細" },
  "blocks": [
    {
      "type": "header",
      "text": { "type": "plain_text", "text": "🤖 Agent: code-reviewer" }
    },
    {
      "type": "section",
      "text": {
        "type": "mrkdwn",
        "text": "*タイプ:* `code-reviewer`\n*説明:* コードレビュー\n*ツール使用数:* 2\n*所要時間:* 8s\n*トークン:* 1,234"
      }
    },
    {
      "type": "divider"
    },
    {
      "type": "section",
      "text": {
        "type": "mrkdwn",
        "text": "*サブエージェントのツール使用:*\n✅ `Read` src/auth/login.ts (247行)\n✅ `Grep` pattern=`security` → 5件"
      }
    },
    {
      "type": "divider"
    },
    {
      "type": "section",
      "text": {
        "type": "mrkdwn",
        "text": "*レビュー結果:*\nJWT実装は適切です。RS256の使用、有効期限チェック、エラーハンドリングが正しく行われています。"
      }
    }
  ]
}
```

---

## 4. stream-json パース戦略

### 4.1 アーキテクチャ概要

```
Agent SDK query()
    │
    │  SDKMessage ストリーム
    ▼
┌─────────────────────────────────┐
│  StreamProcessor                │
│                                 │
│  ┌───────────────────────────┐  │
│  │ MessageAccumulator        │  │
│  │ - textBuffer: string      │  │
│  │ - toolUses: ToolUseState[]│  │
│  │ - currentThinking: string │  │
│  │ - stepCount: number       │  │
│  │ - subAgentState: Map      │  │
│  └────────────┬──────────────┘  │
│               │                 │
│  ┌────────────▼──────────────┐  │
│  │ SlackUpdateThrottler      │  │
│  │ - minInterval: 1200ms     │  │
│  │ - pendingUpdate: Block[]  │  │
│  │ - lastUpdateAt: number    │  │
│  └────────────┬──────────────┘  │
│               │                 │
│  ┌────────────▼──────────────┐  │
│  │ BlockKitBuilder           │  │
│  │ - buildProgressBlocks()   │  │
│  │ - buildResultBlocks()     │  │
│  │ - buildModalBlocks()      │  │
│  └───────────────────────────┘  │
└─────────────────────────────────┘
    │
    ▼
  Slack API (chat.update / chat.postMessage)
```

### 4.2 メッセージ処理ステートマシン

```typescript
type ProcessingPhase =
  | 'idle'           // 未開始
  | 'thinking'       // テキスト生成中（thinking/応答テキスト）
  | 'tool_input'     // ツール入力のJSON構築中
  | 'tool_running'   // ツール実行中（SDKUserMessage待ち）
  | 'sub_agent'      // サブエージェント内
  | 'completed'      // 完了
  | 'error';         // エラー

interface StreamProcessorState {
  phase: ProcessingPhase;
  progressMessageTs: string | null;  // Message A の ts
  steps: ToolUseStep[];              // 完了・進行中のツール使用リスト
  currentText: string;               // 現在のテキストバッファ
  currentToolUse: {                  // 現在構築中のツール使用
    id: string;
    name: string;
    inputJson: string;               // 差分蓄積中のJSON文字列
  } | null;
  subAgentSteps: Map<string, ToolUseStep[]>; // parent_tool_use_id → steps
  startTime: number;
  lastThinkingSnippet: string;       // 思考の最新スニペット（表示用）
}

interface ToolUseStep {
  index: number;
  toolName: string;
  toolUseId: string;
  input: Record<string, unknown>;
  output?: Record<string, unknown>;
  error?: string;
  status: 'running' | 'completed' | 'error';
  startTime: number;
  endTime?: number;
  parentToolUseId: string | null;    // サブエージェント識別
}
```

### 4.3 イベント処理フロー

```typescript
async function processStream(
  query: Query,
  slackClient: WebClient,
  channelId: string,
  threadTs: string,
): Promise<void> {
  const state: StreamProcessorState = { /* 初期化 */ };
  const throttler = new SlackUpdateThrottler(slackClient, channelId, threadTs);

  for await (const message of query) {
    switch (message.type) {

      // ── 初期化 ──
      case 'system':
        if (message.subtype === 'init') {
          // Message A を投稿
          const result = await slackClient.chat.postMessage({
            channel: channelId,
            thread_ts: threadTs,
            blocks: buildInitialProgressBlocks(message),
          });
          state.progressMessageTs = result.ts!;
          state.startTime = Date.now();
        }
        break;

      // ── ストリーミングイベント ──
      case 'stream_event':
        await handleStreamEvent(message, state, throttler);
        break;

      // ── 完成したアシスタントメッセージ ──
      case 'assistant':
        handleAssistantMessage(message, state);
        break;

      // ── ツール実行結果（ユーザーメッセージ） ──
      case 'user':
        if (message.tool_use_result) {
          handleToolResult(message, state, throttler);
        }
        break;

      // ── 最終結果 ──
      case 'result':
        await handleResult(message, state, slackClient, channelId, threadTs, throttler);
        break;
    }
  }
}

async function handleStreamEvent(
  message: SDKPartialAssistantMessage,
  state: StreamProcessorState,
  throttler: SlackUpdateThrottler,
): Promise<void> {
  const event = message.event;
  const parentId = message.parent_tool_use_id;

  switch (event.type) {
    case 'content_block_start':
      if (event.content_block.type === 'text') {
        state.phase = 'thinking';
      } else if (event.content_block.type === 'tool_use') {
        state.phase = 'tool_input';
        state.currentToolUse = {
          id: event.content_block.id,
          name: event.content_block.name,
          inputJson: '',
        };
        // ステップ追加（running状態）
        const step: ToolUseStep = {
          index: state.steps.length,
          toolName: event.content_block.name,
          toolUseId: event.content_block.id,
          input: {},
          status: 'running',
          startTime: Date.now(),
          parentToolUseId: parentId,
        };
        if (parentId) {
          const subSteps = state.subAgentSteps.get(parentId) ?? [];
          subSteps.push(step);
          state.subAgentSteps.set(parentId, subSteps);
        } else {
          state.steps.push(step);
        }
        throttler.scheduleUpdate(buildProgressBlocks(state));
      }
      break;

    case 'content_block_delta':
      if (event.delta.type === 'text_delta') {
        state.currentText += event.delta.text;
        // 思考テキストの最新50文字を抽出（表示用）
        state.lastThinkingSnippet = extractSnippet(state.currentText, 50);
        // テキスト差分でのthrottle更新は頻度を下げる（3秒に1回）
        throttler.scheduleUpdate(buildProgressBlocks(state), { minInterval: 3000 });
      } else if (event.delta.type === 'input_json_delta') {
        if (state.currentToolUse) {
          state.currentToolUse.inputJson += event.delta.partial_json;
        }
      }
      break;

    case 'content_block_stop':
      if (state.currentToolUse) {
        // JSON パースしてinputを確定
        try {
          const input = JSON.parse(state.currentToolUse.inputJson);
          const step = findStep(state, state.currentToolUse.id);
          if (step) step.input = input;
        } catch { /* JSON不完全 — 無視 */ }
        state.phase = 'tool_running';
        state.currentToolUse = null;
        throttler.scheduleUpdate(buildProgressBlocks(state));
      }
      break;

    case 'message_delta':
      // ターン終了。stop_reason を確認
      break;
  }
}
```

### 4.4 Rate Limit 対策: SlackUpdateThrottler

```typescript
class SlackUpdateThrottler {
  private pendingBlocks: Block[] | null = null;
  private timer: NodeJS.Timeout | null = null;
  private lastUpdateAt = 0;
  private defaultMinInterval = 1200; // ms (50回/分 = 1200ms間隔)
  private updateCount = 0;
  private windowStart = Date.now();

  constructor(
    private client: WebClient,
    private channelId: string,
    private threadTs: string,
    private progressMessageTs?: string,
  ) {}

  setProgressMessageTs(ts: string): void {
    this.progressMessageTs = ts;
  }

  /**
   * 更新をスケジュールする。
   * minInterval 以内に複数回呼ばれた場合、最新のblocksのみが送信される。
   */
  scheduleUpdate(blocks: Block[], opts?: { minInterval?: number }): void {
    this.pendingBlocks = blocks;
    const interval = opts?.minInterval ?? this.defaultMinInterval;

    if (this.timer) return; // 既にタイマー待ち

    const elapsed = Date.now() - this.lastUpdateAt;
    if (elapsed >= interval) {
      // 即時送信可能
      this.flush();
    } else {
      // 次の送信可能時刻まで待機
      this.timer = setTimeout(() => {
        this.timer = null;
        this.flush();
      }, interval - elapsed);
    }
  }

  /**
   * 即時更新を強制する（完了時やエラー時に使用）。
   */
  async forceUpdate(blocks: Block[]): Promise<void> {
    this.pendingBlocks = blocks;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.flush();
  }

  private async flush(): Promise<void> {
    if (!this.pendingBlocks || !this.progressMessageTs) return;
    const blocks = this.pendingBlocks;
    this.pendingBlocks = null;

    // スライディングウィンドウでRate Limit監視
    const now = Date.now();
    if (now - this.windowStart > 60_000) {
      this.updateCount = 0;
      this.windowStart = now;
    }

    if (this.updateCount >= 45) {
      // Rate Limit接近 — 間隔を広げる
      this.defaultMinInterval = Math.min(this.defaultMinInterval * 1.5, 5000);
      return; // この更新はスキップ
    }

    try {
      await this.client.chat.update({
        channel: this.channelId,
        ts: this.progressMessageTs,
        blocks,
      });
      this.lastUpdateAt = Date.now();
      this.updateCount++;
    } catch (err: any) {
      if (err?.data?.error === 'ratelimited') {
        // Retry-After ヘッダーを尊重
        const retryAfter = parseInt(err.data?.headers?.['retry-after'] ?? '5', 10);
        this.defaultMinInterval = Math.max(this.defaultMinInterval, retryAfter * 1000);
      }
      // その他のエラーはログのみ（進捗表示の失敗は致命的ではない）
    }
  }
}
```

### 4.5 エラーハンドリング

| 状況 | 対処 |
|------|------|
| ストリーム中断（プロセスクラッシュ） | Message A を「❌ エラーが発生しました」に更新。stderr があればモーダルで表示 |
| タイムアウト | Message A を「⚠️ タイムアウト」に更新。中間結果があれば Message B として投稿 |
| Rate Limit (chat.update) | throttler が自動的に間隔を広げる。最悪のケースでも進捗表示がスキップされるだけ |
| JSON パースエラー（input_json_delta 不完全） | `content_block_stop` 時に再度パースを試みる。失敗してもツール名は表示可能 |
| Slack API エラー（chat.postMessage 失敗） | 指数バックオフで3回リトライ。失敗時はログに記録 |
| サブエージェントのエラー | Agent ツールの output にエラー情報が含まれる。ステップを「❌」で表示 |

---

## 5. サブエージェントの表示設計

### 5.1 サブエージェントのイベント識別方法

Agent SDK の `SDKMessage` には `parent_tool_use_id` フィールドがある:

```typescript
// メインエージェントのメッセージ
{ type: "assistant", parent_tool_use_id: null, message: { ... } }

// サブエージェント内のメッセージ
{ type: "assistant", parent_tool_use_id: "toolu_01ABC...", message: { ... } }
{ type: "stream_event", parent_tool_use_id: "toolu_01ABC...", event: { ... } }
```

処理フロー:
1. メインエージェントが `Agent` ツールを呼び出す → `content_block_start` で `name: "Agent"` を検出
2. `content_block_stop` で Agent ツールの input（description, subagent_type等）が確定
3. 以降、`parent_tool_use_id` が一致するメッセージはサブエージェント内のもの
4. サブエージェント完了時: `SDKUserMessage` の `tool_use_result` で `AgentOutput` を受信

### 5.2 サブエージェントのネスト表示

進捗メッセージ内では、サブエージェントのツール使用をインデントして表示:

```
✅ `Read` src/auth/login.ts (247行)
✅ `Grep` pattern=`validateToken` → 3件
✅ `Edit` src/auth/login.ts (+12/-3行)
🔄 `Agent` code-reviewer: コードレビュー中...
    ├ ✅ `Read` src/auth/login.ts
    └ 🔄 `Grep` pattern=`security` ...
✅ `Bash` npm test → 成功
```

Slack mrkdwn ではインデントが限定的なので、以下のフォーマットを使用:

```
✅ `Read` src/auth/login.ts (247行)
✅ `Grep` pattern=`validateToken` → 3件
✅ `Edit` src/auth/login.ts (+12/-3行)
🔄 `Agent` code-reviewer: コードレビュー中...
  ↳ ✅ `Read` src/auth/login.ts
  ↳ 🔄 `Grep` pattern=`security` ...
✅ `Bash` npm test → 成功
```

### 5.3 サブエージェントが多数のツールを使用する場合

サブエージェント内のツール使用が5つを超える場合は折りたたみ:

```
✅ `Agent` code-reviewer → 完了 (8ツール, 15s)
  ↳ ✅ `Read` x3, `Grep` x3, `Edit` x2 — 📋 詳細を見る
```

「詳細を見る」ボタンでモーダルに全ステップを展開。

---

## 6. Executor の改修: Agent SDK への移行

### 6.1 現行（Round 1/2 設計）との差分

現行の `ClaudeExecutor` は `child_process.spawn` で `claude -p` を起動し、stdout を文字列として受信していた。新設計では Agent SDK の `query()` を使い、型安全なメッセージストリームを処理する。

```typescript
import { query, type SDKMessage, type Options } from '@anthropic-ai/claude-agent-sdk';

export class StreamingClaudeExecutor {
  constructor(private config: BridgeConfig) {}

  async* execute(options: ExecuteOptions): AsyncGenerator<SDKMessage> {
    const sdkOptions: Options = {
      cwd: options.workingDirectory,
      permissionMode: this.config.bridge.permissionMode as any,
      includePartialMessages: true,  // ストリーミングイベント有効化
      maxBudgetUsd: options.maxBudgetUsd,
      sessionId: options.isResume ? undefined : options.sessionId,
      resume: options.isResume ? options.sessionId : undefined,
      env: {
        ...process.env,
        CLAUDECODE: undefined,  // ネスト防止
      },
    };

    const q = query({
      prompt: options.prompt,
      options: sdkOptions,
    });

    for await (const message of q) {
      yield message;
    }
  }
}
```

### 6.2 Agent SDK 導入のメリット

| 観点 | spawn方式 | Agent SDK方式 |
|------|-----------|---------------|
| 型安全性 | なし（stdout文字列パース） | 完全な型定義 |
| ストリーミング | 自前で stream-json パース | `SDKMessage` として構造化済み |
| ツール情報 | 出力からの推測が必要 | input/output の完全な型 |
| サブエージェント | `parent_tool_use_id` の自前管理 | SDK が自動的にフィールドを付与 |
| エラーハンドリング | exit code + stderr パース | `SDKResultMessage.subtype` で判別 |
| セッション管理 | `--session-id` / `-r` の引数構築 | `sessionId` / `resume` オプション |

---

## 7. 全体データフロー（改訂版）

```
User → Slack: "認証機能を実装して"
  │
  ▼
EventHandler: message event → ack()
  │
  ├─ reactions.add(⏳)
  │
  ├─ SessionManager.resolveOrCreate() → { sessionId, isResume }
  │
  └─ StreamingClaudeExecutor.execute() → AsyncGenerator<SDKMessage>
       │
       │  SDKSystemMessage (init)
       ├──────────────────────────────────────────────────────┐
       │                                                      ▼
       │  SDKPartialAssistantMessage (stream_event)    chat.postMessage
       │  - content_block_start (text)                 → Message A 投稿
       │  - content_block_delta (text_delta)            (progressMessageTs 取得)
       │  - content_block_start (tool_use: Read)
       │  - content_block_delta (input_json_delta)      ┌─────────────────┐
       │  - content_block_stop                          │ Throttler       │
       │                                                │ 1.2s間隔で      │
       │  SDKAssistantMessage                    ──────►│ chat.update     │
       │  (完成したアシスタントメッセージ)               │ Message A を更新 │
       │                                                └─────────────────┘
       │  SDKUserMessage (tool_use_result: Read output)
       │  → ToolUseStep を 'completed' に更新
       │  → throttler.scheduleUpdate()
       │
       │  SDKPartialAssistantMessage (stream_event)
       │  - content_block_start (tool_use: Edit)
       │  ... (繰り返し)
       │
       │  SDKPartialAssistantMessage (stream_event)
       │  - content_block_start (tool_use: Agent)
       │  │
       │  │  以降 parent_tool_use_id 付きメッセージ:
       │  │  - サブエージェント内の Read, Grep 等
       │  │  → subAgentSteps Map に蓄積
       │  │  → throttler.scheduleUpdate() (インデント表示)
       │  │
       │  SDKUserMessage (tool_use_result: AgentOutput)
       │  → Agent ステップを 'completed' に更新
       │
       │  SDKResultMessage
       ├──────────────────────────────────────────────────────┐
       │                                                      ▼
       │                                               Message A を最終状態に更新
       │                                               (✅ 完了 | Nステップ | Xs | $Y)
       │                                                      │
       │                                               chat.postMessage
       │                                               → Message B 投稿
       │                                               (応答テキスト + サマリー)
       │                                                      │
       │                                               reactions.remove(⏳)
       ▼                                               reactions.add(✅)
```

---

## 8. 進捗メッセージの最大ブロック数管理

Slack の50ブロック制限に対して、進捗メッセージは以下の構造:

| ブロック | 数 | 説明 |
|----------|-----|------|
| context (ステータスヘッダー) | 1 | 処理中/完了表示 |
| section (ツール使用ログ) | 1-3 | 3,000文字/sectionのため分割可能性あり |
| context (思考スニペット) | 0-1 | thinking中のみ |
| actions (詳細ボタン) | 0-1 | ボタン表示 |
| **合計** | **2-6** | **50ブロック制限に余裕あり** |

ツール使用が多数（20個超）の場合、1 section ブロックの3,000文字に収まらない可能性がある。対策:

```typescript
function buildToolUsageSection(steps: ToolUseStep[]): Block[] {
  const lines = steps.map(s => s.oneLiner);
  const blocks: Block[] = [];
  let currentChunk = '';

  for (const line of lines) {
    if ((currentChunk + '\n' + line).length > 2800) {
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: currentChunk },
      });
      currentChunk = line;
    } else {
      currentChunk += (currentChunk ? '\n' : '') + line;
    }
  }
  if (currentChunk) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: currentChunk },
    });
  }

  // 50ブロック制限保護: section が 40 を超えたら省略
  if (blocks.length > 40) {
    const truncated = blocks.slice(0, 39);
    truncated.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `... 他 ${blocks.length - 39} セクション省略 — 📋 全ログを見るボタンから確認` }],
    });
    return truncated;
  }

  return blocks;
}
```

---

## 9. 状態管理データの永続化

進捗表示のためにメモリに保持するデータ（`StreamProcessorState`）はプロセスメモリのみで管理する。理由:

- 進捗データは一時的（実行中のみ必要）
- 実行完了後は Message A の最終状態と Message B が永続的な記録
- Bridge サーバーがクラッシュした場合、進行中の Claude Code プロセスも終了するため復元不要

ただし、モーダル表示用のツール使用詳細は実行完了後も必要なため、`ToolUseStep[]` を TTL 付きキャッシュに保持:

```typescript
// 実行完了後30分間保持（モーダル表示用）
const toolUseCache = new Map<string, { steps: ToolUseStep[], expiresAt: number }>();

function cacheToolUseSteps(sessionId: string, steps: ToolUseStep[]): void {
  toolUseCache.set(sessionId, {
    steps,
    expiresAt: Date.now() + 30 * 60 * 1000,
  });
}

// 定期的にexpire済みエントリを削除
setInterval(() => {
  const now = Date.now();
  for (const [key, value] of toolUseCache) {
    if (value.expiresAt < now) toolUseCache.delete(key);
  }
}, 60_000);
```

---

## 10. 実装チェックリスト（Stream 表示機能）

既存 MVP チェックリスト (Round 2 統合設計書 §7) への追加タスク:

### Phase 2.5: Streaming Layer (1.5日)

| # | タスク | 依存 | 推定 |
|---|--------|------|------|
| 2.5-1 | `@anthropic-ai/claude-agent-sdk` を依存に追加 | 0-1 | 5分 |
| 2.5-2 | `src/bridge/streaming-executor.ts` — Agent SDK `query()` ラッパー | 2.5-1, 0-4 | 60分 |
| 2.5-3 | `src/bridge/stream-processor.ts` — StreamProcessorState + イベントハンドラ | 2.5-2, 0-7 | 90分 |
| 2.5-4 | `src/slack/throttler.ts` — SlackUpdateThrottler | 0-5 | 45分 |
| 2.5-5 | `src/slack/block-builder.ts` — Block Kit 生成（進捗・結果・モーダル） | 0-7, 3-3 | 90分 |
| 2.5-6 | `src/slack/tool-summarizer.ts` — ツール使用のサマリー生成 | 0-7 | 60分 |
| 2.5-7 | `src/slack/modal-handler.ts` — モーダル表示の interaction handler | 2.5-5, 2.5-6 | 45分 |
| 2.5-8 | streaming-executor.test.ts | 2.5-2 | 30分 |
| 2.5-9 | stream-processor.test.ts | 2.5-3 | 45分 |
| 2.5-10 | block-builder.test.ts | 2.5-5 | 30分 |

### 依存関係

```
Phase 0 (基盤) + Phase 1 (Store)
  │
  └──► Phase 2.5 (Streaming Layer)  ◄── Phase 2 (Bridge Core の session-manager のみ)
        │
        └──► Phase 3 (Slack Layer の event-handler を改修)
              │
              └──► Phase 4 (統合)
```

---

## 11. ディレクトリ構造（改訂版）

```
claude-slack-bridge/
├── src/
│   ├── index.ts
│   ├── config.ts
│   ├── types.ts
│   │
│   ├── slack/
│   │   ├── event-handler.ts
│   │   ├── command-parser.ts
│   │   ├── response-builder.ts
│   │   ├── block-builder.ts          # NEW: Block Kit 生成
│   │   ├── throttler.ts              # NEW: chat.update throttling
│   │   ├── tool-summarizer.ts        # NEW: ツール使用サマリー
│   │   └── modal-handler.ts          # NEW: モーダル interaction
│   │
│   ├── bridge/
│   │   ├── streaming-executor.ts     # NEW: Agent SDK ベース実行
│   │   ├── stream-processor.ts       # NEW: ストリーム処理
│   │   ├── executor.ts               # 旧: spawn ベース（フォールバック用）
│   │   ├── session-manager.ts
│   │   └── queue.ts
│   │
│   ├── store/
│   │   ├── database.ts
│   │   ├── channel-workdir.ts
│   │   ├── thread-session.ts
│   │   └── active-process.ts
│   │
│   └── utils/
│       ├── logger.ts
│       └── errors.ts
│
├── tests/
│   ├── streaming-executor.test.ts    # NEW
│   ├── stream-processor.test.ts      # NEW
│   ├── block-builder.test.ts         # NEW
│   ├── tool-summarizer.test.ts       # NEW
│   ├── executor.test.ts
│   ├── session-manager.test.ts
│   ├── queue.test.ts
│   ├── command-parser.test.ts
│   └── response-builder.test.ts
│
├── package.json                      # @anthropic-ai/claude-agent-sdk 追加
└── ...
```

---

## 12. 技術的注意事項

### 12.1 Agent SDK vs CLI spawn のトレードオフ

| 観点 | Agent SDK | CLI spawn |
|------|-----------|-----------|
| 依存関係 | SDK パッケージへの依存 | claude CLI のみ |
| バージョン追従 | SDK のバージョンアップが必要 | CLI は独立してアップデート |
| 認証 | API キーが必要 | CLI の認証設定を使用 |
| 機能 | hooks, custom tools 等の高度な機能 | CLI オプションのみ |
| ストリーミング | ネイティブサポート | stdout パース必要 |

**推奨**: Agent SDK を primary、CLI spawn を fallback として両方実装する。

### 12.2 CLI spawn でのストリーミング（フォールバック）

Agent SDK が使えない環境（API キーなし等）では、CLI の `--output-format stream-json --verbose` を使う:

```typescript
const proc = spawn('claude', [
  '-p',
  '--output-format', 'stream-json',
  '--verbose',
  '--session-id', sessionId,
  '--permission-mode', 'auto',
  prompt,
], { cwd: workingDirectory });

// stdout は 1行1JSON
const rl = readline.createInterface({ input: proc.stdout! });
rl.on('line', (line) => {
  const event = JSON.parse(line);
  // event.type で分岐: init, start, content_block_start, ...
});
```

この場合のイベント型は Agent SDK の SDKMessage とは若干異なるが、内部で正規化して同じ StreamProcessor に流す。

### 12.3 `includePartialMessages` のコスト

`includePartialMessages: true` にすると、テキストの各トークンごとに `stream_event` が発生する。
長い応答（数千トークン）では大量のイベントが来るが、`SlackUpdateThrottler` がテキスト差分時の更新間隔を 3000ms に広げるため、Slack API への実際のリクエスト数は制限される。

テキストストリーミング時は Slack への表示更新は必須ではない（ユーザーにとって「思考中...」が表示されていれば十分）ため、テキスト差分の Slack 更新はオプショナルとする。

### 12.4 Thinking（拡張思考）の表示

Claude の thinking/extended thinking ブロックは通常のテキストとは別の content_block_type で来る可能性がある。現状の `stream_event` では `text` タイプとして扱われるが、将来的に `thinking` タイプが追加される可能性がある。

進捗メッセージの thinking スニペットは、最新の思考テキストの末尾50文字をイタリック表示:
```
💭 _認証ロジックの修正方針を検討しています..._
```

### 12.5 Slack App 追加 OAuth スコープ

モーダル表示のために追加で必要なスコープ:

```
既存: app_mentions:read, chat:write, channels:history, channels:read,
      reactions:write, files:write, files:read

追加:
  - commands (slash commands、将来用)
  - im:write (DM書き込み)
  - im:history (DM履歴読み取り)
```

Event Subscriptions に追加:
```
  - message.im (DM内メッセージ)
```

Interactivity:
```
  - Interactivity & Shortcuts → Enable (モーダルの interaction 処理に必要)
  - Request URL は Socket Mode 使用時は不要
```
