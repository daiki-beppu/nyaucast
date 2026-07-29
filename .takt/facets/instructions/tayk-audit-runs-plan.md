run 監査を始める前に、証拠パスの読み取りを確認し、対象 run を棚卸しして監査計画を作ってください。

**証拠パス（最初に必ず確認する）:**

監査対象は本体リポの絶対パス `/Users/mba/02-yt/tayk/.takt/runs` にある。タスクの隔離クローンに runs は複製されないため、必ずこの絶対パスを読む。

1. `ls /Users/mba/02-yt/tayk/.takt/runs` を実行する
2. **読めない（存在しない・権限がない）、または run が 1 件も無い場合は、計画を作らず ABORT を申告する。** 空のレポートや推測で埋めたレポートを出してはならない。ABORT の申告には実行したコマンドとエラー出力をそのまま含める（サンドボックスの read 制限や本体リポ移動の検出を兼ねる）

**定義監査の固定対象（#1〜#3。毎回必ず含める）:**

run とは別に、workflow 定義そのものを対象とする固定 3 対象を Audit Targets の先頭に置く（#146。ADR-0008 Consequences 検査 E / F の動的代替と、工程説明 drift の再発検出）:

| #   | Audit Target                    | Runs 列に列挙するもの（run ではなく対象ファイル）                                                     | What to Analyze                                          |
| --- | ------------------------------- | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| 1   | 検査 E: spillover 複製の一致    | `.takt/workflows/tayk-feature.yaml` / `.takt/workflows/tayk-fix.yaml`                                 | 複製された spillover step 定義の乖離                     |
| 2   | 検査 F: callable のレポート境界 | `.takt/workflows/tayk-intake.yaml` / `.takt/workflows/tayk-impl-review.yaml` と参照先 facet           | 親レポート・親 Report Directory への参照（決定 13 違反） |
| 3   | drift: 工程説明と実配線         | `.takt/workflows/*.yaml` 冒頭コメント / `.takt/config.yaml` コメント / `docs/agents/issue-tracker.md` | 工程説明と YAML 実配線の乖離                             |

- 定義ファイルは**隔離クローン内に git 追跡で存在する**。runs と違い絶対パスは使わず、リポジトリルートからの相対パスで読む（証拠パス確認の対象にもしない）
- 固定対象の # と対象名は毎回この表のとおりにする（監査間の突き合わせ先になる）。Priority は既定 Medium とし、run 対象の緊急度に応じて上下してよい
- run 対象は **#4 から採番する**

**やること:**

1. タスク（order.md）が指定する監査スコープ（対象期間 / 対象 workflow）を確認する。指定がなければ全 run
2. 各 run の `meta.json` から workflow / status / currentStep / iterations を**コマンドで機械的に集計する**（全 run を 1 件ずつ精読しない）
3. 分析価値の高い run を特定する — `status: aborted` の run、iterations が突出して多い run（差し戻しを繰り返した末の完走）、同一 workflow で失敗が連続している時期、loop monitor 発火が疑われる run（trace.md に judge step の Iteration が現れる）
4. 監査すべき対象を **Audit Targets 表**として採番する。**1 対象 = 1 run ではなく、同じ問いで束ねられる run 群**（例:「workflow X の aborted run 群」「日付 Y 前後の連続失敗」）を 1 対象とする
5. 再発パターンの抽出に効く順（失敗の集中度・最近性・現行 workflow との関連）で監査順を作る

**Audit Targets の粒度と上限（後続の全工程がこの表を骨格として使う）:**

- 1 対象 = アナリストが 1 回の再分析サイクルで対象 run の trace.md / meta.json / monitor.json を読み切れる範囲にする。束ねる run は 1 対象あたり概ね 10 件以内とし、超える場合は代表 run を明示して層化する
- **対象数は定義監査の固定 3 対象を含めて 24 以下**（run 対象は 21 以下）にする。超える場合は優先度の低い run 対象同士を統合する。この上限は workflow の容量（max_steps 25、再分析 1 サイクル最低 4 対象）から逆算した値であり、超えると完走できない
- 採番した **# は以降の全レポートで不変**。分析レポートの Audit Scope はこの表と一対一で照合される

**run の読み方（後続の全パートに引き継ぐこと）:**

- `meta.json` — workflow / status（completed / aborted / running）/ currentStep（止まった step）/ iterations（消費 step 数）
- `trace.md` — `## Iteration N: <step> (persona: ...)` の見出しから遷移系列を再構成できる。ABORT 原因・差し戻し経路はこの系列と各 Iteration の本文から読む
- `monitor.json` — OTel metrics。step ごとの実行回数と phase の状態

**重要:**

- 疑わしい数 run だけではなく、まずスコープ全体の run を機械的に集計してから対象を選ぶ
- completed の run も、iterations が突出して多いものは差し戻しの再発源として対象に含める
- 対象外とした run 群も、その理由（正常完走・実験用 workflow 等）を計画に明記する
