# Slack Block Kit UX 詳細設計 — DM対話 + App Home Tab

作成日: 2026-03-15
前提: DM専用設計、App Home Tab = ダッシュボード、モーダル = 詳細展開、SQLite不要（インメモリ + `.claude/projects/`）

---

## I1: DM内の対話フロー

### 1.1 セッション開始の流れ

セッションは Home Tab のプロジェクト選択から開始される。開始時、Bot が DM に「セッション開始メッセージ」を投稿する。このメッセージがセッションの「アンカー」となり、以降の対話はこのメッセージのスレッド内で行われる。

```
Home Tab: [プロジェクト選択] → Bot が DM に開始メッセージ投稿
                                    │
                                    ├─ スレッド内: ユーザー → Claude Code → 応答
                                    ├─ スレッド内: ユーザー → Claude Code → 応答
                                    └─ ...
```

DM 内に複数セッション（複数プロジェクト）のスレッドが並ぶ形になる。各スレッドが1セッションに対応する。

### 1.2 セッション開始メッセージ（DM に投稿される）

```json
{
  "channel": "<DM channel ID>",
  "text": "セッション開始: my-webapp",
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
          "text": "Session: `a1b2c3d4` | 開始: 2026-03-15 14:30"
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
        "text": "このスレッド内にメッセージを送信して Claude Code と対話してください。"
      }
    },
    {
      "type": "actions",
      "block_id": "session_actions",
      "elements": [
        {
          "type": "button",
          "text": { "type": "plain_text", "text": "セッション終了" },
          "action_id": "end_session",
          "value": "a1b2c3d4",
          "confirm": {
            "title": { "type": "plain_text", "text": "確認" },
            "text": { "type": "mrkdwn", "text": "このセッションを終了しますか?" },
            "confirm": { "type": "plain_text", "text": "終了" },
            "deny": { "type": "plain_text", "text": "キャンセル" }
          }
        },
        {
          "type": "button",
          "text": { "type": "plain_text", "text": "セッション情報" },
          "action_id": "session_info",
          "value": "a1b2c3d4"
        }
      ]
    }
  ]
}
```

### 1.3 DM内の対話メッセージ（Bot 応答）

ユーザーがスレッド内にテキストを送ると、Claude Code の応答が以下の形式でスレッドに投稿される。

**通常応答（短い回答）:**

```json
{
  "channel": "<DM channel ID>",
  "thread_ts": "<session start message ts>",
  "text": "認証機能を実装しました。...",
  "blocks": [
    {
      "type": "section",
      "text": {
        "type": "mrkdwn",
        "text": "認証機能を実装しました。JWTベースの認証ミドルウェアを `src/middleware/auth.ts` に作成し、ログインエンドポイントを追加しました。"
      }
    },
    {
      "type": "context",
      "elements": [
        {
          "type": "mrkdwn",
          "text": ":page_facing_up: 3 files changed | :stopwatch: 12.3s | :moneybag: $0.08"
        }
      ]
    },
    {
      "type": "actions",
      "block_id": "response_actions_<ts>",
      "elements": [
        {
          "type": "button",
          "text": { "type": "plain_text", "text": "詳細を見る" },
          "action_id": "show_details",
          "value": "<response_id>"
        }
      ]
    }
  ]
}
```

**「詳細を見る」ボタン → モーダル展開:**

```json
{
  "type": "modal",
  "title": { "type": "plain_text", "text": "応答詳細" },
  "blocks": [
    {
      "type": "header",
      "text": { "type": "plain_text", "text": "変更ファイル一覧" }
    },
    {
      "type": "section",
      "text": {
        "type": "mrkdwn",
        "text": ":new: `src/middleware/auth.ts`\n:pencil2: `src/routes/index.ts`\n:pencil2: `src/types.ts`"
      }
    },
    { "type": "divider" },
    {
      "type": "header",
      "text": { "type": "plain_text", "text": "実行ログ" }
    },
    {
      "type": "section",
      "text": {
        "type": "mrkdwn",
        "text": "```\nRead src/routes/index.ts\nWrite src/middleware/auth.ts (new)\nEdit src/routes/index.ts\nEdit src/types.ts\n```"
      }
    },
    { "type": "divider" },
    {
      "type": "context",
      "elements": [
        {
          "type": "mrkdwn",
          "text": "Session: `a1b2c3d4` | Duration: 12.3s | Cost: $0.08 | Stop reason: end_turn"
        }
      ]
    }
  ]
}
```

### 1.4 アクティブセッションの DM 内表示

DM のメッセージ一覧（スレッド外）を見ると、各セッション開始メッセージが並ぶ。ヘッダーにプロジェクト名が表示されるため、どのスレッドがどのプロジェクトかは視覚的に判別できる。

ただし、Slack DM には「ピン留め」はできるが「チャンネルトピック」のような永続ヘッダーがない。そのため、**アクティブセッションの状態は Home Tab で一元管理**し、DM 内では個別のセッション開始メッセージの状態表示（`:large_green_circle:` アクティブ / `:white_circle:` 終了済み）で区別する。

セッション終了時は `chat.update` で開始メッセージを更新する:

```json
{
  "type": "section",
  "text": {
    "type": "mrkdwn",
    "text": ":white_circle: *終了済みセッション*\n:file_folder: `/Users/user/dev/my-webapp`"
  }
}
```

### 1.5 セッション切り替え

**方針: DM 内にはセッション切り替え手段を置かない。Home Tab に戻る。**

理由:
- DM 内にセッション選択 UI を置くと、セッション管理の責務が DM と Home Tab に分散する
- Home Tab が「管理」、DM が「対話」という関心の分離が崩れる
- DM 内のボタンは過去のメッセージに埋もれて見つけにくい

ただし、最低限の導線として DM 内に Home Tab への誘導を含める:

```json
{
  "type": "context",
  "elements": [
    {
      "type": "mrkdwn",
      "text": ":house: 別のセッションに切り替えるには <slack://app?team=T123&id=A456&tab=home|Home Tab> を開いてください"
    }
  ]
}
```

> **注意:** `slack://app` ディープリンクはデスクトップ版では動作するが、モバイル版での動作は不安定な場合がある。代替として「App名をタップ → Homeタブ」の手順をテキストで案内する。

### 1.6 DM 内で使える補助操作

セッション開始メッセージの `actions` ブロックに加え、スレッド内で以下のテキストコマンドを使えるようにする:

| コマンド | 動作 |
|---------|------|
| `cc /status` | 現在のセッション情報を表示 |
| `cc /end` | セッションを終了 |
| `cc /help` | 利用可能なコマンド一覧 |

これにより、モバイルでスレッド内にいる状態でも最低限の操作が可能になる。

---

## I2: 実行中の待機表現

### 2.1 推奨: リアクション + メッセージ更新のハイブリッド

**Phase 1 (MVP):** リアクション絵文字のみ

```typescript
// 受信直後
await client.reactions.add({
  channel, timestamp: userMessageTs,
  name: 'hourglass_flowing_sand'  // :hourglass_flowing_sand:
});

// 完了後
await client.reactions.remove({
  channel, timestamp: userMessageTs,
  name: 'hourglass_flowing_sand'
});
await client.reactions.add({
  channel, timestamp: userMessageTs,
  name: 'white_check_mark'  // :white_check_mark:
});
```

利点:
- 実装が最もシンプル（API 2回で完結）
- モバイルでも確実に表示される
- スレッドの流れを妨げない（追加メッセージ不要）

欠点:
- 経過時間がわからない
- 「処理中」以上の情報がない

**Phase 2:** リアクション + ステータスメッセージ更新

```typescript
// ステータスメッセージを投稿
const statusMsg = await client.chat.postMessage({
  channel, thread_ts: threadTs,
  text: ':hourglass_flowing_sand: 処理中...',
  blocks: [{
    type: 'context',
    elements: [{
      type: 'mrkdwn',
      text: ':hourglass_flowing_sand: 処理中... (0s)'
    }]
  }]
});

// 5秒ごとに更新
const interval = setInterval(async () => {
  elapsed += 5;
  await client.chat.update({
    channel, ts: statusMsg.ts!,
    text: `処理中... (${elapsed}s)`,
    blocks: [{
      type: 'context',
      elements: [{
        type: 'mrkdwn',
        text: `:hourglass_flowing_sand: 処理中... (${elapsed}s)`
      }]
    }]
  });
}, 5000);

// 完了後: ステータスメッセージを削除し、結果メッセージを投稿
clearInterval(interval);
await client.chat.delete({ channel, ts: statusMsg.ts! });
```

### 2.2 選択肢の比較

| 方式 | モバイル表示 | 情報量 | API呼び出し数 | 推奨フェーズ |
|------|------------|--------|-------------|------------|
| リアクション絵文字のみ | 確実に見える | 低（処理中/完了のみ） | 2-3回 | MVP |
| `chat.postMessage` → `chat.update` → `chat.delete` | 確実に見える | 高（経過時間表示可） | N回（更新頻度依存） | Phase 2 |
| Slack typing indicator | **Bot DMでは表示不可** | - | - | 不採用 |
| Slack chat streaming API (2025/10) | 対応端末のみ | 最高（トークン単位） | ストリーム接続 | Phase 3+ |

**typing indicator を不採用とする理由:**
Slack の typing indicator は `user_typing` イベントで実現されるが、Bot ユーザーからの typing イベント送信は Slack API でサポートされていない。`chat.postMessage` の代替手段としては使えない。

### 2.3 chat.update の Rate Limit 対策

`chat.update` は Tier 3 API で、1分あたり約50回の呼び出しが可能。5秒間隔の更新なら1セッションあたり12回/分であり、同時3セッションでも36回/分で制限内に収まる。

ただし安全マージンとして:
- 更新間隔を 5秒以上にする
- 30秒経過後は10秒間隔に緩和する
- 60秒以上の長時間処理では15秒間隔にする

```typescript
function getUpdateInterval(elapsedSec: number): number {
  if (elapsedSec < 30) return 5000;
  if (elapsedSec < 60) return 10000;
  return 15000;
}
```

---

## I3: エラー・長文応答の表示

### 3.1 エラー表示

**Claude Code プロセスエラー (exitCode !== 0):**

```json
{
  "thread_ts": "<session thread>",
  "text": "エラーが発生しました",
  "blocks": [
    {
      "type": "section",
      "text": {
        "type": "mrkdwn",
        "text": ":x: *エラーが発生しました*"
      }
    },
    {
      "type": "section",
      "text": {
        "type": "mrkdwn",
        "text": "```\nError: ENOENT: no such file or directory, open '/Users/user/dev/my-webapp/nonexistent.ts'\n```"
      }
    },
    {
      "type": "context",
      "elements": [
        {
          "type": "mrkdwn",
          "text": "Exit code: 1 | Duration: 3.2s | Session: `a1b2c3d4`"
        }
      ]
    },
    {
      "type": "section",
      "text": {
        "type": "mrkdwn",
        "text": "スレッド内でメッセージを送信するとリトライできます。"
      }
    }
  ]
}
```

リアクション: `:hourglass_flowing_sand:` → `:x:` に置換

**タイムアウト:**

```json
{
  "blocks": [
    {
      "type": "section",
      "text": {
        "type": "mrkdwn",
        "text": ":warning: *処理がタイムアウトしました* (制限: 5分)"
      }
    },
    {
      "type": "section",
      "text": {
        "type": "mrkdwn",
        "text": "タスクを分割して再実行することを推奨します。\n例: 「まず認証部分だけ実装して」→「次にテストを追加して」"
      }
    },
    {
      "type": "actions",
      "elements": [
        {
          "type": "button",
          "text": { "type": "plain_text", "text": "同じ内容でリトライ" },
          "action_id": "retry_prompt",
          "value": "<original_prompt_hash>"
        }
      ]
    }
  ]
}
```

リアクション: `:hourglass_flowing_sand:` → `:warning:` に置換

**セッション不整合（Claude Code 側にセッションファイルが存在しない）:**

```json
{
  "blocks": [
    {
      "type": "section",
      "text": {
        "type": "mrkdwn",
        "text": ":arrows_counterclockwise: セッションをリセットしました。新しいセッションで処理を続行します。"
      }
    }
  ]
}
```

この場合はユーザーの再入力を待たず、自動で新規セッションとして再実行する。

### 3.2 長文応答の分割戦略

#### 判定フロー

```
応答テキスト
  │
  ├─ <= 3,900文字 → 単一メッセージ（section block）
  │
  ├─ 3,900 < x <= 12,000文字 → 分割メッセージ（最大3分割）
  │     └─ 各分割をスレッド内に連続投稿
  │
  ├─ 12,000 < x <= 39,000文字 → 要約メッセージ + ファイルアップロード
  │     ├─ スレッド内: 先頭500文字の要約 + 「全文はファイルを参照」
  │     └─ スレッド内: files.uploadV2 で response.md を添付
  │
  └─ > 39,000文字 → ファイルアップロードのみ
        └─ スレッド内: files.uploadV2 + 簡潔な概要コメント
```

#### 分割境界の優先順位

1. **Markdown の見出し** (`## `, `### `) — 最もクリーンな分割点
2. **コードブロックの終了** (` ``` ` の閉じ) — コードブロック内では絶対に分割しない
3. **空行**（パラグラフ境界）
4. **文末** (`. ` の後、日本語の場合は `。` の後)
5. **強制分割** — 上記すべてで分割できない場合の最終手段（行末で切断）

```typescript
function splitAtBoundaries(text: string, maxLength: number): string[] {
  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > maxLength) {
    let splitIndex = -1;

    // 優先度1: 見出し境界
    const headingMatch = remaining.substring(0, maxLength).match(/\n(?=## )/g);
    if (headingMatch) {
      splitIndex = remaining.lastIndexOf('\n## ', maxLength);
    }

    // 優先度2: コードブロック終了後
    if (splitIndex === -1) {
      splitIndex = remaining.lastIndexOf('\n```\n', maxLength);
      if (splitIndex !== -1) splitIndex += 5; // ``` の後ろで分割
    }

    // 優先度3: 空行
    if (splitIndex === -1) {
      splitIndex = remaining.lastIndexOf('\n\n', maxLength);
    }

    // 優先度4: 文末
    if (splitIndex === -1) {
      const sentenceEnd = remaining.substring(0, maxLength).match(/[.。]\s/g);
      if (sentenceEnd) {
        splitIndex = remaining.lastIndexOf('. ', maxLength);
        if (splitIndex === -1) splitIndex = remaining.lastIndexOf('。', maxLength);
      }
    }

    // 優先度5: 強制分割
    if (splitIndex === -1 || splitIndex < maxLength * 0.3) {
      splitIndex = remaining.lastIndexOf('\n', maxLength);
      if (splitIndex === -1) splitIndex = maxLength;
    }

    chunks.push(remaining.substring(0, splitIndex).trim());
    remaining = remaining.substring(splitIndex).trim();
  }

  if (remaining.length > 0) {
    chunks.push(remaining);
  }

  return chunks;
}
```

#### コードブロック分断の防止

分割前に「開いているコードブロック」を検出する。分割点がコードブロック内にある場合、コードブロックの開始点の直前まで戻す。

```typescript
function isInsideCodeBlock(text: string, position: number): boolean {
  const before = text.substring(0, position);
  const backtickCount = (before.match(/```/g) || []).length;
  return backtickCount % 2 === 1; // 奇数 = コードブロック内
}
```

### 3.3 Block Kit 50ブロック制限への対処

通常の応答は 3-5 ブロック（section + context + actions）程度で収まる。50ブロックに近づくのは以下のケースのみ:

| ケース | 対処 |
|-------|------|
| 非常に長い応答を分割して section ブロックに入れた場合 | → 分割メッセージ化（1メッセージあたりのブロック数を抑える） |
| ファイル一覧が非常に多い場合（モーダル内） | → モーダル内でページネーション、または折りたたみ |

**方針: メッセージ内のブロック数は最大10に制限する。それを超える場合は分割メッセージまたはファイルアップロードにフォールバックする。**

この方針により、50ブロック制限に到達するリスクを排除する。

### 3.4 分割メッセージの連続投稿時の注意

```typescript
// 分割メッセージを順次投稿（間隔を空ける）
for (let i = 0; i < chunks.length; i++) {
  await client.chat.postMessage({
    channel,
    thread_ts: threadTs,
    text: chunks[i],
    blocks: [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: chunks[i] }
      },
      // 最後のチャンクにのみメタ情報と詳細ボタンを付ける
      ...(i === chunks.length - 1 ? [
        {
          type: 'context',
          elements: [{
            type: 'mrkdwn',
            text: `:page_facing_up: ${fileCount} files changed | :stopwatch: ${duration}s | :moneybag: $${cost} | (${i + 1}/${chunks.length})`
          }]
        },
        {
          type: 'actions',
          block_id: `response_actions_${Date.now()}`,
          elements: [{
            type: 'button',
            text: { type: 'plain_text', text: '詳細を見る' },
            action_id: 'show_details',
            value: responseId
          }]
        }
      ] : [
        {
          type: 'context',
          elements: [{
            type: 'mrkdwn',
            text: `(${i + 1}/${chunks.length})`
          }]
        }
      ])
    ]
  });

  // Rate limit 対策: 投稿間に 1 秒の間隔
  if (i < chunks.length - 1) {
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
}
```

---

## I4: `cc /xxx` コマンド体系

### 4.1 方針: テキストコマンドとBlock Kit UIの併用

テキストコマンドを完全に排除してBlock KitのみにするのはUXの劣化を招く。理由:

1. **モバイルでのテキスト入力は速い** — ボタンを探すよりも `cc /status` と打つ方が速い場面が多い
2. **Block Kit ボタンは過去メッセージに埋もれる** — スレッドが長くなると以前のボタンを見つけにくい
3. **Claude Code のコマンドは動的に増える** — ボタンで全コマンドをカバーするのは非現実的

### 4.2 コマンド分類

**テキストコマンド（DM スレッド内で使用）:**

| コマンド | 動作 | 備考 |
|---------|------|------|
| `cc /status` | セッション状態・統計表示 | Block Kit レスポンス |
| `cc /end` | セッション終了 | 確認なしで即終了 |
| `cc /help` | コマンド一覧表示 | Block Kit レスポンス |
| `cc /commit` | Claude Code の /commit を実行 | Claude Code に転送 |
| `cc /review-pr <N>` | Claude Code の /review-pr を実行 | Claude Code に転送 |
| `cc /<any>` | 任意の Claude Code コマンド | そのまま転送 |

**Block Kit UI（ボタン操作）:**

| UI 要素 | 配置場所 | 動作 |
|--------|---------|------|
| 「新規セッション」ボタン | Home Tab | プロジェクト選択 → DM にセッション開始 |
| 「セッション終了」ボタン | DM セッション開始メッセージ | セッション終了（確認ダイアログ付き） |
| 「セッション情報」ボタン | DM セッション開始メッセージ | モーダルでセッション詳細表示 |
| 「詳細を見る」ボタン | DM 各応答メッセージ | モーダルで応答詳細表示 |
| 「リトライ」ボタン | エラーメッセージ | 同じプロンプトで再実行 |

### 4.3 コマンドパーサーの実装

```typescript
interface ParsedCommand {
  type: 'claude_command' | 'bridge_command' | 'plain_text';
  command?: string;  // "commit", "status", "help" 等
  args?: string;     // コマンドの引数
  rawText: string;   // 元のテキスト
}

function parseMessage(text: string): ParsedCommand {
  // cc /xxx パターン
  const ccMatch = text.match(/^cc\s+\/(\S+)\s*(.*)?$/i);
  if (ccMatch) {
    const command = ccMatch[1];
    const args = (ccMatch[2] || '').trim();

    // ブリッジ管理コマンド
    const bridgeCommands = ['status', 'end', 'help', 'sessions'];
    if (bridgeCommands.includes(command)) {
      return { type: 'bridge_command', command, args, rawText: text };
    }

    // Claude Code コマンド（そのまま転送）
    return { type: 'claude_command', command, args, rawText: text };
  }

  // 通常テキスト（Claude Code にプロンプトとして送信）
  return { type: 'plain_text', rawText: text };
}
```

### 4.4 `cc /help` の応答

```json
{
  "blocks": [
    {
      "type": "header",
      "text": { "type": "plain_text", "text": "コマンド一覧" }
    },
    {
      "type": "section",
      "text": {
        "type": "mrkdwn",
        "text": "*Bridge コマンド*\n`cc /status` — セッション情報を表示\n`cc /end` — セッションを終了\n`cc /help` — この一覧を表示"
      }
    },
    { "type": "divider" },
    {
      "type": "section",
      "text": {
        "type": "mrkdwn",
        "text": "*Claude Code コマンド*\n`cc /commit` — 変更をコミット\n`cc /review-pr <N>` — PRレビュー\n`cc /init` — CLAUDE.md 初期化\n`cc /clear` — コンテキストクリア\n`cc /<any>` — 任意のClaude Codeコマンド"
      }
    },
    { "type": "divider" },
    {
      "type": "context",
      "elements": [
        {
          "type": "mrkdwn",
          "text": ":bulb: `cc /` なしでメッセージを送ると、Claude Code への通常のプロンプトとして処理されます"
        }
      ]
    }
  ]
}
```

### 4.5 モバイル vs デスクトップの使い分けガイダンス

- **デスクトップ**: テキストコマンドもボタンも快適に使える。好みで選択。
- **モバイル**: テキスト入力は面倒だがボタンはタップしやすい。ただしスレッド内のボタンを探すのは困難。
  - 頻用コマンドは短い: `cc /status`, `cc /end` は十分に短い
  - 複雑な引数を伴うコマンドはデスクトップで使うことを前提とする

---

## I10: セッション命名

### 10.1 推奨: 自動命名（最初のプロンプトからの要約生成）

**命名タイミングと方式:**

1. セッション開始時: プロジェクト名をデフォルト名として使用（例: `my-webapp`）
2. 最初の応答完了後: Claude Code に送ったプロンプトの内容から短い要約を生成し、セッション名を更新

**自動命名の実装:**

```typescript
function generateSessionName(
  projectName: string,
  firstPrompt: string
): string {
  // プロンプトの先頭30文字を取得し、セッション名に使用
  const summary = firstPrompt
    .replace(/\n/g, ' ')      // 改行を空白に
    .replace(/\s+/g, ' ')     // 連続空白を圧縮
    .trim()
    .substring(0, 30);

  // 末尾が中途半端に切れている場合、最後の単語を除去
  const trimmed = summary.replace(/\s\S*$/, '');

  return `${projectName}: ${trimmed || 'New Session'}`;
}

// 例:
// "認証機能を実装してください。JWTベースで..."
// → "my-webapp: 認証機能を実装してください"
```

**セッション開始メッセージの更新:**

最初の応答完了後に `chat.update` でセッション開始メッセージのヘッダーを更新する:

```typescript
// 初回応答完了後
const sessionName = generateSessionName(projectName, firstPrompt);

await client.chat.update({
  channel: dmChannelId,
  ts: sessionStartMessageTs,
  blocks: [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: sessionName  // "my-webapp: 認証機能を実装して"
      }
    },
    // ... 残りのブロックは同じ
  ]
});
```

### 10.2 手動命名（Phase 2）

Phase 2 で以下を追加:
- セッション開始メッセージの overflow メニューに「名前を変更」オプション
- 選択時にモーダルで新しい名前を入力

```json
{
  "type": "overflow",
  "action_id": "session_overflow",
  "options": [
    {
      "text": { "type": "plain_text", "text": "名前を変更" },
      "value": "rename_<session_id>"
    },
    {
      "text": { "type": "plain_text", "text": "セッション終了" },
      "value": "end_<session_id>"
    }
  ]
}
```

### 10.3 Home Tab でのセッション一覧表示

```json
{
  "type": "home",
  "blocks": [
    {
      "type": "header",
      "text": { "type": "plain_text", "text": "Claude Code Bridge" }
    },
    {
      "type": "context",
      "elements": [{
        "type": "mrkdwn",
        "text": ":large_green_circle: Bridge 稼働中"
      }]
    },
    { "type": "divider" },

    {
      "type": "section",
      "text": { "type": "mrkdwn", "text": "*プロジェクト*" }
    },
    {
      "type": "section",
      "text": {
        "type": "mrkdwn",
        "text": ":file_folder: *my-webapp*\n`/Users/user/dev/my-webapp`"
      },
      "accessory": {
        "type": "button",
        "text": { "type": "plain_text", "text": "新規セッション" },
        "style": "primary",
        "action_id": "start_session",
        "value": "my-webapp"
      }
    },
    {
      "type": "section",
      "text": {
        "type": "mrkdwn",
        "text": ":file_folder: *api-server*\n`/Users/user/dev/api-server`"
      },
      "accessory": {
        "type": "button",
        "text": { "type": "plain_text", "text": "新規セッション" },
        "style": "primary",
        "action_id": "start_session",
        "value": "api-server"
      }
    },

    { "type": "divider" },

    {
      "type": "section",
      "text": { "type": "mrkdwn", "text": "*アクティブセッション*" }
    },
    {
      "type": "section",
      "text": {
        "type": "mrkdwn",
        "text": ":large_green_circle: *my-webapp: 認証機能を実装して*\nSession: `a1b2c3d4` | 最終操作: 3分前"
      },
      "accessory": {
        "type": "button",
        "text": { "type": "plain_text", "text": "スレッドを開く" },
        "action_id": "open_session_thread",
        "value": "a1b2c3d4"
      }
    },
    {
      "type": "section",
      "text": {
        "type": "mrkdwn",
        "text": ":large_green_circle: *api-server: エンドポイント追加*\nSession: `e5f6g7h8` | 最終操作: 15分前"
      },
      "accessory": {
        "type": "button",
        "text": { "type": "plain_text", "text": "スレッドを開く" },
        "action_id": "open_session_thread",
        "value": "e5f6g7h8"
      }
    },

    { "type": "divider" },

    {
      "type": "section",
      "text": { "type": "mrkdwn", "text": "*最近のセッション（終了済み）*" }
    },
    {
      "type": "context",
      "elements": [{
        "type": "mrkdwn",
        "text": ":white_circle: my-webapp: READMEを更新 — 1時間前\n:white_circle: api-server: バグ修正 — 3時間前\n:white_circle: my-webapp: テスト追加 — 昨日"
      }]
    }
  ]
}
```

**「スレッドを開く」ボタンの実装:**

DM 内の特定スレッドへのリンクを生成して `chat.getPermalink` で取得し、`url` 付きボタンにする方法と、ボタンクリック時に Bot がスレッドに「ここです」メッセージを投稿する方法の2つがある。

推奨: `chat.getPermalink` で取得した URL を `url` 属性に設定する。

```typescript
app.action('open_session_thread', async ({ action, client, body, ack }) => {
  await ack();

  const sessionId = (action as ButtonAction).value;
  const session = sessionStore.get(sessionId);
  if (!session) return;

  const permalink = await client.chat.getPermalink({
    channel: session.dmChannelId,
    message_ts: session.threadTs
  });

  // permalink を使ってブラウザ/アプリでスレッドを開く
  // 注: url 属性を使う場合は action ではなく link_button_url にする必要がある
  // 代替: DM 内にメッセージを投稿してスレッドに誘導
  await client.chat.postMessage({
    channel: session.dmChannelId,
    thread_ts: session.threadTs,
    text: ':point_up: このスレッドでセッションが進行中です'
  });
});
```

> **実装メモ:** `button` の `url` 属性は外部リンク専用であり、Slack 内リンクには使えない。そのため、`open_session_thread` はアクションハンドラでスレッドにメッセージを投稿し、DM 側のスレッド通知を活用してユーザーを誘導する形が現実的。

---

## モバイル Slack での制約と対策

### 制約一覧

| 制約 | 影響 | 対策 |
|------|------|------|
| `slack://app` ディープリンクが不安定 | Home Tab へのリンクが動かない場合がある | テキストで「Appの Home タブを開いてください」と案内 |
| モーダルの表示が画面全体を覆う | 長いモーダルはスクロールが面倒 | モーダル内の情報量を絞る（100ブロック上限は問題ないが、UX上20ブロック程度に抑える） |
| スレッド内のボタンが見つけにくい | 長いスレッドで過去のボタンが埋もれる | テキストコマンド (`cc /xxx`) を補助手段として維持 |
| Block Kit の `overflow` メニューのタップ領域 | 小さいタップターゲット | overflow よりも明示的な button を優先 |
| プッシュ通知の文字数制限 | Block Kit の内容は通知に含まれない | `text` フォールバック（blocks 外の text フィールド）を必ず設定 |
| `context` ブロックの文字が小さい | モバイルでは読みにくい | 重要情報は `section` に入れ、`context` は補足情報のみ |
| 画像やリッチメディアの読み込み速度 | モバイル回線では遅い場合がある | テキストベースの表示を基本とし、画像は使わない |

### モバイル対応の実装原則

1. **`text` フォールバックを必ず設定する** — `blocks` を持つメッセージにも必ず `text` フィールドを含める。プッシュ通知やアクセシビリティで使われる。
2. **ボタンは大きく、少なく** — 1つの `actions` ブロックに3つ以上のボタンを置かない。モバイルでは横並びが縦並びになる。
3. **テキストコマンドをファーストクラスにする** — ボタンが見つからない場合の代替手段として、すべてのボタン操作にテキストコマンド等価物を用意する。
4. **section の text は短く** — `section` のテキストは2-3行に抑える。長い説明はモーダルに委譲する。

---

## 推奨実装の優先度

### MVP（最小限で動くもの）

| 項目 | 内容 | 工数 |
|------|------|------|
| Home Tab: プロジェクト一覧 | `.claude/projects/` スキャン → `views.publish` | 2h |
| Home Tab: 「新規セッション」ボタン | `action` ハンドラ → DM に開始メッセージ投稿 | 2h |
| DM: セッション開始メッセージ | header + section + context + actions | 1h |
| DM: 対話フロー（スレッド内） | ユーザーメッセージ → Claude Code → 応答 section | 2h |
| DM: リアクション（処理中/完了/エラー） | reactions.add / remove | 0.5h |
| DM: エラー表示 | エラー section + context | 1h |
| DM: 基本の長文分割 | 3,900文字超で分割投稿 | 2h |
| コマンドパーサー | `cc /xxx` 検出 + ブリッジコマンド分岐 | 1h |
| `cc /status`, `cc /end`, `cc /help` | ブリッジ管理コマンド3つ | 1.5h |

**MVP 合計: 約13時間（2日弱）**

### Phase 2（実用レベル）

| 項目 | 内容 | 工数 |
|------|------|------|
| 処理中メッセージ更新（経過時間表示） | chat.postMessage → chat.update → chat.delete | 2h |
| 応答の「詳細を見る」モーダル | views.open + ファイル一覧 + 実行ログ | 3h |
| セッション自動命名 | 最初のプロンプトから要約生成 | 1h |
| Home Tab: アクティブセッション一覧 | sessions → views.publish | 2h |
| Home Tab: 終了済みセッション履歴 | 直近5件の表示 | 1h |
| ファイルアップロード（長文応答） | files.uploadV2 + initial_comment | 2h |
| セッション終了時の状態更新 | chat.update でステータスアイコン変更 | 1h |
| コードブロック分断防止ロジック | isInsideCodeBlock + 分割点修正 | 2h |

**Phase 2 合計: 約14時間（2日弱）**

### Phase 3（リッチ体験）

| 項目 | 内容 | 工数 |
|------|------|------|
| セッション手動命名（overflow → モーダル） | views.open + views.submission | 2h |
| 確認ダイアログ（commit 等の破壊的操作） | confirm 属性 or モーダル | 2h |
| Home Tab: 設定セクション | タイムアウト時間・予算上限の変更 | 3h |
| Home Tab: プロジェクトごとの統計 | セッション数・累計コスト | 2h |
| リトライボタン | タイムアウト/エラー時のリトライ | 1.5h |
| Markdown → mrkdwn 変換の改善 | テーブル、ネストリスト対応 | 3h |

**Phase 3 合計: 約13.5時間（2日弱）**

---

## 未解決のリスクと注意点

### R1: DM 内スレッドの検索性

DM 内に多数のセッションスレッドが蓄積すると、過去のセッションを探すのが困難になる。Slack の検索機能（`in:@BotName`）は DM 内のメッセージを検索可能だが、スレッドの「タイトル」的なものがないため、セッション開始メッセージのヘッダーテキストが検索対象となる。

**対策:** セッション自動命名を確実に実装し、ヘッダーに検索しやすいキーワードを含める。

### R2: Home Tab の更新タイミング

`views.publish` は `app_home_opened` イベント発火時に呼ばれるが、ユーザーが Home Tab を開いた状態でセッション状態が変わった場合、自動更新されない。

**対策:** セッション状態変更時（開始・終了・エラー）にも `views.publish` を呼ぶ。ただし、ユーザーが Home Tab を開いていない場合は不要な API 呼び出しになる。`app_home_opened` で user_id をキャッシュし、最後にタブを開いた時刻が直近5分以内であれば更新を送る、という戦略が効率的。

### R3: インメモリストアの揮発性

設計コンテキストに「SQLite不要。インメモリ + `.claude/projects/`」と記載されている。インメモリの場合、Bridge プロセスの再起動でセッション情報が失われる。

**影響:**
- アクティブセッションの情報が消える → Home Tab に表示されなくなる
- DM 内のスレッドは残るが、Bridge 側のマッピング（thread_ts → session_id）が消える
- スレッド内に新しいメッセージを送っても、新規セッション扱いになる

**対策:**
- Claude Code の `-r` フラグで指定する session_id を、DM のスレッド ts から決定的に生成する（UUID v5 等）ことで、再起動後も同じスレッドからセッションを復元可能にする
- または、最小限の永続化として `.claude/bridge-state.json` のような軽量ファイルに session マッピングを書き出す

### R4: 複数セッション同時実行時の DM の見え方

複数のアクティブセッションが同時に応答を返す場合、DM のメイン画面（スレッド外）に複数の通知が混在する。スレッド内の応答はスレッドに閉じるため問題ないが、セッション開始メッセージやエラーメッセージはスレッド外に表示される。

**対策:** セッション関連の全メッセージをスレッド内に閉じる（`reply_broadcast: false`）。セッション開始メッセージのみがスレッド外に表示される。

### R5: `.claude/projects/` の自動検出精度

`.claude/projects/` ディレクトリからプロジェクト一覧を自動検出するが、このディレクトリの構造が変わった場合や、プロジェクトパスに特殊文字が含まれる場合の挙動が未定義。

**対策:** ディレクトリスキャン時にバリデーションを行い、読み取れないエントリはスキップしてログに記録する。Home Tab に「プロジェクトが見つかりません」の表示を用意する。

### R6: `chat.getPermalink` のレート制限

Home Tab の「スレッドを開く」ボタンを実装する場合、各セッションのパーマリンクを取得する必要がある。Home Tab の `views.publish` 時に全セッションのパーマリンクを取得すると API 呼び出しが増加する。

**対策:** パーマリンクはセッション開始時に1回取得してインメモリキャッシュする。Home Tab 更新時にはキャッシュを参照する。

### R7: section ブロックの 3,000 文字制限

Block Kit の `section` ブロック内の `text` オブジェクトには 3,000 文字の制限がある。メッセージ全体の 4,000 文字制限とは別に、この制限にも注意が必要。

**対策:** 分割ロジックでは `MAX_SECTION_TEXT = 2,900`（安全マージン込み）を基準にし、1つの section ブロックに収める文字数を制限する。超過する場合は複数の section ブロックに分割する。
