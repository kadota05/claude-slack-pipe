# bundleIndexドリフトによるモーダル表示ズレ

## 症状

Slackのbundle「詳細を見る」ボタンをクリックすると、ラベル（例: 🔧×4）と異なる内容が表示される。例えば「ツール×4」のbundleを開いたら1つのthinkingだけが表示されたり、「エージェント×1」を開いたらReadツールが表示される。新規スレッドでは正常だが、スレッドが長くなるにつれて悪化する。

## 根本原因

**2つの独立したbundleシステム間のインデックスずれ。**

1. **GroupTracker**（メモリ内）: リアルタイムでラベル（💭×2 🔧×3）を生成。`bundleCounter`は0から連番で振られる
2. **SessionJsonlReader**（JSONLファイル）: モーダル表示時にファイルを読み、テキスト境界を数えて`bundleIndex`でbundleを特定

問題: Claude CLIプロセスはアイドルタイムアウト(10分)やクラッシュで頻繁に再起動する（1セッションで38回再起動した例あり）。再起動のたびにGroupTrackerの`bundleCounter`は0にリセットされるが、JSONLファイルには全履歴が蓄積されたまま。さらにCLI再開時(`-r`フラグ)は過去メッセージがstdoutにリプレイされ、GroupTrackerのカウンタをさらにズラす。

結果: GroupTrackerが生成する`bundleIndex=2`がJSONLファイルの実際の`bundleIndex=15`を指す、というドリフトが発生。

## 証拠

- セッション`a71e56c5`のJSONLに233件のassistantイベント、stdoutには376件（143件はリプレイ）
- 同セッションで38回のプロセス再起動を確認
- リプレイイベントはms間隔で到着（通常のイベントは秒単位）
- ほとんどのプロセスライフタイムで1ターンのみ処理（10分アイドルで終了）

## 修正内容

連番`bundleIndex`の代わりにコンテンツベースの`bundleKey`を導入:

- **GroupTracker**: collapse時に`extractBundleKey()`でbundle内の最初の`tool_use_id`またはthinkingテキストのSHA-256ハッシュ（`th_<hash12chars>`）をキーとして抽出
- **tool-formatter**: Slackボタンの`action_id`に`bundleKey`を埋め込み（`view_bundle:sessionId:bundleKey`）
- **SessionJsonlReader**: `readBundleByKey()`でJSONLファイルをスキャンし、キーに一致するbundleを特定
- **後方互換**: 古い数値形式の`action_id`は従来の`readBundle(bundleIndex)`にフォールバック

## 教訓

- **プロセスライフサイクルをまたぐ連番カウンタは危険。** 再起動でリセットされるメモリ内カウンタと、蓄積されるファイルストレージを連番で紐づけてはいけない
- **コンテンツアドレッサブルキーはプロセス再起動に強い。** `tool_use_id`はClaude APIが生成するグローバルユニークIDなので、プロセスの状態に依存しない
- **CLIのリプレイ機能を考慮する。** `--replay-user-messages`で再開すると過去イベントがstdoutに再送される。ストリーム処理はこの重複を想定する必要がある
