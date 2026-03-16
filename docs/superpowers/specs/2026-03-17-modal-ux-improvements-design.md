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

- `buildBundleDetailModal`のシグネチャを`(entries: BundleEntry[], sessionId: string, bundleIndex: number)`に変更
- thinkingエントリにボタンを追加（変更3のボタン形式に従う）
- action_id: `view_thinking_detail:{sessionId}:{bundleIndex}:{thinkingIndex}`
  - `thinkingIndex`はバンドル内のthinkingエントリのみをフィルタした上での出現順インデックス（全エントリ中のインデックスではない）
- `src/index.ts`に`view_thinking_detail`アクションハンドラを追加:
  1. action_idからsessionId, bundleIndex, thinkingIndexをパース
  2. `sessionJsonlReader.readBundle()`で該当バンドルを取得
  3. バンドル内のエントリから`type === 'thinking'`のみをフィルタし、thinkingIndexで特定
  4. `buildThinkingModal(entry.texts)`で第二層モーダルを生成
  5. `views.push`で表示（このアクションは常にBundleDetailモーダル内のボタンから発火するため、常に`views.push`。`views.open`との分岐は不要）
- `index.ts`内の既存`view_bundle`ハンドラ（`buildBundleDetailModal`の呼び出し元）にも`bundleIndex`を渡すように変更

## 変更3: BundleDetailモーダルのエントリをボタン化

### 背景

現在section+accessory「詳細を見る」ボタンが各エントリに付いており、ボタンが多くて見づらい。

### 変更内容

`buildBundleDetailModal`で、各エントリをsection+accessoryからactionsブロック内のボタンに変更:

- 思考: `💭 {思考内容プレビュー}` → action_id: `view_thinking_detail:{sessionId}:{bundleIndex}:{thinkingIndex}`
- ツール: `🔧 {toolName} {oneLiner} ({duration})` → action_id: `view_tool_detail:{sessionId}:{toolUseId}`
- SubAgent: `🤖 SubAgent: "{description}" ({duration})` → action_id: `view_subagent_detail:{sessionId}:{toolUseId}`

ボタンテキストの組み立て: アイコン + ツール名/説明 + oneLiner + duration。全体を`truncate(text, 72)`で切り詰める（既存の`truncate`関数は超過時に`...`(3文字)を付加するため、72+3=75文字でSlack APIの上限に収まる）。

### 制約

- ボタンテキスト（`plain_text`）はSlack API上限75文字。`truncate(text, 72)`で切り詰め
- actionsブロックは最大25要素。超える場合は複数actionsブロックに分割
- 各エントリは1つのボタン。actionsブロック間にdividerは不要（ボタンが自然に区切られるため）

## 変更4: ✅リアクションの永続化

### 背景

現在`replaceWithDone`が✅を付けた3秒後にsetTimeoutで自動削除している。ユーザーの期待は「次にメッセージを送るまで✅が残る」こと。

### 変更内容

- `ReactionManager`に前回の✅情報を保持する`lastDone: { channel: string; ts: string } | null`フィールドを追加
  - DMは1ユーザー1チャンネルなのでグローバルに1つで十分
- `replaceWithDone`からsetTimeoutによる自動削除を撤去し、`lastDone`に情報を保存
- 既存の`replaceWithProcessing`メソッドの先頭に前回✅の削除ロジックを追加:
  1. `lastDone`がnullでなければ、`safeRemove(lastDone.channel, lastDone.ts, 'white_check_mark')`
  2. `lastDone = null`
  3. 既存の🧠付与ロジックを実行
- 新規メソッドの追加は不要（既存の`replaceWithProcessing`を拡張）

## 変更5: 🔴中断をactiveMessageTsベースに変更

### 背景

現在の`reaction_added`ハンドラは`item.ts`からスレッドの先頭メッセージ（`threadTs`）を検索してセッションを特定している。ユーザーの期待は「🧠/砂時計が付いている処理中のメッセージに🔴を付けたら中断」。

### 変更内容

- `reaction_added`ハンドラで`item.ts`を`activeMessageTs`マップの値と照合（Mapをイテレートして値が一致するエントリを探す）
- マッチしたセッションIDでcoordinatorからセッションを取得し、`interrupt`制御メッセージを送信
- `sessionIndexStore.findByThreadTs`ベースの検索は削除（ユーザー要件: activeMessageTsマッチのみ）
- `activeMessageTs`はindex.ts内の`main()`スコープのローカル変数で、`reaction_added`ハンドラと同スコープなのでアクセス可能

## 対象ファイル

- `src/slack/modal-builder.ts` — 変更1, 2, 3
- `src/slack/reaction-manager.ts` — 変更4
- `src/index.ts` — 変更2 (view_thinking_detailハンドラ追加, view_bundleハンドラでbundleIndex渡し), 5 (reaction_addedハンドラ変更)
