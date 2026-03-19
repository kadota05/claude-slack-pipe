# launchdデーモン化 + `/restart-bridge` コマンド設計

## 背景と課題

SlackからBridgeの再起動を依頼すると、Claude CLIがCLAUDE.mdの手順に従い `kill $(cat ~/.claude-slack-pipe/claude-slack-pipe.pid)` を実行する。これにより**Bridgeプロセス自身が死亡**し、以下の症状が発生する：

- :brain: リアクションが除去されずSlack上で固まる
- ストリーミング更新が途絶える
- Claude CLIはorphanプロセスとして処理を完了するが、ユーザーには見えない
- 新Bridgeの起動はClaude CLIのBash処理完了待ちで数分かかる

**根本原因:** Bridgeが自分を殺す指示を自分経由で実行している（自己参照パラドックス）。

## 解決方針

2つの変更を組み合わせて解決する：

1. **launchdデーモン化** — macOS標準のプロセスマネージャでBridgeを管理。`process.exit()` しても数秒で自動再起動
2. **`/restart-bridge` botコマンド** — Bridgeが全クリーンアップを完了してから `process.exit(0)` する安全な再起動経路
3. **PIDファイル廃止** — Claude CLIが `kill $(cat ...pid)` で自殺する経路を物理的に断つ

## 詳細設計

### 1. launchd plistファイル

ファイル: `launchd/com.user.claude-slack-pipe.plist`（リポジトリに含める）
配置先: `~/Library/LaunchAgents/com.user.claude-slack-pipe.plist`（シンボリックリンク or コピー）

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.user.claude-slack-pipe</string>

  <key>ProgramArguments</key>
  <array>
    <string>caffeinate</string>
    <string>-i</string>
    <string>npx</string>
    <string>tsx</string>
    <string>src/index.ts</string>
  </array>

  <key>WorkingDirectory</key>
  <string>/Users/archeco055/dev/claude-slack-pipe</string>

  <key>KeepAlive</key>
  <true/>

  <key>RunAtLoad</key>
  <true/>

  <key>StandardOutPath</key>
  <string>/Users/archeco055/.claude-slack-pipe/bridge.stdout.log</string>

  <key>StandardErrorPath</key>
  <string>/Users/archeco055/.claude-slack-pipe/bridge.stderr.log</string>

  <key>ThrottleInterval</key>
  <integer>5</integer>

  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin</string>
  </dict>
</dict>
</plist>
```

設計判断:
- `caffeinate -i` はProgramArgumentsに含めてスリープ防止を引き継ぐ
- `.env` はアプリ内で `dotenv` で読み込み、plistにトークンを書かない
- `ThrottleInterval: 5` でクラッシュループ時に5秒間隔を確保
- `PATH` にhomebrewパスを含める（`npx`, `node`, `claude` の解決に必要）

### 2. `/restart-bridge` botコマンド

**command-parser.ts の変更:**

`BOT_COMMANDS` に `restart-bridge` を追加：
```typescript
const BOT_COMMANDS = new Set(['end', 'status', 'restart', 'restart-bridge']);
```

**index.ts の変更:**

`handleMessage` 内の bot_command 分岐に追加：
```
parsed.command === 'restart-bridge' の場合:
  1. Slackに「🔄 Bridgeを再起動します」を投稿
  2. 既存の shutdown() ロジックを呼び出し
     - 全アクティブセッション終了
     - トンネル停止
     - app.stop()
  3. process.exit(0)
  4. launchdが自動で再起動
```

ユーザーはSlackで `cc /restart-bridge` と送信する（Slackがスラッシュコマンドとして解釈するのを防ぐため `cc` プレフィックスを使用）。

### 3. PIDロックの廃止

- `src/utils/pid-lock.ts` を削除
- `src/index.ts` から `acquirePidLock` の import と使用を除去
- `shutdown()` から `pidLock.release()` を除去
- `~/.claude-slack-pipe/claude-slack-pipe.pid` ファイルは不要になる

launchdが同一Labelのプロセスを1つしか起動しないため、シングルトン保証はlaunchdに委ねる。

### 4. ドキュメント更新

**CLAUDE.md:**
- 再起動手順を `cc /restart-bridge` に変更
- `kill $(cat ...pid)` の手順を完全に削除
- `caffeinate -i npx tsx src/index.ts` の手動起動手順を削除
- launchctlでの操作方法を記載

**setup.md:**
- タスク6（Bridge起動）をlaunchctl方式に変更:
  1. plistを `~/Library/LaunchAgents/` にシンボリックリンク
  2. `launchctl load` で起動
  3. ログファイルで起動確認

**README.md:**
- 起動方法セクションをlaunchd方式に更新

### 5. 変更しないもの

- `caffeinate -i` によるスリープ防止（plistのProgramArguments経由）
- 蓋閉じスリープ対策（`sudo pmset -a disablesleep 1` は手動）
- `.env` + `config.ts` の環境変数管理
- graceful shutdownのロジック（SIGTERM → セッション終了 → トンネル停止 → app.stop()）
- 既存の `/restart` コマンド（CLIセッションの再起動用、変更なし）

## 操作フロー（変更後）

### 初回セットアップ
```bash
# plistをシンボリックリンク
ln -s /Users/archeco055/dev/claude-slack-pipe/launchd/com.user.claude-slack-pipe.plist \
  ~/Library/LaunchAgents/com.user.claude-slack-pipe.plist

# 起動
launchctl load ~/Library/LaunchAgents/com.user.claude-slack-pipe.plist
```

### Slackからの再起動
```
cc /restart-bridge
```

### 手動停止
```bash
launchctl unload ~/Library/LaunchAgents/com.user.claude-slack-pipe.plist
```

### ログ確認
```bash
tail -f ~/.claude-slack-pipe/bridge.stdout.log
tail -f ~/.claude-slack-pipe/bridge.stderr.log
```
