# WiFi切断時の自動復帰機能

## 概要

WiFiが切れた際にBridgeが自動復帰する機能。macOSの`scutil`でネットワーク変化を検知し、切断時にはユーザーに通知、復帰時にはlaunchd経由でプロセスを再起動する。

## 背景・課題

Slack Socket ModeのSDK（`@slack/socket-mode`）は、ネットワークエラー（`RequestError`）を「回復不可能」として扱い、再接続を諦めてthrowする。これがunhandled rejectionとなりNode.jsプロセスがcrashする。launchdが再起動するが、WiFiがまだ切れている場合は即座に再crash → crash loop circuit breakerが発動して5分間スリープに入る。

ユースケース: 家のWiFiでBridge稼働 → 外出してWiFi切断 → テザリングやカフェのWiFiに接続 → Bridgeが自動復帰してSlackメッセージを送れるようになる。

## コンポーネント

### 1. NetworkWatcher

**ファイル**: `src/utils/network-watcher.ts`（新規）

**責務**: macOSのネットワーク状態変化をイベント駆動で検知する。

**仕組み**:
- `/usr/sbin/scutil`を子プロセスとしてspawn
- stdinに`n.add State:/Network/Global/IPv4`、`n.add State:/Network/Global/IPv6`、`n.watch`を書き込む
- stdoutに`changed key`が出力されたら`os.networkInterfaces()`で非internal IPv4アドレスの有無をチェック
  - 0個 → `emit('disconnected')`
  - 1個以上 → `emit('reconnected')`
- scutilプロセスが予期せず死んだら1秒後に自動再起動（最大5回/分、超過でログ警告のみ）
- `stop()`で子プロセスをkill、再起動を抑止

**デバウンス**: WiFiフラッピング（高速な切断/再接続の繰り返し）対策として、`disconnected`/`reconnected`イベントにデバウンスを適用する。ネットワーク状態変化後5秒間安定していなければイベントを発火しない。

**インターフェース**:
```typescript
class NetworkWatcher extends EventEmitter {
  start(): void    // scutil子プロセス起動、監視開始
  stop(): void     // 子プロセス終了
  // events: 'disconnected' | 'reconnected'
}
```

**`app.start()`成功直後から常時稼働する。**

### 2. 切断時の通知

**トリガー**: NetworkWatcherの`'disconnected'`イベント

**動作**:
1. `sessionIndexStore.getActive()`からアクティブセッション一覧を取得
2. `lastActiveAt`が直近10分以内のセッションをフィルタ（10分はセッションidle timeoutと一致）
3. 該当スレッドに投稿: `⚠️ PCのWiFi接続が切れました。再接続されるまでメッセージは処理されません。`

**注意**: 切断通知はbest-effortである。WiFiが既に切れている場合、Slack API呼び出し自体が失敗する。失敗してもtry/catchで静かに続行し、復帰フローには影響しない。復帰時の通知メッセージにも切断していた旨を含めるため、切断通知が届かなくても状況は伝わる。

### 3. 復帰→再起動

**トリガー**: NetworkWatcherの`'reconnected'`イベント

**動作**:
1. 2秒待機（DHCP/DNS安定化のため）
2. 切断通知を出したスレッドに復帰メッセージを`await`で投稿: `🔄 WiFiの再接続を検知しました。Bridgeを再起動しています...`
   - 投稿失敗時は最大3回リトライ（3秒間隔）。全て失敗してもrestart-pending.jsonへの保存をスキップして再起動は続行する。
3. 成功した各復帰メッセージの`channel`/`ts`/`thread_ts`を`restart-pending.json`に保存
4. 全ての非同期処理完了後に`process.exit(0)` → launchdが再起動

### 4. 起動時メッセージ更新（既存ロジック拡張）

**動作**: 新プロセス起動時に`restart-pending.json`を読み、各メッセージを`✅ Bridgeの再起動が完了しました`に更新。

**拡張**: 現在は1件（オブジェクト形式）のみ対応。複数スレッドへの通知をサポートするため配列形式に拡張する。後方互換ロジック:

```
if (pending.messages) → 配列をループして各メッセージを更新
else if (pending.channel) → 旧形式として単一メッセージを更新
```

```json
{
  "messages": [
    { "channel": "C1", "ts": "1742400001.000", "thread_ts": "1742300000.000" },
    { "channel": "C1", "ts": "1742400002.000", "thread_ts": "1742350000.000" }
  ]
}
```

### 5. ギャップメッセージの破棄

**目的**: Bridgeプロセスが動いていない間に送られたメッセージを無視する。WiFi切断に限らず、crash・手動再起動など全てのケースで一貫して動作する。

**動作**:
1. Bridge起動時に`startedAt = Date.now() / 1000`を記録（Slack ts形式）
2. `handleMessage`の先頭で`parseFloat(event.ts) < startedAt`なら`return`（ログ出力のみ）
3. Slackのリトライで再配信されたメッセージも`event.ts`は元の送信時刻なので、確実に弾かれる

### 6. crash防止（unhandledRejection）

**目的**: SDKの再接続失敗によるunhandled rejection → process crashを防止し、scutilの復帰検知まで生き続ける。

**動作**: `app.start()`成功後に`process.on('unhandledRejection', handler)`を登録。ログ出力のみ行い、rethrowしない。

**スコープの広さについて**: 全てのunhandled rejectionをキャッチするため、SDK以外のバグも飲み込むリスクがある。しかし、このアプリでunhandled rejectionの発生源は実質的にSlack SDKの再接続失敗のみであり、WiFi復帰後にプロセス再起動（クリーン状態）されるため、許容する。

## フロー全体図

```
正常稼働中
  │
  ├─ NetworkWatcher常時稼働（scutil子プロセス）
  │
WiFi切断
  │
  ├─ scutil: ネットワーク変化検知 → os.networkInterfaces() → IPなし
  ├─ NetworkWatcher: emit('disconnected')
  ├─ 直近10分のアクティブスレッドに切断通知
  │   「⚠️ PCのWiFi接続が切れました。再接続されるまでメッセージは処理されません。」
  ├─ SDK内部: 再接続試行 → RequestError → throw → unhandledRejection → catch（crash防止）
  │
  │  （ユーザーが外出中、メッセージを送っても処理されない）
  │
WiFi再接続（テザリング/カフェWiFi等）
  │
  ├─ scutil: ネットワーク変化検知 → os.networkInterfaces() → IPあり
  ├─ 5秒デバウンス（安定確認）
  ├─ NetworkWatcher: emit('reconnected')
  ├─ 2秒待機（DHCP/DNS安定化）
  ├─ 復帰通知を await で投稿（失敗時は最大3回リトライ）
  │   「🔄 WiFiの再接続を検知しました。Bridgeを再起動しています...」
  ├─ restart-pending.json保存
  ├─ 全非同期処理完了後 process.exit(0)
  │
launchd再起動
  │
  ├─ startedAt = 現在時刻 を記録
  ├─ app.start() → Socket Mode接続確立
  ├─ restart-pending.json読み込み → 復帰メッセージを「✅ Bridgeの再起動が完了しました」に更新
  ├─ NetworkWatcher再開
  │
  │  ユーザーがメッセージ送信 → 正常処理
  │  切断中のメッセージがリトライで届く → event.ts < startedAt → 無視
```

## 変更対象ファイル

| ファイル | 変更内容 |
|---|---|
| `src/utils/network-watcher.ts` | 新規作成 |
| `src/index.ts` | NetworkWatcher統合、切断/復帰ハンドラ、ギャップメッセージ破棄、unhandledRejection、restart-pending.json拡張 |

## スコープ外

- macOS以外のプラットフォーム対応（このプロジェクトはlaunchd管理のmacOS専用）
- Slack HTTP Events APIへの移行
- スレッド返信のリトライ重複排除（別課題）
