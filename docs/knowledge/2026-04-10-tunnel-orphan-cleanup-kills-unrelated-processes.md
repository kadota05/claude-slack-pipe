# グローバルpkillによる孤児クリーンアップが無関係なプロセスを殺す

## 症状

CLIから手動で起動したcloudflaredトンネルが数秒で勝手に死ぬ。ブリッジ経由のトンネルは正常に動作する。

## 根本原因

TunnelManagerの孤児クリーンアップが2つの攻撃的な手法を使っていた:

1. **起動時**: `pkill -f "cloudflared tunnel --url localhost"` で全cloudflaredプロセスを無差別にkill
2. **60秒ごと**: `pgrep` で全cloudflaredプロセスを走査し、TunnelManagerが管理していないものをSIGKILL

これにより、ユーザーが別の用途で立てたcloudflaredや、他のツールが起動したトンネルも巻き添えで殺されていた。

## 証拠

CLIから `cloudflared tunnel --url localhost:8080` を起動しても、TunnelManagerの `killUntracked()` が60秒以内にそのPIDを検出してSIGKILLした。

## 修正内容

- グローバル `pkill` / `pgrep` を廃止
- PIDファイル (`/tmp/claude-slack-pipe-tunnel-pids.json`) で自分がspawnしたPIDだけを追跡
- 起動時に前回のPIDファイルから自分のorphanだけクリーンアップ（`ps -o command=` でcloudflaredか確認してからkill）
- SIGTERM → 2秒後にSIGKILLのgraceful shutdown
- 全ての `tunnels.delete()` パスで `savePidFile()` を呼び出し、PIDファイルを常に最新に保つ

## 教訓

- プロセス管理でグローバルなパターンマッチ（pkill/pgrep）を使うと、同名の無関係なプロセスを巻き添えにするリスクがある。自分がspawnした子プロセスのPIDだけを追跡すべき。
- 孤児プロセスのクリーンアップはPIDファイルで管理し、kill前にそのPIDが本当に対象プロセスかを確認するガードを入れる。
- SIGKILLの前にSIGTERMでgraceful shutdownの機会を与える。
