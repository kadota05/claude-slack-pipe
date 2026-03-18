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
    | localhost URL検知
    |-> TunnelManager: cloudflaredでトンネル確立（並列）
    |
テキスト最終更新時（resultイベント）
    | トンネルURL取得済み
    |-> LocalhostRewriter: テキスト変換
    |
Slack API chat.update（既存フロー）
```

### 新規コンポーネント

#### TunnelManager

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
- stdoutからトンネルURL（`https://xxx.trycloudflare.com`）をパースして取得
- Bridgeプロセス終了時に `stopAll()` で全トンネルを停止
- `cloudflared` 未インストール時はエラーをログに出し、変換なしでフォールバック

#### LocalhostRewriter

テキスト内のlocalhost URLを検知して変換する。

**検知対象の正規表現**:
```
http://localhost:\d+[^\s)]*
```

**変換ルール**:
```
入力: サーバーを起動しました: http://localhost:3000
出力: サーバーを起動しました: `http://localhost:3000`（<https://xxx.trycloudflare.com|Slackからはこちら>）
```

- localhost URLをバッククォートで囲みクリック不可にする
- 直後にmrkdwnリンクを追加（表示テキストがURL以外なのでSlackのフィッシング警告が出ない）
- 複数URLがあれば個別にトンネルを張って変換
- トンネル未確立時は5秒タイムアウト後、変換なしでそのまま投稿

## 既存コードへの統合

### StreamProcessor

- `result`イベント処理時（最終更新）にテキストを `LocalhostRewriter.rewrite(text)` に通す
- ストリーミング途中のテキストには触れない（既存動作そのまま）

### localhost URL検知タイミング

- ストリーミング中にテキストを監視し、localhost URLが出現したら即座に `TunnelManager.startTunnel(port)` を呼ぶ
- トンネル確立を先行開始することで、最終更新時には待ち時間ゼロを目指す
- `textAction` 生成時にテキスト内容をチェックする形で実装

### トンネルのライフサイクル

- Bridge起動時: `TunnelManager` インスタンスを生成
- セッション終了時: トンネルは停止しない（別セッションで同じポートが使われる可能性）
- Bridge終了時: `TunnelManager.stopAll()` で全トンネルを一括停止

## セットアップ

`.claude/skills/setup.md` に `brew install cloudflared` を追加する。
