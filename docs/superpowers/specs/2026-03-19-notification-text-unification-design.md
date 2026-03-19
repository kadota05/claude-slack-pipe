# 通知テキスト統一・装飾整理 設計書

## 背景と課題

### 課題1: 通知の二重到達
結果フッターが `postMessage` で `text: 'Complete'` を送信し、その後テキスト回答も `postMessage` で届く。
Slackユーザーには「Complete」と「回答本文」の2つの通知が来て、同じ意味の通知が二重になる。

### 課題2: 意味不明な通知テキスト
- `text: 'Complete'` — 英語で何の完了か分からない
- `text: 'bundle collapsed'` — 開発用語がプレビューに出る
- `text: ''` — 空文字で内容が分からない

### 課題3: テキスト応答の不要フッター
`:hourglass_flowing_sand: 応答中...` のcontextブロックがテキスト応答に付く。
bundleのフッター（実行中...、思考中...）はbundle折りたたみ時に消えるが、テキストのフッターはずっと残り続ける。

### 課題4: リアクションと装飾の絵文字重複
`:white_check_mark:` (✅) がリアクション（完了通知）と装飾（ツール個別の完了アイコン）の両方で使われている。
`:hourglass_flowing_sand:` (⏳) もリアクション（待機中）と装飾（応答中フッター）の両方で使われている。

## 設計方針

- **アプローチB**: 通知テキスト生成と絵文字定義を `notification-text.ts` に集約
- 全 `postMessage` / `update` のtext値をこのモジュールから生成
- 絵文字マップもこのモジュールに一元管理
- 既存の構造（group-tracker, stream-processor等）は変えない

## 詳細設計

### 1. 新モジュール: `src/streaming/notification-text.ts`

#### 1-1. 絵文字マップ（リアクション vs 装飾の完全分離）

```
【リアクション専用】（ユーザーのメッセージに付くSlackリアクション）
  ⏳ hourglass_flowing_sand — ジョブ待機中
  🧠 brain               — 処理中
  ✅ white_check_mark     — 完了

【装飾専用】（メッセージ本文内のアイコン）
  💭 thought_balloon — 思考ブロック
  🔧 wrench          — ツール実行
  🤖 robot_face      — SubAgent
  ✓  (テキスト文字)  — ツール個別の完了
  ✗  (テキスト文字)  — ツール個別の失敗
```

**変更ルール**: 装飾内で `:white_check_mark:` → `✓`、`:x:` → `✗`、`:hourglass_flowing_sand:` → 使わない

#### 1-2. 通知テキスト生成関数

```typescript
// postMessage用（通知が鳴る）→ 内容ベース
notifyText.footer(model, tokens, duration) → "opus | 1,234 tokens | 3.2s"
notifyText.text(buffer)                    → buffer.slice(0, 100)

// update用（通知は鳴らない、プレビューに出る）→ 内容ベース
notifyText.update.tools(tools)             → "🔧 Read, Bash, Grep"
notifyText.update.thinking()               → "💭 思考中"
notifyText.update.collapsed(config)        → "💭×1 🔧×3 (2.5s)"
```

### 2. テキスト応答フッターの削除

| 対象 | ファイル | 行 | 変更 |
|------|---------|-----|------|
| `:hourglass_flowing_sand: 応答中...` | stream-processor.ts | L315-320 | 削除 |

**理由**: bundleのフッター（実行中...、思考中...）はbundle折りたたみ時に消えるから良いが、テキストのフッターはずっと残り続けてしまうため不要。

**残すもの**:
- `実行中...`（ツール実行中フッター）— bundle折りたたみ時に消える
- `:thought_balloon: _思考中..._`（思考フッター）— bundle折りたたみ時に消える

### 3. 既存コードの変更マップ

#### src/index.ts
| 行 | 現在 | 変更後 |
|----|------|--------|
| 569 | `text: 'Complete'` | `notifyText.footer(model, tokens, duration)` |

#### src/streaming/group-tracker.ts
| 箇所 | 現在 | 変更後 |
|------|------|--------|
| バンドル更新時のtext | 動的 | `notifyText.update.tools(tools)` 等 |
| collapseActiveBundle | `text: 'bundle collapsed'` | `notifyText.update.collapsed(config)` |

#### src/streaming/stream-processor.ts
| 箇所 | 現在 | 変更後 |
|------|------|--------|
| テキスト応答の「応答中...」contextブロック | 表示 | 削除 |
| text生成 | インライン | `notifyText.text(buffer)` |

#### src/streaming/tool-formatter.ts
| 箇所 | 現在 | 変更後 |
|------|------|--------|
| ツール完了アイコン | `:white_check_mark:` | `✓` |
| ツール失敗アイコン | `:x:` | `✗` |
| `:hourglass_flowing_sand:` 装飾使用 | 表示 | 削除（装飾では使わない） |

### 4. リアクション（変更なし）

リアクションの絵文字・タイミングは現状維持:
- `hourglass_flowing_sand` → ジョブ待機中
- `brain` → 処理中
- `white_check_mark` → 完了

### 5. 変更しないもの

以下は今回のスコープ外:
- bundleのフッター（実行中...、思考中...）— 折りたたみ時に消えるので問題なし
- bridge-commands.ts内の絵文字 — 管理コマンドの表示で今回の問題と無関係
- block-builder.tsのフッター統計絵文字 — 結果表示用で通知には影響しない
- error-handler.tsのエラーtext — エラー内容がそのまま入っているので既に内容ベース
