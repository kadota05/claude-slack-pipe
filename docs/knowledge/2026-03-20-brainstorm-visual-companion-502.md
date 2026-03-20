# ブレスト ビジュアルコンパニオンがBridge経由で502になる

## 症状

superpowersのブレストスキルでビジュアルコンパニオン（localhost HTTPサーバー）を起動し、Cloudflareトンネル経由でスマホからアクセスすると、1〜2分後に `502 Bad Gateway — Unable to reach the origin service` が発生する。サーバー起動直後でも間に合わないケースがある。

## 根本原因

**ブレストサーバーの「OWNER_PID監視」がBridge環境のプロセス階層と合わない。**

### プロセス階層の不一致

ブレストサーバー（`server.cjs`）は起動時に「ご主人様PID（OWNER_PID）」を記憶し、60秒ごとに `process.kill(OWNER_PID, 0)` で生存チェックする。死んでいたら自分も終了する。

`start-server.sh` の104行目で、OWNER_PIDは `ps -o ppid= -p "$PPID"` で算出される。これは「自分から2階層上のプロセス」であり：

**通常のCLI（ターミナル直接起動）:**
```
ユーザーのシェル（長寿命）  ← OWNER_PID ✅
  └ Claude CLI（シェルと同寿命）
    └ Bashツールシェル（一時的） ← $PPID
      └ start-server.sh
```
OWNER_PID = ユーザーのシェル → ターミナルを閉じるまで生きている → サーバーも生き続ける。

**Bridge環境:**
```
Bridge本体 Node.js（常駐デーモン）
  └ Claude CLI（10分アイドルで終了）  ← OWNER_PID ❌
    └ Bashツールシェル（一時的） ← $PPID
      └ start-server.sh
```
OWNER_PID = Claude CLI → Bashツール完了後にCLIの中間プロセスが消え、次の60秒チェックでサーバーが自殺する。

### なぜBridge側で解決できないか

1. **PPIDはOSカーネルが管理**: `ps -o ppid=` はカーネルに直接問い合わせるため、アプリケーションコードから偽装・上書きできない
2. **環境変数は上書きされる**: Bridge側で `BRAINSTORM_OWNER_PID` をセットしても、`start-server.sh` が内部で独自に算出して上書きする
3. **ヘルスチェックでは不十分**: トンネルの掃除はできるが、サーバーの自殺自体は防げない

## 証拠

過去6セッションのブレストサーバー停止理由:

| セッション | 寿命 | 停止理由 |
|---|---|---|
| 23090 (通常CLI) | 99分 | idle timeout（正常） |
| 19300 (Bridge) | 4分 | owner process exited |
| 37903 (Bridge) | 2分 | owner process exited |
| 45120 (Bridge) | 1分 | owner process exited |
| 46084 (Bridge) | 2分 | owner process exited |
| 46767 (Bridge) | 2分 | owner process exited |

Bridge経由の5セッション全てが1〜4分で「owner process exited」により停止。通常CLI（23090）のみ99分間正常に動作。

## 修正内容

**現時点ではBridge側で修正不可。** superpowersプラグイン側に「`BRAINSTORM_OWNER_PID` が既にセットされていたら外部の値を尊重する」という3行の変更が必要。

## ワークアラウンド

ブレストスキル自体は問題なく使える。ビジュアルコンパニオン（start-server.sh経由のサーバー）だけが自殺する。Bridge環境でlocalhostを見せたい場合は、`npx serve` や `python3 -m http.server` など**OWNER_PID監視を持たない普通のサーバー**で立てれば、CLIが終了してもlaunchd（PID=1）に引き取られて生き続ける。

## 教訓

- 子プロセスの「親プロセス生存チェック」は、プロセス階層の深さが設計時の想定と異なる環境では正しく動作しない。デーモン経由・Docker・CI環境なども同様のリスクがある。
- OSカーネルが管理するPPIDはアプリケーションレイヤーから変更できないため、プロセス階層に依存する設計には外部から注入可能な逃げ道（環境変数の尊重、引数によるオーバーライド）が必要。
- 「サーバーが立ち上がらない」ように見える問題でも、実際には「立ち上がった後に即座に自殺している」パターンがある。停止理由のログ（`.server-stopped`）が調査の決め手になった。
