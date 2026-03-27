# チャネル = AI-Nativeアプリケーション 設計書

## 概要

Slack チャネルを1つの AI-Native アプリケーションとして扱うアーキテクチャ。
従来の「プログラムにAIを組み込む」モデルから「AIにスキル(機能)を組み込む」モデルへ転換し、
DM側のリッチなストリーミングUX（thinking表示、ツール状態、リアクション遷移）を
チャネルでも再利用する。

## AI-Native パラダイムマッピング

| 従来システム | AI-Native | 実体 |
|---|---|---|
| OS/Runtime | Claude CLI | PersistentSession |
| App全体 | Channel Directory | 構成ファイルの束 |
| コアロジック | CLAUDE.md | 仕様+ルール（自然言語） |
| Feature/Module | Skill (.md) | 機能単位（自然言語） |
| 関数+API+Data | ツール群 | 組込(Read,Bash等) + 既存MCP + 自作MCP |
| コード修正 | md編集 | = deploy（即時反映） |
| Config | settings.json | ツール+モデル設定（PJ限定） |
| Cron | schedule.json | 定時トリガー定義 |
| UI/Logs | Streaming UX | リアクション+bundle表示 |

### パラダイムの核心

- **Skill = 機能（モジュール）** — 「何をどういう手順でやるか」を自然言語で定義。中で複数のツールを使う
- **ツール(MCP含む) = 操作** — Read, Bash, Slack MCP, 自作MCP等。全て同じ「ツール」カテゴリ。MCPは実装の仕組みであり概念上の区別はない
- **Memory はアプリ層の概念ではない** — DM側の人間適応レイヤーとして別枠。チャネルアプリの構成要素には含まない

## チャネルプロジェクト構造

```
~/.claude-slack-pipe/channels/<channel-id>/
├── CLAUDE.md            # 不変規約セクション + 可変アプリ定義
├── skills/              # 機能群（1ファイル=1機能）
├── mcps/<ツール名>/     # 自作ツール（最終手段）
│   ├── index.ts
│   └── package.json
├── .claude/
│   └── settings.json    # PJ限定のツール+モデル設定
└── schedule.json        # 定時トリガー
```

### ルーティングモデル

`channels/` ディレクトリの存在自体がルーティングテーブル。
`slack-memory.json` は廃止。

- bot がチャネルにいる = プロジェクトが存在する
- channel-id でディレクトリを引く

## ライフサイクル

### チャネル初期化

```
member_joined_channel (bot自身がチャネルに招待される)
  → channels/<channel-id>/ 作成
    ├── CLAUDE.md (規約テンプレート)
    ├── skills/ (空)
    ├── mcps/ (空)
    ├── .claude/settings.json (最小設定)
    └── schedule.json (空)
  → ウェルカムメッセージ投稿
    「AIアプリとして初期化しました。何を作りましょう？」
```

特別なコマンド不要。bot招待 = init。

### セッション管理（DM/チャネル統一）

```
メッセージ着信
  → cwdを解決
    DM → bridgeプロジェクトルートDir
    チャネル → channels/<channel-id>/（存在確認、なければ無視）
  → スレッド単位でセッション管理
    同一スレッド → 既存セッション再利用
    新スレッド → 新セッション起動
  → PersistentSession(cwd, context) へ
  → 以降は共通パイプライン（ストリーミング + リアクション）
```

DM固有の処理:
- Memory による個人適応
- bridge skills 注入
- モデル切替（Home Tab）

チャネル固有の処理:
- CLAUDE.md / skills の自動読込（cwd による Claude CLI の標準動作）
- .claude/settings.json の PJ 限定ツール
- 定時トリガーからの起動

### 定時トリガー

```
スケジューラ (bridge内蔵)
  → schedule.json を全チャネル分監視
  → 時刻到達
    → チャネルに新スレッド投稿（bot発言）「⏰ 定時実行: <trigger名>」
    → そのスレッドにプロンプト投入
    → 通常のセッション処理（ストリーミング表示）
```

bot が自分の投稿をトリガーとする形で統一。特別な経路を作らない。
ただし現在の handleMessage は bot メッセージをスキップする guard がある。
定時トリガーではこの guard をバイパスし、bot 投稿後に直接セッションへプロンプトを投入する
（Slack イベント経由ではなくスケジューラから直接呼び出す）。

### チャネル退出（deactivate）

```
member_left_channel (bot自身)
  → アクティブセッションがあれば終了
  → プロジェクトディレクトリは残す（データ保全）
  → 再招待で復帰可能
```

## メッセージルーティングと既存コードの変更

### 廃止するもの

| 対象 | 理由 |
|---|---|
| ChannelRouter (`src/bridge/channel-router.ts`) | PersistentSession に統合 |
| slack-memory.json | channels/ ディレクトリが代替 |
| 外部handler スクリプト起動 | 不要 |
| stdout JSON プロトコル (progress/message/error) | 不要 |
| handleMessage の DM/チャネル分岐 | cwd 解決ロジックに置換 |

### 変更しないもの

| 対象 | 理由 |
|---|---|
| PersistentSession | そのまま使う（cwd パラメータ追加のみ） |
| StreamProcessor | 変更不要（共通パイプライン） |
| ReactionManager | 変更不要 |
| SessionCoordinator | セッション管理は共通 |
| SlackActionExecutor | 変更不要 |
| GroupTracker / SerialActionQueue | 変更不要 |

### 新規追加

| 対象 | 役割 |
|---|---|
| ChannelProjectManager | init / ディレクトリ管理 / テンプレート生成 |
| ChannelScheduler | schedule.json 監視 + cron トリガー発火 |
| cwd 解決ロジック | DM/チャネル判定 + ディレクトリパス解決 |

設計方針: ストリーミング基盤に手を入れず、入口（ルーティング）と管理（init/schedule）だけ追加する。

## ファイルフォーマット

### CLAUDE.md（init 時生成テンプレート）

```markdown
<!-- SYSTEM RULES - この規約セクションは編集禁止 -->
# プロジェクト規約

このディレクトリは1つのAIアプリケーション。
対話を通じて以下の構成を育てていく。

## このファイル（CLAUDE.md）
アプリのコアロジック。
「何者で、何をして、何をしないか」を定義。
この規約セクション以外を自由に編集・拡張する。

## skills/
機能の単位。1ファイル = 1つの機能。
「何を、どういう手順と判断基準でやるか」を
自然言語で記述する。
実際の操作にはツールを使う。
フロントマターに name, description を必須。

## mcps/<ツール名>/
ツールの自作場所。これは最終手段。
組込ツール（Read, Bash, Glob等）や
公開済みMCP（数百種以上存在）を徹底的に
調査し、それでも必要な操作が実現できない
場合にのみ自作する。
1フォルダ = 1ツール名 = 1つの操作群。

## .claude/settings.json
このプロジェクトで使うツールとモデルの設定。
ツール追加は必ずこのファイルに行う。
グローバル設定には絶対に追加しない。

## schedule.json
定時トリガー。
「いつ、何のプロンプトを投入するか」を定義。
bridgeのスケジューラが読んで実行する。

## 育て方の原則
1. 対話でアプリの目的を理解する
2. CLAUDE.mdのアプリ定義に目的とルールを書く
3. 機能が必要になったらskills/にスキルを作る
4. ツールが必要になったら：
   組込ツールで可能か確認
   → 既存MCPを徹底調査
   → それでもなければmcps/に自作
   追加は必ず.claude/settings.jsonへ（PJ限定）
5. 定時実行が必要ならschedule.jsonに追加
<!-- END SYSTEM RULES -->

# アプリ定義
（まだ定義されていません。何を作りたいか教えてください）
```

### .claude/settings.json（init 時）

```json
{
  "model": "sonnet"
}
```

### schedule.json（init 時）

```json
{
  "triggers": []
}
```

### schedule.json（定義例）

```json
{
  "triggers": [
    {
      "name": "daily-report",
      "cron": "0 9 * * 1-5",
      "prompt": "日次レポートを作成してください"
    },
    {
      "name": "weekly-review",
      "cron": "0 17 * * 5",
      "prompt": "今週のPR棚卸しをしてください"
    }
  ]
}
```

### スキルファイル例（skills/daily-report.md）

```markdown
---
name: 日次レポート作成
description: 毎朝のメトリクス収集とレポート投稿
---

# 手順
1. weather-api ツールで今日の天気を取得
2. sales-db ツールで昨日の売上サマリを取得
3. 以下のフォーマットでレポートを作成：
   - 天気概況
   - 売上ハイライト（前日比付き）
   - 注意事項（異常値があれば）

# 判断基準
- 売上が前日比20%以上変動 → ⚠️ 付きで強調
- データ取得失敗時 → エラー内容を明記して取得できた分だけでレポート作成
```
