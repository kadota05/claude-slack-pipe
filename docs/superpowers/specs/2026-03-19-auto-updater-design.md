# Auto Updater 設計書

## 概要

mainブランチへのマージを検知し、Bridgeプロセスを自動更新する仕組み。既存のNodeプロセス内にポーリングベースの更新チェッカーを組み込み、アイドル時に安全に更新・再起動を行う。

## 要件

- mainマージ後、約30分〜1時間以内に全ユーザーの環境が自動更新される
- 処理中のセッションを中断しない（アイドル時に更新）
- PC負荷は最小限（定期的な `git fetch` のみ）
- 全ユーザーmacOS + launchd環境
- 追加のデーモンやwebhook設定は不要

## アーキテクチャ

### アプローチ: Nodeプロセス内蔵ポーリング

既存のBridgeプロセス内に `AutoUpdater` クラスを追加する。別プロセスやlaunchdジョブは追加しない。

**選定理由:**
- 実装がシンプル（タイマー + gitコマンド数行）
- `SessionCoordinator` のアイドル判定を直接利用できる
- 管理対象が増えない
- `git fetch` の負荷はほぼゼロ（差分のみ、数KB）

### 前提条件

- ユーザーのローカルリポジトリは `main` ブランチにいること
- 起動時にカレントブランチを確認し、`main` 以外なら自動更新を無効化 + 警告ログを出力

### 更新フロー

```
setInterval(30分)
  │
  ├─ git fetch origin main
  ├─ git rev-parse HEAD vs git rev-parse origin/main
  │
  ├─ 差分なし → 何もしない
  │
  └─ 差分あり
       ├─ pendingUpdate = true（メッセージブロック開始）
       │
       └─ 全セッションidle？
            ├─ YES → applyUpdate() → shutdown('auto-update')
            └─ NO  → セッション完了を待つ
                      │
                      └─ 全セッションidle時
                           → applyUpdate() → shutdown('auto-update')
```

**レースコンディション対策:** 差分検出直後、アイドル判定の前に `pendingUpdate = true` をセットしてメッセージブロックを有効化する。これにより、アイドル判定とセッション開始の間に新しいセッションが割り込むことを防ぐ。

### 再起動

既存の `shutdown()` 関数を経由してプロセスを終了する（セッション終了・tunnelManager停止・Slack SDK切断を正しく行うため）。`shutdown('auto-update')` で呼び出し、crash-historyをクリアする（意図的な再起動のため）。launchdの `KeepAlive: true` が自動で新プロセスを起動し、新プロセスは更新後のコードを読み込む。

## コンポーネント設計

### AutoUpdater クラス (`src/auto-updater.ts`)

```typescript
class AutoUpdater {
  constructor(options: {
    sessionCoordinator: SessionCoordinator;
    shutdown: (reason: string) => Promise<void>;
    interval: number;
    enabled: boolean;
  })

  start(): void          // タイマー開始（起動時にブランチチェック）
  stop(): void           // タイマー停止（graceful shutdown時）
  checkForUpdate(): Promise<void>  // 手動トリガーも可能
  isPendingUpdate(): boolean       // メッセージブロック判定用
  onSessionIdle(): void            // セッション完了時のコールバック

  // private
  fetchAndCompare(): Promise<boolean>  // git fetch → HEAD比較
  applyUpdate(): Promise<void>         // git pull → npm install(必要時)
  cleanGitLocks(): void                // .git/index.lock 残留チェック・削除
  isOnMainBranch(): boolean            // カレントブランチ確認
}
```

### メッセージブロック

`pendingUpdate` がtrueの間、全てのメッセージをブロックする。

- **新規セッション開始** → 「システムを最新バージョンに更新中です。少々お待ちください」とSlackに返す
- **既存セッションへの追加メッセージ** → 同様にブロック
- **処理中のセッション** → 今のタスクだけ完了させて終了（新しいメッセージは受け付けない）

これにより、処理中セッションは確実にアイドルに収束し、更新が適用される。

**実装箇所:** `event-handler.ts` のメッセージ受信時に `autoUpdater.isPendingUpdate()` をチェック。

### セッション完了通知

`SessionCoordinator` の `wireEvents` 内で、セッションの `stateChange` イベント（`to === 'idle'`）発生時に `autoUpdater.onSessionIdle()` を呼び出す。

`onSessionIdle()` 内では `SessionCoordinator` に新設する `isAllIdle()` メソッドで全セッションがidle/dead/not_startedかを判定し、全アイドルなら更新を実行する。

## 更新処理の詳細

### applyUpdate()

1. `.git/index.lock` が残っていれば削除（前回中断時の残留対策）
2. pull前のHEADを保存: `beforeHead = git rev-parse HEAD`
3. `git pull origin main` を実行（タイムアウト: 60秒）
4. `git diff ${beforeHead} HEAD --name-only` で `package-lock.json` の変更を確認
5. lockfileに変更あり → `npm install` を実行（タイムアウト: 120秒）
6. `shutdown('auto-update')` を呼び出し

### 失敗ハンドリング

- `git pull` 失敗（ネットワーク断等）→ 更新をスキップ、`pendingUpdate` 解除、メッセージブロック解除。次回チェックで再試行
- `npm install` 失敗 → 同上
- タイムアウト → 同上（子プロセスをkillしてスキップ）
- ロールバック機構は不要
  - mainブランチは常にCI通過済みの前提
  - tsxが直接実行するのでビルド失敗リスクなし
  - 万が一の起動不能時はlaunchdのサーキットブレーカー（5回/60秒で停止）が無限ループを防止
  - 復旧はユーザー手動で `git reset`

### npm install の実行判定

毎回実行は無駄なので、pull前後のHEAD差分で `package-lock.json` に変更がある場合のみ実行する。

## 設定

`.env` に以下を追加:

```
AUTO_UPDATE_ENABLED=true           # 自動更新の有効/無効
AUTO_UPDATE_INTERVAL_MS=1800000    # チェック間隔（デフォルト30分）
```

`config.ts` の Zod スキーマに追加。

## ログ

| レベル | 内容 |
|---|---|
| `debug` | 更新チェック実行（差分なし） |
| `info` | 更新検出、更新適用、再起動実行 |
| `warn` | git pull / npm install 失敗、main以外のブランチで自動更新無効化 |

## index.ts への組み込み

```typescript
// main() 内
const autoUpdater = new AutoUpdater({
  sessionCoordinator,
  shutdown,
  interval: config.autoUpdateIntervalMs,
  enabled: config.autoUpdateEnabled,
});

autoUpdater.start();

// graceful shutdown時
autoUpdater.stop();
```

`shutdown()` 関数に `'auto-update'` reasonを追加し、crash-historyクリア対象に含める。

## 影響範囲

| ファイル | 変更内容 |
|---|---|
| `src/auto-updater.ts` | 新規作成 |
| `src/config.ts` | 環境変数2つ追加 |
| `src/index.ts` | AutoUpdater初期化・start/stop追加、shutdown reasonに 'auto-update' 追加 |
| `src/slack/event-handler.ts` | メッセージブロック判定追加 |
| `src/bridge/session-coordinator.ts` | `isAllIdle()` メソッド追加、wireEventsにコールバック追加 |
| `.env.example` | 設定項目追加 |
