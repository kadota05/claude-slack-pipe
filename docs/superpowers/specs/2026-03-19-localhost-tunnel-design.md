# localhost トンネリング設計

## 概要

Claude CLIがlocalhost上にWebアプリを起動した場合、スマホや別PCからはアクセスできない。Cloudflare Quick Tunnelを使ってlocalhostをパブリックURLに変換し、Slackメッセージ内にリンクとして提供する。

## 要件

- **汎用性**: どんなlocalhostアプリでも対応（静的サイト、SPA、WebSocket等）
- **ライブ操作**: リアルタイムのブラウザ体験（スクリーンショットのターン制ではない）
- **マルチデバイス**: スマホブラウザ、別PC、タブレットからアクセス可能
- **表示の自然さ**: Claude CLIの出力テキストをできるだけそのまま保持

## 技術選定: Cloudflare Quick Tunnel

- アカウント登録不要、無料
- `cloudflared tunnel --url localhost:{port}` の1コマンドで動作
- WebSocket対応（HMR、リアルタイムアプリが動作する）
- HTTPS自動付与
- 前提条件: `brew install cloudflared` でCLIバイナリをインストール

## アーキテクチャ

```
Claude CLI出力（ストリーミング）
    |
StreamProcessor（既存）
    | localhost URL検知（handleText内、textAction生成直前）
    |-> TunnelManager: cloudflaredでトンネル確立（並列）
    |
テキスト最終更新時（resultイベント）
    | トンネルURL取得済み
    |-> LocalhostRewriter: テキスト変換（convertMarkdownToMrkdwnの前に適用）
    |
Slack API chat.update（既存フロー）
```

### 新規コンポーネント

#### TunnelManager (`src/streaming/tunnel-manager.ts`)

ポートごとに1つのcloudflaredプロセスを管理する。

```typescript
TunnelManager {
  startTunnel(port: number): Promise<string>  // -> トンネルURL返却
  stopTunnel(port: number): void
  stopAll(): void
  getTunnelUrl(port: number): string | undefined
}
```

- 同じポートに対して重複してトンネルを張らない（既存トンネルがあればそのURLを返す）
- `cloudflared tunnel --url localhost:{port}` を子プロセスとして起動
- **stderrからトンネルURL**（`https://xxx.trycloudflare.com`）をパースして取得（cloudflaredはログをstderrに出力する）
- 最大同時トンネル数: 5（超過時は最も古いトンネルを停止）
- cloudflaredプロセスが異常終了した場合: URLマッピングを削除し、次回同じポートが参照された時に自動で再確立する。エラーはログに記録
- Bridgeプロセス終了時に `stopAll()` で全トンネルを停止（`index.ts` の `shutdown` 関数内、セッション終了後・`pidLock.release()` 前に呼び出す）
- `cloudflared` 未インストール時はエラーをログに出し、変換なしでフォールバック

#### LocalhostRewriter (`src/streaming/localhost-rewriter.ts`)

テキスト内のlocalhost URLを検知して変換する。

**検知対象の正規表現**:
```
https?://(localhost|127\.0\.0\.1|0\.0\.0\.0|\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})(:\d+)?[^\s)]*
```

以下にマッチ:
- `http://localhost:3000`、`http://localhost`（ポートなし）
- `http://127.0.0.1:8080/path`、`http://0.0.0.0:3000`
- `http://192.168.1.10:3000` 等のローカルIP

**注意**: パブリックIP（グローバルアドレス）はトンネル不要なのでフィルタする。プライベートIPレンジ（`10.x.x.x`、`172.16-31.x.x`、`192.168.x.x`）とloopback（`127.x.x.x`）のみ変換対象とする。

**変換ルール**:
```
入力: サーバーを起動しました: http://localhost:3000
出力: サーバーを起動しました: `http://localhost:3000`（<https://xxx.trycloudflare.com|Slackからはこちら>）
```

- localhost URLをバッククォートで囲みクリック不可にする
- 直後にmrkdwnリンクを追加（表示テキストがURL以外なのでSlackのフィッシング警告が出ない）
- 複数URLがあれば個別にトンネルを張って変換
- トンネル未確立時は8秒タイムアウト後、変換なしでそのまま投稿（実測でトンネル確立に約5秒かかるため、バラつき込みで8秒）
- **適用順序**: `convertMarkdownToMrkdwn` の前に適用する（Markdown→mrkdwn変換でURLリンクの形式が変わるため、先にrewriteしないと検知が壊れる）

## 既存コードへの統合

### StreamProcessor

- `handleResult` メソッド内で、`convertMarkdownToMrkdwn` を呼ぶ前に `LocalhostRewriter.rewrite(text)` を適用する
- ストリーミング途中のテキストには触れない（既存動作そのまま）

### localhost URL検知タイミング

- `handleText` メソッド内、`textAction` 生成直前にテキストをチェック
- localhost URLが出現したら即座に `TunnelManager.startTunnel(port)` を呼ぶ（awaitしない、fire-and-forget）
- トンネル確立を先行開始することで、最終更新時には待ち時間ゼロを目指す

### トンネルのライフサイクル

- Bridge起動時: `TunnelManager` インスタンスを生成
- セッション終了時: トンネルは停止しない（別セッションで同じポートが使われる可能性）
- Bridge終了時: `shutdown` 関数内で `TunnelManager.stopAll()` を呼び全トンネルを一括停止

## セットアップ

`.claude/skills/setup.md` に `brew install cloudflared` を追加する。
