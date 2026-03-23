# Shutdown Guard Fixes 設計書

## 概要

シナリオベーステスト検証で発見された3つの問題を修正する。すべてスコープが小さく独立した修正。

## 問題と修正

### Fix 1: S01 — shutdown中メッセージのガード追加

**問題**: `handleMessage()`に`isShuttingDown`チェックがなく、shutdown中に到着したメッセージが処理開始され、`process.exit(0)`で中断される可能性がある。

**修正**: `handleMessage()`の冒頭（メッセージ処理の最初期、タイムスタンプチェックの直前）に`isShuttingDown`ガードを追加。

```typescript
// src/index.ts handleMessage冒頭
if (isShuttingDown) return;
```

- shutdown中のメッセージは静かにドロップ
- Slack Socket Modeは配信保証なしのため、ドロップは許容される
- ログ出力なし（shutdown中のログは無意味）

### Fix 2: S06 — テストシナリオ記述の修正

**問題**: シナリオS06の期待(c)が「サーキットブレーカーが発動して無限クラッシュループにならない」だが、nodeバイナリ消失時はアプリケーション層のサーキットブレーカーに到達しない。

**修正**: `docs/test-scenarios/feat-launchd-daemon_20260323.md`のS06期待(c)を修正。

変更前:
> サーキットブレーカーが発動して無限クラッシュループにならない

変更後:
> nodeバイナリが存在しないためアプリケーション層のサーキットブレーカーは機能しない。ただしplistのThrottleInterval(5秒)により低頻度リトライに制限され、CPU暴走は防止される

### Fix 3: S09 — shutdown時の🧠リアクション除去

**問題**: `shutdown()`関数に🧠リアクション除去コードがなく、再起動後に🧠が残置される。

**修正**: `shutdown()`内で`coordinator.endSession()`の後、`activeMessageTs`を走査して🧠リアクションを除去。

```typescript
// src/index.ts shutdown関数内、endSessionループの後
const reactionCleanups: Promise<void>[] = [];
for (const [sessionId, messageTs] of activeMessageTs) {
  const entry = sessionIndexStore.getByCliSessionId(sessionId);
  if (entry) {
    reactionCleanups.push(
      rm.removeProcessing(entry.channel, messageTs).catch(() => {})
    );
  }
}
await Promise.allSettled(reactionCleanups);
activeMessageTs.clear();
```

- `Promise.allSettled`で全API呼び出しを待つ（個別失敗は無視）
- `.catch(() => {})`で個別のSlack APIエラーを吸収
- best-effort: 失敗してもshutdownは続行
- `app.stop()`の前に実行（Slack APIクライアントがまだ有効な間に実行する必要あり）

## 変更対象ファイル

| ファイル | 変更内容 |
|---|---|
| `src/index.ts` | handleMessage冒頭にガード追加、shutdown関数にリアクション除去追加 |
| `docs/test-scenarios/feat-launchd-daemon_20260323.md` | S06の期待(c)を修正 |

## テスト方針

- Fix 1, Fix 3: 既存テストへの影響なし。手動テストで確認（shutdown中のメッセージドロップ、再起動後の🧠残置なし）
- Fix 2: ドキュメント修正のみ
- S04のcrash-history形式（ISOタイムスタンプ→数値）も併せて修正

## リスク

- Fix 1: メッセージドロップのリスクはあるが、shutdown→再起動は数秒で完了するため影響は極小
- Fix 3: Slack APIのレート制限に引っかかる可能性があるが、アクティブセッション数は通常1-2個のため問題なし
