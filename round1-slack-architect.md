# Slack Bot 設計レポート

## 1. 技術選定（Bolt, Socket Mode等）

### 1.1 フレームワーク比較

| 項目 | Bolt for JavaScript | Bolt for Python | slack-go (非公式) |
|------|-------------------|----------------|------------------|
| メンテナ | Slack 公式 | Slack 公式 | コミュニティ |
| 成熟度 | ★★★★★ 最も成熟 | ★★★★ 十分成熟 | ★★★ |
| Socket Mode 対応 | ネイティブ対応 | ネイティブ対応 | 部分的 |
| Block Kit 型定義 | TypeScript で完全型安全 | 辞書ベース（型ヒントあり） | 構造体定義あり |
| ドキュメント量 | 最多 | 豊富 | 限定的 |
| AI/ストリーミング対応 | chat_stream ユーティリティ対応 | chat_stream 対応 | 未対応 |
| Claude Code との親和性 | 高（Claude Code 自体が TypeScript） | 中 | 低 |

**推奨: Bolt for JavaScript (TypeScript)**

round1-bridge-architect.md での技術スタック提案と一致する。主な理由:

1. **Claude Code が TypeScript 製** — 内部構造の理解、デバッグ時に言語統一のメリットが大きい
2. **Bolt for JS が最も成熟** — Socket Mode、Block Kit、インタラクティブ機能すべてにおいて最も安定
3. **2025年10月に追加された AI 向け機能**（chat streaming、フィードバックボタン）が JS SDK で最初にサポートされている
4. **async/await + イベントループ** — Slack イベント受信 → 非同期プロセス実行 → 結果返信のフローに最適

### 1.2 Socket Mode vs HTTP Mode

| 観点 | Socket Mode (WebSocket) | HTTP Mode (Events API) |
|------|------------------------|----------------------|
| パブリック URL | **不要** | 必要（ngrok 等） |
| ファイアウォール | 内側から接続可能 | ポート開放 or トンネリング必要 |
| レイテンシ | 低（常時接続） | 中（HTTP ハンドシェイク） |
| 信頼性 | WebSocket 切断時に自動再接続 | HTTP リトライ機構あり |
| Marketplace 配布 | **不可** | 可能 |
| スケーラビリティ | 単一インスタンス向き | 複数インスタンス可能 |
| セットアップ難度 | **低** | 中〜高 |

**推奨: Socket Mode**

ローカル PC 常時起動という前提条件において、Socket Mode が圧倒的に適切:

- パブリック URL の公開が不要（セキュリティリスクなし）
- ngrok 等のトンネリングツール不要（依存関係の削減）
- Marketplace 配布は不要（個人利用のため）
- Bolt の `App({ socketMode: true })` で初期化するだけで動作

### 1.3 必要な OAuth スコープ一覧

#### Bot Token Scopes (xoxb)

| スコープ | 用途 | 必須度 |
|---------|------|--------|
| `app_mentions:read` | @メンションの受信 | MVP |
| `chat:write` | メッセージの投稿 | MVP |
| `channels:history` | パブリックチャンネルのメッセージ読み取り | MVP |
| `channels:read` | チャンネル情報の取得 | MVP |
| `channels:manage` | チャンネルの作成・管理（パターン2/3用） | Phase 2 |
| `groups:history` | プライベートチャンネルのメッセージ読み取り | Phase 2 |
| `groups:read` | プライベートチャンネル情報の取得 | Phase 2 |
| `im:history` | DM のメッセージ読み取り（パターン1用） | パターン依存 |
| `im:read` | DM チャンネル情報の取得 | パターン依存 |
| `im:write` | DM の送信 | パターン依存 |
| `reactions:write` | リアクション絵文字の追加・削除 | MVP |
| `reactions:read` | リアクションの読み取り | Phase 2 |
| `files:write` | ファイルアップロード（長文出力用） | MVP |
| `files:read` | アップロードしたファイルの読み取り | MVP |
| `commands` | スラッシュコマンドの受信 | Phase 2 |
| `users:read` | ユーザー情報の取得 | Phase 2 |

#### App-Level Token Scopes

| スコープ | 用途 |
|---------|------|
| `connections:write` | Socket Mode 接続用（必須） |

#### Event Subscriptions

| イベント | 用途 |
|---------|------|
| `message.channels` | パブリックチャンネルのメッセージ受信 |
| `message.groups` | プライベートチャンネルのメッセージ受信 |
| `message.im` | DM のメッセージ受信 |
| `app_mention` | @メンションの受信 |
| `app_home_opened` | Home Tab の表示 |

---

## 2. チャンネル戦略の比較分析

### パターン1: DM + インタラクティブ選択

```
ユーザー ──DM──► Bot
                 │
                 ├─ モーダル表示「作業ディレクトリを選択」
                 │   ├─ /Users/user/project-a
                 │   ├─ /Users/user/project-b
                 │   └─ カスタムパスを入力
                 │
                 └─ 選択後、DM スレッド内で Claude Code とやり取り
```

| 観点 | 評価 |
|------|------|
| 実装複雑度 | **中** — モーダル + ボタンの実装が必要 |
| UX | **良** — 全操作が DM 内で完結、Slack ワークスペースを汚さない |
| プロジェクト切り替え | **やや煩雑** — モーダルを再度開いて選択し直す必要 |
| 同時並行作業 | **困難** — DM は1チャンネルしかないため、複数プロジェクトのスレッドが混在 |
| セッション管理 | スレッド ts でセッションを区別。同一 DM 内に複数スレッドが乱立する可能性 |
| 他者との共有 | **不可** — DM なので他のユーザーが閲覧・参加できない |
| チャンネル数 | 増加しない（DM 1つのみ） |

**長所:**
- ワークスペースのチャンネル一覧を汚さない
- 初期セットアップが簡単（Bot との DM を開くだけ）
- 1人で使う場合のプライバシーが確保される

**短所:**
- 複数プロジェクトを同時に扱うと DM 内のスレッドが混乱
- スレッド一覧から「どのプロジェクトのスレッドか」が視覚的に判別しにくい
- DM にはチャンネルトピックのような永続的メタ情報がない

### パターン2: 自動チャンネル作成（作業ディレクトリごと）

```
ユーザー ──コマンド──► Bot: /claude new /path/to/project
                        │
                        ├─ #claude-project-name チャンネルを自動作成
                        ├─ チャンネルトピックに作業ディレクトリを設定
                        └─ チャンネル内のメッセージ → そのディレクトリの Claude Code へ

チャンネル内:
  メッセージ → 新規セッション開始
  スレッド内返信 → セッション継続
```

| 観点 | 評価 |
|------|------|
| 実装複雑度 | **中〜高** — チャンネル作成・命名・アーカイブの自動化が必要 |
| UX | **優** — プロジェクトごとに明確に分離、直感的 |
| プロジェクト切り替え | **容易** — チャンネルを切り替えるだけ |
| 同時並行作業 | **容易** — 各チャンネルが独立 |
| セッション管理 | チャンネル + スレッド ts で一意に特定。非常に明快 |
| 他者との共有 | **可能** — チャンネルに招待すれば共有可能 |
| チャンネル数 | プロジェクト数に応じて増加（`channels:manage` スコープ必要） |

**長所:**
- プロジェクトとチャンネルの 1:1 対応が直感的
- チャンネルトピック・ブックマーク等で作業ディレクトリ情報を永続表示可能
- スレッド = セッションという対応が自然
- 将来的にチームメンバーとの共有が容易

**短所:**
- プロジェクトが多いとチャンネル一覧が肥大化
- チャンネル名のバリデーション（Slack の制約: 小文字英数字 + ハイフン、80文字以下）
- 不要になったチャンネルのアーカイブ運用が必要
- 無料プランだとチャンネル数に実質上限がある場合がある

### パターン3: ハイブリッド

```
DM（管理レイヤー）:
  ユーザー ──DM──► Bot
                   ├─ プロジェクト一覧表示
                   ├─ 新規プロジェクト登録
                   ├─ プロジェクト削除（チャンネルアーカイブ）
                   └─ 設定変更

作業チャンネル（実行レイヤー）:
  #claude-project-a ── Claude Code との実際のやり取り
  #claude-project-b ── Claude Code との実際のやり取り
```

| 観点 | 評価 |
|------|------|
| 実装複雑度 | **高** — パターン1 + パターン2 の両方を実装 |
| UX | **最良** — 管理と実行が明確に分離 |
| プロジェクト切り替え | **容易** — チャンネル切り替え |
| 同時並行作業 | **容易** — チャンネル独立 |
| セッション管理 | パターン2と同等 |
| 他者との共有 | **可能** |
| チャンネル数 | パターン2と同等 |

**長所:**
- 関心の分離（管理 vs 実行）が明確
- DM でプロジェクト全体の俯瞰が可能
- 作業チャンネルはクリーンに保たれる

**短所:**
- 実装量が最も多い
- 2つの UI パスのメンテナンスが必要
- 個人利用では管理レイヤーが過剰な可能性

### 総合比較

```
              実装複雑度    UX      同時並行    拡張性    MVP適性
パターン1(DM)    ★★★★      ★★★      ★★        ★★       ★★★★★
パターン2(自動CH) ★★★       ★★★★     ★★★★★     ★★★★     ★★★★
パターン3(ハイブリ) ★★        ★★★★★    ★★★★★     ★★★★★    ★★
```

### 推奨戦略

**MVP: パターン2（自動チャンネル作成）をベースにシンプル化**

理由:
1. 「チャンネル = プロジェクト」「スレッド = セッション」のメンタルモデルが最も自然
2. 実装複雑度がパターン1と大差ない（モーダル実装 vs チャンネル作成の差）
3. 同時並行作業が自然にサポートされる

ただし MVP 段階では自動チャンネル作成は不要。round1-bridge-architect.md の設計通り、環境変数で固定した1チャンネルから開始し、Phase 2 で自動チャンネル作成を追加する。

**将来: パターン3 への段階的移行**

Phase 2 以降で DM ベースの管理レイヤー（Home Tab 活用）を追加し、パターン3 に進化させる。

---

## 3. メッセージハンドリング設計

### 3.1 Slack のメッセージ制限

| 制限 | 値 | 対処 |
|------|-----|------|
| メッセージテキスト推奨長 | 4,000 文字 | 超過時は分割 |
| メッセージテキスト上限 | 40,000 文字 | 超過時はファイルアップロード |
| Block Kit text オブジェクト | 3,000 文字 | セクションブロックの分割 |
| ブロック数上限（メッセージ） | 50 ブロック | 超過時はファイルアップロード |
| ブロック数上限（モーダル/Home Tab） | 100 ブロック | ページネーション |
| ファイルアップロード（スニペット） | 1 MB | 通常十分 |

### 3.2 長文レスポンスの分割戦略

```typescript
function splitResponse(text: string): SlackOutput {
    const MAX_MESSAGE_LENGTH = 3900;  // 安全マージン込み
    const MAX_FILE_THRESHOLD = 39000; // ファイルアップロード閾値

    // 40,000文字超 → ファイルアップロード
    if (text.length > MAX_FILE_THRESHOLD) {
        return { type: 'file', content: text, filename: 'response.md' };
    }

    // 4,000文字以下 → そのまま投稿
    if (text.length <= MAX_MESSAGE_LENGTH) {
        return { type: 'single', messages: [text] };
    }

    // 4,000〜40,000文字 → 分割投稿
    return { type: 'multi', messages: splitAtBoundaries(text, MAX_MESSAGE_LENGTH) };
}
```

**分割の優先境界（上から優先）:**

1. **Markdown の見出し境界** (`## `, `### `)
2. **コードブロック境界** (` ``` ` の開始/終了)
3. **空行（パラグラフ境界）**
4. **文末（`. ` の後）**
5. **強制分割（上記すべてで分割できない場合、文字数で切断）**

**重要なルール:**
- コードブロックの途中で分割しない（開始 ` ``` ` と終了 ` ``` ` は同一メッセージ内に収める）
- 分割した場合、2番目以降のメッセージにはスレッド内返信として投稿（メインチャンネルを汚さない）

### 3.3 Claude Code 出力 → Slack mrkdwn 変換

Claude Code の出力は標準 Markdown だが、Slack の mrkdwn は独自記法であるため変換が必要。

| Markdown | Slack mrkdwn | 変換要否 |
|----------|-------------|---------|
| `**bold**` | `*bold*` | 要変換 |
| `*italic*` | `_italic_` | 要変換 |
| `~~strike~~` | `~strike~` | 要変換 |
| `` `code` `` | `` `code` `` | 変換不要 |
| ` ```code block``` ` | ` ```code block``` ` | 変換不要 |
| `[text](url)` | `<url\|text>` | 要変換 |
| `# Heading` | `*Heading*` (太字で代用) | 要変換 |
| `- item` | `• item` | 要変換（推奨） |
| `> quote` | `> quote` | 変換不要 |
| `---` | `───────` (装飾線) | 要変換 |

```typescript
function markdownToMrkdwn(md: string): string {
    let result = md;

    // 見出しを太字に変換（コードブロック外のみ）
    result = convertOutsideCodeBlocks(result, (text) => {
        text = text.replace(/^### (.+)$/gm, '*$1*');
        text = text.replace(/^## (.+)$/gm, '*$1*');
        text = text.replace(/^# (.+)$/gm, '*$1*');
        return text;
    });

    // 太字: **text** → *text*
    result = convertOutsideCodeBlocks(result, (text) =>
        text.replace(/\*\*(.+?)\*\*/g, '*$1*')
    );

    // イタリック: *text* → _text_ (太字変換後に実行)
    // 注意: 太字変換済みの *text* と衝突しないよう注意
    result = convertOutsideCodeBlocks(result, (text) =>
        text.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '_$1_')
    );

    // 取り消し線: ~~text~~ → ~text~
    result = convertOutsideCodeBlocks(result, (text) =>
        text.replace(/~~(.+?)~~/g, '~$1~')
    );

    // リンク: [text](url) → <url|text>
    result = convertOutsideCodeBlocks(result, (text) =>
        text.replace(/\[(.+?)\]\((.+?)\)/g, '<$2|$1>')
    );

    // リスト: - item → • item
    result = convertOutsideCodeBlocks(result, (text) =>
        text.replace(/^(\s*)- /gm, '$1• ')
    );

    // 水平線
    result = convertOutsideCodeBlocks(result, (text) =>
        text.replace(/^---+$/gm, '═══════════════════')
    );

    return result;
}
```

### 3.4 コードブロック・diff の表示

Slack のコードブロックは言語ハイライトをサポートしていない。Claude Code の diff 出力を見やすくするための工夫:

**方法1: mrkdwn コードブロック（デフォルト）**
```
    ```
    - removed line
    + added line
      unchanged line
    ```
```
シンプルだが、色分けなし。短い diff に適切。

**方法2: ファイルアップロード（推奨: 長い diff）**
```typescript
// diff が長い場合はファイルとしてアップロード
if (isDiff(output) && output.length > 2000) {
    await client.files_upload_v2({
        channel_id: channelId,
        thread_ts: threadTs,
        content: output,
        filename: 'changes.diff',
        title: 'コード変更差分',
    });
}
```

**方法3: Block Kit の rich_text ブロック**
```json
{
    "type": "rich_text",
    "elements": [{
        "type": "rich_text_preformatted",
        "elements": [{
            "type": "text",
            "text": "- removed\n+ added"
        }]
    }]
}
```

### 3.5 ファイル添付での出力

`files_upload_v2` を使用（旧 `files.upload` は 2025年3月に廃止済み）。

```typescript
async function uploadAsFile(
    client: WebClient,
    channelId: string,
    threadTs: string,
    content: string,
    options: { filename?: string; title?: string; comment?: string } = {}
): Promise<void> {
    await client.filesUploadV2({
        channel_id: channelId,
        thread_ts: threadTs,
        content,
        filename: options.filename ?? 'output.txt',
        title: options.title ?? 'Claude Code Output',
        initial_comment: options.comment ?? '',
    });
}
```

**ファイル出力が適切なケース:**
- 40,000 文字超の出力
- diff 出力が 2,000 文字超
- ファイル一覧（`ls -la` 等の長い出力）
- 生成されたコード全体

### 3.6 スレッドの活用方法

```
チャンネル（#claude-project-a）
│
├─ [メッセージ] 「認証機能を実装して」        ← セッション1 開始
│  ├─ [Bot] ⏳ 処理中...
│  ├─ [Bot] 認証機能を実装しました。...       ← セッション1 応答
│  ├─ [ユーザー] テストも追加して             ← セッション1 継続
│  └─ [Bot] テストを追加しました。...         ← セッション1 応答
│
├─ [メッセージ] 「README を更新して」         ← セッション2 開始（別スレッド）
│  └─ [Bot] README を更新しました。...        ← セッション2 応答
│
└─ [メッセージ] 「現在の git status は？」    ← セッション3 開始
   └─ [Bot] ...
```

**ルール:**
- チャンネル直下のメッセージ = 新規セッション開始
- スレッド内の返信 = 既存セッション継続（`--session-id` + `-r`）
- Bot の応答は常にスレッド内に投稿（`reply_broadcast: false`）
- 重要な結果のみ `reply_broadcast: true` でチャンネルにも表示（ユーザーが明示的に要求した場合）

---

## 4. スラッシュコマンド設計

### 4.1 問題の整理

Claude Code のスラッシュコマンド（`/commit`, `/review` 等）と Slack のスラッシュコマンド（`/` で始まるコマンド）は記法が衝突する。Slack でユーザーが `/commit` と入力すると、Slack がコマンドとして解釈してしまう。

### 4.2 案の比較

#### 案1: プレフィックス変更（テキストベースコマンド）

ユーザーがメッセージ内で特定プレフィックスを使用:

```
cc /commit          → Claude Code の /commit を実行
cc /review-pr 123   → Claude Code の /review-pr を実行
!commit             → 短縮形
::commit            → 別の記法
```

| 観点 | 評価 |
|------|------|
| 実装コスト | **低** — メッセージテキストをパースするだけ |
| UX | **中** — プレフィックスを覚える必要がある |
| 衝突回避 | **完全** — Slack コマンドとは無関係 |
| 補完・ヘルプ | **なし** — テキスト入力なので入力補完がない |
| 柔軟性 | **高** — 任意のコマンドを自由に追加可能 |

**推奨プレフィックス: `cc /`**

理由:
- `cc` = Claude Code の略で直感的
- `/` を含めることで Claude Code のコマンドとの対応が明確
- `!` や `::` は他のツールとの衝突リスクがある
- 例: `cc /commit -m "fix bug"`, `cc /review-pr 123`

#### 案2: Slack スラッシュコマンドとして登録

Bot の Slack App 設定で `/cc-commit`, `/cc-review` 等を登録:

```
/cc-commit          → Claude Code の /commit
/cc-review 123      → Claude Code の /review-pr
/cc-sessions        → セッション一覧
/cc-new /path       → 新規セッション
```

| 観点 | 評価 |
|------|------|
| 実装コスト | **中** — 各コマンドの登録 + ハンドラー実装が必要 |
| UX | **高** — Slack ネイティブの補完・ヘルプ表示が使える |
| 衝突回避 | **完全** — `cc-` プレフィックスで名前空間を分離 |
| 補完・ヘルプ | **あり** — `/cc-` と入力すると候補一覧が表示される |
| 柔軟性 | **低** — コマンド追加のたびに App 設定を変更する必要 |

**注意点:**
- Slack のスラッシュコマンドは名前空間がない（同名コマンドは後からインストールしたものが優先）
- コマンド数が多いと管理が煩雑
- Socket Mode では `/` コマンドも WebSocket 経由で受信可能

#### 案3: 特殊記法（メンション + コマンド）

```
@Claude commit      → Claude Code の /commit
@Claude review 123  → Claude Code の /review-pr
```

| 観点 | 評価 |
|------|------|
| 実装コスト | **低** — app_mention イベントのパース |
| UX | **高** — 自然言語に近い |
| 衝突回避 | **完全** — メンションベースなので衝突なし |
| 補完・ヘルプ | **なし** |
| 柔軟性 | **高** — コマンドもテキストも同じハンドラーで処理 |

**問題:** コマンドと通常の会話メッセージの区別が曖昧になる。「commit って何？」という質問なのか、commit コマンドなのか判別が困難。

### 4.3 推奨: 案1 + 案2 のハイブリッド

**MVP（案1: テキストベースコマンド）:**

```
cc /commit          → /commit を転送
cc /review-pr 123   → /review-pr を転送
cc /help            → 利用可能なコマンド一覧表示
```

実装:
```typescript
app.message(/^cc\s+\/(\S+)(.*)$/i, async ({ message, context, say }) => {
    const command = context.matches[1];   // "commit"
    const args = context.matches[2].trim(); // "-m 'fix bug'"

    // Claude Code のスラッシュコマンドとして実行
    // claude -p の入力として "/" + command + args を渡す
    const prompt = `/${command} ${args}`;
    await executeClaudeCommand(message, prompt);
});
```

**Phase 2（案2: Slack スラッシュコマンドを追加）:**

管理系コマンドのみ Slack スラッシュコマンドとして登録:

| Slack コマンド | 用途 | 対応する Claude Code コマンド |
|--------------|------|---------------------------|
| `/cc` | メインコマンド（サブコマンド形式） | — |
| `/cc new <dir>` | 新規プロジェクトチャンネル作成 | — |
| `/cc sessions` | セッション一覧 | — |
| `/cc status` | Bot のステータス確認 | — |
| `/cc help` | ヘルプ表示 | — |

Claude Code 固有のコマンド（`/commit`, `/review` 等）はテキストベース（`cc /commit`）のまま維持。理由:
- Claude Code のコマンドは頻繁に追加・変更される可能性がある
- Slack App 設定の変更なしに対応可能
- コマンドの引数がそのまま Claude Code に渡される（変換不要）

### 4.4 コマンド一覧（想定）

```
■ ブリッジ管理コマンド（Slack スラッシュコマンド）
/cc new <directory>      プロジェクトチャンネルの新規作成
/cc sessions             現在のセッション一覧
/cc status               Bot ステータス表示
/cc help                 ヘルプ表示
/cc config <key> <value> 設定変更

■ Claude Code コマンド（テキストベース: cc /xxx）
cc /commit               変更をコミット
cc /review-pr <number>   PR レビュー
cc /init                 CLAUDE.md の初期化
cc /clear                セッションのクリア
cc /help                 Claude Code のヘルプ
cc /<any>                任意の Claude Code コマンド
```

---

## 5. インタラクティブ UI 設計

### 5.1 Block Kit 活用設計

#### 作業ディレクトリ選択（プロジェクト登録時）

```json
{
    "blocks": [
        {
            "type": "section",
            "text": {
                "type": "mrkdwn",
                "text": "新しいプロジェクトを登録します"
            }
        },
        {
            "type": "input",
            "block_id": "workdir_input",
            "element": {
                "type": "plain_text_input",
                "action_id": "workdir_path",
                "placeholder": {
                    "type": "plain_text",
                    "text": "/Users/you/dev/project-name"
                }
            },
            "label": {
                "type": "plain_text",
                "text": "作業ディレクトリ"
            }
        },
        {
            "type": "input",
            "block_id": "channel_name_input",
            "element": {
                "type": "plain_text_input",
                "action_id": "channel_name",
                "placeholder": {
                    "type": "plain_text",
                    "text": "project-name（空欄の場合はディレクトリ名を使用）"
                }
            },
            "label": {
                "type": "plain_text",
                "text": "チャンネル名"
            },
            "optional": true
        }
    ]
}
```

#### セッション一覧表示

```json
{
    "blocks": [
        {
            "type": "header",
            "text": {
                "type": "plain_text",
                "text": "アクティブセッション"
            }
        },
        {
            "type": "divider"
        },
        {
            "type": "section",
            "text": {
                "type": "mrkdwn",
                "text": "*#claude-myproject*\nセッション: `abc123`\n最終アクティブ: 5分前\nディレクトリ: `/Users/user/dev/myproject`"
            },
            "accessory": {
                "type": "button",
                "text": {
                    "type": "plain_text",
                    "text": "スレッドを開く"
                },
                "url": "https://workspace.slack.com/archives/C123/p456",
                "action_id": "open_session_thread"
            }
        },
        {
            "type": "section",
            "text": {
                "type": "mrkdwn",
                "text": "*#claude-webapp*\nセッション: `def456`\n最終アクティブ: 2時間前\nディレクトリ: `/Users/user/dev/webapp`"
            },
            "accessory": {
                "type": "overflow",
                "action_id": "session_actions",
                "options": [
                    {
                        "text": { "type": "plain_text", "text": "スレッドを開く" },
                        "value": "open_def456"
                    },
                    {
                        "text": { "type": "plain_text", "text": "セッション終了" },
                        "value": "end_def456"
                    }
                ]
            }
        }
    ]
}
```

#### 確認ダイアログ（destructive operations 用）

`cc /commit` や破壊的操作の実行前に確認を挟む:

```json
{
    "blocks": [
        {
            "type": "section",
            "text": {
                "type": "mrkdwn",
                "text": "以下の変更をコミットしますか？\n```\nM  src/auth.ts\nM  src/auth.test.ts\nA  src/middleware/jwt.ts\n```"
            }
        },
        {
            "type": "actions",
            "elements": [
                {
                    "type": "button",
                    "text": { "type": "plain_text", "text": "コミットする" },
                    "style": "primary",
                    "action_id": "confirm_commit",
                    "value": "session_abc123"
                },
                {
                    "type": "button",
                    "text": { "type": "plain_text", "text": "キャンセル" },
                    "style": "danger",
                    "action_id": "cancel_commit",
                    "value": "session_abc123"
                }
            ]
        }
    ]
}
```

**確認ダイアログを表示すべき操作:**
- `cc /commit` — コミット内容の確認
- ファイル削除を伴う操作
- `git push` を伴う操作
- 大規模なファイル変更（10ファイル以上の変更等）

### 5.2 処理中インジケーター

```typescript
// Phase 1: リアクション（MVP）
await client.reactions.add({
    channel: channelId,
    timestamp: messageTs,
    name: 'hourglass_flowing_sand',  // ⏳
});

// Phase 2: ステータスメッセージ（進捗表示）
const statusMsg = await client.chat.postMessage({
    channel: channelId,
    thread_ts: messageTs,
    text: '処理中...',
    blocks: [{
        type: 'context',
        elements: [{
            type: 'mrkdwn',
            text: ':hourglass_flowing_sand: 処理中... (経過時間: 0秒)'
        }]
    }]
});

// 定期的に更新（5秒ごと）
const interval = setInterval(async () => {
    elapsed += 5;
    await client.chat.update({
        channel: channelId,
        ts: statusMsg.ts,
        text: `処理中... (${elapsed}秒)`,
        blocks: [{
            type: 'context',
            elements: [{
                type: 'mrkdwn',
                text: `:hourglass_flowing_sand: 処理中... (経過時間: ${elapsed}秒)`
            }]
        }]
    });
}, 5000);

// 完了後
clearInterval(interval);
await client.reactions.remove({ channel: channelId, timestamp: messageTs, name: 'hourglass_flowing_sand' });
await client.reactions.add({ channel: channelId, timestamp: messageTs, name: 'white_check_mark' });
await client.chat.delete({ channel: channelId, ts: statusMsg.ts });
```

### 5.3 Home Tab の活用

Home Tab は Bot の「ダッシュボード」として最適。`app_home_opened` イベントで表示を更新する。

```typescript
app.event('app_home_opened', async ({ event, client }) => {
    if (event.tab !== 'home') return;

    const sessions = await sessionManager.listActiveSessions();
    const projects = await projectManager.listProjects();

    await client.views.publish({
        user_id: event.user,
        view: {
            type: 'home',
            blocks: [
                // ヘッダー
                {
                    type: 'header',
                    text: { type: 'plain_text', text: 'Claude Code Bridge' }
                },
                {
                    type: 'context',
                    elements: [{
                        type: 'mrkdwn',
                        text: `:large_green_circle: Bot 稼働中 | セッション数: ${sessions.length}`
                    }]
                },
                { type: 'divider' },

                // プロジェクト一覧
                {
                    type: 'section',
                    text: { type: 'mrkdwn', text: '*登録プロジェクト*' }
                },
                ...projects.map(p => ({
                    type: 'section',
                    text: {
                        type: 'mrkdwn',
                        text: `*${p.name}*\n\`${p.directory}\`\nチャンネル: <#${p.channelId}>`
                    },
                    accessory: {
                        type: 'button',
                        text: { type: 'plain_text', text: 'チャンネルを開く' },
                        url: `slack://channel?team=${event.view.team_id}&id=${p.channelId}`
                    }
                })),
                { type: 'divider' },

                // アクション
                {
                    type: 'actions',
                    elements: [
                        {
                            type: 'button',
                            text: { type: 'plain_text', text: '新規プロジェクト登録' },
                            style: 'primary',
                            action_id: 'register_project'
                        },
                        {
                            type: 'button',
                            text: { type: 'plain_text', text: 'セッション一覧' },
                            action_id: 'list_sessions'
                        }
                    ]
                },
                { type: 'divider' },

                // 最近のアクティビティ
                {
                    type: 'section',
                    text: { type: 'mrkdwn', text: '*最近のアクティビティ*' }
                },
                ...sessions.slice(0, 5).map(s => ({
                    type: 'context',
                    elements: [{
                        type: 'mrkdwn',
                        text: `${s.status === 'active' ? ':large_green_circle:' : ':white_circle:'} ` +
                              `<#${s.channelId}> | セッション \`${s.sessionId.slice(0, 8)}\` | ${s.lastActiveAt}`
                    }]
                }))
            ]
        }
    });
});
```

**Home Tab に表示する情報:**
- Bot のステータス（稼働中/停止中）
- 登録プロジェクト一覧（チャンネルへのリンク付き）
- アクティブセッション数
- 最近のアクティビティ
- 「新規プロジェクト登録」ボタン
- 設定項目（タイムアウト時間、デフォルト挙動等）

---

## 6. 推奨アーキテクチャ

### 全体構成

```
┌──────────────────────────────────────────────────────────────┐
│                     Slack Workspace                          │
│                                                              │
│  ┌─────────────┐  ┌──────────────────┐  ┌───────────────┐  │
│  │  Home Tab    │  │ #claude-project-a │  │ DM with Bot   │  │
│  │ (ダッシュボード)│  │ (作業チャンネル)   │  │ (将来: 管理用) │  │
│  └──────┬──────┘  └────────┬─────────┘  └───────┬───────┘  │
│         │                  │                     │          │
└─────────┼──────────────────┼─────────────────────┼──────────┘
          │                  │                     │
          └──────────────────┼─────────────────────┘
                             │ WebSocket (Socket Mode)
                             ▼
┌──────────────────────────────────────────────────────────────┐
│                  Slack Bot Server (TypeScript)                │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  Bolt App (Socket Mode)                                │  │
│  │                                                        │  │
│  │  ┌──────────────┐  ┌──────────────┐  ┌─────────────┐  │  │
│  │  │ Event Handler │  │ Command      │  │ Interactive │  │  │
│  │  │              │  │ Handler      │  │ Handler     │  │  │
│  │  │ message      │  │ /cc new      │  │ buttons     │  │  │
│  │  │ app_mention  │  │ /cc sessions │  │ modals      │  │  │
│  │  │ app_home     │  │ /cc status   │  │ confirmations│ │  │
│  │  └──────┬───────┘  └──────┬───────┘  └──────┬──────┘  │  │
│  │         └─────────────────┼─────────────────┘         │  │
│  └───────────────────────────┼────────────────────────────┘  │
│                              ▼                               │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  Message Router                                        │  │
│  │                                                        │  │
│  │  ┌─────────────────┐  ┌──────────────────────────────┐│  │
│  │  │ Command Parser  │  │ mrkdwn Formatter             ││  │
│  │  │ "cc /xxx" 検出   │  │ Markdown → Slack mrkdwn      ││  │
│  │  │ 通常テキスト判別  │  │ 長文分割                      ││  │
│  │  └────────┬────────┘  │ ファイルアップロード判定        ││  │
│  │           │           └──────────────────────────────┘│  │
│  └───────────┼───────────────────────────────────────────┘  │
│              ▼                                               │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  Bridge Core（round1-bridge-architect.md の設計）       │  │
│  │                                                        │  │
│  │  Session Manager → Queue → Executor (claude -p)        │  │
│  └────────────────────────────────────────────────────────┘  │
│                              │                               │
│  ┌───────────────────────────▼────────────────────────────┐  │
│  │  State Store (SQLite)                                  │  │
│  │  channel_workdir | thread_session | active_process     │  │
│  └────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘
```

### 設計原則

1. **関心の分離** — Slack 層（イベント受信・UI 構築）とブリッジ層（Claude Code 実行）を明確に分離
2. **段階的拡張** — MVP はシンプルなメッセージ → 応答のみ。UI 要素は Phase 2 以降で追加
3. **非同期ファースト** — すべての Claude Code 実行は非同期。即時 ack + 非同期処理 + 結果投稿
4. **フォールバック** — Block Kit が使えない場面（古いクライアント等）ではプレーンテキストにフォールバック

---

## 7. 実装の優先順位（MVP → フル機能）

### Phase 1: MVP（推定 2〜3 日）

round1-bridge-architect.md の MVP スコープに Slack 固有の最小実装を追加。

| 項目 | 詳細 |
|------|------|
| Slack Bolt (Socket Mode) セットアップ | `App({ socketMode: true })` の初期化 |
| 単一チャンネルでの動作 | 環境変数で指定した1チャンネルのみ |
| メッセージ受信 → claude -p → 返信 | 基本フロー |
| スレッド = セッション | `thread_ts` → `session_id` マッピング |
| 処理中リアクション | ⏳ → ✅ |
| 基本エラー通知 | エラー時にスレッドに通知 |
| OAuth スコープ | `chat:write`, `channels:history`, `channels:read`, `reactions:write`, `files:write`, `files:read` |

**この段階で動かないもの:** スラッシュコマンド、Block Kit UI、長文分割、Home Tab、複数チャンネル

### Phase 2: 実用拡張（推定 3〜4 日）

| 項目 | 詳細 |
|------|------|
| `cc /xxx` テキストコマンド | メッセージパターンマッチでコマンド検出・転送 |
| Markdown → mrkdwn 変換 | `markdownToMrkdwn()` 関数 |
| 長文分割・ファイルアップロード | 4,000文字超の分割、40,000文字超のファイル化 |
| `/cc` スラッシュコマンド | `/cc new`, `/cc sessions`, `/cc status` |
| 複数チャンネル対応 | `channels:manage` でチャンネル自動作成 |
| セッション一覧 | Block Kit でリッチ表示 |

### Phase 3: リッチ UI（推定 2〜3 日）

| 項目 | 詳細 |
|------|------|
| Home Tab | ダッシュボード表示（プロジェクト一覧、アクティビティ） |
| 確認ダイアログ | 破壊的操作の実行前確認 |
| 処理中プログレス | 経過時間表示の定期更新 |
| モーダル | プロジェクト登録フォーム |
| オーバーフローメニュー | セッション操作（終了、リセット等） |

### Phase 4: 高度な機能（推定 3〜5 日）

| 項目 | 詳細 |
|------|------|
| DM 管理レイヤー（パターン3化） | DM でプロジェクト管理、チャンネルで実行 |
| AI ストリーミング | Slack の chat streaming API で逐次表示（2025/10 新機能） |
| ファイル添付対応 | ユーザーが Slack にアップロードしたファイルを Claude Code に渡す |
| リアクション操作 | 特定の絵文字でアクション実行（例: 🔄 でリトライ） |
| ショートカット | グローバル/メッセージショートカットの登録 |

### 各 Phase の依存関係

```
Phase 1 (MVP)
    │
    ├── Phase 2 (実用拡張)
    │       │
    │       ├── Phase 3 (リッチ UI)
    │       │       │
    │       │       └── Phase 4 (高度な機能)
    │       │
    │       └── Phase 4 の一部（ファイル添付等）は Phase 2 完了後に着手可能
    │
    └── Phase 2 の一部（mrkdwn 変換等）は Phase 1 完了後すぐに着手可能
```

### クイックスタート手順（MVP）

```bash
# 1. Slack App 作成
#    https://api.slack.com/apps → Create New App → From scratch
#    App Name: "Claude Code Bridge"

# 2. Socket Mode 有効化
#    Settings → Socket Mode → Enable
#    App-Level Token を生成（connections:write スコープ）

# 3. Bot Token Scopes 設定
#    OAuth & Permissions → Bot Token Scopes:
#    chat:write, channels:history, channels:read,
#    reactions:write, files:write, files:read, app_mentions:read

# 4. Event Subscriptions 有効化
#    Event Subscriptions → Enable Events
#    Subscribe to bot events: message.channels, app_mention

# 5. App をワークスペースにインストール
#    Install App → Install to Workspace
#    Bot User OAuth Token (xoxb-...) を控える

# 6. 環境変数設定
cp .env.example .env
# SLACK_BOT_TOKEN=xoxb-...
# SLACK_APP_TOKEN=xapp-...
# DEFAULT_WORKING_DIRECTORY=/path/to/project

# 7. 起動
npm install && npm run dev
```

---

## 参考リンク

- [Comparing HTTP & Socket Mode - Slack Developer Docs](https://docs.slack.dev/apis/events-api/comparing-http-socket-mode/)
- [Using Socket Mode - Slack Developer Docs](https://docs.slack.dev/apis/events-api/using-socket-mode/)
- [Permission scopes - Slack](https://api.slack.com/scopes)
- [Block Kit - Slack Developer Docs](https://docs.slack.dev/block-kit/)
- [Modals - Slack Developer Docs](https://docs.slack.dev/surfaces/modals/)
- [App Home - Slack Developer Docs](https://docs.slack.dev/surfaces/app-home/)
- [Implementing slash commands - Slack Developer Docs](https://docs.slack.dev/interactivity/implementing-slash-commands/)
- [Formatting message text - Slack Developer Docs](https://docs.slack.dev/messaging/formatting-message-text/)
- [Working with files - Slack Developer Docs](https://docs.slack.dev/messaging/working-with-files/)
- [Section block (3000 char limit) - Slack Developer Docs](https://docs.slack.dev/reference/block-kit/blocks/section-block/)
- [AI in Slack apps - Slack Developer Docs](https://docs.slack.dev/ai/)
- [Chat streaming for AI responses (2025/10)](https://docs.slack.dev/changelog/2025/10/7/chat-streaming/)
- [Select menu element - Slack Developer Docs](https://docs.slack.dev/reference/block-kit/block-elements/select-menu-element/)
