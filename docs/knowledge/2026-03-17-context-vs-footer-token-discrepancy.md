# フッターのctx表示が異常な値を示す問題

## 症状

1. 新規スレッドの初回応答（ツール使用あり）でctxが異常に高い値を示す（例: 125.4k/200k = 62.7%）
2. 同じスレッドで返信を重ねると、2回目の応答のctxが1回目より**大幅に低下**する（例: 64.7k/200k = 32.4%）
3. コンテキストは積み上がるはずなのに減少するという直感に反する挙動

## 根本原因

**Claude CLIの`result`イベントの`usage`フィールドは、ターン内のメインセッション全APIコールのトークン使用量の合算値を報告している。**

ツール使用があるターンでは、CLIは内部的に複数のAPIコールを行う：
- APIコール1: ユーザーメッセージ → Claudeがtool_useを返す
- APIコール2: tool_result → Claudeが最終応答を返す

各コールのコンテキストはほぼ同じ（システムプロンプト + 会話履歴）なので、`usage`の合計は実際のコンテキスト量の約N倍になる（NはメインセッションのAPIコール数 = tool_use数 + 1）。

### 具体的な数値での証明

制御テスト（同プロジェクト、haikuモデル）:

| テスト | tool_use | APIコール数 | usage合計 | modelUsage合計 | 比率 |
|---|---|---|---|---|---|
| 「1+1は？」 | 0 | 1 | 55,661 | 55,661 | 1.00x |
| 「package.jsonのname教えて」 | 1 (Read) | 2 | 112,146 | 112,146 | 1.00x |

- tool_use 0回: usage = modelUsage = 55.6k（単一APIコール = 実際のコンテキスト量）
- tool_use 1回: usage = modelUsage = 112.1k ≈ 55.6k × 2（2コール分の合算）

### `usage` vs `modelUsage` の関係

| フィールド | 意味 |
|---|---|
| `usage` | メインセッションの全APIコールの合算（サブエージェント含まず） |
| `modelUsage` | メイン + サブエージェント全コールのセッション累積 |

- サブエージェントなし（Read等）: `usage == modelUsage`
- サブエージェントあり（Agent）: `modelUsage >> usage`（サブエージェントの大量コールが含まれる）

### `contextWindow`の問題

`modelUsage.contextWindow` はモデルのベースコンテキストウィンドウ（全モデル200k）を返す。sonnet/opusの拡張コンテキスト（1M）は反映されないため、モデル名から判定する必要がある。

## 証拠

### 診断ログ（セッション 0142de72）

Turn 1（ツール使用あり、137.7s）:
```
usage: input=20, cache_read=75712, cache_creation=49712 → total=125,444
modelUsage: cacheRead=2,560,512, cacheCreation=132,029, input=46
```

Turn 2（ツール使用なし、1.6s）:
```
usage: input=10, cache_read=63858, cache_creation=843 → total=64,711
modelUsage: cacheRead=2,624,370, cacheCreation=132,872, input=56
```

modelUsage delta (Turn2 - Turn1) = Turn 2のusageと全フィールド完全一致 → Turn 2は1回のAPIコールのみ。

### JSONL検証

セッションJSONLには`compact_boundary`エントリなし → auto-compactは未発生。tool_use/tool_resultエントリは保持されている。

### 制御テスト

`claude -p --input-format stream-json --output-format stream-json` で直接テスト:
- tool_use 0回: usage合計 ≈ 55k（1コール分）
- tool_use 1回: usage合計 ≈ 112k（2コール分 ≈ 55k × 2）

## 修正内容

### 1. StreamProcessorでメインセッションのtool_useをカウント

`src/streaming/stream-processor.ts`:
- `mainToolUseCount` フィールドを追加
- メインセッション（parentToolUseId がnull）のtool_useイベントをカウント
- resultイベント発生時に `mainApiCallCount = mainToolUseCount + 1` を `ProcessedActions` に付与

### 2. ctx計算をAPIコール数で割る

`src/index.ts`:
```typescript
const apiCalls = mainApiCallCount || 1;
const inputTotal = (usage.input_tokens || 0)
  + (usage.cache_read_input_tokens || 0)
  + (usage.cache_creation_input_tokens || 0);
const contextUsed = Math.round(inputTotal / apiCalls);
```

### 3. contextWindowをモデル名から判定

```typescript
const contextWindow = sessionModel.includes('haiku') ? 200_000 : 1_000_000;
```

`modelUsage.contextWindow` はベース値（200k）しか返さないため使用しない。

## 教訓

1. **Claude CLIの`result.usage`はターン内の全メインAPIコールの合算**。単一APIコールの値ではない。ツール使用回数が増えるほど値が膨張する。
2. **`modelUsage`はセッション全体の累積（サブエージェント含む）**。コンテキストウィンドウ使用量の計算には使えない。
3. **`modelUsage.contextWindow`はベースコンテキストウィンドウのみ報告**。拡張コンテキスト（1M）は反映されないため、モデル名ベースの判定が必要。
4. **APIの自己申告値を鵜呑みにしない**。制御テスト（tool_use有無の比較）で実際の挙動を検証することが重要。
5. **仮説の検証には複数の角度が必要**。当初の「ツール中間やり取りの剪定」仮説は誤りで、制御テストで「APIコール合算」が真の原因と判明した。
