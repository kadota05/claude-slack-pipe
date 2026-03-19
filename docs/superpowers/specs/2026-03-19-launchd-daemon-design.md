# launchdデーモン化 + `/restart-bridge` コマンド設計

## 背景と課題

SlackからBridgeの再起動を依頼すると、Claude CLIがCLAUDE.mdの手順に従い `kill $(cat ~/.claude-slack-pipe/claude-slack-pipe.pid)` を実行する。これにより**Bridgeプロセス自身が死亡**し、以下の症状が発生する：

- :brain: リアクションが除去されずSlack上で固まる
- ストリーミング更新が途絶える
- Claude CLIはorphanプロセスとして処理を完了するが、ユーザーには見えない
- 新Bridgeの起動はClaude CLIのBash処理完了待ちで数分かかる

**根本原因:** Bridgeが自分を殺す指示を自分経由で実行している（自己参照パラドックス）。

## 解決方針

3つの変更を組み合わせて解決する：

1. **launchdデーモン化** — macOS標準のプロセスマネージャでBridgeを管理。`process.exit()` しても数秒で自動再起動
2. **`/restart-bridge` botコマンド** — Bridgeが全クリーンアップを完了してから `process.exit(0)` する安全な再起動経路
3. **PIDファイル廃止** — Claude CLIが `kill $(cat ...pid)` で自殺する経路を物理的に断つ

## 詳細設計

### 1. launchd plistテンプレート

ファイル: `launchd/com.user.claude-slack-pipe.plist.template`（リポジトリに含める）
生成先: `~/Library/LaunchAgents/com.user.claude-slack-pipe.plist`（セットアップ時に生成）

テンプレートでは `{{PROJECT_DIR}}`, `{{DATA_DIR}}`, `{{NODE_PATH}}` をプレースホルダとし、セットアップスクリプトで `which node` やプロジェクトパスを埋め込んで生成する。

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
    <string>{{NODE_PATH}}</string>
    <string>{{PROJECT_DIR}}/node_modules/.bin/tsx</string>
    <string>src/index.ts</string>
  </array>

  <key>WorkingDirectory</key>
  <string>{{PROJECT_DIR}}</string>

  <key>KeepAlive</key>
  <true/>

  <key>RunAtLoad</key>
  <true/>

  <key>StandardOutPath</key>
  <string>{{DATA_DIR}}/bridge.stdout.log</string>

  <key>StandardErrorPath</key>
  <string>{{DATA_DIR}}/bridge.stderr.log</string>

  <key>ThrottleInterval</key>
  <integer>5</integer>

  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin</string>
    <key>MANAGED_BY_LAUNCHD</key>
    <string>1</string>
  </dict>
</dict>
</plist>
```

設計判断:
- `npx` はlaunchd環境でPATH解決が不安定なため、`node` と `tsx` の絶対パスを使用
- `caffeinate -i` はProgramArgumentsに含めてスリープ防止を引き継ぐ
- `.env` はアプリ内で `dotenv` で読み込み、plistにトークンを書かない
- `ThrottleInterval: 5` でクラッシュループ時に5秒間隔を確保
- `MANAGED_BY_LAUNCHD=1` 環境変数でアプリ側がlaunchd管理下かどうかを判別
- パスはテンプレートのプレースホルダでセットアップ時に埋め込み（ハードコード回避）

### 2. `/restart-bridge` botコマンド

**command-parser.ts の変更:**

`BOT_COMMANDS` に `restart-bridge` を追加：
```typescript
const BOT_COMMANDS = new Set(['end', 'status', 'restart', 'restart-bridge']);
```

**index.ts の変更:**

`handleMessage` 内の bot_command 分岐に追加。`restart-bridge` は特定セッションではなくBridge全体の操作のため、`indexEntry` チェックの**前**に配置する：

```
parsed.command === 'restart-bridge' の場合:
  1. admin権限チェック — adminでなければ拒否（ephemeral）
  2. Slackに「🔄 Bridgeを再起動します」を投稿
  3. 既存の shutdown() ロジックを呼び出し
     - 全アクティブセッション終了
     - トンネル停止
     - app.stop()
  4. process.exit(0)
  5. launchdが自動で再起動
```

ユーザーはSlackで `cc /restart-bridge` と送信する（Slackがスラッシュコマンドとして解釈するのを防ぐため `cc` プレフィックスを使用）。

### 3. PIDロックの段階的廃止

PIDロックは即座に削除せず、段階的に移行する：

- `MANAGED_BY_LAUNCHD=1` 環境変数がある場合: PIDロックをスキップ（launchdがシングルトンを保証）
- 環境変数がない場合: 従来通りPIDロックを使用（手動起動 / `npm run dev` 対応）

```typescript
if (!process.env.MANAGED_BY_LAUNCHD) {
  pidLock = acquirePidLock(config.dataDir);
}
```

PIDファイルに自プロセスのPIDを書かないことで、Claude CLIが `kill $(cat ...pid)` で自殺する経路を断つ。

### 4. クラッシュループ防止

`KeepAlive: true` + 起動直後のクラッシュが無限ループするのを防ぐため、アプリ側にサーキットブレーカーを実装する。

`~/.claude-slack-pipe/crash-history.json` に直近の起動タイムスタンプを記録し、短時間に連続クラッシュした場合は `process.exit(0)` で自ら停止：

```
起動時:
  1. crash-history.json から直近の起動履歴を読む
  2. 直近5回が全て30秒以内にクラッシュ → ログ出力して process.exit(0)
  3. 正常なら現在時刻を追記して続行
```

### 5. ログローテーション

launchdの `StandardOutPath` / `StandardErrorPath` は追記モードのため、ログが肥大化する。

アプリ側の対策として、Bridge起動時にログファイルのサイズをチェックし、一定サイズ（例: 10MB）を超えていたら `.log.old` にリネームする簡易ローテーションを実装する。

### 6. ドキュメント更新

**CLAUDE.md:**
- 再起動手順を `cc /restart-bridge` に変更
- `kill $(cat ...pid)` の手順を完全に削除
- `caffeinate -i npx tsx src/index.ts` の手動起動手順を削除
- launchctlでの操作方法を記載

**setup.md:**
- タスク6（Bridge起動）をlaunchctl方式に変更:
  1. テンプレートからplistを生成（`which node` でパス解決）
  2. `~/Library/LaunchAgents/` に配置
  3. `launchctl bootstrap gui/$(id -u)` で起動
  4. ログファイルで起動確認

**README.md:**
- 起動方法セクションをlaunchd方式に更新

### 7. 変更しないもの

- `caffeinate -i` によるスリープ防止（plistのProgramArguments経由）
- 蓋閉じスリープ対策（`sudo pmset -a disablesleep 1` は手動）
- `.env` + `config.ts` の環境変数管理
- graceful shutdownのロジック（SIGTERM → セッション終了 → トンネル停止 → app.stop()）
- 既存の `/restart` コマンド（CLIセッションの再起動用、変更なし）

## 操作フロー（変更後）

### 初回セットアップ
```bash
# テンプレートからplistを生成（setup.mdが自動で行う）
# 生成されたplistは ~/Library/LaunchAgents/ に配置される

# 起動
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.user.claude-slack-pipe.plist
```

### Slackからの再起動（admin限定）
```
cc /restart-bridge
```

### 手動停止
```bash
launchctl bootout gui/$(id -u)/com.user.claude-slack-pipe
```

### ログ確認
```bash
tail -f ~/.claude-slack-pipe/bridge.stdout.log
tail -f ~/.claude-slack-pipe/bridge.stderr.log
```
