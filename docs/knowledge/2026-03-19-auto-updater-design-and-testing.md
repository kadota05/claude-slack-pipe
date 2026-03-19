# 自動更新機能（AutoUpdater）の設計と検証

## 概要

GitHub mainブランチへのマージをトリガーにして、配布先の全ユーザーのBridgeプロセスを自動更新する仕組みを設計・実装した。

## 設計判断

### アプローチ選定

3つのアプローチを比較検討した:

| アプローチ | 負荷 | 実装コスト | 即時性 |
|---|---|---|---|
| **A) Nodeプロセス内蔵ポーリング** ✅採用 | 極小 | 低 | チェック間隔に依存 |
| B) 別launchd定期ジョブ | 極小 | 中 | 同上 |
| C) GitHub Webhooks + Tunnel | ゼロ | 高 | 即時 |

**Aを採用した理由:**
- 実装が最もシンプル（既存プロセスにタイマー追加するだけ）
- SessionCoordinatorが既にアイドル状態を管理しているため、アイドル判定が容易
- 管理対象が増えない（新しいlaunchdジョブ不要）
- `git fetch` は差分のみで数KB、30分に1回なら負荷は無視できる

### 更新時のメッセージブロック

更新検知後、全メッセージ（新規・追加の両方）をブロックする設計にした。

- **新規メッセージのみブロック（不採用）:** 追加メッセージを通すと既存セッションが永遠にidle にならず、更新が適用されない
- **全メッセージブロック（採用）:** 処理中のセッションは現在のタスクだけ完了させ、新規も追加も止める。確実にアイドルに収束する

### ロールバック不要の判断

- mainブランチはCI通過済みの前提
- tsxが直接実行するのでビルド失敗リスクなし
- launchdのサーキットブレーカー（5回/60秒で停止）が無限再起動ループを防ぐ
- 万が一の復旧は手動 `git reset` で十分

## 更新フロー

```
setInterval(30分)
  ├─ git fetch origin main
  ├─ git rev-parse HEAD vs origin/main 比較
  ├─ 差分なし → スキップ
  └─ 差分あり
       ├─ 全セッションidle → 即座にapplyUpdate()
       └─ 処理中あり → pendingUpdate = true
            ├─ 新規メッセージ → 「🔄 更新中です」で拒否
            └─ セッション完了 → onSessionIdle() → applyUpdate()

applyUpdate():
  ├─ git pull origin main
  ├─ package-lock.json変更時のみ npm install
  └─ process.exit(0) → launchdが自動再起動
```

## 検証結果

### 成功した項目

1. **更新検知:** `git fetch` → HEAD比較で正しく差分を検知
2. **git pull:** fast-forward pullが正常に完了
3. **プロセス再起動:** `process.exit(0)` → launchdが自動で新プロセス起動（約1秒）
4. **新プロセスが最新コードで起動:** tsxが直接src/index.tsを読むためビルド不要
5. **診断ログ:** `fetchAndCompare` のinfoレベルログで local/remote HEAD を可視化
6. **pendingUpdate + "Sessions active, waiting for idle":** セッション処理中の検知でフラグが立つことを確認

### 未検証の項目

1. **メッセージブロック:** pendingUpdate中に新メッセージが「🔄 更新中です」で拒否されるか
2. **アイドル収束→自動更新:** 処理中セッションが完了後にonSessionIdle()が発火して更新されるか

### 未検証の原因

テスト手順にレースコンディションがあった:
- `git reset --hard HEAD~1` でローカルを巻き戻す
- **しかし旧BridgeのAutoUpdaterが先に差分を検知してpullしてしまう**
- `/restart-bridge` で新Bridgeが起動する頃にはローカル=リモートになっている

これはコードのバグではなく、テスト手順の問題。正しくテストするには:
1. 先にBridgeを停止する
2. push & resetを行う
3. Bridgeを再起動する
4. 起動後すぐに重い質問を送る（10秒以内）
5. 10秒後に別スレッドでメッセージを送ってブロック確認

## 教訓

### 鶏と卵問題

自動更新機能自体が更新対象のコードに含まれるため、「更新コードがない状態に戻すと更新できない」問題がある。テスト時は、AutoUpdater統合コミットより後のコミットで差分を作る必要がある。

### テスト時のレースコンディション

AutoUpdaterが短い間隔（10秒）で動いていると、手動操作（push, reset, restart）の間にチェックが走って差分を消化してしまう。テスト時はBridgeを先に停止してから環境を準備すべき。

### fetchAndCompareの診断ログの重要性

初期実装ではfetchAndCompareの結果がdebugレベルだったため、チェックが走っているのか・何が起きているのか全く見えなかった。infoレベルのログ（local/remote HEAD表示）を追加したことで、問題の切り分けが格段に容易になった。

## 関連ファイル

- `src/auto-updater.ts` — AutoUpdaterクラス
- `src/index.ts` — メッセージブロック処理（handleMessage内）、onIdleCallbackの登録
- `src/bridge/session-coordinator.ts` — isAllIdle()、onIdleCallback
- `.env.example` — AUTO_UPDATE_ENABLED、AUTO_UPDATE_INTERVAL_MS
