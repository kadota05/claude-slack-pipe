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
       ├─ 全セッションidle？
       │    ├─ YES → applyUpdate() → process.exit(0)
       │    └─ NO  → pendingUpdate = true
       │              全メッセージをブロック開始
       │              セッション完了を待つ
       │
       └─ pendingUpdate中にセッション完了
            → 全セッションidle？
                 ├─ YES → applyUpdate() → process.exit(0)
                 └─ NO  → 引き続き待機
```

### 再起動

`process.exit(0)` でプロセスを終了すると、launchdの `KeepAlive: true` が自動で新プロセスを起動する。tsxが直接 `src/index.ts` を実行するため、ビルドステップは不要。新プロセスは更新後のコードを読み込む。

## コンポーネント設計

### AutoUpdater クラス (`src/auto-updater.ts`)

```typescript
class AutoUpdater {
  constructor(options: {
    sessionCoordinator: SessionCoordinator;
    interval: number;
    enabled: boolean;
  })

  start(): void          // タイマー開始
  stop(): void           // タイマー停止（graceful shutdown時）
  checkForUpdate(): Promise<void>  // 手動トリガーも可能
  isPendingUpdate(): boolean       // メッセージブロック判定用
  onSessionIdle(): void            // セッション完了時のコールバック

  // private
  fetchAndCompare(): Promise<boolean>  // git fetch → HEAD比較
  applyUpdate(): Promise<void>         // git pull → npm install(必要時)
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

`SessionCoordinator` のセッション終了処理に `autoUpdater.onSessionIdle()` コールバックを追加。全セッションがアイドルになったタイミングで更新を実行する。

## 更新処理の詳細

### applyUpdate()

1. `git pull origin main` を実行
2. `git diff HEAD~1 --name-only` で `package-lock.json` の変更を確認
3. lockfileに変更あり → `npm install` を実行
4. `process.exit(0)`

### 失敗ハンドリング

- `git pull` 失敗（ネットワーク断等）→ 更新をスキップ、`pendingUpdate` 解除、メッセージブロック解除。次回チェックで再試行
- `npm install` 失敗 → 同上
- ロールバック機構は不要
  - mainブランチは常にCI通過済みの前提
  - tsxが直接実行するのでビルド失敗リスクなし
  - 万が一の起動不能時はlaunchdのサーキットブレーカー（5回/60秒で停止）が無限ループを防止
  - 復旧はユーザー手動で `git reset`

### npm install の実行判定

毎回実行は無駄なので、更新前後で `package-lock.json` に差分がある場合のみ実行する。

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
| `warn` | git pull / npm install 失敗 |

## index.ts への組み込み

```typescript
// main() 内
const autoUpdater = new AutoUpdater({
  sessionCoordinator,
  interval: config.autoUpdateIntervalMs,
  enabled: config.autoUpdateEnabled,
});

autoUpdater.start();

// graceful shutdown時
autoUpdater.stop();
```

## 影響範囲

| ファイル | 変更内容 |
|---|---|
| `src/auto-updater.ts` | 新規作成 |
| `src/config.ts` | 環境変数2つ追加 |
| `src/index.ts` | AutoUpdater初期化・start/stop追加 |
| `src/slack/event-handler.ts` | メッセージブロック判定追加 |
| `src/bridge/session-coordinator.ts` | セッション完了時のコールバック追加 |
| `.env.example` | 設定項目追加 |
