# Claude Code Slack Bridge — コントロールUI設計書

作成日: 2026-03-16
前提: Bot DM + スレッドモデル（1セッション = 1スレッド）、既存設計（round1-*、final-recommendation.md）の上に構築

---

## 目次

1. [設計サマリ](#1-設計サマリ)
2. [セッション開始メッセージ（アンカー）の構成](#2-セッション開始メッセージアンカーの構成)
3. [権限モードの設計](#3-権限モードの設計)
4. [モデル選択の設計](#4-モデル選択の設計)
5. [スラッシュコマンド/スキルの入力UI](#5-スラッシュコマンドスキルの入力ui)
6. [セッション名変更](#6-セッション名変更)
7. [確認ダイアログ（ツール承認UI）](#7-確認ダイアログツール承認ui)
8. [設定変更モーダル（統合）](#8-設定変更モーダル統合)
9. [action_id / block_id 命名規則](#9-action_id--block_id-命名規則)
10. [モバイル対応の考慮](#10-モバイル対応の考慮)
11. [実装優先度](#11-実装優先度)
12. [技術的な補足](#12-技術的な補足)

---

## 1. 設計サマリ

### 基本方針

| 設定項目 | UI方式 | 理由 |
|---------|--------|------|
| 権限モード | `static_select` (アンカー内) | 4択の切替はセレクトメニューが最適。ボタン4個は画面を圧迫する |
| モデル選択 | `static_select` (アンカー内) | 3択の切替。権限モードと並列配置 |
| スラッシュコマンド | テキスト `cc /xxx` + overflow メニュー | 頻用コマンドはメニュー化、任意コマンドはテキスト入力 |
| セッション名変更 | overflow → モーダル | 使用頻度が低い操作はoverflowに格納 |
| ツール承認 | インラインボタン（スレッド内メッセージ） | モーダルではなくスレッド内で承認/拒否。モバイルで即タップ可能 |

### CLIフラグとの対応

| Slack UI上の設定 | CLIフラグ | 適用タイミング |
|-----------------|----------|--------------|
| 権限モード: 変更バイパス | `--permission-mode auto` | 次のターンから |
| 権限モード: 編集を自動承認 | `--permission-mode auto` + `--allowedTools` 制限 | 次のターンから |
| 権限モード: プランモード | `--permission-mode auto` + プロンプト先頭に指示注入 | 次のターンから |
| 権限モード: 確認を要求 | stream-json + stdin制御 or Slack承認UI | 次のターンから |
| モデル選択 | `--model` | 次のターンから |
| セッション名 | Bridge内部のメタデータのみ（CLIフラグなし） | 即時反映 |

---

## 2. セッション開始メッセージ（アンカー）の構成

セッション開始メッセージは、スレッドの最初のメッセージであり、セッション全体の「コントロールパネル」として機能する。`chat.update` で動的に状態を更新する。

### Block Kit JSON

```json
{
  "channel": "<DM channel ID>",
  "text": "セッション: my-webapp — Opus / 変更バイパス",
  "blocks": [
    {
      "type": "header",
      "text": {
        "type": "plain_text",
        "text": "my-webapp"
      }
    },
    {
      "type": "section",
      "text": {
        "type": "mrkdwn",
        "text": ":large_green_circle: *アクティブセッション*\n:file_folder: `/Users/user/dev/my-webapp`"
      }
    },
    {
      "type": "context",
      "elements": [
        {
          "type": "mrkdwn",
          "text": "Session: `a1b2c3d4` | 開始: 2026-03-16 14:30 | :moneybag: $0.00"
        }
      ]
    },
    {
      "type": "divider"
    },
    {
      "type": "section",
      "text": {
        "type": "mrkdwn",
        "text": "*権限モード*"
      },
      "accessory": {
        "type": "static_select",
        "action_id": "set_permission_mode",
        "initial_option": {
          "text": { "type": "plain_text", "text": ":shield: 変更バイパス" },
          "value": "bypass"
        },
        "options": [
          {
            "text": { "type": "plain_text", "text": ":raised_hand: 確認を要求" },
            "value": "ask"
          },
          {
            "text": { "type": "plain_text", "text": ":pencil2: 編集を自動承認" },
            "value": "auto_edit"
          },
          {
            "text": { "type": "plain_text", "text": ":brain: プランモード" },
            "value": "plan"
          },
          {
            "text": { "type": "plain_text", "text": ":shield: 変更バイパス" },
            "value": "bypass"
          }
        ]
      }
    },
    {
      "type": "section",
      "text": {
        "type": "mrkdwn",
        "text": "*モデル*"
      },
      "accessory": {
        "type": "static_select",
        "action_id": "set_model",
        "initial_option": {
          "text": { "type": "plain_text", "text": "Opus" },
          "value": "opus"
        },
        "options": [
          {
            "text": { "type": "plain_text", "text": "Opus" },
            "value": "opus"
          },
          {
            "text": { "type": "plain_text", "text": "Sonnet" },
            "value": "sonnet"
          },
          {
            "text": { "type": "plain_text", "text": "Haiku" },
            "value": "haiku"
          }
        ]
      }
    },
    {
      "type": "divider"
    },
    {
      "type": "actions",
      "block_id": "session_controls",
      "elements": [
        {
          "type": "overflow",
          "action_id": "quick_commands",
          "options": [
            {
              "text": { "type": "plain_text", "text": ":package: /commit" },
              "value": "cmd_commit"
            },
            {
              "text": { "type": "plain_text", "text": ":mag: /review-pr" },
              "value": "cmd_review_pr"
            },
            {
              "text": { "type": "plain_text", "text": ":broom: /compact" },
              "value": "cmd_compact"
            },
            {
              "text": { "type": "plain_text", "text": ":memo: /init" },
              "value": "cmd_init"
            },
            {
              "text": { "type": "plain_text", "text": ":brain: /memory" },
              "value": "cmd_memory"
            }
          ]
        },
        {
          "type": "button",
          "text": { "type": "plain_text", "text": "セッション終了" },
          "action_id": "end_session",
          "value": "a1b2c3d4",
          "confirm": {
            "title": { "type": "plain_text", "text": "確認" },
            "text": { "type": "mrkdwn", "text": "このセッションを終了しますか？" },
            "confirm": { "type": "plain_text", "text": "終了" },
            "deny": { "type": "plain_text", "text": "キャンセル" }
          }
        },
        {
          "type": "overflow",
          "action_id": "session_overflow",
          "options": [
            {
              "text": { "type": "plain_text", "text": ":pencil2: セッション名を変更" },
              "value": "rename_session"
            },
            {
              "text": { "type": "plain_text", "text": ":bar_chart: セッション情報" },
              "value": "session_info"
            },
            {
              "text": { "type": "plain_text", "text": ":wastebasket: コンテキストクリア" },
              "value": "cmd_clear"
            }
          ]
        }
      ]
    },
    {
      "type": "context",
      "elements": [
        {
          "type": "mrkdwn",
          "text": "スレッド内にメッセージを送信して対話開始 | `cc /help` でコマンド一覧"
        }
      ]
    }
  ]
}
```

### レイアウト図（視覚的な構造）

```
┌─────────────────────────────────────────────────┐
│ my-webapp                              [header]  │
├─────────────────────────────────────────────────┤
│ 🟢 アクティブセッション                          │
│ 📁 /Users/user/dev/my-webapp                    │
│                                                  │
│ Session: a1b2c3d4 | 開始: 14:30 | 💰 $0.00     │
├─────────────────────────────────────────────────┤
│ 権限モード        [🛡️ 変更バイパス     ▾]       │
│ モデル            [Opus               ▾]        │
├─────────────────────────────────────────────────┤
│ [⋮ コマンド] [セッション終了] [⋮ その他]          │
│                                                  │
│ スレッド内にメッセージを送信して対話開始            │
│ cc /help でコマンド一覧                           │
└─────────────────────────────────────────────────┘
```

### アンカー更新のタイミング

| トリガー | 更新内容 |
|---------|---------|
| 権限モード変更 | `initial_option` の更新 + context に変更履歴追加 |
| モデル変更 | `initial_option` の更新 |
| セッション名変更 | `header` テキストの更新 |
| 応答完了時 | context 内のコスト表示 `$0.00` → `$0.08` を累積更新 |
| セッション終了 | ステータスを `:white_circle: 終了済み` に変更、select/buttonを無効化 |

---

## 3. 権限モードの設計

### 3.1 4つのモードとCLI実装方式

#### モード1: 変更バイパス（デフォルト、推奨）

```
claude -p --permission-mode auto --session-id <uuid> --model <model>
```

全ツールを自動承認。Round 1の最終推奨通り、`-p`モードでの最もシンプルな構成。

#### モード2: 編集を自動承認

```
claude -p --permission-mode auto --allowedTools "Edit,Write,Read,Glob,Grep,NotebookEdit" --session-id <uuid>
```

ファイル編集系ツールのみをホワイトリストで許可。`Bash`等の実行系ツールは除外されるため、Claude Codeがそれらを使おうとした場合はエラーになる。

**実装上の注意:**
- `--allowedTools` で許可するツールのリストはBridge側で定義する
- ユーザーから見ると「ファイル編集は自動、Bash実行等は拒否」に見える
- 厳密には「確認して承認」ではなく「禁止」だが、`-p`モードの制約上これが現実的

#### モード3: プランモード

```
claude -p --permission-mode auto --session-id <uuid> --model <model>
```

プロンプトの先頭に以下の指示を注入する:

```
[PLAN MODE] あなたは計画モードで動作しています。コードの変更を実行せず、計画のみを説明してください。ファイルの読み取りと分析は可能ですが、Write、Edit、Bashツールによる変更は行わないでください。
---
<ユーザーの実際のプロンプト>
```

**代替実装:** `--allowedTools "Read,Glob,Grep"` で読み取り系のみ許可する方法もあるが、プロンプト注入の方がClaudeが「計画を説明する」という応答を生成できるため、UXが良い。

#### モード4: 確認を要求

これが最も技術的に難しいモードであり、後述の [セクション7](#7-確認ダイアログツール承認ui) で詳細に設計する。

### 3.2 権限モード変更時のフロー

```
ユーザーがセレクトメニューで「確認を要求」を選択
  │
  ├─ Slack: action イベント発火 (action_id: set_permission_mode)
  │
  ├─ Bridge: セッションメタデータを更新
  │    sessionStore.update(sessionId, { permissionMode: 'ask' })
  │
  ├─ Bridge: アンカーメッセージを chat.update で更新
  │    - initial_option を新しい値に変更
  │    - context に「権限モード: 確認を要求 に変更しました」を一時追加
  │
  └─ Bridge: スレッド内に確認メッセージを投稿
       「:information_source: 権限モードを *確認を要求* に変更しました。
        次のメッセージから適用されます。」
```

### 3.3 セレクトメニュー変更時のハンドラ

```typescript
app.action('set_permission_mode', async ({ action, ack, client, body }) => {
  await ack();

  const selectedOption = (action as StaticSelectAction).selected_option;
  const newMode = selectedOption.value; // 'ask' | 'auto_edit' | 'plan' | 'bypass'

  // body.message からスレッドtsとセッションIDを特定
  const messageTs = body.message?.ts;
  const sessionId = resolveSessionId(body);

  // セッションメタデータ更新
  sessionStore.update(sessionId, { permissionMode: newMode });

  // アンカーメッセージの再構築と更新
  const updatedBlocks = buildAnchorBlocks({
    ...sessionStore.get(sessionId),
    permissionMode: newMode,
  });

  await client.chat.update({
    channel: body.channel!.id,
    ts: messageTs!,
    blocks: updatedBlocks,
    text: `セッション: ${sessionName} — ${modelLabel} / ${modeLabel}`,
  });

  // スレッド内に変更通知
  await client.chat.postMessage({
    channel: body.channel!.id,
    thread_ts: messageTs!,
    text: `:information_source: 権限モードを *${selectedOption.text.text}* に変更しました。次のメッセージから適用されます。`,
  });
});
```

---

## 4. モデル選択の設計

### 4.1 モデルとCLIフラグの対応

| UI表示 | `--model` 値 | 備考 |
|--------|-------------|------|
| Opus | `claude-opus-4-6-20250313` | 最高性能、コスト高 |
| Sonnet | `claude-sonnet-4-20250514` | バランス型 |
| Haiku | `claude-haiku-3-5-20241022` | 高速・低コスト |

**注意:** モデルIDは環境変数 `MODEL_OPUS`, `MODEL_SONNET`, `MODEL_HAIKU` でオーバーライド可能にする。新モデルリリース時にコード変更なしで対応できる。

### 4.2 モデル変更時のフロー

権限モード変更と同じパターン。`action_id: set_model` のハンドラで:

1. セッションメタデータの `model` フィールドを更新
2. アンカーメッセージを `chat.update` で更新
3. スレッド内に変更通知を投稿

```typescript
app.action('set_model', async ({ action, ack, client, body }) => {
  await ack();

  const selectedOption = (action as StaticSelectAction).selected_option;
  const newModel = selectedOption.value; // 'opus' | 'sonnet' | 'haiku'

  const sessionId = resolveSessionId(body);
  sessionStore.update(sessionId, { model: newModel });

  // アンカー更新 + スレッド通知（権限モードと同パターン）
  await updateAnchorAndNotify(client, body, sessionId, {
    notification: `:robot_face: モデルを *${selectedOption.text.text}* に変更しました。次のメッセージから適用されます。`,
  });
});
```

### 4.3 モデル変更の適用タイミング

**次のターン（次の `claude -p` 実行時）から適用する。**

理由:
- `claude -p` は都度起動モデルであり、実行中のプロセスに対してモデルを動的に変更することはできない
- セッションメタデータに保存された `model` 値を、次の `claude -p` spawn時に `--model` フラグとして渡す
- セッション途中のモデル変更は、コンテキスト（`--session-id`）は維持しつつモデルだけが変わるため、応答の一貫性には注意が必要

```typescript
// ClaudeExecutor.execute() 内
const args = [
  '-p',
  '--output-format', 'json',
  '--permission-mode', 'auto',
  '--model', resolveModelId(session.model), // session.model: 'opus' | 'sonnet' | 'haiku'
  '--session-id', session.sessionId,
  '--max-budget-usd', String(maxBudget),
];

if (isResume) {
  args.push('-r', session.sessionId);
}
```

---

## 5. スラッシュコマンド/スキルの入力UI

### 5.1 2つの入力経路

#### 経路A: テキストコマンド（既存設計を維持）

```
cc /commit
cc /review-pr 123
cc /compact
cc /memory read
cc /init
cc /help
```

- 任意のClaude Codeコマンドに対応可能
- 引数付きコマンドが自然に入力できる
- モバイルでも十分な短さ

#### 経路B: overflow メニュー（アンカー内）

頻用コマンドをメニュー化。引数が不要、またはデフォルト引数で実行できるコマンドを配置する。

```json
{
  "type": "overflow",
  "action_id": "quick_commands",
  "options": [
    {
      "text": { "type": "plain_text", "text": ":package: /commit" },
      "value": "cmd_commit"
    },
    {
      "text": { "type": "plain_text", "text": ":mag: /review-pr" },
      "value": "cmd_review_pr"
    },
    {
      "text": { "type": "plain_text", "text": ":broom: /compact" },
      "value": "cmd_compact"
    },
    {
      "text": { "type": "plain_text", "text": ":memo: /init" },
      "value": "cmd_init"
    },
    {
      "text": { "type": "plain_text", "text": ":brain: /memory" },
      "value": "cmd_memory"
    }
  ]
}
```

**overflow メニューの制約:** 最大5つのオプション。5つに厳選する。

### 5.2 引数が必要なコマンドの処理

`/review-pr` は PR番号が必要。overflow メニューから選択した場合、モーダルで引数を入力させる。

```json
{
  "type": "modal",
  "callback_id": "command_args_modal",
  "title": { "type": "plain_text", "text": "/review-pr" },
  "submit": { "type": "plain_text", "text": "実行" },
  "close": { "type": "plain_text", "text": "キャンセル" },
  "private_metadata": "{\"sessionId\":\"a1b2c3d4\",\"command\":\"review-pr\"}",
  "blocks": [
    {
      "type": "input",
      "block_id": "pr_number_input",
      "element": {
        "type": "plain_text_input",
        "action_id": "pr_number",
        "placeholder": {
          "type": "plain_text",
          "text": "PR番号を入力（例: 123）"
        }
      },
      "label": {
        "type": "plain_text",
        "text": "PR番号"
      }
    }
  ]
}
```

### 5.3 コマンド実行のハンドラ

```typescript
app.action('quick_commands', async ({ action, ack, client, body }) => {
  await ack();

  const selected = (action as OverflowAction).selected_option.value;
  const sessionId = resolveSessionId(body);

  // 引数不要のコマンドはそのまま実行
  const noArgsCommands: Record<string, string> = {
    cmd_commit: '/commit',
    cmd_compact: '/compact',
    cmd_init: '/init',
    cmd_memory: '/memory',
    cmd_clear: '/clear',
  };

  if (noArgsCommands[selected]) {
    // Claude Code にコマンドを送信
    await executeClaudeCommand(sessionId, noArgsCommands[selected], client, body);
    return;
  }

  // 引数が必要なコマンドはモーダルを開く
  const argsRequiredCommands: Record<string, ModalBuilder> = {
    cmd_review_pr: buildReviewPrModal,
  };

  if (argsRequiredCommands[selected]) {
    await client.views.open({
      trigger_id: (body as BlockAction).trigger_id,
      view: argsRequiredCommands[selected](sessionId),
    });
  }
});
```

### 5.4 カスタムスキルの対応

カスタムスキル（`.claude/commands/` 配下のユーザー定義コマンド）は、テキストコマンド `cc /<skill-name>` で実行する。メニューへの動的追加は Phase 3 で検討する。

Phase 3での拡張案:
- セッション開始時に `.claude/commands/` をスキャンし、カスタムスキルをoverflowメニューに追加
- ただしoverflowは最大5オプションの制約があるため、「その他のコマンド...」からモーダルで一覧表示する方が現実的

---

## 6. セッション名変更

### 6.1 自動命名（既存設計を維持）

最初のプロンプトから自動的にセッション名を生成し、アンカーの `header` を更新する。

### 6.2 手動命名（overflow → モーダル）

アンカーの `session_overflow` メニューから「セッション名を変更」を選択すると、モーダルが開く。

```json
{
  "type": "modal",
  "callback_id": "rename_session_modal",
  "title": { "type": "plain_text", "text": "セッション名を変更" },
  "submit": { "type": "plain_text", "text": "変更" },
  "close": { "type": "plain_text", "text": "キャンセル" },
  "private_metadata": "{\"sessionId\":\"a1b2c3d4\",\"anchorTs\":\"1710567000.000000\"}",
  "blocks": [
    {
      "type": "input",
      "block_id": "session_name_input",
      "element": {
        "type": "plain_text_input",
        "action_id": "session_name",
        "initial_value": "my-webapp: 認証機能を実装して",
        "max_length": 150,
        "placeholder": {
          "type": "plain_text",
          "text": "セッション名を入力"
        }
      },
      "label": {
        "type": "plain_text",
        "text": "新しいセッション名"
      },
      "hint": {
        "type": "plain_text",
        "text": "header ブロックの上限は150文字です"
      }
    }
  ]
}
```

### 6.3 名前変更のハンドラ

```typescript
app.action('session_overflow', async ({ action, ack, client, body }) => {
  await ack();

  const selected = (action as OverflowAction).selected_option.value;

  if (selected === 'rename_session') {
    const sessionId = resolveSessionId(body);
    const session = sessionStore.get(sessionId);

    await client.views.open({
      trigger_id: (body as BlockAction).trigger_id,
      view: buildRenameModal(sessionId, session.name, body.message?.ts),
    });
  }
  // ... 他のオプションのハンドリング
});

app.view('rename_session_modal', async ({ view, ack, client }) => {
  const newName = view.state.values.session_name_input.session_name.value!;
  const metadata = JSON.parse(view.private_metadata);

  // バリデーション
  if (newName.trim().length === 0) {
    await ack({
      response_action: 'errors',
      errors: { session_name_input: 'セッション名を入力してください' },
    });
    return;
  }

  await ack();

  // メタデータ更新
  sessionStore.update(metadata.sessionId, { name: newName.trim() });

  // アンカーのheaderを更新
  await updateAnchorHeader(client, metadata.sessionId, newName.trim());
});
```

---

## 7. 確認ダイアログ（ツール承認UI）

### 7.1 問題の整理

`claude -p` モードは非対話的であり、ツール使用時にユーザーに確認を求める仕組みがない。デスクトップ版Claude Codeの「確認を要求」モードをSlackで再現するには、別のアプローチが必要。

### 7.2 推奨アプローチ: stream-json + プロセス制御

**原理:**

1. `--output-format stream-json --verbose` でClaude Codeを起動
2. stream-jsonの出力から `tool_use` イベントを検知
3. プロセスの stdin を閉じずに保持し、出力をパース
4. Slackに承認/拒否ボタン付きメッセージを投稿
5. ユーザーの応答を受けて、stdinに承認/拒否を書き込む

**ただし、この方式には重大な制約がある:**

`-p` モードの標準入力からの対話的な承認/拒否は、Claude Code CLIが公式にサポートしていない機能である。`--permission-mode` が `ask` の場合、`-p`モードでは対話的確認が行えずブロックされる（Round 1で検証済み）。

### 7.3 現実的なアプローチ: 2段階実行パターン

**推奨: 「確認を要求」モードは、実行前の計画表示 + 承認後に実行、という2段階で実現する。**

```
ユーザー: 「認証機能を実装して」
  │
  ├─ Step 1: プランモードで実行
  │    claude -p --permission-mode auto --model opus --session-id <uuid>
  │    プロンプト: "[PLAN ONLY] 以下のタスクの実行計画を作成してください。
  │                実際のファイル変更は行わないでください。
  │                使用予定のツールと変更内容を一覧で示してください。
  │                ---
  │                認証機能を実装して"
  │
  ├─ Step 2: 計画をSlackに表示 + 承認ボタン
  │
  │    ┌──────────────────────────────────────────┐
  │    │ :clipboard: 実行計画                       │
  │    │                                           │
  │    │ 以下の操作を実行します:                      │
  │    │ 1. Read: src/routes/index.ts              │
  │    │ 2. Write: src/middleware/auth.ts (新規)     │
  │    │ 3. Edit: src/routes/index.ts              │
  │    │ 4. Bash: npm install jsonwebtoken         │
  │    │ 5. Edit: src/types.ts                     │
  │    │                                           │
  │    │ [✅ 承認して実行] [❌ 拒否] [✏️ 修正指示]    │
  │    └──────────────────────────────────────────┘
  │
  ├─ ユーザーが「承認して実行」をタップ
  │
  └─ Step 3: 実際に実行
       claude -p --permission-mode auto --model opus -r <uuid>
       プロンプト: "先ほどの計画通りに実行してください。"
```

### 7.4 承認ダイアログのBlock Kit

```json
{
  "thread_ts": "<session thread>",
  "text": "実行計画の確認",
  "blocks": [
    {
      "type": "header",
      "text": { "type": "plain_text", "text": "実行計画" }
    },
    {
      "type": "section",
      "text": {
        "type": "mrkdwn",
        "text": "以下の操作を実行します:\n\n1. `Read` src/routes/index.ts\n2. `Write` src/middleware/auth.ts _(新規作成)_\n3. `Edit` src/routes/index.ts\n4. `Bash` `npm install jsonwebtoken`\n5. `Edit` src/types.ts"
      }
    },
    {
      "type": "context",
      "elements": [
        {
          "type": "mrkdwn",
          "text": ":information_source: 権限モードが「確認を要求」のため、実行前に承認が必要です"
        }
      ]
    },
    {
      "type": "actions",
      "block_id": "approval_actions",
      "elements": [
        {
          "type": "button",
          "text": { "type": "plain_text", "text": ":white_check_mark: 承認して実行" },
          "style": "primary",
          "action_id": "approve_execution",
          "value": "{\"sessionId\":\"a1b2c3d4\",\"planId\":\"plan_001\"}"
        },
        {
          "type": "button",
          "text": { "type": "plain_text", "text": ":x: 拒否" },
          "style": "danger",
          "action_id": "reject_execution",
          "value": "{\"sessionId\":\"a1b2c3d4\",\"planId\":\"plan_001\"}"
        },
        {
          "type": "button",
          "text": { "type": "plain_text", "text": ":pencil2: 修正指示" },
          "action_id": "modify_execution",
          "value": "{\"sessionId\":\"a1b2c3d4\",\"planId\":\"plan_001\"}"
        }
      ]
    }
  ]
}
```

### 7.5 承認/拒否後のメッセージ更新

承認または拒否後、ボタン付きメッセージを `chat.update` で更新し、ボタンを無効化（結果表示に置換）する。

**承認後:**

```json
{
  "blocks": [
    {
      "type": "header",
      "text": { "type": "plain_text", "text": "実行計画" }
    },
    {
      "type": "section",
      "text": {
        "type": "mrkdwn",
        "text": ":white_check_mark: *承認済み* — 実行中...\n\n1. `Read` src/routes/index.ts\n2. `Write` src/middleware/auth.ts _(新規作成)_\n..."
      }
    },
    {
      "type": "context",
      "elements": [
        {
          "type": "mrkdwn",
          "text": "承認者: <@U12345> | 承認時刻: 2026-03-16 14:35"
        }
      ]
    }
  ]
}
```

**拒否後:**

```json
{
  "blocks": [
    {
      "type": "header",
      "text": { "type": "plain_text", "text": "実行計画" }
    },
    {
      "type": "section",
      "text": {
        "type": "mrkdwn",
        "text": ":x: *拒否* — 実行はキャンセルされました\n\n~~1. Read src/routes/index.ts~~\n..."
      }
    },
    {
      "type": "context",
      "elements": [
        {
          "type": "mrkdwn",
          "text": "拒否者: <@U12345> | 時刻: 2026-03-16 14:35"
        }
      ]
    }
  ]
}
```

### 7.6 「修正指示」ボタンの処理

「修正指示」ボタンを押すと、モーダルで修正内容を入力できる。

```json
{
  "type": "modal",
  "callback_id": "modify_execution_modal",
  "title": { "type": "plain_text", "text": "実行計画を修正" },
  "submit": { "type": "plain_text", "text": "修正して再計画" },
  "close": { "type": "plain_text", "text": "キャンセル" },
  "private_metadata": "{\"sessionId\":\"a1b2c3d4\",\"planId\":\"plan_001\"}",
  "blocks": [
    {
      "type": "section",
      "text": {
        "type": "mrkdwn",
        "text": "現在の計画に対する修正指示を入力してください。修正内容を反映した新しい計画が生成されます。"
      }
    },
    {
      "type": "input",
      "block_id": "modification_input",
      "element": {
        "type": "plain_text_input",
        "action_id": "modification_text",
        "multiline": true,
        "placeholder": {
          "type": "plain_text",
          "text": "例: Bash操作は除外して、パッケージのインストールは手動で行います"
        }
      },
      "label": {
        "type": "plain_text",
        "text": "修正指示"
      }
    }
  ]
}
```

### 7.7 確認モードの制限事項

| 制限 | 説明 |
|------|------|
| 個別ツール単位の承認は不可 | デスクトップ版のような「1ツールずつ確認」は`-p`モードでは実現できない。計画全体の承認/拒否のみ |
| 計画と実行が異なる可能性 | プランモードで生成した計画と、実際の実行でClaudeが行う操作が異なる可能性がある。これはLLMの性質上避けられない |
| 2回のAPI呼び出し | 計画生成 + 実行で2回のClaude Code実行が必要。コストと時間が倍増する |
| セッション継続性 | 計画と実行で同じsession_idを使うことで、コンテキストは維持される |

### 7.8 将来の改善（Phase 4+）

Claude Code CLIが `--interactive-approval` のようなフラグを将来サポートした場合、または MCP serve モードで双方向通信が安定した場合、個別ツール単位の承認が実現可能になる。現時点では2段階実行パターンが最も現実的。

---

## 8. 設定変更モーダル（統合）

セッション開始時の初期設定や、複数の設定を一括変更したい場合に使う統合設定モーダル。アンカーの `session_overflow` → 「セッション情報」から開く。

```json
{
  "type": "modal",
  "callback_id": "session_settings_modal",
  "title": { "type": "plain_text", "text": "セッション設定" },
  "submit": { "type": "plain_text", "text": "保存" },
  "close": { "type": "plain_text", "text": "キャンセル" },
  "private_metadata": "{\"sessionId\":\"a1b2c3d4\"}",
  "blocks": [
    {
      "type": "header",
      "text": { "type": "plain_text", "text": "セッション情報" }
    },
    {
      "type": "section",
      "text": {
        "type": "mrkdwn",
        "text": "*Session ID:* `a1b2c3d4-e5f6-7890-abcd-ef1234567890`\n*プロジェクト:* `/Users/user/dev/my-webapp`\n*開始時刻:* 2026-03-16 14:30\n*累計コスト:* $0.14\n*ターン数:* 3"
      }
    },
    {
      "type": "divider"
    },
    {
      "type": "input",
      "block_id": "session_name_setting",
      "element": {
        "type": "plain_text_input",
        "action_id": "session_name",
        "initial_value": "my-webapp: 認証機能を実装して"
      },
      "label": { "type": "plain_text", "text": "セッション名" }
    },
    {
      "type": "input",
      "block_id": "permission_mode_setting",
      "element": {
        "type": "static_select",
        "action_id": "permission_mode",
        "initial_option": {
          "text": { "type": "plain_text", "text": "変更バイパス" },
          "value": "bypass"
        },
        "options": [
          {
            "text": { "type": "plain_text", "text": "確認を要求" },
            "value": "ask"
          },
          {
            "text": { "type": "plain_text", "text": "編集を自動承認" },
            "value": "auto_edit"
          },
          {
            "text": { "type": "plain_text", "text": "プランモード" },
            "value": "plan"
          },
          {
            "text": { "type": "plain_text", "text": "変更バイパス" },
            "value": "bypass"
          }
        ]
      },
      "label": { "type": "plain_text", "text": "権限モード" }
    },
    {
      "type": "input",
      "block_id": "model_setting",
      "element": {
        "type": "static_select",
        "action_id": "model",
        "initial_option": {
          "text": { "type": "plain_text", "text": "Opus" },
          "value": "opus"
        },
        "options": [
          {
            "text": { "type": "plain_text", "text": "Opus" },
            "value": "opus"
          },
          {
            "text": { "type": "plain_text", "text": "Sonnet" },
            "value": "sonnet"
          },
          {
            "text": { "type": "plain_text", "text": "Haiku" },
            "value": "haiku"
          }
        ]
      },
      "label": { "type": "plain_text", "text": "モデル" }
    },
    {
      "type": "input",
      "block_id": "budget_setting",
      "element": {
        "type": "plain_text_input",
        "action_id": "max_budget",
        "initial_value": "2.00",
        "placeholder": { "type": "plain_text", "text": "USD単位（例: 2.00）" }
      },
      "label": { "type": "plain_text", "text": "予算上限（USD）" },
      "hint": { "type": "plain_text", "text": "このセッションの最大コスト。0で無制限。" },
      "optional": true
    }
  ]
}
```

---

## 9. action_id / block_id 命名規則

一貫した命名規則により、ハンドラの管理とデバッグを容易にする。

### action_id

| パターン | 例 | 用途 |
|---------|-----|------|
| `set_<setting>` | `set_permission_mode`, `set_model` | 設定変更セレクトメニュー |
| `<verb>_session` | `end_session`, `rename_session` | セッション操作 |
| `<verb>_execution` | `approve_execution`, `reject_execution`, `modify_execution` | 承認操作 |
| `quick_commands` | `quick_commands` | コマンドoverflowメニュー |
| `session_overflow` | `session_overflow` | セッションoverflowメニュー |

### block_id

| パターン | 例 | 用途 |
|---------|-----|------|
| `session_controls` | `session_controls` | アンカーのactionsブロック |
| `approval_actions` | `approval_actions` | 承認ダイアログのactionsブロック |
| `<name>_input` | `session_name_input`, `pr_number_input` | モーダル入力フィールド |
| `<name>_setting` | `permission_mode_setting`, `model_setting` | 設定モーダルのフィールド |

### callback_id（モーダル用）

| callback_id | 用途 |
|-------------|------|
| `rename_session_modal` | セッション名変更モーダル |
| `command_args_modal` | コマンド引数入力モーダル |
| `modify_execution_modal` | 実行計画修正モーダル |
| `session_settings_modal` | 統合設定モーダル |

---

## 10. モバイル対応の考慮

### アンカーメッセージのモバイル表示

モバイルSlackでは `static_select` はタップでドロップダウンが開く。デスクトップと同等の操作性。

| UI要素 | モバイルでの挙動 | 対策 |
|--------|----------------|------|
| `static_select` | タップでドロップダウン表示。操作性良好 | 問題なし |
| `overflow` (⋮) | タップでメニュー表示。ただしタップ領域が小さい | ラベル「⋮ コマンド」で存在を認知させる |
| `button` | タップで実行。操作性良好 | 問題なし |
| 承認ボタン（3つ横並び） | モバイルでは縦並びになる | 3ボタンまでなら縦並びでも問題ない |
| モーダル | 全画面表示。入力フィールドの操作性はやや低い | モーダルの使用頻度を最小限に（名前変更、引数入力のみ） |

### テキストコマンドとの併用

全てのUI操作にテキストコマンド等価物を用意する:

| UI操作 | テキストコマンド等価物 |
|--------|---------------------|
| 権限モード変更 | `cc /mode bypass`, `cc /mode ask`, `cc /mode plan`, `cc /mode auto_edit` |
| モデル変更 | `cc /model opus`, `cc /model sonnet`, `cc /model haiku` |
| セッション名変更 | `cc /rename 新しい名前` |
| セッション終了 | `cc /end` |
| セッション情報 | `cc /status` |

これにより、アンカーメッセージが画面外にスクロールされた場合でも、テキスト入力で全操作が可能。

### 拡張コマンドパーサー

```typescript
function parseMessage(text: string): ParsedCommand {
  // cc /xxx パターン
  const ccMatch = text.match(/^cc\s+\/(\S+)\s*(.*)?$/i);
  if (!ccMatch) {
    return { type: 'plain_text', rawText: text };
  }

  const command = ccMatch[1];
  const args = (ccMatch[2] || '').trim();

  // Bridge管理コマンド
  const bridgeCommands: Record<string, string> = {
    status: 'bridge_status',
    end: 'bridge_end',
    help: 'bridge_help',
    mode: 'bridge_set_permission_mode',
    model: 'bridge_set_model',
    rename: 'bridge_rename_session',
  };

  if (bridgeCommands[command]) {
    return { type: 'bridge_command', command: bridgeCommands[command], args, rawText: text };
  }

  // Claude Code コマンド
  return { type: 'claude_command', command, args, rawText: text };
}
```

---

## 11. 実装優先度

### Phase 1 (MVP): アンカー + 基本設定

| 項目 | 工数 | 詳細 |
|------|------|------|
| アンカーメッセージ構築 | 2h | header + status + context + divider + select x2 + actions |
| 権限モード「変更バイパス」のみ | 0h | 既存の `--permission-mode auto` そのまま |
| モデル選択セレクトメニュー | 1h | `set_model` ハンドラ + メタデータ更新 |
| `cc /model` テキストコマンド | 0.5h | パーサー拡張 |
| セッション終了ボタン | 0.5h | 既存設計のまま |
| アンカー `chat.update` | 1h | 設定変更時のアンカー再構築ロジック |

**Phase 1 合計: 約5時間**

### Phase 2: 権限モード全4種 + コマンドメニュー

| 項目 | 工数 | 詳細 |
|------|------|------|
| 権限モードセレクトメニュー | 1.5h | `set_permission_mode` ハンドラ |
| 「編集を自動承認」実装 | 1h | `--allowedTools` ホワイトリスト |
| 「プランモード」実装 | 1h | プロンプト注入ロジック |
| コマンドoverflowメニュー | 1.5h | `quick_commands` ハンドラ |
| コマンド引数モーダル | 1.5h | `/review-pr` 用モーダル |
| `cc /mode` テキストコマンド | 0.5h | パーサー拡張 |

**Phase 2 合計: 約7時間**

### Phase 3: 確認モード + セッション名変更

| 項目 | 工数 | 詳細 |
|------|------|------|
| 「確認を要求」2段階実行 | 4h | プラン生成 → 承認UI → 実行のフロー |
| 承認/拒否ボタン + メッセージ更新 | 2h | `approve_execution` / `reject_execution` |
| 修正指示モーダル | 1.5h | `modify_execution_modal` |
| セッション名手動変更 | 1.5h | overflow → モーダル → header更新 |
| `cc /rename` テキストコマンド | 0.5h | パーサー拡張 |
| 統合設定モーダル | 2h | session_settings_modal |

**Phase 3 合計: 約11.5時間**

### Phase 4: カスタムスキル + 高度な機能

| 項目 | 工数 | 詳細 |
|------|------|------|
| カスタムスキル動的メニュー | 3h | `.claude/commands/` スキャン + メニュー生成 |
| 個別ツール承認（MCP対応時） | 8h | MCP serve + 双方向通信 |
| コスト累積のリアルタイム更新 | 1h | 応答完了時にアンカーのcontext更新 |

**Phase 4 合計: 約12時間**

---

## 12. 技術的な補足

### 12.1 アンカーメッセージの再構築関数

アンカーの各設定変更時に、全体のBlocksを再構築する関数が必要。部分更新ではなく全体置換する（`chat.update` は全ブロックの置換を要求するため）。

```typescript
interface SessionState {
  sessionId: string;
  name: string;
  projectPath: string;
  permissionMode: 'ask' | 'auto_edit' | 'plan' | 'bypass';
  model: 'opus' | 'sonnet' | 'haiku';
  status: 'active' | 'ended';
  startTime: Date;
  totalCost: number;
}

function buildAnchorBlocks(state: SessionState): KnownBlock[] {
  const modeOptions = [
    { text: ':raised_hand: 確認を要求', value: 'ask' },
    { text: ':pencil2: 編集を自動承認', value: 'auto_edit' },
    { text: ':brain: プランモード', value: 'plan' },
    { text: ':shield: 変更バイパス', value: 'bypass' },
  ];

  const modelOptions = [
    { text: 'Opus', value: 'opus' },
    { text: 'Sonnet', value: 'sonnet' },
    { text: 'Haiku', value: 'haiku' },
  ];

  const currentMode = modeOptions.find(o => o.value === state.permissionMode)!;
  const currentModel = modelOptions.find(o => o.value === state.model)!;

  const statusIcon = state.status === 'active'
    ? ':large_green_circle:'
    : ':white_circle:';
  const statusText = state.status === 'active'
    ? 'アクティブセッション'
    : '終了済みセッション';

  return [
    {
      type: 'header',
      text: { type: 'plain_text', text: state.name },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `${statusIcon} *${statusText}*\n:file_folder: \`${state.projectPath}\``,
      },
    },
    {
      type: 'context',
      elements: [{
        type: 'mrkdwn',
        text: `Session: \`${state.sessionId.slice(0, 8)}\` | 開始: ${formatTime(state.startTime)} | :moneybag: $${state.totalCost.toFixed(2)}`,
      }],
    },
    { type: 'divider' },

    // 設定セクション（アクティブ時のみ表示）
    ...(state.status === 'active' ? [
      {
        type: 'section' as const,
        text: { type: 'mrkdwn' as const, text: '*権限モード*' },
        accessory: {
          type: 'static_select' as const,
          action_id: 'set_permission_mode',
          initial_option: {
            text: { type: 'plain_text' as const, text: currentMode.text },
            value: currentMode.value,
          },
          options: modeOptions.map(o => ({
            text: { type: 'plain_text' as const, text: o.text },
            value: o.value,
          })),
        },
      },
      {
        type: 'section' as const,
        text: { type: 'mrkdwn' as const, text: '*モデル*' },
        accessory: {
          type: 'static_select' as const,
          action_id: 'set_model',
          initial_option: {
            text: { type: 'plain_text' as const, text: currentModel.text },
            value: currentModel.value,
          },
          options: modelOptions.map(o => ({
            text: { type: 'plain_text' as const, text: o.text },
            value: o.value,
          })),
        },
      },
      { type: 'divider' as const },
      {
        type: 'actions' as const,
        block_id: 'session_controls',
        elements: [
          {
            type: 'overflow' as const,
            action_id: 'quick_commands',
            options: [
              { text: { type: 'plain_text' as const, text: ':package: /commit' }, value: 'cmd_commit' },
              { text: { type: 'plain_text' as const, text: ':mag: /review-pr' }, value: 'cmd_review_pr' },
              { text: { type: 'plain_text' as const, text: ':broom: /compact' }, value: 'cmd_compact' },
              { text: { type: 'plain_text' as const, text: ':memo: /init' }, value: 'cmd_init' },
              { text: { type: 'plain_text' as const, text: ':brain: /memory' }, value: 'cmd_memory' },
            ],
          },
          {
            type: 'button' as const,
            text: { type: 'plain_text' as const, text: 'セッション終了' },
            action_id: 'end_session',
            value: state.sessionId,
            confirm: {
              title: { type: 'plain_text' as const, text: '確認' },
              text: { type: 'mrkdwn' as const, text: 'このセッションを終了しますか？' },
              confirm: { type: 'plain_text' as const, text: '終了' },
              deny: { type: 'plain_text' as const, text: 'キャンセル' },
            },
          },
          {
            type: 'overflow' as const,
            action_id: 'session_overflow',
            options: [
              { text: { type: 'plain_text' as const, text: ':pencil2: セッション名を変更' }, value: 'rename_session' },
              { text: { type: 'plain_text' as const, text: ':bar_chart: セッション情報' }, value: 'session_info' },
              { text: { type: 'plain_text' as const, text: ':wastebasket: コンテキストクリア' }, value: 'cmd_clear' },
            ],
          },
        ],
      },
    ] : []),

    {
      type: 'context',
      elements: [{
        type: 'mrkdwn',
        text: state.status === 'active'
          ? 'スレッド内にメッセージを送信して対話開始 | `cc /help` でコマンド一覧'
          : 'このセッションは終了しました',
      }],
    },
  ];
}
```

### 12.2 セッションメタデータのスキーマ

```typescript
interface SessionMetadata {
  sessionId: string;            // UUID v4
  threadTs: string;             // Slack message timestamp (anchor)
  dmChannelId: string;          // DM channel ID
  projectPath: string;          // 作業ディレクトリ
  name: string;                 // セッション名（header表示）
  permissionMode: PermissionMode;
  model: ModelChoice;
  status: 'active' | 'ended';
  startTime: Date;
  totalCost: number;            // 累計コスト (USD)
  turnCount: number;            // ターン数
  lastActiveAt: Date;
}

type PermissionMode = 'ask' | 'auto_edit' | 'plan' | 'bypass';
type ModelChoice = 'opus' | 'sonnet' | 'haiku';
```

### 12.3 CLIフラグ生成のロジック

```typescript
function buildClaudeArgs(session: SessionMetadata, isResume: boolean): string[] {
  const modelMap: Record<ModelChoice, string> = {
    opus: process.env.MODEL_OPUS || 'claude-opus-4-6-20250313',
    sonnet: process.env.MODEL_SONNET || 'claude-sonnet-4-20250514',
    haiku: process.env.MODEL_HAIKU || 'claude-haiku-3-5-20241022',
  };

  const args = [
    '-p',
    '--output-format', 'json',
    '--permission-mode', 'auto',
    '--model', modelMap[session.model],
    '--max-budget-usd', String(process.env.MAX_BUDGET_PER_SESSION || '2.00'),
  ];

  // allowedTools（auto_editモードの場合）
  if (session.permissionMode === 'auto_edit') {
    args.push(
      '--allowedTools',
      'Edit,Write,Read,Glob,Grep,NotebookEdit,WebFetch,WebSearch'
    );
  }

  // セッションID
  if (isResume) {
    args.push('-r', session.sessionId);
  } else {
    args.push('--session-id', session.sessionId);
  }

  return args;
}

function buildPrompt(
  session: SessionMetadata,
  userPrompt: string
): string {
  // プランモードの場合はプロンプトを装飾
  if (session.permissionMode === 'plan') {
    return `[PLAN MODE] あなたは計画モードで動作しています。コードの変更を実行せず、計画のみを説明してください。ファイルの読み取りと分析は可能ですが、Write、Edit、Bashツールによる変更は行わないでください。\n---\n${userPrompt}`;
  }

  // 確認モードの場合は計画生成プロンプト
  if (session.permissionMode === 'ask') {
    return `[PLAN ONLY] 以下のタスクの実行計画を作成してください。実際のファイル変更は行わないでください。使用予定のツールと変更内容を一覧で示してください。\n---\n${userPrompt}`;
  }

  return userPrompt;
}
```

### 12.4 `chat.update` の注意点

- `chat.update` はメッセージ全体のブロックを置換する。部分更新はできない
- アンカーメッセージの `ts` を保持しておく必要がある
- 更新時に `text` フィールド（プッシュ通知用フォールバック）も更新すること
- Rate limit: Tier 3 (約50回/分)。設定変更の頻度を考えれば問題ない

### 12.5 `static_select` の制約

- `initial_option` は `options` のいずれかと完全一致する必要がある（`text` と `value` の両方）
- `options` は最大100個まで
- `option_groups` を使えばグルーピングも可能だが、今回の用途では不要
- `static_select` はアンカーメッセージ内に配置した場合、セッション終了後も操作可能な状態で残る。終了時にはアンカーを再構築してセレクトメニューを除去する
