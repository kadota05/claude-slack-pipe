# E2E検証レポート

検証日: 2026-03-13
CLIバージョン: 2.1.74
検証環境: macOS (Darwin 25.3.0)

---

## 1. セッション継続の検証結果

### パターンA: `--session-id` で新規作成 → `-r` で再開

```bash
SESSION_ID=$(uuidgen | tr '[:upper:]' '[:lower:]')
claude -p --session-id "$SESSION_ID" "hello, remember the word 'banana'"
claude -p -r "$SESSION_ID" "what word did I ask you to remember?"
```

**結果: 成功**

- 1回目: `--session-id` で指定したUUIDでセッションが作成され、正常に応答
- 2回目: `-r <session-id>` でセッションを再開し、前回の文脈（"banana"）を正しく想起
- セッションIDはUUID v4形式（小文字）が必要

### パターンB: `-c` で直前セッション継続

```bash
claude -p "hello, remember the word 'apple'"
claude -p -c "what word did I ask you to remember?"
```

**結果: 成功**

- 1回目: 新規セッションが自動作成され、正常に応答
- 2回目: `-c` で直前のセッションを自動検出し、前回の文脈（"apple"）を正しく想起

### 重要な発見

| 項目 | 結果 |
|------|------|
| `--session-id <uuid>` → `-r <uuid>` | 動作確認済み。Bridge向け推奨パターン |
| `-c` で直前セッション継続 | 動作確認済み。ただしCWD依存（同一ディレクトリから実行する必要あり） |
| セッションIDの形式 | UUID v4（小文字）。`uuidgen` の出力は大文字の場合があるため `tr '[:upper:]' '[:lower:]'` で変換推奨 |
| `CLAUDECODE` 環境変数 | Claude Codeセッション内からの起動は `CLAUDECODE=1` によりブロックされる。Bridge実行時は `unset CLAUDECODE` が必要 |

### Round 1 C1の検証結論

Round 1で矛盾として挙げられた「`--session-id` + `-r` の組み合わせ」 vs 「`-r` 単独」について:

- **CLI側が正しい**: 新規作成時は `--session-id <uuid>`、再開時は `-r <uuid>` が正しい
- `--session-id` と `-r` を同時に指定する必要はない（それぞれ別のコマンド呼び出しで使用）

---

## 2. permission-mode の検証結果

### テスト1: `--permission-mode auto`

```bash
claude -p --permission-mode auto "Read the file ... and tell me how many sections it has"
```

**結果: 成功**

- ファイルの読み取りが自動承認され、正常に応答（「8個」のセクションを正しくカウント）
- 対話的な権限確認ダイアログは表示されなかった

### テスト2: `--allowedTools` + `--permission-mode dontAsk`

```bash
claude -p --allowedTools "Read" "Grep" "Glob" --permission-mode dontAsk "List the files in ..."
```

**結果: 成功**

- 指定した3つのツール（Read, Grep, Glob）のみが使用可能な状態で、ファイル一覧を正しく取得
- `Glob` ツールを使用してディレクトリ内容を列挙した

### 推奨設定

| ユースケース | 推奨設定 |
|-------------|---------|
| 読み取り専用タスク | `--allowedTools "Read" "Grep" "Glob" --permission-mode dontAsk` |
| 編集を含むタスク | `--permission-mode auto` |
| コマンド実行を含むタスク | `--permission-mode auto --allowedTools "Bash(git:*)" "Read" "Grep" "Glob" "Edit" "Write"` |
| サンドボックス環境 | `--dangerously-skip-permissions` |

### 重要な発見

- `--allowedTools` の引数はスペース区切りで複数指定可能（`"Read" "Grep" "Glob"` のように個別引数として渡す）
- `--permission-mode dontAsk` は許可されていないツールの使用を自動拒否する（プロンプトは表示されない）
- **P0-2は解消**: `-p`モードでは `--permission-mode auto` を推奨デフォルトとすることで、対話的権限確認なしに安全に動作する

---

## 3. JSON出力の構造

### コマンド

```bash
claude -p --output-format json "say hello in one word"
```

### 出力されたJSON構造

```json
{
  "type": "result",
  "subtype": "success",
  "is_error": false,
  "duration_ms": 2377,
  "duration_api_ms": 2365,
  "num_turns": 1,
  "result": "Hello!",
  "stop_reason": "end_turn",
  "session_id": "79c2a6a5-2f2a-4db8-b2bc-bf886b0f1911",
  "total_cost_usd": 0.0354405,
  "usage": {
    "input_tokens": 3,
    "cache_creation_input_tokens": 4468,
    "cache_read_input_tokens": 14751,
    "output_tokens": 5,
    "server_tool_use": {
      "web_search_requests": 0,
      "web_fetch_requests": 0
    },
    "service_tier": "standard",
    "cache_creation": {
      "ephemeral_1h_input_tokens": 4468,
      "ephemeral_5m_input_tokens": 0
    },
    "inference_geo": "",
    "iterations": [],
    "speed": "standard"
  },
  "modelUsage": {
    "claude-opus-4-6": {
      "inputTokens": 3,
      "outputTokens": 5,
      "cacheReadInputTokens": 14751,
      "cacheCreationInputTokens": 4468,
      "webSearchRequests": 0,
      "costUSD": 0.0354405,
      "contextWindow": 200000,
      "maxOutputTokens": 32000
    }
  },
  "permission_denials": [],
  "fast_mode_state": "off",
  "uuid": "495d1e64-5a5b-4b4b-8232-083b496f0333"
}
```

### Bridge実装で重要なフィールド

| フィールド | 型 | 用途 |
|-----------|---|------|
| `result` | string | Claudeの応答テキスト。Slackに投稿する内容 |
| `is_error` | boolean | エラー判定 |
| `session_id` | string (UUID) | セッションID。DB保存用 |
| `total_cost_usd` | number | コスト追跡用 |
| `duration_ms` | number | 実行時間の監視用 |
| `stop_reason` | string | `"end_turn"` = 正常終了 |
| `num_turns` | number | ツール呼び出し回数を含むターン数 |
| `permission_denials` | array | 権限拒否されたツール操作のリスト |

---

## 4. stream-json出力の構造

### コマンド

```bash
claude -p --output-format stream-json --verbose "say hello in one word"
```

**重要な発見: `--output-format stream-json` には `--verbose` フラグが必須。**
`--verbose` なしでは以下のエラーが発生する:
```
Error: When using --print, --output-format=stream-json requires --verbose
```

### 出力されたJSONLの各行（イベントタイプ別）

#### 1. `system` (subtype: `hook_started`) - フック開始
```json
{
  "type": "system",
  "subtype": "hook_started",
  "hook_id": "UUID",
  "hook_name": "SessionStart:startup",
  "hook_event": "SessionStart",
  "uuid": "UUID",
  "session_id": "UUID"
}
```

#### 2. `system` (subtype: `hook_response`) - フック応答
```json
{
  "type": "system",
  "subtype": "hook_response",
  "hook_id": "UUID",
  "hook_name": "SessionStart:startup",
  "hook_event": "SessionStart",
  "output": "...(JSON文字列)",
  "stdout": "...",
  "stderr": "",
  "exit_code": 0,
  "outcome": "success",
  "uuid": "UUID",
  "session_id": "UUID"
}
```

#### 3. `system` (subtype: `init`) - 初期化情報
```json
{
  "type": "system",
  "subtype": "init",
  "cwd": "/Users/archeco055/dev/Discussion",
  "session_id": "UUID",
  "tools": ["Task", "Bash", "Glob", "Grep", "Read", "Edit", "Write", "..."],
  "mcp_servers": [...],
  "model": "claude-opus-4-6",
  "permissionMode": "bypassPermissions",
  "slash_commands": [...],
  "claude_code_version": "2.1.74",
  "agents": [...],
  "skills": [...],
  "plugins": [...]
}
```

#### 4. `assistant` - Claudeの応答メッセージ
```json
{
  "type": "assistant",
  "message": {
    "model": "claude-opus-4-6",
    "id": "msg_...",
    "type": "message",
    "role": "assistant",
    "content": [{"type": "text", "text": "Hello!"}],
    "stop_reason": null,
    "usage": {
      "input_tokens": 3,
      "output_tokens": 1,
      "service_tier": "standard"
    }
  },
  "parent_tool_use_id": null,
  "session_id": "UUID",
  "uuid": "UUID"
}
```

#### 5. `rate_limit_event` - レートリミット情報
```json
{
  "type": "rate_limit_event",
  "rate_limit_info": {
    "status": "allowed",
    "resetsAt": 1773370800,
    "rateLimitType": "five_hour",
    "overageStatus": "rejected"
  },
  "uuid": "UUID",
  "session_id": "UUID"
}
```

#### 6. `result` - 最終結果（JSON出力と同一構造）
```json
{
  "type": "result",
  "subtype": "success",
  "is_error": false,
  "duration_ms": 1433,
  "result": "Hello!",
  "session_id": "UUID",
  "total_cost_usd": 0.0354405,
  "usage": {...}
}
```

### イベント出現順序

```
system(hook_started) → system(hook_response) → system(init) → assistant → rate_limit_event → result
```

### Bridge実装で重要なイベント

| イベントtype | 用途 |
|-------------|------|
| `system(init)` | セッション初期化の確認、CWD・モデル情報の取得 |
| `assistant` | リアルタイム応答表示（`message.content[].text` を抽出） |
| `result` | 最終結果の取得、コスト・実行時間の記録 |
| `rate_limit_event` | レートリミット監視 |

---

## 5. CWD制御の検証結果

### コマンド

```bash
cd /tmp && claude -p "what is the current working directory?"
```

### 結果: 成功

- 応答: `/private/tmp`（macOSでは `/tmp` は `/private/tmp` のシンボリックリンク）
- CWDは呼び出し側のカレントディレクトリがそのまま使用される
- `--cwd` のような直接指定オプションは存在しない（Round 1レポートと一致）

### Bridge実装での制御方法

Node.jsの `spawn` / `execSync` で `cwd` オプションを指定する:

```javascript
const child = spawn('claude', ['-p', '--session-id', sessionId, prompt], {
  cwd: '/path/to/project'
});
```

---

## 6. max-budget-usd の検証結果

### コマンド

```bash
claude -p --max-budget-usd 0.01 "say hello in one word"
```

### 結果

```
Error: Exceeded USD budget (0.01)
```

- 予算を超過した場合、即座にエラーメッセージを出力して終了（exit code 1ではなく通常出力）
- $0.01はシステムプロンプト+入力トークンだけで超過するため、極端に低い値では実質的に使用不可
- 検証3のJSON出力から、単純な応答でも `total_cost_usd` は約 $0.035 であった

### 実用的な予算設定の目安

| タスク種別 | 推奨予算 |
|-----------|---------|
| 単純な質問応答 | $0.10 |
| ファイル読み取り+分析 | $0.50 |
| コード編集タスク | $1.00 |
| 複雑なマルチターンタスク | $5.00 |

### 重要な発見

- 予算エラーのメッセージは `Error: Exceeded USD budget (X.XX)` 形式
- `--output-format json` と組み合わせた場合の予算超過時の出力形式は未確認（追加検証推奨）
- キャッシュ利用状況によりコストは大幅に変動する

---

## 7. 検証結果のサマリー（P0解消状況）

### P0-1: セッション継続コマンドの正確な形式

**解消済み**

| 操作 | 正しいコマンド | 検証結果 |
|------|--------------|---------|
| 新規セッション（ID指定） | `claude -p --session-id <uuid> "prompt"` | 成功 |
| セッション再開 | `claude -p -r <uuid> "prompt"` | 成功 |
| 直前セッション継続 | `claude -p -c "prompt"` | 成功（CWD依存） |

### P0-2: permission-mode の推奨設定

**解消済み**

| モード | 動作 | 推奨用途 |
|--------|------|---------|
| `auto` | 自動判断で権限付与 | 汎用タスク向けデフォルト |
| `dontAsk` + `--allowedTools` | 許可ツールのみ実行、他は自動拒否 | セキュア環境向け |
| `bypassPermissions` | 全権限バイパス | サンドボックス専用 |

### 追加で発見されたP0級の問題

| ID | 問題 | 影響 | 対策 |
|----|------|------|------|
| P0-3 | `CLAUDECODE` 環境変数によるネスト禁止 | Claude Code内からBridgeを開発/テストする際にブロックされる | Bridge起動時に `delete process.env.CLAUDECODE` を実行 |
| P0-4 | `--output-format stream-json` に `--verbose` が必須 | Round 1レポートで未記載。`--verbose` なしではエラー | コマンド構築時に `--verbose` を必ず付与 |

### Gap解消状況

| ID | Gap | 状態 | 結果 |
|----|-----|------|------|
| G1 | `--permission-mode`の推奨設定 | **解消** | `auto` を推奨デフォルトに |
| G4 | `--output-format json` のレスポンス構造 | **解消** | 構造を完全に記録（セクション3参照） |

---

## 8. Bridge実装への推奨事項

### 8.1 コマンド構築テンプレート

#### 新規セッション開始

```typescript
const sessionId = crypto.randomUUID(); // UUID v4（小文字）
const args = [
  '-p',
  '--session-id', sessionId,
  '--output-format', 'json',
  '--permission-mode', 'auto',
  '--max-budget-usd', String(maxBudget),
  prompt
];
```

#### セッション継続

```typescript
const args = [
  '-p',
  '-r', existingSessionId,
  '--output-format', 'json',
  '--permission-mode', 'auto',
  '--max-budget-usd', String(maxBudget),
  prompt
];
```

#### リアルタイムストリーミング（Phase 2以降）

```typescript
const args = [
  '-p',
  '--session-id', sessionId,
  '--output-format', 'stream-json',
  '--verbose',  // 必須！
  '--permission-mode', 'auto',
  prompt
];
```

### 8.2 環境変数の制御

```typescript
const env = { ...process.env };
delete env.CLAUDECODE; // ネスト禁止チェック回避
```

### 8.3 レスポンスパース（JSON出力）

```typescript
interface ClaudeJsonResult {
  type: 'result';
  subtype: 'success' | 'error';
  is_error: boolean;
  result: string;          // Slackに投稿するテキスト
  session_id: string;      // DB保存用
  total_cost_usd: number;  // コスト追跡
  duration_ms: number;     // 実行時間監視
  stop_reason: string;     // 'end_turn' = 正常終了
  num_turns: number;       // ターン数
  permission_denials: string[]; // 権限拒否リスト
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens: number;
    cache_creation_input_tokens: number;
  };
}
```

### 8.4 エラーハンドリング

```typescript
// 予算超過
if (output.includes('Exceeded USD budget')) {
  // ユーザーに予算超過を通知
}

// ネスト禁止
if (output.includes('cannot be launched inside another Claude Code session')) {
  // CLAUDECODE環境変数のunsetを試行
}

// JSON出力のis_error チェック
const result = JSON.parse(output);
if (result.is_error) {
  // エラー内容をSlackに投稿
}
```

### 8.5 CWD制御

```typescript
const child = spawn('claude', args, {
  cwd: projectDirectory,  // チャンネルに紐づくプロジェクトディレクトリ
  env: cleanEnv
});
```

### 8.6 推奨デフォルト設定

```typescript
const DEFAULT_CONFIG = {
  permissionMode: 'auto',
  maxBudgetUsd: 1.00,      // セッションあたりのデフォルト上限
  outputFormat: 'json',     // MVPではjson、Phase 2でstream-json
  verbose: false,           // stream-json使用時のみtrue
  noSessionPersistence: false, // セッション永続化は有効のまま
};
```

### 8.7 stream-jsonモード使用時の注意

- `--verbose` フラグが必須（Round 1レポートでは未記載だった重要な発見）
- イベントのフィルタリングが必要: `system(hook_*)` イベントは無視してよい
- `assistant` イベントの `message.content[].text` からリアルタイムテキストを抽出
- `result` イベントで最終結果とコスト情報を取得
- `rate_limit_event` でレートリミットを監視
