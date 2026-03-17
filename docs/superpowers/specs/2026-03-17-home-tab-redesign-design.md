# Home Tab リデザイン設計書

## 概要

ホームタブを「Claude Codeの現在の状態を一目で把握し、設定を変更できるダッシュボード」として再設計する。不要なセクション（Usage Guide、Active Sessions、ページネーション）を削除し、ステータスカードを主役に据える。

## 構成

上から順に以下の3セクションのみ：

1. **ヘッダー** — 「Claude Code Bridge」
2. **ステータスカード** — Active/Inactive + Model/Directory ドロップダウン
3. **Recent Sessions** — 最近のセッション5件（全プロジェクト横断）

## Section 1: ステータスカード

### 視覚設計

ホームタブ内で最も目立つ要素。Block Kit構成：

```
[header]     "Claude Code Bridge"
[section]    🟢 *Active*  /  🔴 *Inactive*     ← mrkdwn bold + emoji
[context]    "MODEL"          "DIRECTORY"        ← ラベル（中央揃え風にスペース調整）
[actions]    [static_select]  [static_select]    ← 横並びドロップダウン
[divider]
```

### Active/Inactive 判定ロジック

**方式**: ハートビートファイルによるBridgeプロセス生存確認

Bridgeプロセスが起動しているかどうか（= Slackからclaude codeに指示を飛ばせるか）を判定する。

#### ハートビートの仕組み

- **ファイルパス**: `~/.claude-slack-pipe/heartbeat`
- **内容**: Unixタイムスタンプ（ミリ秒）1行のみ。毎回上書き
- **更新間隔**: 30秒ごと（`setInterval`）
- **ファイルサイズ**: 常に数十バイト固定

#### ライフサイクル

1. **Bridge起動時** → ハートビート書き込み開始（ホームタブは次回表示時にActive判定される）
2. **Bridge稼働中** → 30秒ごとにハートビートファイルを上書き更新
3. **ホームタブを開く**（`app_home_opened`）→ ハートビートファイルのタイムスタンプを確認
   - 現在時刻との差が60秒以内 → 🟢 Active
   - 60秒超、またはファイルが存在しない → 🔴 Inactive
4. **正常終了時**（SIGINT, SIGTERM）→ ハートビートファイルを削除（ホームタブは次回表示時にInactive判定される）
5. **異常終了時**（SIGKILL, クラッシュ）→ ハートビートの更新が止まる → 次にホームタブを開いた時にInactiveと判定

#### 判定タイミング

- `app_home_opened` イベント発火時
- モデル/ディレクトリ変更時

### Model ドロップダウン

- 選択肢: Opus / Sonnet / Haiku
- デフォルト: **Opus**
- action_id: `home_set_default_model`（既存ハンドラ再利用）
- 変更時: `userPrefStore.setModel()` → `coordinator.broadcastControl()` → ホームタブ再描画
- 既存ユーザーの保存済みプリファレンスはそのまま維持。デフォルト変更は新規ユーザーのみに影響

### Working Directory ドロップダウン

- 選択肢: `ProjectStore` から取得したプロジェクト一覧 + ホームディレクトリ
- デフォルト: **ホームディレクトリ（`~`）** — CLIプロジェクトパスとしては `-Users-<username>`
- action_id: `home_set_directory`（既存ハンドラ再利用）
- 変更時: `userPrefStore.setDirectory()` → ホームタブ再描画
- 表示名: パスの末尾2セグメント（例: `dev/claude-slack-pipe`）。ホームディレクトリは `~` 表示
- プロジェクトが存在しない場合（空リスト）: ホームディレクトリのみを選択肢として表示

## Section 2: Recent Sessions

### データソース

`~/.claude/projects/` 配下の **全プロジェクトディレクトリ** を横断して `{sessionId}.jsonl` ファイルを収集する。特定のプロジェクトに限定しない。

### 取得ロジック

1. `~/.claude/projects/` 配下の全サブディレクトリから `.jsonl` ファイルを列挙
2. ファイルの mtime（最終更新日時）で降順ソート
3. 上位10〜15件の候補を取得（除外分を見込む）
4. 各候補のJSONL先頭を読み、最初の `type: "user"` エントリを探す（最大20行まで読み取り、見つからなければスキップ）
5. 定期実行フィルタを適用（後述）
6. 残った上位5件を表示

### RecentSession 型定義

```typescript
interface RecentSession {
  sessionId: string;        // JSONLファイル名（拡張子なし）
  projectPath: string;      // デコード済みプロジェクトパス（例: "dev/claude-slack-pipe"）
  mtime: Date;              // ファイルの最終更新日時
  firstPrompt: string;      // 最初のユーザーメッセージ全文（フィルタリング用）
  firstPromptPreview: string; // 表示用プレビュー（50文字で切り詰め）
}
```

### 表示内容

各セッション1行：
- **時刻**: mtime からの相対時間（既存の `getTimeAgo()` 関数を使用。例: `3m ago`、`2d ago`）
- **最初のユーザーメッセージ冒頭**: 50文字程度で切り詰め
- **プロジェクトパス**: ディレクトリ名をデコードしたパス末尾（例: `dev/claude-slack-pipe`）

### Block Kit構成

```
[section]    *Recent Sessions*
[context]    "3m ago — ホームタブの構成を考えたい..."
             "dev/claude-slack-pipe"
[context]    "1h ago — バグ修正: セッションインデックス..."
             "dev/claude-slack-pipe"
... (最大5件)
```

セッションが0件の場合: `[context] "No recent sessions"` を表示。

### 定期実行セッション除外ロジック

**方式**: 初回プロンプト完全一致除外

1. 各セッションの `firstPrompt`（最初のユーザーメッセージ全文）を取得
2. 候補セッション群の中で、同一の `firstPrompt` が **2件以上存在する** 場合、そのプロンプトを持つセッションを **すべて除外**
3. 除外後の上位5件を表示

**補足**: この方式ではユーザーが偶然同じプロンプトを2回送った場合も除外される。定期実行の除外を優先するトレードオフとして許容する。

### パフォーマンス考慮

- JSONLファイルは**先頭最大20行のみ**読み取る（最初の `type: "user"` エントリが見つかれば打ち切り）
- `type: "user"` が20行以内に見つからないセッションはスキップ（空セッションやシステムのみのセッション）
- mtimeソートでファイルシステムメタデータのみ使用し、全ファイルの内容読み取りを回避
- 候補を10〜15件に絞ってから内容を読むため、大量のセッションがあっても軽量

## 削除するセクション

現在のホームタブから以下を削除：

- **Usage Guide** — 不要
- **Active Sessions** — ステータスカードのActive/Inactive表示に集約
- **ページネーション** — Recent Sessions は固定5件のため不要

## 変更対象ファイル

| ファイル | 変更内容 |
|---------|---------|
| `src/slack/block-builder.ts` | `buildHomeTabBlocks()` を全面書き換え |
| `src/slack/home-tab.ts` | Recent Sessions のJSONL読み取りロジック追加、ハートビート判定ロジック追加 |
| `src/types.ts` | `RecentSession` 型追加 |
| `src/store/user-preference-store.ts` | デフォルト値変更（model: opus, directory: home） |
| `src/heartbeat.ts` | **新規**: ハートビートの書き込み・読み取り・削除ロジック |
| `src/index.ts` | ハートビート開始/停止、シャットダウンフック追加 |

## デフォルト値

| 設定 | デフォルト値 |
|-----|------------|
| Model | `opus`（既存ユーザーの保存済み設定は維持） |
| Working Directory | ホームディレクトリ（`~`、CLIパス: `-Users-<username>`） |
