# シナリオベーステスト仕様書

## メタ情報
| 項目 | 値 |
|---|---|
| プロジェクト | claude-slack-pipe (Claude Code Slack Bridge) |
| ブランチ | feat/launchd-daemon |
| 生成日時 | 2026-03-23 |
| ブランチ時間範囲 | 2026-03-19 01:58 ~ 2026-03-19 12:54 |
| 対象セッション数 | 6 |
| 設計書・計画書 | `docs/superpowers/specs/2026-03-19-launchd-daemon-design.md`, `docs/superpowers/plans/2026-03-19-launchd-daemon.md` |
| 利用シーン数 | 11（うちブランチに直接関連: 7） |
| 生成シナリオ数 | 16 |

## プロジェクト概要

Claude Code Slack Bridgeは、SlackのDMからローカルPCのClaude Code CLIを操作するツール。Node.js親プロセスがSocket ModeでSlackと接続し、受信メッセージを子プロセスのClaude CLI（`claude -p`）にstdinで渡し、stdoutの応答をSlackに返す。macOS launchdデーモンとして常時起動され、KeepAliveによるクラッシュ復旧、caffeinate -iによるスリープ防止が組み込まれている。主なユーザーはPCを持ち歩きながらスマホのSlackから遠隔でClaude Codeを使う開発者。

## ブランチ進化サマリ

ブランチの主目的はBridgeプロセスのlaunchdデーモン化。Claude CLIがBridgeを`kill`して自殺する問題を根本解決するために、プロセス管理をlaunchdに委譲し、`/restart-bridge` botコマンドで安全な再起動手段を提供した。計画では「PIDロックの段階的廃止」「手動起動パスの維持」としていたが、実装後に launchd-only管理に一本化する方針転換を行った。修正フェーズでは KeepAlive: true と exit(0) の相互作用（設計想定ミス）、launchd環境のPATH問題（fnm/nvmバイナリ不在）が発見・修正された。

## 利用シーン

ブランチに直接関連する利用シーン:
1. **Slackから `/restart-bridge` でBridgeを再起動する** — admin権限チェック → graceful shutdown → process.exit(0) → launchd再起動 → restart-pending.jsonで完了通知
2. **PC起動時にBridgeが自動で立ち上がる** — launchd RunAtLoad → caffeinate -i → crash-history記録 → Socket Mode接続
3. **Bridgeがクラッシュしても自動復旧する** — KeepAlive: true → ThrottleInterval: 5 → crash-history → サーキットブレーカー（60秒/5回→5分sleep）
4. **外出先からスマホでコード修正を指示する** — launchd管理下でのメッセージ受信・処理フロー
5. **PCの蓋を閉じてカバンに入れたまま長時間使う** — caffeinate -iの動作範囲とスリープポリシー
6. **localhostリンクのトンネル変換** — トンネルURL分割バグ修正、mrkdwnリンク修正
7. **ホームタブの再起動ボタンからBridgeを再起動する** — ※ブランチ範囲外（テスト対象外）

## セッションから読み取れた主要な議論

- **自殺パラドックスの発見と議論**: ユーザーが「Slackからbridge再起動すると:brain:のまま固まる」と報告。Claude CLIがBashで`kill`を実行 → Bridge死亡 → Slack切断の因果関係を特定
- **プロセスマネージャの比較検討**: pm2、watchdog分離、ゼロダウンタイムリスタート（ソケット移譲）、launchdの4案を議論。launchdの圧倒的シンプルさで決定
- **KeepAlive: trueの設計想定ミス**: boolean値の場合、exit codeに関係なく再起動する仕様。サーキットブレーカーが機能しない問題が実機テストで発覚
- **launchd PATHの盲点**: nodeのパスはplistに入れていたが、nodeが管理するグローバルパッケージ（claude CLI）のパスを入れ忘れ。`spawn claude ENOENT`エラー
- **PIDロック廃止の方針転換**: 計画の「段階的廃止」から「完全削除」へ。手動起動パスを残すとkill経路が残り根本解決にならないという判断
- **Bridge再起動のCLI実行禁止**: ユーザーが「再起動しようとしてbashで止まった」と報告。Claude CLIからの再起動Bashコマンド実行を絶対禁止ルールに
- **スリープポリシーの議論**: none/idle/alwaysの3択をconfigで管理したい。セットアップの進捗管理も含めた将来課題として記録

---

## シナリオ一覧

#### S01: /restart-bridge実行中にSlackメッセージが到着する
- **利用シーン**: Slackから `/restart-bridge` でBridgeを再起動する
- **前提**: Bridgeが正常稼働中。他のユーザーがセッションを持っていない状態
- **操作**: (1) `cc /restart-bridge` を送信 (2) graceful shutdown開始直後〜process.exit(0)の間に別メッセージを送信
- **期待**: (a) 再起動前のメッセージに対して「再起動中」の応答が返るか、メッセージがドロップされる（エラーにはならない） (b) 再起動完了後に送ったメッセージは正常に処理される (c) restart-pending.jsonに基づく「再起動完了」メッセージが元のスレッドに投稿される
- **導出根拠**: (d) 利用シーン「/restart-bridge」のシステム状態遷移で、shutdown中のメッセージ受信が未定義。graceful shutdownは全セッション終了→app.stop()だが、app.stop()前にSocket Modeがまだ生きている間にメッセージが来る可能性

#### S02: restart-pending.jsonが破損・欠損している状態での起動
- **利用シーン**: Slackから `/restart-bridge` でBridgeを再起動する
- **前提**: restart-pending.jsonが手動削除、パーミッション異常、または不正なJSON
- **操作**: (1) restart-pending.jsonを削除 (2) `cc /restart-bridge` を送信 (3) 再起動完了を待つ
- **期待**: (a) Bridgeは正常に起動する（restart-pending.jsonの読み込みエラーでクラッシュしない） (b) 「再起動完了」メッセージは投稿されない（情報がないため）が、Bridge自体は正常動作する (c) (a)(b)が満たされればPASS。warningログが出力されていれば品質の上乗せとして記録する
- **導出根拠**: (c) コミット0da7257で計画外に追加されたrestart-pending.json機構。設計レビューを経ていないためエラーハンドリングが不十分な可能性（計画外の追加機能パターン）

#### S03: admin権限のないユーザーが/restart-bridgeを実行する
- **利用シーン**: Slackから `/restart-bridge` でBridgeを再起動する
- **前提**: Bridgeが正常稼働中。あるスレッドで他セッションがアクティブ（:brain:表示中）。admin以外のSlackユーザーが存在する
- **操作**: admin以外のユーザーが `cc /restart-bridge` を送信
- **期待**: (a) 権限エラーメッセージが返される (b) Bridgeは再起動しない (c) アクティブなセッションの:brain:リアクションが維持され、処理が継続する
- **導出根拠**: (b) セッション「デバッグ結果まとめ」でadmin権限チェック付きと議論。設計書にも「admin権限チェック後」と明記

#### S04: サーキットブレーカー発動中にユーザーがSlackを使おうとする
- **利用シーン**: Bridgeがクラッシュしても自動復旧する + /restart-bridge
- **前提**: crash-history.jsonに60秒以内の5件のタイムスタンプ（Date.now()形式のミリ秒数値配列）を直接書き込んでサーキットブレーカーを強制発動させる（例: `now=$(date +%s)000; echo "[$((now-4000)),$((now-3000)),$((now-2000)),$((now-1000)),$now]" > ~/.claude-slack-pipe/crash-history.json`）。その後Bridgeを起動させるとsleepに入る
- **操作**: (1) sleep中にユーザーがSlackでメッセージを送信 (2) 5分後のsleep明けを待つ (3) Bridgeが再起動した後に再度メッセージを送信
- **期待**: (a) sleep中はSocket Mode接続がないため、メッセージは受信されない（応答なし） (b) 5分後にBridgeが再起動し、Socket Mode接続を確立する (c) 再起動後にメッセージを送信すると正常に処理される
- **導出根拠**: (d) 利用シーン「クラッシュ自動復旧」と「/restart-bridge」の掛け合わせ。サーキットブレーカーsleep中のユーザー体験が未定義

#### S05: PC起動時にcrash-history.jsonに過去のクラッシュ記録が残っている
- **利用シーン**: PC起動時にBridgeが自動で立ち上がる
- **前提**: crash-history.jsonに4件のタイムスタンプが残っているが、全て数時間前のもの
- **操作**: PC起動 → launchdがBridgeを自動起動
- **期待**: (a) 数時間前のクラッシュ記録は60秒の閾値を超えているため、サーキットブレーカーは発動しない (b) 古いクラッシュ記録が閾値チェックで無視される (c) Bridgeが正常に起動してSocket Mode接続を確立する
- **導出根拠**: (c) コミットdb7a3f3「60秒以内に5回クラッシュ」のロジック。60秒の時間窓が正しく機能するかの境界値テスト

#### S06: fnmバージョン変更後にplistのパスが不整合になる
- **利用シーン**: PC起動時にBridgeが自動で立ち上がる
- **前提**: fnmでNodeのバージョンを切り替え（例: v22 → v23）した後、plistの{{NODE_PATH}}が旧バージョンのパスのまま
- **操作**: (1) `fnm use v23` でNodeバージョンを変更 (2) PC再起動 or launchd再起動
- **期待**: (a) plistのNODE_PATHが旧バージョンのパスを指しているためBridge起動に失敗する (b) エラーログに「nodeが見つからない」旨が記録される (c) nodeバイナリが存在しないためアプリケーション層のサーキットブレーカーは機能しない。ただしplistのThrottleInterval(5秒)により低頻度リトライに制限され、CPU暴走は防止される
- **導出根拠**: (a) セッションの議論「fnm/nvmのシンボリックリンク問題」+ 知見ファイル2026-03-19-launchd-path-missing-claude-cli.md。バージョン切り替え後にplistの再生成を忘れるケースは未対処

#### S07: claude CLIが見つからず ENOENT
- **利用シーン**: 外出先からスマホでコード修正を指示する
- **前提**: Bridgeは起動しているが、claude CLIが削除されたかfnmバージョン切り替えでパスが変わった
- **操作**: (1) Slackからメッセージを送信 (2) BridgeがClaude CLIをspawnしようとする
- **期待**: (a) `spawn claude ENOENT` エラーが発生 (b) エラーがユーザーに分かる形でSlackスレッドに投稿される (c) Bridgeプロセス自体はクラッシュしない（個別セッションのエラーとして処理される）
- **導出根拠**: (b) セッション「ログに `spawn claude ENOENT`」。実際に発生した事象。修正後も、claude CLIのパスが変わる可能性は常にある

#### S08a: caffeinate -iがアイドルスリープを防止しているか（蓋開け・放置）
- **利用シーン**: PCの蓋を閉じてカバンに入れたまま長時間使う
- **前提**: macOSデフォルト設定（disablesleep未設定）。PCの蓋は開いた状態。launchdでBridgeが稼働中
- **操作**: (1) PCの蓋を開けた状態で30分以上放置する (2) スマホからSlackでメッセージを送信
- **期待**: (a) `caffeinate -i` によりアイドルスリープが防止されている (b) Bridgeが応答する（Socket Mode接続が維持されている） (c) `pmset -g assertions` でcaffeinate由来のアサーションが確認できる
- **導出根拠**: (d) 利用シーン「蓋閉じ長時間利用」のシステム状態遷移。caffeinate -iがProgramArgumentsに含まれているが、実際にアイドルスリープ防止として機能しているかの直接検証

#### S08b: 蓋閉じスリープからの復帰後にBridgeが正常復帰するか（disablesleep未設定）
- **利用シーン**: PCの蓋を閉じてカバンに入れたまま長時間使う
- **前提**: macOSデフォルト設定（disablesleep未設定）。caffeinate -iはアイドルスリープのみ防止し、蓋閉じスリープは防止できない
- **操作**: (1) PCの蓋を閉じる → macOSスリープ発動 (2) 10分後に蓋を開ける (3) スマホからSlackでメッセージを送信
- **期待**: (a) 蓋閉じでmacOSがスリープし、Bridgeプロセスもsuspendされる（これは正常動作） (b) 蓋開け後にmacOSが復帰し、Bridgeプロセスも復帰する (c) Socket Mode WebSocket接続が自動再接続される (d) メッセージが受信・処理される。ただし、スリープ中に送られたメッセージは配信保証なし
- **導出根拠**: (d) 利用シーン「蓋閉じ」のシステム状態遷移。launchd管理下でのスリープ→復帰時のSocket Mode再接続が正しく動作するかの検証

#### S09: /restart-bridge中にアクティブなCLIセッションがある
- **利用シーン**: Slackから `/restart-bridge` でBridgeを再起動する + 外出先からスマホでコード修正
- **前提**: あるスレッドでClaude CLIが処理中（:brain:リアクション表示中）
- **操作**: (1) 処理中のスレッドがある状態で `cc /restart-bridge` を別スレッド or 新DMで送信
- **期待**: (a) graceful shutdownで全セッションが終了される (b) 処理中のスレッドの:brain:リアクションが除去される（または✅に変更される） (c) 再起動後に同じスレッドで新しいメッセージを送ると新規セッションとして処理される（graceful shutdownがセッション永続化を保証するものではない） (d) 再起動完了メッセージが投稿される
- **導出根拠**: (b) セッション「自殺パラドックスの発見」でin-memoryステートのリセット問題が議論された。graceful shutdown時に:brain:リアクションの除去が確実に行われるか

#### S10: ログファイルが10MBを超えた状態での起動
- **利用シーン**: PC起動時にBridgeが自動で立ち上がる
- **前提**: bridge.stdout.logが15MB、bridge.stderr.logが5MB、bridge.stdout.log.oldが5MBのファイルとして既に存在する状態
- **操作**: Bridgeが起動（launchd or /restart-bridge）
- **期待**: (a) bridge.stdout.logがbridge.stdout.log.oldにリネームされる（既存の.oldは上書きされる） (b) bridge.stderr.logは10MB未満なのでそのまま (c) 新しいbridge.stdout.logが作成され、以降のログが書き込まれる (d) 上書き前の.oldファイル（5MB）は失われる
- **導出根拠**: (c) コミットbc791b0「10MB超でローテーション」。ローテーションの境界条件と.old上書き挙動

#### S11: トンネルURLを含む応答がSlackに正しく表示される
- **利用シーン**: localhostリンクのトンネル変換
- **前提**: cloudflaredがインストール済み。Claude CLIが`npx serve`等でlocalhostサーバーを起動可能な状態
- **操作**: (1) Slackから「簡単なHTMLファイルを作って`npx serve`で表示して」と送信 (2) 応答のSlackメッセージにリンクが表示されるのを待つ
- **期待**: (a) localhostのURLがCloudflareトンネルURLに書き換えられている (b) リンクがクリック可能な形式（Slack mrkdwn `<url|text>` 形式）で表示される (c) リンクをクリックするとトンネル経由でlocalhostのコンテンツが表示される。もしチャンク分割による検知漏れが自然に再現されない場合は、コードレビューで`localhost-rewriter`の全バッファスキャン実装を確認する
- **導出根拠**: (b) セッション中のバグ修正（コミット3fec189、2b71eb9）。ストリーミングチャンク境界でのURL検知漏れとSlack mrkdwnリンクの4層バグが実際に発生した問題

#### S12: setup.md実行時にfnm/nvmの一時パスが正しく解決される
- **利用シーン**: PC起動時にBridgeが自動で立ち上がる（前提としてのセットアップ）
- **前提**: ユーザーがfnmでNodeを管理している環境。初回セットアップ
- **操作**: (1) セットアップスキルを実行 (2) plistテンプレートにNODE_PATH、NODE_BIN_DIRが展開される (3) `cat ~/Library/LaunchAgents/com.user.claude-slack-pipe.plist` で展開結果を確認
- **期待**: (a) NODE_PATHが永続パスで設定されている（`fnm_multishells/XXXXX/bin/node` ではなく `fnm/node-versions/<version>/installation/bin/node`） (b) NODE_BIN_DIRにclaude CLIのパスが含まれる (c) `ls -la <NODE_PATH>` でファイルが存在し、PC再起動後も有効
- **導出根拠**: (b) コミット72c038eの修正内容 + セッション「fnm/nvmのシンボリックリンク問題」

#### S13: /restart-bridgeとサーキットブレーカーの相互作用
- **利用シーン**: /restart-bridge + クラッシュ自動復旧
- **前提**: crash-history.jsonに60秒以内の3件のクラッシュ記録がある
- **操作**: (1) ユーザーが `cc /restart-bridge` を実行 (2) 再起動完了を待つ (3) crash-history.jsonの内容を確認
- **期待**: (a) /restart-bridge はcrash-history.jsonをクリアしてからprocess.exit(0)する (b) 次の起動時にサーキットブレーカーが誤発動しない (c) crash-history.jsonが空またはクリアされた状態になっている
- **導出根拠**: (b) コミット1a118b3で「restart-bridge コマンド実行時にcrash historyをクリア」が追加。計画外の修正（修正コミットの背景パターン）

#### S14: PIDロック廃止後に2つのBridgeプロセスが同時起動する
- **利用シーン**: PC起動時にBridgeが自動で立ち上がる
- **前提**: PIDロックが完全廃止されている（コミット0da7257）。launchdでBridgeが稼働中
- **操作**: (1) launchdでBridgeが稼働中であることを確認 (2) ターミナルから手動で `npx tsx src/index.ts` を実行
- **期待**: (a) 2つのBridgeプロセスが同時にSocket Mode接続を確立する (b) 同じSlackメッセージに対して2つの返信が投稿されるか、片方のプロセスにのみメッセージが配信される — いずれの挙動かを記録する (c) `ps aux | grep tsx` で2つのPIDが確認できる (d) 手動プロセスを`Ctrl+C`で終了し、launchdプロセスが引き続き正常に動作することを確認
- **導出根拠**: (a) 計画では「PIDロック段階的廃止（手動時は維持）」だったが、完全削除された（計画からの方針転換パターン）。手動起動の安全網が失われた

#### S15: クラッシュ後のThrottleInterval動作確認
- **利用シーン**: Bridgeがクラッシュしても自動復旧する
- **前提**: Bridgeがlaunchdで稼働中
- **操作**: (1) `kill -9 <bridge_pid>` でBridgeプロセスを強制終了 (2) `log show --predicate 'process == "launchd"' --last 30s | grep claude-slack-pipe` でlaunchdの再起動ログを確認 (3) 再起動後のPIDと起動時刻を記録
- **期待**: (a) launchdがBridgeを自動再起動する (b) ThrottleInterval: 5により、kill後5秒以内にはプロセスが再起動しない (c) 5秒経過後にプロセスが起動する (d) 再起動後のBridgeが正常にSocket Mode接続を確立する
- **導出根拠**: (d) ブランチの「存在する機能」にThrottleInterval: 5が明記。クラッシュ復旧のタイミングがユーザー体験（応答遅延）に直結

#### S16: /restart-bridge後にlaunchdがexit(0)で確実に再起動するか
- **利用シーン**: Slackから `/restart-bridge` でBridgeを再起動する
- **前提**: BridgeがlaunchdのKeepAlive: true（boolean値）で管理されている
- **操作**: (1) 再起動前のPIDを `launchctl list | grep claude-slack-pipe` で記録 (2) `cc /restart-bridge` を送信 (3) 10秒後に `launchctl list | grep claude-slack-pipe` で新PIDを確認
- **期待**: (a) /restart-bridge でprocess.exit(0)が実行される (b) launchdがKeepAlive: trueによりプロセスを再起動する（exit codeに関係なく） (c) 新しいPIDでBridgeが起動している (d) 旧PIDと新PIDが異なる
- **導出根拠**: (b) セッション「KeepAlive: trueの設計想定ミス」。exit(0)後のlaunchd再起動がこのブランチの根幹的な変更の前提

---

## 導出根拠サマリ
| # | シナリオ | 利用シーン | 根拠カテゴリ | 情報源 |
|---|---|---|---|---|
| S01 | /restart-bridge中のメッセージ到着 | /restart-bridge | d) 利用シーン×変更 | graceful shutdownのタイミング |
| S02 | restart-pending.json破損 | /restart-bridge | c) 計画外追加機能 | コミット0da7257 |
| S03 | 非admin /restart-bridge | /restart-bridge | b) セッション議論 | 設計書のadmin認証要件 |
| S04 | サーキットブレーカーsleep中の操作 | クラッシュ復旧×/restart-bridge | d) 利用シーン×変更 | ブレーカー発動中のUX |
| S05 | 古いcrash-historyでの起動 | PC起動自動立ち上がり | c) コミットdiff | db7a3f3の60秒閾値 |
| S06 | fnmバージョン変更後のplist不整合 | PC起動自動立ち上がり | b) セッション発見 | fnm/nvm問題 |
| S07 | claude CLI ENOENT | 外出先コード修正 | b) セッション発見 | ENOENT実発生 |
| S08a | caffeinate -iアイドルスリープ防止 | 蓋閉じ長時間利用 | d) 利用シーン×変更 | caffeinate動作範囲 |
| S08b | 蓋閉じ復帰後のSocket Mode | 蓋閉じ長時間利用 | d) 利用シーン×変更 | launchd下のスリープ復帰 |
| S09 | セッション処理中の/restart-bridge | /restart-bridge×コード修正 | b) セッション議論 | 自殺パラドックス |
| S10 | 10MB超ログローテーション | PC起動自動立ち上がり | c) コミットdiff | bc791b0 |
| S11 | トンネルURLリンク表示 | localhostトンネル | b) セッション発見 | コミット3fec189/2b71eb9 |
| S12 | fnmパスのrealpath解決 | セットアップ→PC起動 | b) セッション発見 | コミット72c038e |
| S13 | /restart-bridgeとcrash-history | /restart-bridge×クラッシュ復旧 | a) 修正コミット背景 | コミット1a118b3 |
| S14 | 重複プロセス起動 | PC起動×手動起動 | a) 計画vs実装乖離 | PIDロック完全削除 |
| S15 | ThrottleInterval動作確認 | クラッシュ自動復旧 | d) 利用シーン×変更 | plistのThrottleInterval: 5 |
| S16 | exit(0)後のlaunchd再起動確認 | /restart-bridge | b) セッション議論 | KeepAlive設計想定ミス |

## レビュー結果

### Strengths（3項目）

1. **計画vs実装の乖離を体系的に網羅**: 6項目の乖離を全てシナリオに落とし込み、「計画と異なるものが安全か」を問う設計になっている
2. **ブランチ境界の管理が正確**: ブランチ範囲外シーン（ホームタブ再起動ボタン等）を明示的に除外
3. **再現性が高い前提条件**: ファイルシステム操作で再現可能な前提が多い

### Issues

#### Critical — 修正済み
- C-1 (S08): caffeinate -iの動作範囲を正確に反映し、S08a（アイドルスリープ防止検証）とS08b（蓋閉じ復帰検証）に分割
- C-2 (S14): 「望ましい」を削除し、観測可能な挙動（2返信 or 片方配信）の記録に変更

#### Important — 修正済み
- I-1 (S09): resume期待を「新規セッションとして処理」に修正
- I-2 (S04): crash-history直接書き込みの再現手順を追加
- I-3 (S11): 再現手順を自然発生ケースに簡略化、代替としてコードレビュー手段を追記
- Minor 3件（S03の前提追加、S10の.old既存追加、S02のwarning表現修正）も反映

### Missing Scenarios — 追加済み
- S15: ThrottleInterval=5の動作確認
- S16: KeepAlive exit(0)再起動確認

### Assessment
Approve — Critical 0件（2件とも修正済み）。16シナリオでブランチの変更をカバー。
