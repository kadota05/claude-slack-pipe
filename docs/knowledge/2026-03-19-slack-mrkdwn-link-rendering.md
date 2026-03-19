# Slack mrkdwnリンクが表示されない4つのバグ

## 症状

localhostのURLをCloudflareトンネル経由のリンクに置換して `<tunnelUrl|Slackからはこちら>` としてSlackに表示しようとしたが、以下の3パターンで表示が壊れた：

1. バッククオートは表示されるがカッコ内が空: `` `http://localhost:8080`（） ``
2. URL部分に `|` や `>` まで含まれて不正なURL表示
3. `&lt;`, `%7C`, `&gt;` とエスケープされてリンクがクリック不可
4. Slackの自動URL検出がベアURLを`<http://...>`で囲み、後続の`<url|text>`と混合

## 根本原因

### Bug 1: HTML タグ除去による mrkdwn リンク消失
`convertMarkdownToMrkdwn` の119行目 `result.replace(/<[^>]+>/g, '')` が、HTMLタグだけでなくSlack mrkdwn形式 `<url|text>` も除去していた。localhost URL書き換えをmrkdwn変換の**前**に行っていたため、変換パイプラインで消された。

### Bug 2: URL正規表現がSlack mrkdwn特殊文字で止まらない
`LOCALHOST_URL_PATTERN` の末尾が `[^\s)]*` で、`<`, `>`, `|` を含んでマッチしていた。Markdownリンク `[url](url)` がmrkdwn変換で `<url|url>` になった後、`extractLocalUrls` が `http://localhost:8080|http://localhost:8080>` を1つのURLとしてマッチしていた。

### Bug 3: `@slack/web-api` の form-urlencoded エンコーディング
`@slack/web-api` v7.15.0 の `serializeApiCallData()` は `application/x-www-form-urlencoded` + `querystring.stringify` を使用。これにより `<` → `&lt;`, `|` → `%7C`, `>` → `&gt;` にエスケープされ、mrkdwnリンクが壊れていた。

### Bug 4: Slack の自動URL検出（verbatim: false）
mrkdwnテキストで `verbatim` がデフォルト `false` の場合、Slackが `http://localhost:8080` のようなベアURLを自動検出して `<http://localhost:8080>` で囲む。この自動生成された `<...>` が、後続の `<tunnelUrl|text>` の `>` と混ざり、全体が1つの壊れたリンクとして解釈された。

## 証拠

### Bug 1
書き換え後のテキストをログで確認 → `<url|text>` が存在 → `convertMarkdownToMrkdwn` 通過後に消失。パイプラインのステップを `npx tsx -e` で個別実行して特定。

### Bug 2
Slack上の表示: `` `http://localhost:8080`（<https://...trycloudflare.com|http://localhost:8080|Slackからはこちら>） `` — URLに `|` が混入していた。

### Bug 3
同じJSON bodyを `curl -H "Content-Type: application/json"` で直接送信 → **クリック可能**。`@slack/web-api` 経由 → **エスケープされて不可**。ライブラリのソースコード `serializeApiCallData()` を確認して form-urlencoded であることを特定。

### Bug 4
`curl` で `application/json` で送信してもまだ壊れる。Slack APIのレスポンスを確認:
```json
"text": "`<http://localhost:8080`（&lt;...%7C...&gt;）>"
"verbatim": false
```
Slackが `http://localhost:8080` を自動検出して `<...>` で囲み、後続のmrkdwnリンクと結合していた。

## 修正内容

1. **Bug 1**: URL書き換えを `convertMarkdownToMrkdwn` の**後**に移動。`this.textBuffer` ではなく変換済みの `converted` に対して操作。
2. **Bug 2**: 正規表現を `[^\s)<>|]*` に変更。`rewriteLocalUrls` を2フェーズに：既存mrkdwnリンク内のURL置換 → ベアURL置換。
3. **Bug 3**: `client.chat.postMessage/update` を `fetch` + `application/json` に置換（`slackApiJson` メソッド）。
4. **Bug 4**: `buildTextBlocks` で `verbatim: true` を設定。表示URLからプロトコルを除去（`http://localhost:8080` → `localhost:8080`）してSlackの自動リンク検出を回避。

## 教訓

1. **Slack mrkdwnの`<url|text>`は複数のレイヤーで壊れうる**: テキスト変換パイプライン、HTTPエンコーディング、Slack側の自動処理、の3層すべてを考慮する必要がある。
2. **`@slack/web-api` は `application/json` を使わない**: mrkdwnの特殊文字（`<`, `>`, `|`）を含むテキストを送る場合、ライブラリのPOSTメソッドではなく `fetch` + JSON を直接使う必要がある。
3. **`verbatim: true` は必須**: mrkdwnテキストにURLが含まれる場合、Slackの自動URL検出が意図しない `<...>` ラッピングを行い、明示的な `<url|text>` リンクと衝突する。
4. **デバッグは各レイヤーを分離してテストする**: `npx tsx -e` でパイプライン個別実行、`curl` でAPI直接テスト、ライブラリ経由テスト、の3段階で原因を切り分けられた。
5. **正規表現はコンテキストに合わせて制限文字を追加する**: URLマッチングの `[^\s)]*` は一般テキストには十分だが、Slack mrkdwn内では `<>|` も除外する必要がある。
