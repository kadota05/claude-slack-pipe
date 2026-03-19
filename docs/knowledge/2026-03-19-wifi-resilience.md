# WiFi切断時のBridge自動復帰

## 症状

家のWiFiでBridgeを稼働中に外出するとWiFi接続が切れ、Bridgeがcrash loopに入って復帰しない。テザリングやカフェのWiFiに接続しても自動的に復帰せず、手動でBridgeを再起動するまでSlackメッセージが処理されない。

## 根本原因

Slack Socket Mode SDK（`@slack/socket-mode`）の`retrieveWSSURL()`メソッドが、ネットワークエラー（`RequestError`）を**回復不可能**として扱っている。WiFi切断時の再接続フロー:

1. WebSocketのping/pongタイムアウトで切断検知
2. SDKが`delayReconnectAttempt(start)`で再接続を試みる
3. `apps.connections.open` HTTPリクエストがネットワーク不通で`RequestError`
4. `isRecoverable = false`と判定され、例外をthrow
5. `delayReconnectAttempt`内に`.catch()`がないため、unhandled promise rejection
6. Node.js 22のデフォルト挙動でプロセスcrash
7. launchdが再起動 → まだWiFiなし → 即crash → circuit breaker発動（5分スリープ）

## 証拠

- `node_modules/@slack/socket-mode/dist/src/SocketModeClient.js` 230行: `RequestError`で`isRecoverable = false`
- 同ファイル199行: `cb.apply(this).then(res)` — `.catch()`がない
- Node.js 22: unhandled rejectionでデフォルトcrash

## 修正内容

### 1. NetworkWatcher（`src/utils/network-watcher.ts`）
macOSの`scutil`コマンドを子プロセスとして実行し、ネットワーク状態の変化をイベント駆動で検知。`os.networkInterfaces()`でIPアドレスの有無を判定し、`disconnected`/`reconnected`イベントを発火。5秒のデバウンスでWiFiフラッピングに対処。

### 2. crash防止（`src/index.ts`）
`process.on('unhandledRejection', ...)`でSDKの再接続失敗を捕捉し、プロセスのcrashを防止。scutilがWiFi復帰を検知するまでプロセスを生かしておく。

### 3. WiFi復帰時の再起動
`reconnected`イベントで2秒待機後（DHCP/DNS安定化）、`shutdown('wifi-reconnect')`でプロセスを終了。launchdが再起動し、新しいSocket Mode接続を確立。

### 4. ギャップメッセージの破棄
プロセス起動時に`startedAt`を記録し、`handleMessage`で`event.ts < startedAt`のメッセージを無視。プロセス停止中に送られたメッセージのリトライ配信を確実に弾く。

### 5. ユーザー通知
切断時: 直近10分以内のアクティブセッションに「⚠️ PCのWiFi接続が切れました」（best-effort）。
復帰時: 同スレッドに「🔄 WiFiの再接続を検知しました。Bridgeを再起動しています...」→ 再起動完了後「✅ Bridgeの再起動が完了しました」に更新。

## 教訓

- **Socket Mode SDKのエラーハンドリングは信頼できない。** `RequestError`（一時的なネットワーク不通）を回復不可能と判定するのはSDKのバグ。アプリレイヤーで回復機構を持つべき。
- **macOSの`scutil`はネットワーク変化のイベント駆動検知に最適。** ポーリング不要で、WiFi切断・接続の両方を即座に検知できる。
- **`unhandledRejection`はSDKのバグに対するセーフティネットとして有効。** ただしスコープが広いため、WiFi復帰後のプロセス再起動（クリーン状態）とセットで使う。
