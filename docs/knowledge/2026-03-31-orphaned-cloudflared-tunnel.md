# 孤児化cloudflaredプロセスによるトンネル障害

## 症状
Slackのlocalhostアクセスボタンを押しても「サーバーが見つかりません」（DNS解決失敗）となり、モバイルからlocalhostにアクセスできない。Macからのcurlでは一時的に成功するが、やがてMac側のDNSも解決できなくなる。

## 根本原因
Bridge再起動時に前回セッションのcloudflaredプロセスが生き残り（PPID=1で孤児化）、新しいcloudflaredプロセスと同じポートに対して同時にトンネルを張っていた。trycloudflare.comは新しいサブドメインごとに個別のDNSレコードを作成するため、古いプロセスの存在がCloudflare側の状態に影響し、新しいサブドメインのDNS伝播がモバイルDNSに届かなかった。

## 証拠
- `ps aux` で日曜から残っていたcloudflaredプロセス（PID 12619, PPID=1）を発見
- 新しいトンネルURL（`category-drainage-camping-specification.trycloudflare.com`）がGoogle DNS(8.8.8.8)では解決できるがモバイルSafariでは「サーバーが見つかりません」
- 数十分後にはMac側のDNSからも解決不能に（curl exit code 6）
- 直接IP接続（`--resolve`オプション）では200が返る → トンネル接続は生きているがDNSレコードが無効化

## 修正内容
TunnelManagerのコンストラクタで `pkill -f "cloudflared tunnel --url localhost"` を実行し、前回セッションの孤児プロセスを起動時に一掃するようにした。

## 教訓
- Bridgeがクラッシュ・SIGKILLされると`stopAll()`が走らず子プロセスが孤児化する
- 孤児プロセスは `PPID=1` で確認できる
- cloudflaredは同じポートに対して複数プロセスが同時に動くとDNS側に悪影響を与える可能性がある
- 子プロセスを管理するManagerパターンでは、起動時の孤児掃除が必須
- trycloudflare.comはワイルドカードDNSではなく個別DNS登録のため、DNS伝播の信頼性にばらつきがある
