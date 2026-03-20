# スリープポリシーとセットアップ設定の管理

## 背景

Bridgeプロセスはlaunchdデーモンとして常時起動しており、`caffeinate -i` 経由で実行されるためPC全体のアイドルスリープが防止される。これはシステム全体に影響する設定であり、ユーザーが意図的に選択すべきもの。

## 課題1: スリープポリシーの選択肢

現状は `caffeinate -i` 固定だが、ユーザーの利用スタイルによって最適な設定が異なる。

| ポリシー | 動作 | 向いているユーザー |
|---|---|---|
| **none** | caffeinate なし。スリープしたらBridgeも止まるが、復帰時にlaunchdが自動再起動 | バッテリー節約重視。PCをデスクに置いて使うだけ |
| **idle**（現状） | `caffeinate -i`。アイドルスリープ防止。蓋を閉じると止まる | 基本的にPC開いたまま使う。外出中もSlackから使いたい |
| **always** | `caffeinate -i` + `sudo pmset -a disablesleep 1`。蓋を閉じても止まらない | 電車でPCを閉じてカバンに入れたままSlackから使いたい |

→ これをconfigファイルの設定1つで切り替えたい。plistの `ProgramArguments` やsystemdのExecStartに反映される形。

## 課題2: セットアップの進捗管理

セットアップは複数のステップから成る（.env作成、Slackアプリ設定、launchd登録、pmset設定など）。現状はセットアップスキルが一気に実行するが、以下の問題がある：

- 何が完了して何をスキップしたか記録されていない
- 途中で失敗した場合、どこから再開すべかわからない
- 後からスリープポリシーだけ変えたい場合、セットアップ全体を再実行する必要がある

→ configファイルで「各ステップの完了状態」と「ユーザーが選択した設定値」を管理すべきでは？

## 理想のイメージ

```jsonc
// ~/.claude-slack-pipe/bridge-config.json（例）
{
  "sleepPolicy": "idle",        // "none" | "idle" | "always"
  "setup": {
    "envCreated": true,
    "slackAppConfigured": true,
    "launchdRegistered": true,
    "pmsetConfigured": false     // sleepPolicy=always の場合のみ必要
  }
}
```

- スリープポリシーを変えたい → configの `sleepPolicy` を変更 → `cc /restart-bridge` で反映
- セットアップの再実行 → 未完了のステップだけ実行
- 設定の確認 → `cc /status` 等で現在のポリシーとセットアップ状態を表示
