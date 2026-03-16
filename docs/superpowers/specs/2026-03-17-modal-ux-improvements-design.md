# モーダルUX改善 設計ドキュメント

## 概要

モバイルSlackでのモーダル表示のバランス改善、思考詳細の第二層モーダル追加、BundleDetailモーダルのボタンUI改善、✅リアクションの永続化、🔴中断のactiveMessageTsベース化を行う。

## 変更1: 全モーダルのbody内headerブロック削除

### 背景

現在、全モーダルでSlackが自動表示する`title`フィールドと、body内の`header`ブロックが重複している。モバイルでは特にバランスが悪い。

### 対象

`src/slack/modal-builder.ts`の以下5関数:

| 関数 | titleフィールド | 削除対象のbody header |
|---|---|---|
| `buildToolModal` | `"${toolName} 詳細"` | `config.toolName` |
| `buildThinkingModal` | `"思考詳細"` | `"思考詳細"` |
| `buildToolGroupModal` | `"ツール実行詳細"` | `"ツール実行詳細"` |
| `buildSubagentModal` | `"SubAgent詳細"` | `"SubAgent: ${description}"` |
| `buildBundleDetailModal` | `"アクション詳細"` | `"アクション詳細"` |

### 変更内容

- 各関数のblocks配列から最初の`{ type: 'header' }`要素を削除
- `title`フィールドは変更なし

## 変更2: 思考詳細の第二層モーダル追加

### 背景

`buildBundleDetailModal`でtoolとsubagentは第二層モーダルで詳細を見られるが、thinkingにはその機能がない。

### 変更内容

- `buildBundleDetailModal`のシグネチャに`bundleIndex: number`を追加
- thinkingエントリにボタンを追加（変更3のボタン形式に従う）
- action_id: `view_thinking_detail:{sessionId}:{bundleIndex}:{thinkingIndex}`
  - `thinkingIndex`はバンドル内のthinkingエントリの出現順インデックス
- `src/index.ts`に`view_thinking_detail`アクションハンドラを追加:
  1. action_idからsessionId, bundleIndex, thinkingIndexをパース
  2. `sessionJsonlReader.readBundle()`で該当バンドルを取得
  3. バンドル内のthinkingエントリをthinkingIndexで特定
  4. `buildThinkingModal(entry.texts)`で第二層モーダルを生成
  5. `views.push`で表示

## 変更3: BundleDetailモーダルのエントリをボタン化

### 背景

現在section+accessory「詳細を見る」ボタンが各エントリに付いており、ボタンが多くて見づらい。

### 変更内容

`buildBundleDetailModal`で、各エントリをsection+accessoryからactionsブロック内のボタンに変更:

- 思考: `💭 思考を表示する...` → action_id: `view_thinking_detail:{sessionId}:{bundleIndex}:{thinkingIndex}`
- ツール: `🔧 Read src/index.ts (1.2s)` → action_id: `view_tool_detail:{sessionId}:{toolUseId}`
- SubAgent: `🤖 SubAgent: "探索" (3.5s)` → action_id: `view_subagent_detail:{sessionId}:{toolUseId}`

### 制約

- ボタンテキストは最大75文字。超える場合はtruncate
- actionsブロックは最大25要素。超える場合は複数actionsブロックに分割

## 変更4: ✅リアクションの永続化

### 背景

現在`replaceWithDone`が✅を付けた3秒後にsetTimeoutで自動削除している。ユーザーの期待は「次にメッセージを送るまで✅が残る」こと。

### 変更内容

- `ReactionManager`に前回の✅情報（channel, ts）を保持するフィールドを追加
- `replaceWithDone`からsetTimeoutによる自動削除を撤去
- `markProcessing`（新しいメッセージの処理開始時）で:
  1. 前回の✅を削除
  2. 🧠を付与
  3. 新しいメッセージのtsを記録

## 変更5: 🔴中断をactiveMessageTsベースに変更

### 背景

現在の`reaction_added`ハンドラは`item.ts`からスレッドの先頭メッセージ（`threadTs`）を検索してセッションを特定している。ユーザーの期待は「🧠/砂時計が付いている処理中のメッセージに🔴を付けたら中断」。

### 変更内容

- `reaction_added`ハンドラで`item.ts`を`activeMessageTs`マップの値と照合
- マッチしたセッションに`interrupt`制御メッセージを送信
- `sessionIndexStore.findByThreadTs`ベースの検索は削除
- `activeMessageTs`はindex.ts内のローカル変数なので、ハンドラからアクセス可能

## 対象ファイル

- `src/slack/modal-builder.ts` — 変更1, 2, 3
- `src/slack/reaction-manager.ts` — 変更4
- `src/index.ts` — 変更2 (ハンドラ追加), 4 (markProcessing呼び出し変更), 5 (reaction_addedハンドラ変更)
