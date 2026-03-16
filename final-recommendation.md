# Claude Code Slack Bridge — 最終推奨レポート

## 1. あなたが考えるべきこと

### P0 — 即座に決定すべきこと

**権限モードの選択: `--permission-mode auto` を採用せよ。**
`-p`モード（非対話的実行）では対話的な権限確認ができないため、`auto`以外を選ぶとツール実行がブロックされる。実機検証で動作確認済みであり、これがMVPの唯一の現実的選択肢である。セキュリティを強化したい場合は `--allowedTools` でホワイトリスト制御を上乗せする。

**セッション継続コマンドの形式: 新規は `--session-id <uuid>`、再開は `-r <uuid>` の排他的使用を採用せよ。**
Round 1で混乱があった2つのフラグの使い分けは、実機検証で完全に解消された。`--session-id`と`-r`は別の目的を持つフラグであり、同時使用は不要かつ未定義動作になる。Bridge実装のexecutorはこの排他パターンを厳守する必要がある。

**`CLAUDECODE`環境変数の除去: spawn時に `CLAUDECODE: undefined` を設定せよ。**
Claude Codeはネスト起動を禁止する仕組みを持つ。開発・テスト時にClaude Code内からBridgeを起動するとブロックされる。spawn時の環境変数から明示的に除外することで回避でき、実装コストはゼロに等しい。

### P1 — 1週間以内に決定すべきこと

**セッションあたりのコスト上限: デフォルト $2.00 を設定せよ。**
単純な1ワード応答でも約$0.035のコストが発生する（実測値）。Slack経由で誰でもClaude Codeを起動できる状態になるため、`--max-budget-usd`による安全弁は必須である。$2.00はコード編集タスクまでをカバーする現実的な上限であり、環境変数`MAX_BUDGET_PER_SESSION`で変更可能にする。

**同時実行セッション数の上限: デフォルト3を設定せよ。**
同一セッション内は直列化が必須（セッションファイルの競合回避）だが、異なるセッション間は並行実行できる。上限3はローカルマシンのリソース消費とCLI実行の安定性のバランスを取った値である。

**stream-json対応はPhase 2に延期せよ。**
`--output-format stream-json`には`--verbose`フラグが必須という未文書の制約が実機検証で発見された。MVPでは`--output-format json`で十分であり、Phase 2でstream-json + Slackの`chat.update`によるリアルタイム表示を実装するのが合理的である。

### P2 — ロードマップとして記録すべきこと

**`claude mcp serve`モードへの移行検討はPhase 4以降。**
MCPプロトコルは構造化されたインターフェースを提供するが、安定性が未検証であり、サーバー起動+クライアント実装というオーバーヘッドがある。`-p`モードで十分にMVPの要件を満たせるため、将来のアーキテクチャ進化候補として記録にとどめる。

**ファイルアップロード対応（Slack→Claude Code方向）はPhase 4以降。**
ユーザーがSlackにファイルを添付した場合のハンドリングは未定義である。Slack Files APIでファイル取得→一時ディレクトリ保存→`--add-dir`参照という流れが想定されるが、MVPスコープ外で問題ない。

---

## 2. 推奨アーキテクチャ

### インフラ・ランタイム

TypeScript + Bolt for JS + Socket Modeの組み合わせを採用する。Claude Code自体がTypeScript製であり、Bolt for JSはSlack公式SDKで最も成熟しているため、エコシステムの一貫性とサポートの安定性で優位である。Socket ModeはパブリックURLが不要であり、ファイアウォール内やローカルマシンでの運用に適する。Node.js 20以上を要件とし、ESModule形式で構成する。

### プロセス管理・セッション管理

都度起動モデル（メッセージごとに`claude -p`をspawn）を採用する。Claude Codeが`--session-id`によるセッション永続化をファイルシステム上で行うため、Bridge側でプロセスを常駐させる必要がない。状態管理にはSQLite（better-sqlite3）を使用し、`channel_workdir`、`thread_session`、`active_process`の3テーブルで構成する。スレッドとセッションの1:1マッピングにより、チャンネル直下メッセージが新規セッション、スレッド内返信がセッション継続となる。

### UI・レスポンス設計

2段階レスポンスパターンを採用する。即時ackとリアクション絵文字（⏳）で受理を通知し、非同期でclaude実行後に結果をスレッドに投稿し、リアクションを✅に更新する。長文出力は3段階で処理する: 4,000文字以下は単一メッセージ、4,000〜40,000文字はMarkdown見出し・コードブロック境界で分割、40,000文字超はファイルアップロード。Markdown→Slack mrkdwn変換はコードブロック外にのみ適用する。コマンド体系は`cc /xxx`テキストベースとし、Slackの`/`コマンドとの衝突を回避する。

### セキュリティ・コスト制御

`--permission-mode auto`をデフォルトとし、`--max-budget-usd`でセッションあたりのコスト上限を設定する。MVPでは単一チャンネル固定（環境変数で指定）とすることで、意図しないチャンネルでの応答を防ぐ。spawn時に`CLAUDECODE`環境変数を除去してネスト禁止チェックを回避する。

---

## 3. 深い戦略的インサイト

このプロジェクトの本質的な価値は、「Slackのスレッドモデル」と「Claude Codeのセッションモデル」が構造的に一致するという発見にある。多くのAIチャットブリッジは会話状態を自前で管理しようとして複雑化するが、Claude Codeの`--session-id`/`-r`によるファイルベースのセッション永続化は、Bridge側の責務を「マッピングテーブルの管理」だけに限定させる。これにより、都度起動モデルというもっともシンプルなアーキテクチャが成立し、プロセス管理・障害復旧・スケーリングの複雑性を大幅に削減できる。常駐プロセスモデルが持つメモリリーク・コネクション管理・graceful shutdownの問題をすべて回避できることの工学的価値は大きい。

もう一つの重要な洞察は、CLIツールの未文書の挙動が統合設計の成否を左右するという点である。`stream-json`に`--verbose`が必須であること、`CLAUDECODE`環境変数によるネスト禁止、セッションIDにUUID v4小文字が必要であること — これらはいずれもドキュメントからは読み取れず、実機検証で初めて判明した。2ラウンドの議論で、仕様調査→矛盾検出→実機検証というサイクルを回したことで、P0級の設計ミスを実装前に4件すべて解消できた。この「設計段階での実機検証」は、外部CLIをラップするプロジェクトにおいて必須のプラクティスである。

最後に、このBridgeは将来的に「Slack AI Streaming API」（2025年10月リリース）と`--output-format stream-json`を組み合わせることで、ネイティブAIアプリと同等のリアルタイム体験を提供できる可能性を持つ。MVPをjson出力で堅実に構築し、Phase 2以降でストリーミング対応を追加するという段階的アプローチは、現時点で最もリスクが低く、将来の拡張余地が最も大きい戦略である。

---

## 4. 即時アクション順序

1. **Slack App作成とトークン取得**（30分）— Socket Mode有効化、Bot Token Scopes設定、Event Subscriptions設定。他のすべての実装と並行可能。

2. **プロジェクト基盤構築**（0.5日）— `npm init`、TypeScript/Vitest設定、zod環境変数バリデーション、Winstonロガー、型定義。ここで`.env.example`のテンプレートも作成する。

3. **Storeレイヤー実装**（0.5日）— SQLite接続と3テーブル（`channel_workdir`、`thread_session`、`active_process`）のCRUD。単体テストで動作確認。

4. **Bridge Coreレイヤー実装**（1日）— ClaudeExecutor（`--session-id`/`-r`排他、`--permission-mode auto`、`--max-budget-usd`）、SessionManager（resolveOrCreate）、SessionQueue（セッション内直列・セッション間並行）。これが最も重い実装フェーズ。

5. **Slackレイヤー実装**（0.5日）— CommandParser（`cc /xxx`検出）、ResponseBuilder（mrkdwn変換+長文分割）、EventHandler（message/app_mentionハンドラ、2段階レスポンス）。

6. **統合・E2Eテスト**（0.5日）— `src/index.ts`でBolt App初期化、手動E2Eテスト（新規メッセージ→応答、スレッド継続、`cc /commit`、タイムアウト、エラー表示）、起動時orphanプロセス検出の実装。

合計見積もり: 3日（1人の場合）。

---

## 5. 一文での最終回答

TypeScript + Bolt(Socket Mode)で都度起動モデルのBridgeを構築し、`claude -p --session-id/--r --permission-mode auto --output-format json`でSlackスレッドとClaude Codeセッションを1:1マッピングせよ — これが最小の複雑性で最大の拡張性を持つ設計である。
