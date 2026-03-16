# Round 1 Synthesis (Updated: DM + Block Kit UI 設計)

## Confirmed Decisions (Vx)

| # | Decision | Evidence | Agents |
|---|----------|----------|--------|
| V1 | `.claude/projects/` のJONL構造は完全に把握済み。セッション判別: `.jsonl && !agent-` | CLI specialist実機調査 | 全員 |
| V2 | パスの逆変換は非可逆。`cwd`フィールドから正確なパスを取得 | CLI specialist: 7.1 | CLI + Architect |
| V3 | 監視方式: オンデマンド + TTLキャッシュ（30秒）。ファイルウォッチャーはMVP不要 | Architect: I6 | Architect |
| V4 | 軽量パーサー（zod不使用）。必要フィールドのみ抽出、未知フィールド無視 | Architect: I7 | Architect + CLI |
| V5 | セッション一覧は`fs.statSync`のみで軽量取得、内容は遅延ロード | Architect: I6 | Architect |
| V6 | 待機表現MVP: リアクション絵文字（⏳→✅/❌） | UX: I2 | UX |
| V7 | エラー表示: リアクション置換 + Block Kitエラーメッセージ | UX: I3 | UX |
| V8 | 長文分割: 3,900文字基準、コードブロック分断防止、最終的にファイルアップロード | UX: I3 | UX |
| V9 | コマンド: `cc /xxx` テキスト + Block Kit UI併用 | UX: I4 | UX |
| V10 | セッション命名: 最初のプロンプトから先頭30文字自動生成。`-n`フラグでCLI側にも反映 | UX: I10 + CLI: 6.2 | UX + CLI |
| V11 | セキュリティ: 環境変数ベースのユーザーallowlist + `--allowedTools` standard | Architect: I9 | Architect |
| V12 | 同時実行: MVP=ユーザーあたり1、グローバル3。`--max-budget-usd`でコスト制限 | Architect: I8 | Architect |
| V13 | ProcessManager: Map<sessionId, ManagedProcess>でインメモリ管理 | Architect: I8 | Architect |
| V14 | Graceful shutdown: SIGTERM→5s→SIGKILL + process.on('exit')で子プロセス清掃 | Architect: I8 | Architect |
| V15 | コスト: CLI outputでは`total_cost_usd`あり。ログからは`usage`で都度計算 | CLI: 7.8, 6.1 | CLI |
| V16 | DM内の対話はスレッドベース: セッション開始メッセージ=アンカー、スレッド内で対話 | UX: I1 | UX |

## Contradictions

| ID | Agent A position | Agent B position | Resolution | Rationale |
|----|-----------------|-----------------|------------|-----------|
| C1 | UX: DM内でスレッドベース（セッション=スレッド） | ユーザー確定: DMは対話専用 | **要ユーザー確認** | スレッドモデルはモバイルでも自然なセッション分離を実現。DMスレッドはチャンネル乱立とは異なる |
| C2 | UX/Architect: インメモリの揮発性→永続化必要 | ユーザー確定: SQLite不要 | **UUID v5で解決** | thread_tsからUUID v5を決定的生成→再起動後もマッピング復元可能、永続化不要 |

## Multi-Perspective Reframing (C1: スレッドモデル)

- **User-value**: スレッドモデルはセッション分離をSlackネイティブに実現
- **Risk**: DMにスレッドが増えるリスク。ただしチャンネル乱立よりはるかに軽微
- **Simplicity**: スレッドの方がシンプル（フラットDMだとセッション文脈が混在）
- **Evidence**: Slack公式Bot多数がDMスレッドを活用
- **Assumptions**: 「チャンネルを無駄に生成したくない」はDMスレッドには当てはまらない
- **Verdict**: スレッドモデルを推奨、ユーザーに視覚的に提示して確認

## Emergent Insights

1. **CLIのstdoutで直接JSON出力を受け取れるため、ログファイル監視は対話中は不要**。ログパースは「過去のセッション閲覧」にのみ使用。
2. **`~/.claude/sessions/<pid>.json`で実行中セッションを検出可能**。ブリッジ外で実行中のセッションもHome Tabに表示できる。
3. **`-n, --name <name>`フラグでセッション名を設定可能**。ブリッジ側で自動命名する際にCLI本体のUIにも名前が反映される。
4. **`section`ブロックの3,000文字制限**はメッセージ全体の4,000文字制限とは別。MAX_SECTION_TEXT=2,900で安全マージン。

## Issues (P0/P1/P2)

| ID | Issue | Priority | Resolution |
|----|-------|----------|------------|
| P0-1 | DMスレッドモデルの合意 | P0 | ユーザーにモック提示 |
| P0-2 | インメモリ揮発性 | P0 | UUID v5 deterministic生成で解決 |
| P1-1 | section blockの3,000文字制限 | P1 | MAX_SECTION_TEXT=2,900で分割 |
| P1-2 | Home Tab→スレッド遷移 | P1 | permalink + メッセージ投稿で誘導 |
| P1-3 | プロジェクトパス逆変換の曖昧性 | P1 | cwdフィールドで解決済み |
| P2-1 | Slack chat streaming API | P2 | Phase 3で検討 |
| P2-2 | プロンプトインジェクション対策 | P2 | 入出力サニタイズ |

## Convergence Status

- [x] `.claude/projects/` パーサーの入出力仕様が確定
- [x] モバイルSlackでの制約が全て洗い出し済み
- [x] P0矛盾がゼロ（C2はUUID v5で解決）
- [ ] **DM内対話フローのBlock Kit構成** → C1のスレッドモデルの合意が必要
- [ ] **App Home Tabの全状態遷移** → スレッドモデル確定後に詳細化
- [ ] **全Ix質問に具体的な実装方針が決定** → I1のDM対話フローが未確定
