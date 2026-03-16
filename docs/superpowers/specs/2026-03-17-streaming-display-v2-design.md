# Streaming Display V2 — 折りたたみ表示 + 順序保証 + モーダル詳細

## 概要

Claude CLIのstream-json出力をSlackスレッドに表示する仕組みを再設計する。

**現状の問題:**
1. Slack APIコールが並列実行され、メッセージの時系列順が保証されない
2. thinking/tool_use/subagentの詳細がスレッドに展開され、本文テキストが埋もれる
3. 設計ドキュメント（Phase 2計画）で意図されていた機能が未実装（PriorityQueue、TextStreamUpdater、ツール詳細ボタン等）

**新しい方針:**
- 実行中はライブ詳細表示（薄い表示スタイルで本文と区別）
- 完了後は`chat.update`で折りたたみサマリーに更新
- 詳細はモーダルで閲覧
- イベント処理をシリアル化して順序保証

## アーキテクチャ

```
Claude CLI stdout (JSONL, 時系列順)
    ↓
PersistentSession.on('message')
    ↓
SerialActionQueue (1つずつawaitして順序保証)
    ↓
StreamProcessor (イベント→SlackAction変換 + グループ状態管理)
    ↓
SlackActionExecutor (API実行 + Rate Limit + GracefulDegradation)
    ↓
Slack Thread
```

### 順序保証の原理

Claude CLIの`--output-format stream-json`はstdoutに1行ずつ順番にJSONLを出力する。stdoutはシリアルなストリームなので、イベント自体は正しい時系列順で到着する。

現在の問題はイベント到着後にSlack APIコールを`await`せずに並列発火していること。SerialActionQueueでイベント処理をSlack API実行まで含めてエンドツーエンドでシリアル化することで順序が保証される。

具体的には、各キュータスクが以下を**全て`await`してから**次のタスクをデキューする：
1. `processEvent(event)` を呼び出し、`GroupAction[]`を**返り値として**受け取る（EventEmitter経由のemitではない）
2. 各GroupActionをSlack APIで順番に実行し、`await`する
3. `postMessage`の結果として得られた`ts`をGroupTrackerに`registerMessageTs()`で登録する

この設計により、`messageTs`は必ずupdate/collapseアクションの前に登録済みとなり、レース条件が発生しない。

## 表示モデル

### 時系列グループ

1ターン内のイベントを「時系列グループ」に分類する。同じカテゴリのイベントが連続する間は1つのグループとして扱い、別カテゴリのイベントが来たら新しいグループを開始する。

**カテゴリ:**
- `thinking` — 思考ブロック
- `tool` — ツール実行（Agent以外）
- `subagent` — Agent tool
- `text` — テキスト応答（折りたたみ対象外、GroupTrackerでは追跡しない）

> **Note:** `text`はGroupCategory型には含めない。テキストはStreamProcessorが直接処理し、GroupTrackerはthinking/tool/subagentのみを管理する。テキストイベント到着時は`handleTextStart()`でアクティブなグループの折りたたみのみ行い、テキスト投稿自体はStreamProcessorが担当する。

**例:** 思考 → Read × 2 → 思考 → Bash × 1 → テキスト応答

```
グループ1: thinking (思考1回)
グループ2: tool (Read × 2)
グループ3: thinking (思考1回)
グループ4: tool (Bash × 1)
グループ5: text (テキスト応答)
```

### 実行中の表示（ライブ状態）

thinking/tool_use/subagentは`context`ブロックやイタリック体を使い、本文テキスト（`section`ブロック）と視覚的に区別する。

**思考（実行中）:**
```
💭 思考中...                              ← contextブロック
_ユーザーの質問を分析すると..._             ← contextブロック + italic（薄い表示）
```

**ツール（実行中）— 1メッセージ内で進捗更新:**
```
⏳ `Read` src/auth.ts — 実行中...          ← contextブロック
✅ `Read` src/config.ts (0.2s)             ← contextブロック
```

**SubAgent（実行中）:**
```
🤖 SubAgent: "コード探索" — 実行中...       ← contextブロック
  ⏳ `Grep` handleAuth                     ← contextブロック + indent
  ✅ `Read` src/auth.ts (0.2s)             ← contextブロック + indent
```

### 折りたたみ後の表示

グループ完了時に`chat.update`で折りたたみサマリーに更新する。

```
💭 思考完了                                [詳細を見る]
🔧 Read × 2 完了 (0.5s)                   [詳細を見る]
💭 思考完了                                [詳細を見る]
🔧 Bash × 1 完了 (1.0s)                   [詳細を見る]

テキスト応答の本文...（section blockで通常表示）
```

### 折りたたみの遷移タイミング

- **ツールグループ:** グループ内の全ツールが完了した時点で折りたたむ
- **思考グループ:** 次のカテゴリのイベントが来た時点で折りたたむ（思考には明示的な「完了」イベントがないため）
- **SubAgentグループ:** Agent toolの`tool_result`を受信した時点で折りたたむ
- **テキスト:** 折りたたみ対象外。そのまま全文表示

## コンポーネント設計

### 1. SerialActionQueue（新規）

`src/streaming/serial-action-queue.ts`

EventEmitterの`message`イベントをキューに入れて、1つずつ`await`で順番に処理する。

```typescript
class SerialActionQueue {
  private queue: Array<() => Promise<void>> = [];
  private processing = false;

  enqueue(task: () => Promise<void>): void;
  private async processNext(): Promise<void>;
}
```

**責務:**
- `session.on('message', callback)` のcallbackをラップ
- 前のcallbackの完了を待ってから次を実行
- エラーが起きても次のタスクは実行する

### 2. GroupTracker（新規）

`src/streaming/group-tracker.ts`

時系列グループの状態を管理し、グループの開始・更新・折りたたみを制御する。

```typescript
type GroupCategory = 'thinking' | 'tool' | 'subagent';

interface ActiveGroup {
  id: string;
  category: GroupCategory;
  messageTs: string | null;
  startTime: number;

  // thinking
  thinkingTexts: string[];

  // tool
  tools: Array<{
    toolUseId: string;
    toolName: string;
    input: Record<string, unknown>;
    oneLiner: string;
    status: 'running' | 'completed' | 'error';
    durationMs?: number;
    result?: string;
    isError?: boolean;
  }>;

  // subagent
  agentToolUseId?: string;
  agentDescription?: string;
  agentSteps: Array<{
    toolName: string;
    toolUseId: string;
    oneLiner: string;
    status: 'running' | 'completed' | 'error';
  }>;
}

class GroupTracker {
  private activeGroup: ActiveGroup | null = null;
  private completedGroups: ActiveGroup[] = [];

  // Returns actions: postMessage for new group, update for existing, collapse for completed
  handleThinking(text: string): GroupAction[];
  handleToolUse(toolUseId: string, toolName: string, input: Record<string, unknown>): GroupAction[];
  handleToolResult(toolUseId: string, result: string, isError: boolean, durationMs: number): GroupAction[];
  handleSubagentStart(toolUseId: string, description: string): GroupAction[];
  handleSubagentStep(agentToolUseId: string, toolName: string, toolUseId: string, oneLiner: string): GroupAction[];
  handleSubagentStepResult(agentToolUseId: string, toolUseId: string, status: string): GroupAction[];
  handleSubagentComplete(agentToolUseId: string, result: string, durationMs: number): GroupAction[];
  handleTextStart(): GroupAction[];  // Collapse any active group before text

  registerMessageTs(groupId: string, messageTs: string): void;

  // Collapse the currently active group (used on result event or interruption)
  // Marks incomplete tools as "interrupted"
  flushActiveGroup(): GroupAction[];

  // Rate limit mitigation: returns true if >=500ms since last update for this group
  shouldEmitUpdate(): boolean;

  // For modal data
  getGroupData(groupId: string): ActiveGroup | undefined;
}
```

**GroupAction型:**
```typescript
type GroupAction =
  | { type: 'postMessage'; groupId: string; blocks: Block[]; text: string; category: GroupCategory }
  | { type: 'update'; groupId: string; messageTs: string; blocks: Block[]; text: string }
  | { type: 'collapse'; groupId: string; messageTs: string; blocks: Block[]; text: string };
```

`collapse`は意味的には`update`と同じだが、折りたたみであることを明示するために区別する。

**SlackAction変換時の優先度マッピング:**
| GroupAction type | Priority | 説明 |
|---|---|---|
| `postMessage` | P3 | グループ開始メッセージ |
| `update` | P4 | ライブ進捗更新（GracefulDegradationでスキップ可能） |
| `collapse` | P3 | 折りたたみ更新（スキップ不可） |

テキストのpostMessage/updateはP1（最高優先度）を維持。

### 3. StreamProcessor（大幅改修）

`src/streaming/stream-processor.ts`

現在のフラットなイベント処理をGroupTrackerベースに変更する。

**変更点:**
- BatchAggregatorを削除 — GroupTrackerが同カテゴリのツールを自然にグループ化するため不要
- SubagentTrackerを削除 — GroupTrackerに統合
- テキスト処理はそのまま（textBuffer + markdown変換）
- **EventEmitter経由のemitを廃止** — `processEvent()`は`ProcessedActions`を返り値として返す
- 呼び出し側（index.ts）が返り値のアクションを順番に`await`実行する

```typescript
interface ProcessedActions {
  groupActions: GroupAction[];   // GroupTrackerから返されたアクション
  textAction?: SlackAction;     // テキスト投稿/更新アクション（あれば）
  resultEvent?: any;            // resultイベント（あれば）
}

processEvent(event: any): ProcessedActions;
```

**イベントフロー:**
```
processEvent(event) → ProcessedActions
  → event.type === 'assistant'
    → thinking block → groupTracker.handleThinking(text)
    → tool_use block (Agent) → groupTracker.handleSubagentStart(...)
    → tool_use block (other) → groupTracker.handleToolUse(...)
    → text block → groupTracker.handleTextStart() + buildTextAction(text)
  → event.type === 'user'
    → tool_result (subagent child) → groupTracker.handleSubagentStepResult(...)
    → tool_result (normal) → groupTracker.handleToolResult(...)
  → event.type === 'result'
    → groupTracker.flushActiveGroup() + テキスト確定 + resultEvent設定
```

### 4. ToolFormatter（改修）

`src/streaming/tool-formatter.ts`

**追加する関数:**

```typescript
// 実行中の表示（contextブロック、薄い表示）
buildThinkingLiveBlocks(texts: string[]): Block[];
buildToolGroupLiveBlocks(tools: ToolInfo[]): Block[];
buildSubagentLiveBlocks(description: string, steps: StepInfo[]): Block[];

// 折りたたみ表示（1行サマリー + [詳細を見る]ボタン）
buildThinkingCollapsedBlocks(count: number, groupId: string): Block[];
buildToolGroupCollapsedBlocks(tools: ToolSummary[], totalDurationMs: number, groupId: string): Block[];
buildSubagentCollapsedBlocks(description: string, totalDurationMs: number, groupId: string): Block[];
```

**薄い表示のルール:**
- 全てのライブ表示は`context`ブロックを使用（Slackでは小さめ・グレーで表示される）
- 思考テキストはイタリック（`_text_`）
- ツールのステータスアイコンは⏳（実行中）、✅（完了）、❌（エラー）

**折りたたみの[詳細を見る]ボタン:**
```typescript
{
  type: 'actions',
  elements: [{
    type: 'button',
    text: { type: 'plain_text', text: '詳細を見る' },
    action_id: `view_group_detail:${groupId}`,
  }]
}
```

### 5. ModalBuilder（改修）

`src/slack/modal-builder.ts`

3種類のモーダルを構築する。

**思考モーダル:**
```typescript
buildThinkingModal(thinkingTexts: string[]): ModalView;
```
- タイトル: "💭 思考詳細"
- 内容: 全思考テキストを時系列で連結、セパレータで区切り

**ツールグループモーダル:**
```typescript
buildToolGroupModal(tools: ToolInfo[]): ModalView;
```
- タイトル: "🔧 ツール実行詳細"
- 内容: 各ツールのサマリー行（アイコン + ツール名 + oneLiner + duration）
- 各ツールに[詳細]ボタン → 個別ツールモーダル（既存の`buildToolModal`を流用）

**SubAgentモーダル:**
```typescript
buildSubagentModal(agentDescription: string, conversationFlow: SubagentConversationFlow): ModalView;
```
- タイトル: "🤖 SubAgent詳細"
- 内容: JSONLから整形した会話フロー
- 各ツールに[詳細]ボタン

### 6. SubagentJsonlReader（新規）

`src/streaming/subagent-jsonl-reader.ts`

SubAgentのJSONLファイルを読み込み、モーダル表示用に整形する。

```typescript
interface SubagentConversationFlow {
  agentType: string;
  systemPromptSummary: string;  // 最初のuserメッセージから抽出、200文字に切り詰め
  steps: Array<{
    type: 'text' | 'tool_use' | 'tool_result';
    // text
    text?: string;
    // tool_use
    toolName?: string;
    toolUseId?: string;
    input?: Record<string, unknown>;
    oneLiner?: string;
    // tool_result
    resultSummary?: string;
    isError?: boolean;
    durationMs?: number;
  }>;
  finalResult: string;  // 最後のassistant textブロック
  totalDurationMs: number;
}

class SubagentJsonlReader {
  constructor(private claudeProjectsDir: string);

  // projectPath: e.g. "/Users/archeco055/dev/claude-slack-pipe"
  // sessionId: e.g. "d892b151-9663-44ae-b0bc-e60f8eb548a4"
  // agentId: e.g. "a716e415e0e889e1a"
  async read(projectPath: string, sessionId: string, agentId: string): Promise<SubagentConversationFlow | null>;

  // projectPathをハイフン化ディレクトリ名に変換
  private toProjectDirName(projectPath: string): string;
}
```

**パス構築:**
```
{claudeProjectsDir}/{projectPathHyphenated}/{sessionId}/subagents/agent-{agentId}.jsonl
```

`projectPathHyphenated`の変換ルール: `/Users/archeco055/dev/claude-slack-pipe` → `-Users-archeco055-dev-claude-slack-pipe`

**JSONLパース方針:**
- 1行ずつ読み込み、type/role/contentを抽出
- 最初の`user`メッセージ → systemPromptSummary
- `assistant`のtool_use → steps
- `user`のtool_result → steps
- 最後の`assistant`のtext → finalResult
- Slackモーダルの上限を考慮し、各テキストは適切に切り詰め

**agentIdの取得:**
- stream-jsonのAgent toolの`tool_result`内にはagentIdが含まれる（`agentId: agent-xxx`形式で返される）
- これをSubagentTrackerまたはGroupTrackerで保持
- tool_resultのテキストから正規表現で抽出: `/agentId:\s*([\w]+)/`

### 7. index.ts（改修）

**変更点:**
- `wireSessionOutput`内でSerialActionQueueを使用
- GroupTrackerのgroupIdとmessageTsの紐付け
- モーダルアクションハンドラを3種類に拡張（thinking、tool_group、subagent）
- SubagentJsonlReaderのインスタンス化とパス情報の受け渡し

```typescript
// 現在（問題あり: 並列実行でレース）
streamProcessor.on('action', (action) => {
  const promise = (async () => { ... })();
  pendingActions.push(promise);
});

// 新しい方式（エンドツーエンドシリアル）
const serialQueue = new SerialActionQueue();
session.on('message', (event) => {
  serialQueue.enqueue(async () => {
    // 1. イベント処理 → アクション収集（同期）
    const { groupActions, textAction, resultEvent } = streamProcessor.processEvent(event);

    // 2. groupActionsを順番に実行、postMessageのtsを登録
    for (const ga of groupActions) {
      const slackAction = convertGroupActionToSlackAction(ga);
      const result = await executor.execute(slackAction);
      if (result.ok && result.ts && ga.type === 'postMessage') {
        streamProcessor.registerGroupMessageTs(ga.groupId, result.ts);
      }
    }

    // 3. テキストアクション実行
    if (textAction) {
      const result = await executor.execute(textAction);
      if (result.ok && result.ts && textAction.type === 'postMessage') {
        streamProcessor.registerTextMessageTs(result.ts);
      }
    }

    // 4. resultイベント処理（footer投稿等）
    if (resultEvent) {
      await handleResultEvent(resultEvent);
    }
  });
});
```

### 8. ToolResultCache（改修）

`src/streaming/tool-result-cache.ts`

**追加:**
- グループデータのキャッシュ（思考テキスト配列、ツールグループ情報）
- SubAgent情報のキャッシュ（agentId, description, sessionId, projectPath）

```typescript
// 既存
set(toolUseId: string, data: ToolResultData): void;
get(toolUseId: string): ToolResultData | null;

// 追加
setGroupData(groupId: string, data: GroupCacheData): void;
getGroupData(groupId: string): GroupCacheData | null;
```

## ファイル一覧

### 新規ファイル
| ファイル | 責務 |
|---|---|
| `src/streaming/serial-action-queue.ts` | イベント処理のシリアル化 |
| `src/streaming/group-tracker.ts` | 時系列グループ管理 + 折りたたみ制御 |
| `src/streaming/subagent-jsonl-reader.ts` | SubAgent JSONLの読み込み・整形 |

### 改修ファイル
| ファイル | 変更内容 |
|---|---|
| `src/streaming/stream-processor.ts` | GroupTrackerベースに全面改修 |
| `src/streaming/tool-formatter.ts` | ライブ表示 + 折りたたみブロック生成 |
| `src/streaming/tool-result-cache.ts` | グループデータキャッシュ追加 |
| `src/slack/modal-builder.ts` | 思考/ツールグループ/SubAgentモーダル |
| `src/index.ts` | SerialActionQueue統合、モーダルハンドラ拡張 |

### 削除ファイル
| ファイル | 理由 |
|---|---|
| `src/streaming/batch-aggregator.ts` | GroupTrackerに置き換え |
| `src/streaming/subagent-tracker.ts` | GroupTrackerに統合 |
| `src/streaming/priority-queue.ts` | 未使用、SerialActionQueueに置き換え |
| `src/streaming/text-stream-updater.ts` | 未使用 |

## テスト方針

各新規・改修ファイルに対応するテストを作成する。

- `tests/streaming/serial-action-queue.test.ts`
- `tests/streaming/group-tracker.test.ts`
- `tests/streaming/subagent-jsonl-reader.test.ts`
- `tests/streaming/stream-processor.test.ts`（既存を大幅更新）
- `tests/streaming/tool-formatter.test.ts`（既存に追加）
- `tests/slack/modal-builder.test.ts`（既存を大幅更新）

## 制約・注意事項

### Slack API制約
- Slackモーダルのブロック上限: 最大100ブロック、テキストは1ブロック3000文字
- `context`ブロックのelement上限: 10個。ツールが10個以上のグループでは、1つの`context`ブロック内にmrkdwnテキストを連結して収める
- `chat.update`のRate Limit: 50回/分

### chat.update Rate Limit対策
グループ内のライブ更新が増えるため、以下のデバウンス戦略を適用する：
- グループ内のライブ更新は**最低500ms間隔**とする。500ms以内に次のイベントが来た場合、前の更新をスキップして最新状態で1回だけ更新する
- これはGroupTracker内でタイムスタンプを管理し、`shouldEmitUpdate()`メソッドで判定する
- 折りたたみ（collapse）アクションは必ず実行する（スキップしない）
- 例: 5ツールのグループ → 最悪でもpostMessage(1) + 更新(~4) + collapse(1) = 6回。デバウンスにより実際は3-4回程度

### SubAgent JSONL
- ファイルサイズ: 50KB〜200KB。モーダル表示用に切り詰めが必要
- パス構築はClaude CLIの内部ディレクトリ構造に依存。ファイルが存在しない場合は「SubAgent詳細を取得できませんでした」を表示する
- ハイフン化ルール（`/Users/foo/bar` → `-Users-foo-bar`）はCLIバージョンにより変更される可能性がある

### agentIdの取得
- stream-jsonのAgent toolの`tool_result`テキストから正規表現で抽出: `/agentId:\s*([\w]+)/`
- **フォールバック:** 抽出に失敗した場合、SubAgentモーダルはstream-jsonから得られた子ツール一覧のみを表示する（JSONLの会話フローは表示しない）
- sessionIdは`SessionIndexStore`の`cliSessionId`から取得する
- projectPathは`SessionIndexStore`の`projectPath`から取得する
- claudeProjectsDirは`~/.claude/projects/`（configから取得）
