# ホームタブ★ボタン — static_select後にビューが更新されない

## 症状

- ディレクトリAに★を付ける → ディレクトリBに切り替える → ★/☆ボタンが古いまま（★のまま）
- その状態で★ボタンを押すと、Bにスターが付く代わりにAのスターが外れる
- ボタンの `value` が古いディレクトリIDのまま残っている
- 「お気に入りを外す」操作時に「Slackになかなか接続できません」バナーが出やすい

## 根本原因

**`static_select` でディレクトリを変更した後、`views.publish` がSlackモバイルクライアントに反映されない。**

### 詳細メカニズム

1. `views.publish` はHTTPS REST APIで成功（`ok: true`）する
2. しかしSlackモバイルが `static_select` 操作直後の `views.publish` を正しく適用しない
3. セレクタの表示値は変わるが、ビューの他の部分（★ボタン等）が古いまま残る
4. 結果として古い `value` を持つボタンが表示され、意図しないディレクトリに対してトグルが実行される

### ★ボタンのクリックではビュー更新される

- `button` クリック → `views.publish` → クライアントに反映される（正常）
- `static_select` 変更 → `views.publish` → クライアントに反映されない（問題）

つまり Slack モバイルの `static_select` 操作後のビュー更新に固有の問題。

## 証拠

### ログの時系列証拠（決定的）

```
22:51:37 publishHomeTab
  directoryId=claude-slack-pipe
  starred=[claude-slack-pipe] → ★ボタン表示
  views.publish ok=true

22:51:53 ディレクトリをCoworkに変更
  directoryId=Cowork
  starred=[claude-slack-pipe]
  → ボタンは☆になるはず（Coworkは未スター）
  views.publish ok=true

22:51:57 ★ボタンクリック
  button text=★（古い！☆のはず）
  button value=claude-slack-pipe（古い！Coworkのはず）
  → claude-slack-pipeのスターが外れる（意図と逆）
```

### データ層・API層は正常

- `toggleStar` は正しく動作、JSONファイルに正しく保存される
- 全 `views.publish` 呼び出しが `ok: true`

### WebSocket不安定（既存問題）

```
[WARN] socket-mode:SlackWebSocket:N
  A pong wasn't received from the server
  before the timeout of 5000ms!
```

pongタイムアウトはスター機能追加前から存在。WebSocket番号が1→11+まで増加（多数の再接続）。★外し時の「接続できません」バナーはソート順変更による大きなビュー構造変更が原因の可能性。

## 修正内容

**`views.publish` の `view` に `private_metadata` タイムスタンプを追加。**

```ts
// src/slack/home-tab.ts
const view = {
  type: 'home' as const,
  blocks,
  private_metadata: JSON.stringify({ ts: Date.now() }),
};
await this.client.views.publish({ user_id: userId, view });
```

毎回異なる `private_metadata` を付与することで、Slackにビューが新しいものであると認識させ、`static_select` 操作後でもクライアント側の再描画を強制する。

**結果**: この修正後、ディレクトリ切り替え時に★/☆ボタンが正しく更新されるようになった。

## 教訓

1. **`views.publish` の `ok: true` はクライアント反映を保証しない** — サーバー側の受理のみ。モバイルSlackでは特に `static_select` 操作後にビュー更新が到達しないケースがある
2. **`private_metadata` をビュー更新の一意性保証に使える** — タイムスタンプを入れることでSlackにビューの変更を強制認識させる
3. **UIの操作種別によって `views.publish` の信頼性が異なる** — ボタンクリック後は反映されるが、`static_select` 変更後は反映されないという非対称な挙動がある
4. **ログの3層分析が有効** — データ層(JSON)・API層(views.publish結果)・クライアント層(ボタンのvalue/text)を分けて調査することで、問題箇所を特定できた
5. **pongタイムアウトと「接続できません」バナーは別問題** — 前者はSocket Mode既存問題、後者はビュー構造の大きな変更（ソート順変更）時にSlackモバイルが一時的に表示するもの
