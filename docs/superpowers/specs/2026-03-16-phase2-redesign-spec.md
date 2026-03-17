# Phase 2 実装計画

## 目的

Claude Codeのデフォルト対話セッションをSlackから忠実に再現する。
永続プロセスモデル (`--input-format stream-json`) を採用し、1セッション = 1プロセスのアーキテクチャに移行する。アンカーメッセージを廃止し、リアクションベースの軽量なスレッド体験を提供する。

---

## 機能マップ

### パススルー機能（CLIに `user_message` として直接送信）

ユーザーがスレッド内で入力した内容を `{"type":"user_message","content":"/<command>"}` として永続プロセスのstdinに送信する。botは中間処理を一切行わない。

| Claude Code コマンド | Slack入力形式 | stdin送信形式 | 備考 |
|---------------------|-------------|-------------|------|
| `/compact [instructions]` | `/compact` or `cc /compact` | `{"type":"user_message","content":"/compact"}` | コンテキスト圧縮 |
| `/clear` | `/clear` or `cc /clear` | `{"type":"user_message","content":"/clear"}` | コンテキストクリア |
| `/cost` | `/cost` or `cc /cost` | `{"type":"user_message","content":"/cost"}` | コスト/トークン表示 |
| `/context` | `/context` or `cc /context` | `{"type":"user_message","content":"/context"}` | コンテキスト使用量 |
| `/diff` | `/diff` or `cc /diff` | `{"type":"user_message","content":"/diff"}` | 変更差分表示 |
| `/commit` | `/commit` or `cc /commit` | `{"type":"user_message","content":"/commit"}` | git commit作成 |
| `/review [N]` | `/review N` or `cc /review N` | `{"type":"user_message","content":"/review N"}` | PRレビュー |
| `/model [name]` | `cc /model opus` | `{"type":"user_message","content":"/model opus"}` | セッション単位モデル変更 |
| `/plan [desc]` | `/plan` or `cc /plan` | `{"type":"user_message","content":"/plan"}` | Planモード切替 |
| `/effort [level]` | `/effort high` or `cc /effort high` | `{"type":"user_message","content":"/effort high"}` | 推論レベル変更 |
| `/brief` | `/brief` or `cc /brief` | `{"type":"user_message","content":"/brief"}` | 簡潔モード切替 |
| `/rename [name]` | `/rename myname` or `cc /rename myname` | `{"type":"user_message","content":"/rename myname"}` | セッション名変更 |
| `/memory` | `/memory` or `cc /memory` | `{"type":"user_message","content":"/memory"}` | メモリ管理 |
| `/export [file]` | `/export` or `cc /export` | `{"type":"user_message","content":"/export"}` | 会話エクスポート |
| `/help` | `/help` or `cc /help` | `{"type":"user_message","content":"/help"}` | ヘルプ表示 |
| `/btw [question]` | `cc /btw question` | `{"type":"user_message","content":"/btw question"}` | サイドクエスチョン |
| `/fork [name]` | `cc /fork myname` | `{"type":"user_message","content":"/fork myname"}` | セッション分岐 |
| `/status` | `cc /cli-status` | `{"type":"user_message","content":"/status"}` | CLIステータス表示 |
| `/config` | `cc /config` | `{"type":"user_message","content":"/config"}` | 設定表示 |
| `/mcp [cmd]` | `cc /mcp` | `{"type":"user_message","content":"/mcp"}` | MCP管理 |
| (プレーンテキスト) | `任意のテキスト` | `{"type":"user_message","content":"テキスト"}` | 通常のプロンプト |

### 制御メッセージ機能（Home tab操作 or Slackアクション → stdin制御メッセージ）

| 操作 | トリガー | stdin送信形式 | 備考 |
|------|---------|-------------|------|
| モデル変更（グローバル） | Home tab `static_select` | `{"type":"control","subtype":"set_model","model":"opus"}` | 全aliveプロセスに送信 |
| ターン中断 | 🔴 リアクション追加 | `{"type":"control","subtype":"interrupt"}` | 処理中のターンを中断 |
| 権限モード変更 | Home tab or コマンド | `{"type":"control","subtype":"set_permission_mode","mode":"plan"}` | Phase 2ではdefaultモード対応 |
| ツール使用許可 | Approve/Denyボタン | `{"type":"control","subtype":"can_use_tool","tool_use_id":"...","allowed":true}` | defaultモード時の許可応答 |
| キープアライブ | 定期タイマー | `{"type":"control","subtype":"keep_alive"}` | IDLEプロセスの接続維持 |

### Bot固有機能（Slack側で実装）

| 機能 | コマンド/操作 | 実装内容 |
|------|-------------|---------|
| セッション終了 | `cc /end` | プロセスstdin.close() → Slack更新 → Home tab更新 |
| Bot情報表示 | `cc /status` | SessionIndexStore + プロセス状態からephemeralメッセージ表示 |
| プロセス手動再起動 | `cc /restart` | 連続クラッシュ後の手動復旧 |
| Home tab描画 | `app_home_opened` | モデル選択、ディレクトリ選択、セッション一覧、Usage Guide |
| リアクション状態管理 | 自動 | ⏳(spawn/queue) → 🧠(processing) → ✅(done) |
| レスポンスフッター | 自動 | `📊 tokens | cost | model | time` をcontext blockで付与 |
| スレッドヘッダー | セッション初回 | Working directory, model, session IDの初期情報をephemeralで表示 |
| セッション一覧 | Home tab | ディレクトリスコープ、ページネーション付き |
| 過去セッション復元 | Home tab「Open」 | JSONL解析 → スレッド投稿 |
| 権限プロンプトUI | 自動 | Approve/Denyボタンをスレッド内に投稿 |

### スコープ外（Slackでは不要/不適用）

| Claude Code機能 | 除外理由 |
|----------------|---------|
| `/color`, `/theme` | Slack UIが制御するため不適用 |
| `/voice` | Slackに音声入力機能がないため不適用 |
| `/copy` | Slackのネイティブコピーで代替 |
| `/terminal-setup` | ターミナル固有の設定 |
| `/stickers`, `/think-back` | ノベルティ機能 |
| `/install`, `/install-github-app`, `/install-slack-app` | CLI固有のセットアップ |
| `/ide` | IDE統合。Slack経由では不要 |
| `/login`, `/logout` | CLI認証。botが認証済み |
| `/feedback` | GitHub Issues等で直接対応 |
| `/add-dir` | サーバー側のディレクトリ管理 |
| `/upgrade`, `/extra-usage`, `/usage` | APIキーベースのため不適用 |
| `/privacy-settings` | CLI個人設定 |
| `/agents`, `/plugins`, `/skills`, `/hooks` | 高度な拡張機能。Phase 2スコープ外 |
| `/reload-plugins`, `/stats` | CLI固有 |
| キーボードショートカット | Slack固有のショートカットが存在 |

---

## 実装フェーズ

| フェーズ | 内容 | 見積もり | 依存 |
|---------|------|---------|------|
| **2-A** | 永続プロセス基盤 | 2日 | なし |
| **2-B** | コマンドアーキテクチャ刷新 | 2日 | 2-A |
| **2-C** | 永続ストア | 1.5日 | なし（2-Aと並行可） |
| **2-D** | Home Tabリデザイン | 2日 | 2-C |
| **2-E** | スレッド体験リデザイン | 1.5日 | 2-A, 2-B |
| **2-F** | セッション内キュー + グローバルキュー | 1.5日 | 2-A |
| **2-G** | 過去セッション復元 | 1.5日 | 2-C, 2-D |
| **合計** | | **12日** | |

```
2-C (永続ストア) ────────────┬─→ 2-D (Home Tab) ──→ 2-G (過去セッション復元)
                              │
2-A (永続プロセス基盤) ──────┼─→ 2-B (コマンド刷新) ──→ 2-E (スレッド体験)
                              │
                              └─→ 2-F (キュー)
```

---

## 各フェーズの詳細

### Phase 2-A: 永続プロセス基盤

#### 目的

spawn-on-demandモデル（1プロンプト = 1プロセス）から永続プロセスモデル（1セッション = 1プロセス）に移行する。

#### 状態マシン

```
┌─────────────┐
│ NOT_STARTED  │  プロセス未起動
└──────┬───────┘
       │ ユーザーメッセージ到着 → spawn
       ▼
┌─────────────┐
│  STARTING    │  spawn中、system initイベント待ち
└──────┬───────┘
       │ system init受信
       ▼
┌─────────────┐  sendPrompt()   ┌──────────────┐
│    IDLE      │───────────────►│  PROCESSING   │
│ (タイマー    │                │              │
│  動作中)     │◄───────────────│              │
└──────┬───────┘  result受信    └──────┬────────┘
       │                              │
       │ idle timeout / cc /end       │ crash
       ▼                              ▼
┌─────────────┐               ┌──────────────┐
│   ENDING     │               │    DEAD       │
└──────┬───────┘               └──────┬────────┘
       │ exit                         │ 次メッセージで再spawn
       ▼                              ▼
     DEAD                          STARTING
```

#### 遷移表

| From | Event | To | Action |
|------|-------|----|--------|
| NOT_STARTED | user message | STARTING | spawn `claude -p --input-format stream-json --output-format stream-json --verbose --replay-user-messages --model <model> --max-budget-usd <budget> --session-id <id>` |
| STARTING | system init event | IDLE | send first prompt → PROCESSING |
| IDLE | sendPrompt() | PROCESSING | write to stdin, clear idle timer |
| IDLE | idle timeout (10min) | ENDING | stdin.end() |
| IDLE | `cc /end` | ENDING | stdin.end() |
| IDLE | process exit (code 0) | DEAD | cleanup |
| PROCESSING | result event | IDLE | start idle timer, check session queue |
| PROCESSING | result event + queued prompt | PROCESSING | send queued prompt (stay in PROCESSING) |
| PROCESSING | process crash | DEAD | notify user, cleanup |
| ENDING | process exit | DEAD | cleanup |
| DEAD | user message | STARTING | spawn with `--session-id` (CLIがJSONLから復元) |

#### ビルド対象

| ファイル | 操作 | 内容 |
|---------|------|------|
| `src/bridge/persistent-session.ts` | **新規作成** | `PersistentSession` クラス（EventEmitter, 状態管理, stdin/stdout管理, idle timer, crash detection） |
| `src/bridge/streaming-executor.ts` | **大幅書換** | `PersistentSessionExecutor` に改名。`startSession()` で永続プロセスを起動し `PersistentSession` を返す。`execute()` AsyncGeneratorは廃止 |
| `src/bridge/stream-processor.ts` | **小変更** | `resetForNextTurn()` メソッド追加。phase/steps/currentTextをリセットし、次ターンの処理に備える |
| `src/types.ts` | **変更** | `SessionState` 型追加、`SessionStartParams` インターフェース追加、`StreamExecuteParams` を非推奨化 |

#### PersistentSession インターフェース

```typescript
interface PersistentSession extends EventEmitter {
  readonly sessionId: string;
  readonly state: SessionState;
  sendPrompt(prompt: string): void;      // state=idleの時のみ
  sendControl(msg: ControlMessage): void; // 任意の制御メッセージ送信
  end(): void;                            // stdin.close → graceful end
  kill(): void;                           // SIGTERM → 5s → SIGKILL
  on(event: 'message', listener: (msg: StreamMessage) => void): this;
  on(event: 'stateChange', listener: (from: SessionState, to: SessionState) => void): this;
  on(event: 'error', listener: (err: Error) => void): this;
}

type SessionState = 'not_started' | 'starting' | 'idle' | 'processing' | 'ending' | 'dead';
```

#### CLI起動コマンド

```typescript
const args = [
  '-p',
  '--input-format', 'stream-json',
  '--output-format', 'stream-json',
  '--verbose',
  '--replay-user-messages',
  '--model', model,
  '--max-budget-usd', String(budgetUsd),
  '--session-id', sessionId,
];
// resumeの場合は --session-id の代わりに -r sessionId
```

#### stdin書き込みフォーマット

```typescript
// ユーザーメッセージ
{"type":"user_message","content":"ユーザーの入力テキスト"}\n

// 制御メッセージ
{"type":"control","subtype":"set_model","model":"opus"}\n
{"type":"control","subtype":"interrupt"}\n
{"type":"control","subtype":"can_use_tool","tool_use_id":"toolu_xxx","allowed":true}\n
```

#### 受入基準

- [ ] 単一プロンプト → result → 次のプロンプト → result のサイクルが動作する
- [ ] system init受信でIDLE遷移、result受信でIDLE遷移が正しく動作する
- [ ] idle timeout (10分) 後にプロセスが正常終了する
- [ ] プロセスクラッシュ時にDEAD遷移し、次メッセージで `--session-id` 付きで再spawnできる
- [ ] `end()` 呼び出しでstdinがcloseされ、プロセスが正常終了する

---

### Phase 2-B: コマンドアーキテクチャ刷新

#### 目的

ブリッジのコマンド翻訳レイヤーを撤廃し、Claude Codeのネイティブコマンドをパススルーで送信するアーキテクチャに移行する。`cc /` プレフィックスの有無に関わらず、スラッシュコマンドはそのままstdinに送信する。

#### ビルド対象

| ファイル | 操作 | 内容 |
|---------|------|------|
| `src/slack/command-parser.ts` | **大幅書換** | コマンド分類を3種類に簡素化: `bot_command`（cc /end, cc /status, cc /restart）, `passthrough`（その他全コマンド）, `plain_text` |
| `src/slack/bridge-commands.ts` | **大幅書換** | `handleModel()` 削除（制御メッセージに移行）。`handleEnd()` にプロセス終了ロジック追加。`handleStatus()` をSessionIndexStore対応に更新。`handleRestart()` 新規追加 |
| `src/slack/action-handler.ts` | **大幅書換** | アンカー関連メソッド全削除（handleSetModel, handleToggleAnchor, handleEndSession）。Home tabアクション + 権限プロンプト応答を追加 |
| `src/slack/event-handler.ts` | **変更** | メッセージ受信時にPersistentSessionの状態を確認し、IDLE→sendPrompt、PROCESSING→キュー追加、DEAD→respawnの分岐を実装 |
| `src/index.ts` | **大幅変更** | アンカー関連コード削除、アクションハンドラ再登録、SessionCoordinator統合 |

#### 権限プロンプトUI（defaultモード対応）

CLIの `--permission-mode default` 使用時、`type: "tool_use"` イベントでツール使用の許可プロンプトがユーザーに提示される。

```
Bot投稿（スレッド内）:
  🔧 *Bash* を実行しようとしています
  > `rm -rf node_modules && npm install`
  [✅ Approve]  [❌ Deny]
```

ユーザーがボタンをクリック → `{"type":"control","subtype":"can_use_tool","tool_use_id":"toolu_xxx","allowed":true/false}` をstdinに送信。

#### 中断機能

ユーザーがスレッド内のメッセージに 🔴 (`:red_circle:`) リアクションを追加 → `reaction_added` イベント検知 → `{"type":"control","subtype":"interrupt"}` をstdinに送信。

#### 受入基準

- [ ] `/compact`, `/clear`, `/cost`, `/diff`, `/commit`, `/review` がstdinにパススルーされ、CLIの応答がスレッドに投稿される
- [ ] `cc /end` でプロセスが正常終了し、Home tabが更新される
- [ ] `cc /status` でセッション情報がephemeralメッセージで表示される
- [ ] 🔴 リアクションでinterruptが送信され、処理が中断される
- [ ] `--permission-mode default` でApprove/Denyボタンが表示され、操作が反映される

---

### Phase 2-C: 永続ストア

#### 目的

インメモリのSessionStoreを永続的なJSON fileストアに移行する。UserPreferenceStoreとSessionIndexStoreの2つを新設する。

#### ビルド対象

| ファイル | 操作 | 内容 |
|---------|------|------|
| `src/store/user-preference-store.ts` | **新規作成** | `UserPreferenceStore` クラス。defaultModel, activeDirectoryId をユーザーごとに永続化。atomic write (tmp+rename) |
| `src/store/session-index-store.ts` | **新規作成** | `SessionIndexStore` クラス。cliSessionId ↔ threadTs/channelId マッピング。threadIndex逆引き。ディレクトリスコープでの検索 |
| `src/store/session-store.ts` | **変更** | UUIDv5生成廃止。外部から `sessionId` を受け取る方式に変更。`findByThreadTs()` はSessionIndexStore経由に委譲 |
| `src/bridge/session-manager.ts` | **変更** | `resolveOrCreate()` にSessionIndexStore統合。`crypto.randomUUID()` でセッションID生成。再起動後のセッション復元ロジック追加 |
| `src/config.ts` | **変更** | `dataDir` 設定追加 (`~/.claude-slack-pipe/`) |
| `src/types.ts` | **変更** | `SessionIndexEntry`, `UserPreferences`, `UserPreferenceFile`, `SessionIndexFile` 型追加。`SessionMetadata` から `anchorCollapsed`, `anchorMessageTs` 削除 |

#### ファイルパス

```
~/.claude-slack-pipe/
├── user-preferences.json    # ユーザー設定
└── session-index.json       # セッションマッピング
```

#### 受入基準

- [ ] UserPreferenceStore: モデル/ディレクトリ設定の保存・読み込みが動作する
- [ ] SessionIndexStore: セッション登録、threadTs逆引き、ディレクトリスコープ検索が動作する
- [ ] bot再起動後にSessionIndexStoreからセッション情報が復元される
- [ ] atomic writeにより、クラッシュ時にJSONファイルが破損しない

---

### Phase 2-D: Home Tabリデザイン

#### 目的

Home tabをコントロールセンターとして再設計する。モデル選択、ディレクトリ選択、Usage Guide、セッション一覧を配置する。

#### レイアウト

```
┌─────────────────────────────────────────────┐
│  Claude Code Bridge                          │
│  🟢 Bridge Running | Model: Sonnet          │
│                      | Dir: myapp            │
├──────────────────────────────────────────────┤
│  Settings                                     │
│  Model:     [Sonnet  v]                      │
│    Applies to all threads (new and existing)  │
│  Directory: [myapp   v]                      │
│    New threads use this directory             │
├──────────────────────────────────────────────┤
│  Usage Guide                                  │
│  1. Select Model & Directory above           │
│  2. Send a DM to start a session             │
│  3. Each thread = one session                │
│  4. Follow-ups are auto-queued               │
├──────────────────────────────────────────────┤
│  Active Sessions (myapp)                      │
│  🟢 fix-auth-bug | 5m ago       [Open]      │
│  🟢 add-tests | 1h ago          [Open]      │
│  ──────────────────────                      │
│  Recent (Ended)                               │
│  ⚪ refactor-api | 2h ago                     │
│  ⚪ fix-typo | 1d ago                         │
│                          [← 前] [次 →]       │
└──────────────────────────────────────────────┘
```

#### Block予算: 固定13 + セッション20件/ページ + ページネーション1 = 34/100

#### モデル変更のグローバル適用

Home tabでモデルを変更すると:
1. `UserPreferenceStore.setModel()` で永続化
2. 全aliveプロセスに `{"type":"control","subtype":"set_model","model":"<new>"}` を送信
3. 新規セッションも新モデルで起動

#### ディレクトリ変更

- 新規スレッドのみに適用。既存スレッドは作成時のディレクトリを保持
- Home tabのセッション一覧は選択ディレクトリでフィルタリング

#### ビルド対象

| ファイル | 操作 | 内容 |
|---------|------|------|
| `src/slack/block-builder.ts` | **大幅書換** | Home tab用ブロック構築関数を全面書き換え。`buildHomeTabBlocks()`, `buildSessionListBlocks()` 新規。`buildAnchorBlocks()`, `buildCollapsedAnchorBlocks()` 削除 |
| `src/slack/home-tab.ts` | **大幅変更** | UserPreferenceStore/SessionIndexStore統合。ページネーション対応。ディレクトリ切替時の再描画 |
| `src/slack/action-handler.ts` | **変更** | `home_set_default_model`, `home_set_directory`, `open_session`, `session_page_prev`, `session_page_next` アクションハンドラ追加 |
| `src/index.ts` | **変更** | 新アクションの登録 |

#### 受入基準

- [ ] Home tabにモデル選択、ディレクトリ選択、Usage Guide、セッション一覧が表示される
- [ ] モデル変更が全aliveプロセスに反映される
- [ ] ディレクトリ変更でセッション一覧がフィルタリングされる
- [ ] セッション一覧が20件/ページでページネーションされる
- [ ] 「Open」ボタンクリックでスレッドへの遷移が案内される（ephemeralメッセージ）

---

### Phase 2-E: スレッド体験リデザイン

#### 目的

アンカーメッセージを完全廃止し、リアクションベースのシンプルなスレッド体験を実現する。

#### アンカー廃止後のスレッド体験

```
Thread:
  User: "Fix the authentication bug in auth.ts"
    ⏳ (spawn中)
    → spawn完了
    🧠 (processing)
    → 応答完了
    ✅ (done、3秒後削除)

  Bot: I've fixed the authentication bug...
    ─────────────────────────
    📁 M: `src/auth.ts`
    📊 1.2k→3.4k tokens | $0.042 | sonnet | 12.3s

  User: "Now add rate limiting"
    🧠 (即座 — プロセスalive)
    ...
```

#### リアクション状態遷移

| プロセス状態 | リアクション | 意味 |
|------------|------------|------|
| STARTING (spawn中) | ⏳ `:hourglass_flowing_sand:` | プロセス起動中 |
| PROCESSING | 🧠 `:brain:` | 処理中 |
| 完了 | ✅ `:white_check_mark:` | 完了（3秒後に削除） |
| キュー待ち | ⏳ `:hourglass_flowing_sand:` | キューで待機中 |
| ユーザー中断 | 🔴 `:red_circle:` | ユーザーが追加（interrupt送信のトリガー） |

#### スレッドヘッダー（初回のみ）

新規セッション開始時に、ephemeralメッセージでコンテキスト情報を表示する。

```
📋 Session Started
📁 /Users/alice/dev/myapp
Model: sonnet | Session: abc12345
```

#### レスポンスフッター（毎ターン）

```
📊 1.2k→3.4k tokens | $0.042 | sonnet | 12.3s
```

`type: "result"` イベントから `total_cost_usd`, `usage`, `duration_ms` を取得して表示。

#### `cc /status` 出力（ephemeral）

```
📋 Session Status
Session: abc12345 | Started: 2026-03-16 10:00
📁 /Users/alice/dev/myapp
Model: sonnet
💰 Total: $0.120 | 📊 18,600 tokens | 2 turns
⚡ Process: Ready
```

#### `cc /end` 出力（ephemeral）

```
✅ Session ended.
💰 Total: $0.423 | 📊 52,400 tokens | 4 turns | Duration: 45m
```

#### ストリーミング表示

CLIの `type: "assistant"` イベントをバッファし、1-3秒間隔で `chat.update` でメッセージを更新する（既存の `SlackUpdateThrottler` を流用）。

#### ビルド対象

| ファイル | 操作 | 内容 |
|---------|------|------|
| `src/slack/block-builder.ts` | **変更** | `buildAnchorBlocks()`, `buildCollapsedAnchorBlocks()` 削除。`buildResponseFooter()` 関数維持 |
| `src/slack/reaction-manager.ts` | **変更** | ✅ リアクション追加 + 3秒後自動削除ロジック追加。🔴 リアクション検知でinterrupt送信 |
| `src/slack/response-builder.ts` | **変更** | スレッドヘッダーephemeral投稿関数追加。`cc /status`, `cc /end` のephemeral出力関数追加 |
| `src/index.ts` | **変更** | アンカー投稿コード削除。アンカー更新コール削除。`reaction_added` イベントハンドラ追加（🔴 検知） |
| `src/types.ts` | **変更** | `SessionMetadata` から `anchorCollapsed`, `anchorMessageTs` フィールド削除 |

#### 受入基準

- [ ] アンカーメッセージが投稿されない
- [ ] リアクション ⏳ → 🧠 → ✅ の遷移が正しく動作する
- [ ] レスポンスフッターに per-turn の tokens/cost/model/time が表示される
- [ ] `cc /status` がephemeralメッセージで正しい情報を表示する
- [ ] `cc /end` でephemeralに終了サマリーが表示され、プロセスが終了する
- [ ] ストリーミング表示が1-3秒間隔で更新される
- [ ] 🔴 リアクションでinterruptが発火する

---

### Phase 2-F: セッション内キュー + グローバルキュー

#### 目的

処理中に追加されたプロンプトをキューイングし、現ターン完了後に自動実行する（セッション内キュー）。また、最大プロセス数に達した場合のグローバルキューも実装する。

#### セッション内キュー

| 項目 | 仕様 |
|------|------|
| スコープ | 1セッション内 |
| 順序 | FIFO |
| 上限 | 5件 |
| TTL | なし |
| トリガー | `type: "result"` イベント受信で次プロンプトを自動送信 |
| 超過時 | ephemeral: "Queue is full. Please wait for current messages to complete." |

#### グローバルキュー

| 項目 | 仕様 |
|------|------|
| スコープ | 全ユーザー/全セッション |
| 順序 | FIFO |
| 上限 | 10件 |
| TTL | 5分 |
| トリガー | いずれかのプロセスが終了（idle timeout or /end）してスロットが空いた時 |
| 同時プロセス制限 | `maxAliveProcessesPerUser: 1`, `maxAliveProcessesGlobal: 3` |

#### セッション切替（maxAlivePerUser=1）

```
ユーザーがセッションAで会話中（プロセスA: IDLE）
  → セッションBのスレッドに返信
  → プロセスA を graceful end (stdin.close)
  → プロセスB を spawn
  → ユーザーのメッセージを処理
```

#### ビルド対象

| ファイル | 操作 | 内容 |
|---------|------|------|
| `src/bridge/session-coordinator.ts` | **新規作成** | `SessionCoordinator` クラス。ProcessManagerの後継。状態管理 + セッション内キュー + アイドルタイマー + グローバルキュー連携 + セッション切替ロジック |
| `src/bridge/message-queue.ts` | **新規作成** | `MessageQueue` クラス。グローバルキュー。FIFO, 上限10, TTL 5分 |
| `src/bridge/process-manager.ts` | **削除** | SessionCoordinatorに統合 |
| `src/index.ts` | **変更** | ProcessManagerをSessionCoordinatorに置換 |

#### キュー処理フロー

```
メッセージ受信
  │
  ├─ プロセス IDLE → sendPrompt() → PROCESSING
  │   Reaction: 🧠
  │
  ├─ プロセス PROCESSING → セッション内キューに追加
  │   Reaction: ⏳
  │
  ├─ プロセス DEAD → respawn → キューに追加
  │   Reaction: ⏳
  │
  └─ プロセスなし (NOT_STARTED) → spawn → キューに追加
      Reaction: ⏳

result受信
  │
  ├─ セッション内キューにプロンプトあり
  │   → dequeue → sendPrompt() → PROCESSING維持
  │   → ⏳ → 🧠 に切替
  │
  └─ キューなし → IDLE遷移 → アイドルタイマー開始
```

#### クラッシュリカバリ

| 条件 | 動作 |
|------|------|
| アイドルタイムアウト後にメッセージ受信 | 自動respawn。`--session-id` でコンテキスト復元 |
| 処理中クラッシュ | エラーメッセージ投稿 → 自動respawn → キュー内メッセージ処理再開 |
| 連続クラッシュ3回以内 | 自動respawn（指数バックオフ: 1s, 2s, 4s） |
| 連続クラッシュ3回超 | respawn停止。エラーメッセージ投稿。`cc /restart` で手動復旧 |
| 正常な result 受信 | クラッシュカウンタリセット |

#### 受入基準

- [ ] PROCESSING中に送信されたメッセージがキューに入り、result後に自動実行される
- [ ] セッション内キュー上限5件を超えた場合にephemeralメッセージが表示される
- [ ] maxAliveProcessesGlobal到達時にグローバルキューに入り、スロット空き後に実行される
- [ ] セッション切替（別スレッドへの返信）で前のプロセスがgraceful endされる
- [ ] クラッシュ後に自動respawnし、`--session-id` でコンテキストが復元される
- [ ] 連続3回超のクラッシュでrespawnが停止し、`cc /restart` で手動復旧できる

---

### Phase 2-G: 過去セッション復元

#### 目的

Home tabの「Open」ボタンから過去セッションの会話履歴をスレッドに投稿し、セッションを再開可能にする。

#### フロー

```
1. Home tab「Open」クリック
2. ack() 即座に返却
3. セッションマーカーをDMに投稿（スレッドの親メッセージ）
   → "📂 Session: UXリデザイン... ⏳ 履歴を読み込み中..."
4. バックグラウンドでJSONL解析
5. スレッドに順次投稿（最新15ターン、user+assistantバンドル）
   → 5件ごとにプログレス更新
6. マーカーメッセージを完了状態に更新
   → "✅ 履歴読み込み完了 (12ターン)"
7. SessionIndexStoreにthreadTs/channelIdを登録
```

#### HistoryPoster

| 項目 | 仕様 |
|------|------|
| 投稿上限 | 最新15ターン |
| 投稿形式 | user+assistantをバンドル（1メッセージ/ターン） |
| レート制限 | 1.1秒/メッセージ |
| 所要時間 | 15ターン ≈ 17秒 |
| プログレス更新 | 5件ごとに親メッセージを `chat.update` |
| 省略通知 | 15ターン超の場合 "_N件の古いターンは省略されています_" |

#### 投稿データ

| データ | 投稿 | 理由 |
|-------|------|------|
| Userプロンプト（テキスト） | Yes | 会話の文脈理解に必須 |
| Assistant応答（テキスト） | Yes | 回答内容の確認 |
| Thinking | No | 冗長 |
| Tool use | 要約のみ | `🔧 Read: src/index.ts` のような1行表示 |
| Tool result (全文) | No | 冗長 |
| System entries | No | 内部データ |

#### ビルド対象

| ファイル | 操作 | 内容 |
|---------|------|------|
| `src/bridge/history-poster.ts` | **新規作成** | `HistoryPoster` クラス。JSONL解析、ターン抽出、バンドル投稿、プログレス更新、レート制限 |
| `src/slack/block-builder.ts` | **変更** | セッションマーカーブロック + プログレスブロック構築関数追加 |
| `src/index.ts` | **変更** | `open_session` アクションハンドラでHistoryPoster呼び出し |

#### 受入基準

- [ ] 「Open」ボタンクリックでセッションマーカーがDMに投稿される
- [ ] 過去の会話履歴が最新15ターン分、スレッドに投稿される
- [ ] 投稿中にプログレスが5件ごとに更新される
- [ ] 15ターン超の場合に省略通知が表示される
- [ ] 履歴投稿完了後、スレッドに返信するとセッションが再開される
- [ ] 重複Openが防止される（SessionIndexStore.threadTsチェック）

---

## 削除対象コード一覧

### 完全削除

| ファイル | 対象 | 行数概算 | 理由 |
|---------|------|---------|------|
| `src/slack/block-builder.ts` | `buildAnchorBlocks()` | ~95行 | アンカー廃止 |
| `src/slack/block-builder.ts` | `buildCollapsedAnchorBlocks()` | ~24行 | アンカー廃止 |
| `src/slack/action-handler.ts` | `handleSetModel()` | ~8行 | 制御メッセージに移行 |
| `src/slack/action-handler.ts` | `handleToggleAnchor()` | ~6行 | アンカー廃止 |
| `src/slack/action-handler.ts` | `handleEndSession()` | ~15行 | `cc /end` に一本化 |
| `src/index.ts` | `updateAnchor()` 関数 | ~12行 | アンカー廃止 |
| `src/index.ts` | `app.action('set_model', ...)` | ~9行 | 制御メッセージに移行 |
| `src/index.ts` | `app.action('end_session', ...)` | ~10行 | `cc /end` に一本化 |
| `src/index.ts` | `app.action('toggle_anchor', ...)` | ~10行 | アンカー廃止 |
| `src/index.ts` | `app.action('open_command_modal', ...)` | ~10行 | `cc /help` で代替 |
| `src/index.ts` | アンカーメッセージ投稿コード | ~8行 | アンカー廃止 |
| `src/index.ts` | `updateAnchor()` 呼び出し | ~4行 | アンカー廃止 |
| `src/types.ts` | `anchorCollapsed: boolean` | 1行 | アンカー廃止 |
| `src/types.ts` | `anchorMessageTs: string \| null` | 1行 | アンカー廃止 |
| `src/store/session-store.ts` | `anchorCollapsed/anchorMessageTs` 初期値 | 2行 | フィールド削除 |
| `src/store/session-store.ts` | `threadTsToSessionId()` (UUIDv5) | ~3行 | randomUUIDに移行 |
| `src/bridge/process-manager.ts` | ファイル全体 | 全体 | SessionCoordinatorに統合 |

### 大幅書換（実質削除+新規）

| ファイル | 対象 | 理由 |
|---------|------|------|
| `src/bridge/streaming-executor.ts` | `execute()` AsyncGenerator | PersistentSessionExecutorに書換 |
| `src/slack/command-parser.ts` | `BRIDGE_COMMANDS` 定義 | 3カテゴリに簡素化 |

### 削減効果

- アンカー関連: ~285行削減
- コマンド翻訳レイヤー: ~60行削減
- プロセス管理の統合: ~100行削減（process-manager.ts → session-coordinator.ts）
- **合計: ~445行削減**（ただし新規コードが ~800行追加）

---

## 新規ファイル一覧

| ファイル | 内容 | 工数 |
|---------|------|------|
| `src/bridge/persistent-session.ts` | PersistentSessionクラス。EventEmitter, 状態マシン, stdin/stdout管理, idle timer, crash detection, sendPrompt/sendControl/end/kill | **L** |
| `src/bridge/session-coordinator.ts` | SessionCoordinator。ProcessManagerの後継。永続プロセスのライフサイクル管理, セッション内キュー, グローバルキュー連携, セッション切替, クラッシュリカバリ | **XL** |
| `src/bridge/message-queue.ts` | MessageQueue。グローバルキュー。FIFO, 上限10, TTL 5分, 待ち順位通知 | **M** |
| `src/bridge/history-poster.ts` | HistoryPoster。JSONL解析, ターン抽出, バンドル投稿, プログレス更新, レート制限 | **L** |
| `src/store/user-preference-store.ts` | UserPreferenceStore。defaultModel, activeDirectoryId の永続化。atomic write | **M** |
| `src/store/session-index-store.ts` | SessionIndexStore。cliSessionId ↔ threadTs/channelId マッピング。threadIndex逆引き | **L** |

---

## テスト計画

### Phase 2-A: 永続プロセス基盤

| # | テストシナリオ | 確認内容 |
|---|-------------|---------|
| A1 | 単一プロンプト送信 → 応答受信 | spawn → system init → IDLE → sendPrompt → PROCESSING → result → IDLE の遷移 |
| A2 | 連続2プロンプト送信 | 1つ目のresult後にIDLE遷移、2つ目のsendPromptが正常動作 |
| A3 | idle timeout | IDLE状態で10分放置 → stdin.close → プロセス正常終了 → DEAD |
| A4 | プロセスクラッシュ | プロセス強制kill → error event → DEAD → 次メッセージでrespawn |
| A5 | end() 呼び出し | IDLE状態でend() → ENDING → exit → DEAD |
| A6 | PROCESSING中のend() | 処理完了を待ってからstdin.close |

### Phase 2-B: コマンドアーキテクチャ

| # | テストシナリオ | 確認内容 |
|---|-------------|---------|
| B1 | `/compact` パススルー | stdinに `user_message` として送信され、CLIの応答がスレッドに投稿される |
| B2 | `cc /end` | プロセスが終了し、ephemeralメッセージが表示される |
| B3 | `cc /status` | セッション情報がephemeralで表示される |
| B4 | 🔴 リアクション | interrupt制御メッセージが送信され、処理が中断される |
| B5 | 権限プロンプト (default mode) | tool_useイベントでApprove/Denyボタン表示、クリックでcan_use_tool送信 |
| B6 | プレーンテキスト | `user_message` としてstdinに送信される |

### Phase 2-C: 永続ストア

| # | テストシナリオ | 確認内容 |
|---|-------------|---------|
| C1 | UserPreference保存・読み込み | JSON fileへの保存と再読み込みが一致 |
| C2 | SessionIndex登録・逆引き | threadTsからのO(1)逆引きが動作 |
| C3 | bot再起動後の復元 | SessionIndexStoreからセッション情報が正しく復元される |
| C4 | 同時アクセス安全性 | atomic writeでファイル破損しない |
| C5 | ディレクトリスコープ検索 | 特定ディレクトリのセッションのみフィルタリングされる |

### Phase 2-D: Home Tab

| # | テストシナリオ | 確認内容 |
|---|-------------|---------|
| D1 | 初回表示 | 全セクション（Settings, Guide, Sessions）が正しくレンダリング |
| D2 | モデル変更 | 選択後にUserPreference更新 + 全aliveプロセスにset_model送信 |
| D3 | ディレクトリ変更 | セッション一覧がフィルタリングされる |
| D4 | ページネーション | 20件超のセッションで「次のページ」「前のページ」が動作 |
| D5 | 「Open」クリック | ephemeralメッセージでスレッドへの遷移が案内される |

### Phase 2-E: スレッド体験

| # | テストシナリオ | 確認内容 |
|---|-------------|---------|
| E1 | 新規セッション開始 | アンカーなし。リアクション ⏳ → 🧠 → ✅ の遷移。スレッドヘッダーephemeral |
| E2 | フォローアップ（IDLE） | 即座に 🧠。spawn不要 |
| E3 | フォローアップ（PROCESSING） | ⏳ リアクション。result後に自動実行 |
| E4 | レスポンスフッター | per-turn tokens/cost/model/time が正しく表示 |
| E5 | ストリーミング表示 | 1-3秒間隔でメッセージが更新される |

### Phase 2-F: キュー

| # | テストシナリオ | 確認内容 |
|---|-------------|---------|
| F1 | PROCESSING中に3件送信 | 3件ともキューに入り、順次実行される |
| F2 | セッション内キュー上限超過 | 6件目でephemeralエラー |
| F3 | グローバルキュー | 3プロセス到達時にキューに入り、スロット空き後に実行 |
| F4 | セッション切替 | 別スレッドへの返信で前プロセスがgraceful end |
| F5 | クラッシュ後の自動respawn | プロセス再起動 + キュー内メッセージ処理再開 |
| F6 | 連続クラッシュ | 3回超でrespawn停止、`cc /restart` で復旧 |

### Phase 2-G: 過去セッション復元

| # | テストシナリオ | 確認内容 |
|---|-------------|---------|
| G1 | 5ターンの履歴投稿 | 全ターンがスレッドに投稿され、プログレスが更新される |
| G2 | 20ターンの履歴投稿 | 最新15ターンのみ投稿。省略通知あり |
| G3 | 重複Openの防止 | 同じセッションの2回目Openでエラーメッセージ |
| G4 | 履歴投稿後のセッション再開 | スレッドに返信するとセッションが `--session-id` で再開される |
| G5 | JSONL解析エラー | パース失敗行はスキップ。他の行は正常投稿 |
