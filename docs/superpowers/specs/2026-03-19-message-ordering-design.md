# メッセージ順序整列設計

## 概要

Claude CLIからのストリーミングイベントをSlackスレッドに表示する際、複数ラウンドにまたがるタスクでメッセージの表示順序が崩れる問題を解決する。

## 問題

### 根本原因

1. **テキストが全ラウンドで1メッセージに集約される** — `textMessageTs`がresult eventまでリセットされないため、後のラウンドのテキストが前のbundleより上に表示される
2. **bundleの境界がテキストの長さ（100文字）で決まる** — 論理的なラウンド区切りではなく内容依存
3. **並列subagentのトラッキングが単一activeGroupのみ** — 2つ目のsubagent起動時に1つ目の追跡が破綻

### 症状

```
理想:  [bundle-1] [text-1] [bundle-2] [text-2] [bundle-3] [text-3]
現状:  [bundle-1] [text-ALL] [bundle-2] [bundle-3]
       ※text-ALLに全ラウンドのテキストが集約され、bundle-2,3より上に位置固定
```

## 設計

### 1. テキスト到着 = ラウンド境界

テキストイベントが来たら即座にbundle collapseしてテキストメッセージを新規作成する。100文字バッファリングは廃止。

**処理フロー:**

```
テキストイベント到着:
  1. activeGroupがあれば → completedGroupsに移動
  2. activeBundleがあり、collapse可能なら → collapse (updateで折りたたみ表示に)
  3. テキストを新規postMessage
```

### 2. textMessageTsのラウンドスコープ化

`textMessageTs`を次のbundle開始時にリセットする。これにより各ラウンドのテキストが独立したSlackメッセージになる。

**リセットタイミング:**

- 新しいthinking/tool_use/subagent_startが来た時点
- （result eventでのリセットは従来通り維持）

**テキストストリーミング中の挙動:**

```
text chunk 1 → Msg2 postMessage (textMessageTs = Msg2)
text chunk 2 → Msg2 update
text chunk 3 → Msg2 update
thinking     → textMessageTs リセット、新bundle開始
text chunk 4 → Msg3 postMessage (textMessageTs = Msg3)
```

### 3. 並列Subagentのトラッキング

subagentのみMapベースで複数同時追跡する。thinking/toolは従来通り単一activeGroup。

**データ構造:**

```typescript
// 変更前
private activeGroup: ActiveGroup | null = null;

// 変更後
private activeGroup: ActiveGroup | null = null;         // thinking/tool用
private activeSubagents: Map<string, ActiveGroup> = new Map(); // agentToolUseId → ActiveGroup
```

**イベント振り分け:**

| イベント | 処理 |
|---------|------|
| `handleSubagentStart(toolUseId)` | `activeSubagents.set(toolUseId, 新Group)` |
| `handleSubagentStep(parentToolUseId)` | `activeSubagents.get(parentToolUseId)` から更新 |
| `handleSubagentComplete(toolUseId)` | completedに移動、`activeSubagents.delete(toolUseId)` |

**bundle内表示（live状態）:**

```
[Bundle]
  🤖 SubAgent: コードベース調査 (🔄 実行中)
     ✅ Glob  ✅ Read  🔄 Grep
  🤖 SubAgent: テスト実行 (🔄 実行中)
     🔄 Bash npm test
```

### 4. Bundleライフサイクル

**状態遷移:**

```
[bundleなし]
  → thinking/tool_use/subagent_start → [bundle生成 + postMessage]

[bundle live]
  → 同カテゴリのイベント → update（デバウンス500ms）
  → 異カテゴリのイベント → activeGroup切替、update
  → subagent start → activeSubagentsに追加、update
  → subagent complete → activeSubagentsから削除、update
  → テキスト到着 → collapse判定へ

[collapse判定]
  条件: activeGroup === null && activeSubagents.size === 0
  → YES: collapse, textMessageTsリセット, テキストpostMessage
  → NO (subagent実行中): テキストをバッファ、subagent全完了後にcollapse + postMessage
```

**テキストとbundleの交互パターン:**

```
Case 1: subagent実行中にテキスト
  → テキストはバッファ
  → 全subagent完了時にbundle collapse + テキストpostMessage

Case 2: 全完了済みでテキスト
  → 即座にbundle collapse + テキストpostMessage

Case 3: テキスト途中でthinking/toolが来た
  → 現在のテキストメッセージをfinalize（「応答中...」インジケータ除去）
  → textMessageTsリセット
  → 新bundle開始
```

### 5. API使用量の見積もり

| シナリオ | 現状 | 変更後 | レートリミット(20/60s) |
|---------|------|--------|----------------------|
| 3ラウンド | 5 postMessage | 7 postMessage | 余裕 |
| 10ラウンド | 12 postMessage | 21 postMessage | ぎりぎりだがラウンド間隔で問題なし |

## 変更対象ファイル

| ファイル | 変更内容 |
|---------|---------|
| `src/streaming/stream-processor.ts` | 100文字バッファ廃止、テキスト到着時のcollapse + postMessage、textMessageTsリセットタイミング変更 |
| `src/streaming/group-tracker.ts` | activeSubagents Map追加、collapse条件変更（subagent考慮）、テキストバッファリング（subagent中） |
| `src/streaming/types.ts` | ActiveGroupの型にsubagent Map対応を追加（必要に応じて） |
| `src/streaming/tool-formatter.ts` | 並列subagentのliveブロック表示対応 |
| `src/streaming/session-jsonl-reader.ts` | ラウンド分割に合わせたbundle読み取りロジック調整 |
| `src/index.ts` | textMessageTsリセットの呼び出し追加 |
