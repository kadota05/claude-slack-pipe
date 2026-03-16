# ActionBundle設計: text間アクションの1メッセージ統合

## 概要

現在、thinking / tool / subagent がカテゴリごとに別メッセージとしてSlackスレッドに投稿されている。これをtext間のアクションすべてを1つのメッセージにまとめる「ActionBundle」として統合する。

### Before

```
Claude出力: thinking → tool(Read) → tool(Bash) → text("結果は...") → thinking → tool(Grep) → text("見つかりました")

Slackスレッド:
├─ メッセージ1: 💭 thinking (collapsed)
├─ メッセージ2: 🔧 Read, Bash 完了 (collapsed)
├─ メッセージ3: 💬 "結果は..."
├─ メッセージ4: 💭 thinking (collapsed)
├─ メッセージ5: 🔧 Grep 完了 (collapsed)
└─ メッセージ6: 💬 "見つかりました"
→ 合計6メッセージ
```

### After

```
Slackスレッド:
├─ メッセージ1: 💭×1 🔧×2 (0.7s)  [詳細を見る]
├─ メッセージ2: 💬 "結果は..."
├─ メッセージ3: 💭×1 🔧×1 (0.3s)  [詳細を見る]
└─ メッセージ4: 💬 "見つかりました"
→ 合計4メッセージ
```

## データモデル

### ActionBundle

GroupTracker上に追加するレイヤー。text間のグループ群を1つのバンドルとしてまとめる。

```typescript
interface ActionBundle {
  id: string;                       // bundle-1, bundle-2, ...
  index: number;                    // 0-indexed、JSONLスキャン用。GroupTrackerが内部カウンタで採番する。
  messageTs: string | null;         // Slack postMessageで取得
  completedGroups: CompletedGroup[]; // 完了済みグループ（時系列順）
  activeGroup: ActiveGroup | null;  // 現在ライブのグループ（1つだけ）。既存のActiveGroup型をそのまま使う。
}

// CompletedGroupはActiveGroupから変換して作成する。
// activeGroupがcompletedGroupsに移動する際、ActiveGroupのフィールドから以下のようにマッピングする:
//   ActiveGroup.thinkingTexts → CompletedGroup.thinkingTexts
//   ActiveGroup.tools         → CompletedGroup.tools, totalDuration
//   ActiveGroup.agentToolUseId, agentDescription, agentId, agentSteps → CompletedGroup の各subagentフィールド
interface CompletedGroup {
  category: 'thinking' | 'tool' | 'subagent';
  // thinking用
  thinkingTexts?: string[];
  // tool用
  tools?: ToolEntry[];
  totalDuration?: number;
  // subagent用
  agentDescription?: string;
  agentId?: string;
  agentSteps?: AgentStep[];
  duration?: number;
}
```

- バンドルは1つのmessageTsを持ち、カテゴリが切り替わってもメッセージは同じ
- `completedGroups` はcollapse時のカテゴリ集約に使う（ライブ中はインメモリ保持のみ、バンドル確定後は不要）
- `activeGroup` は既存のActiveGroupをそのまま流用
- textが来たらバンドルが確定し、次のtext間アクション用に新バンドルが始まる
- `index` はGroupTrackerの内部カウンタで管理。text到着でバンドル確定するたびにインクリメント

## ライブ表示の更新フロー

```
1. 最初のイベント(例: thinking)到着
   → activeGroup = new ThinkingGroup
   → postMessage(thinkingライブブロック)
   → messageTs取得

2. 同カテゴリのイベント(例: thinking続き)
   → activeGroupを更新
   → chat.update(thinkingライブブロック) ※500msデバウンス

3. カテゴリ切り替え(例: thinking → tool)
   → activeGroupをcompletedGroupsに移動
   → activeGroup = new ToolGroup
   → chat.update(toolライブブロック) ※前カテゴリの表示は消えて単純差し替え
     （意図的な設計判断: ライブ中は最新カテゴリのみ表示。過去のカテゴリはバンドル確定後にモーダルで確認可能）

4. さらにカテゴリ切り替え(例: tool → subagent)
   → activeGroupをcompletedGroupsに移動
   → activeGroup = new SubagentGroup
   → chat.update(subagentライブブロック)

5. text到着
   → activeGroupをcompletedGroupsに移動
   → activeGroup = null
   → chat.update(collapsedブロック) ← バンドル確定
   → 新バンドル開始
```

chat.updateの中身はライブ中は常にactiveGroupのブロックだけ。completedGroupsはライブ中は表示されない。

## collapsedブロック

バンドル確定時、completedGroupsからカテゴリ別にカウントを集計する。

```
completedGroups: [thinking, tool, tool, subagent, thinking, tool]
                       ↓ 集計
                  💭×2  🔧×3 (1.0s)  🤖×1 (3.0s)
```

### Slackブロック構成

```
context block:  💭×2  🔧×3 (1.0s)  🤖×1 (3.0s)
actions block:  [詳細を見る]  action_id: view_bundle:{sessionId}:{bundleIndex}
```

### 集約ルール

- 💭: 出現回数のみ（時間は表示しない）
- 🔧: 出現回数 + 全toolの合計所要時間
- 🤖: 出現回数 + 全subagentの合計所要時間
- 出現したカテゴリだけ表示
- 表示順序は 💭 → 🔧 → 🤖 の固定順（見た目の一貫性のため）

## モーダル2階層構造

### 第1階層: バンドル詳細モーダル（時系列一覧）

`view_bundle:{sessionId}:{bundleIndex}` クリック時にSessionJsonlReaderでJSONLをスキャンして構築。

新しいBoltハンドラ `app.action(/^view_bundle:/)` を登録する。

```
┌─ バンドル詳細 ──────────────────────────────────────────┐
│ 💭 思考                                                  │
│ 「ファイル構成を確認して...」(冒頭50文字程度)               │
│ ─────────────────────────────────────────────────        │
│ 🔧 Read src/auth.ts (0.2s)              [詳細を見る]     │
│ ─────────────────────────────────────────────────        │
│ 🔧 Bash ls (0.5s)                       [詳細を見る]     │
│ ─────────────────────────────────────────────────        │
│ 🤖 SubAgent "コード探索" (3.0s)          [詳細を見る]     │
│ ─────────────────────────────────────────────────        │
│ 💭 思考                                                  │
│ 「次はGrepで検索して...」(冒頭50文字程度)                  │
│ ─────────────────────────────────────────────────        │
│ 🔧 Grep "pattern" (0.3s)                [詳細を見る]     │
└─────────────────────────────────────────────────────────┘
```

表示ルール:
- 💭 thinking: テキスト冒頭を直接表示。詳細ボタンなし
- 🔧 tool: ワンライナー + 所要時間 + 詳細ボタン（action_id: `view_tool_detail:{sessionId}:{toolUseId}`）
- 🤖 subagent: description + 所要時間 + 詳細ボタン（action_id: `view_subagent_detail:{sessionId}:{toolUseId}`）

#### モーダル構築関数

```typescript
// modal-builder.ts に追加
buildBundleDetailModal(entries: BundleEntry[], sessionId: string): ModalView

// BundleEntry[] を走査し、各エントリに対して:
//   thinking → section block (テキスト冒頭50文字 + divider)
//   tool     → section block (ワンライナー + 時間) + button accessory
//   subagent → section block (description + 時間) + button accessory
```

### 第2階層: 既存モーダルを流用

- tool [詳細を見る] → SessionJsonlReader.readToolDetail() で取得 → 既存の tool詳細モーダル (input/output全文)
- subagent [詳細を見る] → SessionJsonlReader経由 → 既存の SubAgentモーダル (JSONL会話フロー)

第2階層のボタンは `view_tool_detail:{sessionId}:{toolUseId}` / `view_subagent_detail:{sessionId}:{toolUseId}` を使い、既存の `view_group_detail:{groupId}` とは別のハンドラとして登録する。

## データソース: 完全JSONL駆動

インメモリキャッシュは使わない。全てSessionJsonlReaderでJSONLファイルからオンデマンド読み取り。

### レイテンシ

- JSONLスキャン: ~5-50ms（最大2.8MB / 856行）
- Slack views.open: ~200-500ms（ボトルネック）
- 体感差なし

### メリット

- プロセス再起動してもモーダルが動作する
- メモリを消費しない
- JSONLファイルが残っている限り過去セッションも閲覧可能

### バンドル範囲の特定

action_idに `sessionId` と `bundleIndex` を埋め込む。

```
JSONL内のassistantメッセージにはtextブロックが含まれる。
textの出現順(0-indexed)でバンドルを特定する。

例:
  [thinking] [tool Read] [tool Bash] [text] [thinking] [tool Grep] [text]
       ↑ バンドル0 (text#0の前)              ↑ バンドル1 (text#0〜#1の間)

action_id: view_bundle:{sessionId}:{bundleIndex}
```

### SessionJsonlReader拡張

```typescript
readBundle(sessionId: string, bundleIndex: number): Promise<BundleEntry[]>

BundleEntry =
  | { type: 'thinking'; texts: string[] }
  | { type: 'tool'; toolUseId: string; toolName: string; oneLiner: string; durationMs: number }
  | { type: 'subagent'; toolUseId: string; description: string; agentId: string; durationMs: number }
```

スキャンロジック:
1. JSONLを先頭からスキャン
2. textブロックの出現をカウント
3. bundleIndex番目のtext前の非textイベント群を収集
4. subagentの判別: tool_useのnameが `Agent` の場合はsubagentとして扱う。
   subagentの子ツール（parent_tool_use_id付き）はsubagentエントリ内に含め、
   トップレベルのBundleEntryとしては出さない。
5. thinking内テキストの粒度: JSONL内のthinkingブロック1つ = texts配列の1要素。
   連続するthinkingブロック（カテゴリ切り替えなし）は1つのBundleEntry(type:'thinking')にまとめる。
6. 収集したイベント群を時系列順で返す

## GroupActionの変更

```
現在: { type: 'postMessage' | 'update' | 'collapse', groupId, blocks }
変更: { type: 'postMessage' | 'update' | 'collapse', bundleId, blocks }

postMessage: バンドル内の最初のイベント時
update:      ライブ更新 + カテゴリ切り替え時
collapse:    text到着 or ストリーム終了時（バンドル確定）
```

index.ts側の変更は最小限。`groupId` → `bundleId` に変わるだけで、SerialActionQueueのpostMessage → ts登録 → updateの流れは同じ。

## 既存コードからの移行

### 廃止するもの

- `view_group_detail:{groupId}` ハンドラ → `view_bundle:{sessionId}:{bundleIndex}` に置き換え
- `ToolResultCache` のグループデータキャッシュ (`setGroupData`/`getGroupData`) → JSONLスキャンに置き換え
- `ToolResultCache` のツール結果キャッシュ (`setToolResult`/`getToolResult`) → `SessionJsonlReader.readToolDetail` に置き換え
- GroupTrackerの既存の `completedGroups: Map` → ActionBundle内の `completedGroups: CompletedGroup[]` に置き換え

### 新規追加するもの

- `app.action(/^view_bundle:/)` ハンドラ（第1階層モーダル）
- `app.action(/^view_tool_detail:/)` ハンドラ（第2階層: ツール詳細）
- `app.action(/^view_subagent_detail:/)` ハンドラ（第2階層: SubAgent詳細）
- `SessionJsonlReader.readBundle()` メソッド
- `modal-builder.ts` の `buildBundleDetailModal()` 関数
- GroupTracker内のActionBundleライフサイクル管理
