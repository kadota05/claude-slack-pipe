# AutoUpdaterがfeatureブランチで無限更新ループを起こす

## 症状

- 「🔄 システムを最新バージョンに更新中です」メッセージが突然表示され、処理が止まる
- 表示が変わらず、ユーザーにはフリーズに見える
- ログ上では30分ごとにBridgeが再起動を繰り返していた

## 根本原因

`AutoUpdater.isOnMainBranch()` は `start()` 時に1回しか呼ばれなかった。
Bridgeがmainブランチで起動後にfeatureブランチに切り替えると:

1. `fetchAndCompare()` は `git rev-parse HEAD`（featureブランチ）と `git rev-parse origin/main` を比較
2. 永遠に一致しないため、毎回「更新あり」と判定
3. `git pull origin main` がfeatureブランチにmainをマージ
4. shutdown → 再起動 → 30分後にまた同じことが起きる

さらに `_pendingUpdate = true` の間に届いたメッセージはブロックされるが、
再起動後に「更新完了」通知がなく、ユーザーにはフリーズに見えた。

## 証拠

```
09:15:47 Compare: local=1708711, remote=d6c10b3, hasUpdate=true → pull → restart
09:45:50 Compare: local=1708711, remote=d6c10b3, hasUpdate=true → pull → restart
10:15:52 Compare: local=1708711, remote=d6c10b3, hasUpdate=true → pull → restart
12:12:12 Compare: local=bf140bb, remote=dd07a14, hasUpdate=true → pull → restart
```

localが毎回origin/mainと異なるハッシュ = featureブランチのHEAD。

## 修正内容

1. `fetchAndCompare()` 内で毎回 `isOnMainBranch()` をチェック。main以外なら `stop()` してタイマーも停止
2. ブロックメッセージのchannel/tsを記録し、再起動後に「✅ 自動更新が完了しました」に書き換える仕組みを追加

## 教訓

- ブランチチェックのような前提条件は、起動時だけでなく**実行時にも毎回検証**すべき
- `git rev-parse HEAD` vs `git rev-parse origin/main` の比較は、mainブランチ上でのみ意味がある
- ユーザーに「待ってください」と言ったら、**必ず結果を通知**すること。通知なしは最悪のUX
