# launchd PATH に claude CLI のパスが含まれず ENOENT

## 症状

`cc /restart-bridge` でBridgeを再起動した後、Slackからメッセージを送ると処理が完全に停止する。ログには `spawn claude ENOENT` が記録される。

## 根本原因

launchd の plist で設定した `EnvironmentVariables.PATH` に、fnm が管理する node の bin ディレクトリが含まれていなかった。

- 手動起動時: シェルの PATH（fnm の bin を含む）を継承 → `claude` が見つかる
- launchd 起動時: plist の PATH（`/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin`）のみ → `claude` が見つからない

`claude` CLI は `npm install -g @anthropic-ai/claude-code` で fnm 管理下の node にインストールされるため、そのパスは `/Users/<user>/.local/share/fnm/node-versions/<version>/installation/bin/` になる。

## 証拠

```
2026-03-19 12:13:35.873 [error] [bfdf49ae] process error {"error":"spawn claude ENOENT"}
```

launchd plist の PATH:
```
/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin
```

実際の claude のパス:
```
/Users/archeco055/.local/share/fnm/node-versions/v22.22.0/installation/bin/claude
```

## 修正内容

1. plist テンプレートの PATH に `{{NODE_BIN_DIR}}` プレースホルダーを追加
2. setup.md の sed コマンドで `NODE_BIN_DIR=$(dirname "$NODE_PATH")` を導出して置換
3. 実 plist にも直接パスを追加

## 教訓

- launchd はシェル環境を一切継承しない。fnm/nvm などの Node バージョンマネージャが管理するバイナリは、plist の PATH に明示的に追加する必要がある
- 手動起動で動くのに launchd 起動で動かない場合、まず PATH の差異を疑うこと
- node のパスだけでなく、node が管理するグローバルパッケージ（claude CLI など）のパスも必要
