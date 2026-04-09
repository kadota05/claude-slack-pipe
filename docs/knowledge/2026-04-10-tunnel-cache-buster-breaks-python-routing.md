# キャッシュバスター付きURLがPythonサーバーで404になる

## 症状

トンネルボタンを押しても真っ白な画面が表示される。Cloudflareトンネル自体は正常に動作しているが、Originサーバーが404を返していた。

## 根本原因

ブリッジ側でSlack WebViewのキャッシュ対策として `?_cb=<timestamp>` をトンネルURLに付加していたが、Pythonの `BaseHTTPRequestHandler` では `self.path` にクエリパラメータが含まれるため、`self.path == "/"` が `"/?_cb=1775766763866"` にマッチしなかった。

## 証拠

```bash
# ローカルでも再現
curl -s -o /dev/null -w "%{http_code}" "http://localhost:8080/"        # → 200
curl -s -o /dev/null -w "%{http_code}" "http://localhost:8080/?_cb=123" # → 404

# トンネル経由
curl -s -D - "https://xxx.trycloudflare.com/"          # → 200
curl -s -D - "https://xxx.trycloudflare.com/?_cb=123"  # → 404
```

## 修正内容

`workout_server.py` の `do_GET` で `self.path` を直接比較する代わりに `urlparse(self.path).path` でパス部分だけを比較するように変更。

```python
# Before
if self.path == "/":

# After
parsed = urlparse(self.path)
if parsed.path == "/":
```

## 教訓

- ブリッジ側でURLにクエリパラメータを付加する機能（キャッシュバスター等）を導入する場合、サーバー側がクエリパラメータ付きURLを正しくルーティングできることが前提になる。
- PythonのBaseHTTPRequestHandlerは `self.path` にクエリ文字列を含むため、パスの完全一致比較は危険。必ず `urlparse` でパース後に比較すべき。
- 新機能を複数レイヤーにまたがって追加する時は、各レイヤー間のインターフェース（この場合はURLの形式）が整合しているか確認する。
