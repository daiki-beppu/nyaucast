---
name: verify-collection-gates
description: BGM 動画（collection）の企画ゲート・公開ゲート・やめる操作の判定を、時計が戻る場合も含めて TLA+ モデルで検査する。src/collections/gate-operations.ts、src/db/gates.ts、src/db/fact-time.ts、src/db/read-model.ts を変えたときに使う。
---

# collection の承認ゲートを検査する

`formal/collection-gates/CollectionGates.tla` は、`nyaucast video produce / publish / abandon`（`src/videos/cli.ts` が collection のチャンネルで呼ぶ `src/collections/gate-operations.ts`）が積む承認と NO-GO の事実と、そこから毎回導く判定を写す。判定は事実の時刻の比較なので、壁時計が戻っても（NTP の補正など）判定が最後の操作に従うかを見る。

## いつ使うか

| コード                                                                                                  | モデルの中の対応                                             |
| ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `src/db/gates.ts` `decideGate`・`latestGateTimestamp`・`recordDecisionIn`・`abandonIn`・`hasApprovalIn` | `Decision`・`GateLatest`・`Record`・`Abandon`・`HasApproval` |
| `src/db/fact-time.ts` `afterLatestFact`                                                                 | `After`                                                      |
| `src/collections/gate-operations.ts` `produceCollection`・`publishCollection`・`abandonCollection`      | `Produce`・`Publish`・`Abandon`                              |
| `src/db/read-model.ts` `progressFromFacts`                                                              | `PublishedIsNeverTerminated`                                 |

`src/db/gates.ts` と `fact-time.ts` は verify-explainer-gates と共有している。変えたら両方を走らせる。

同期コミット: `2922c2683cc21cc8e440a582a2c1f85eb55e5e52`。

```sh
git diff --stat 2922c2683cc21cc8e440a582a2c1f85eb55e5e52 -- src/db/gates.ts src/db/fact-time.ts src/db/read-model.ts src/collections
```

## 走らせる

```sh
scripts/formal/check.sh formal/collection-gates/CollectionGates.tla
```

約 3 秒。境界: 時刻 1〜4 ms（前後どちらへも動く）、事実は 6 行まで。既知の破れは無い（`\* expect:` 行が無い）。

## 規則

| 規則                         | 一文                                                                                     |
| ---------------------------- | ---------------------------------------------------------------------------------------- |
| `DecisionFollowsLastAction`  | 各ゲートの判定は、そのゲートに最後に事実を積んだ操作が望んだ判定と同じ（時計が戻っても） |
| `PublishNeedsProduce`        | 公開ゲートが承認なら、企画ゲートも承認                                                   |
| `PublishedIsNeverTerminated` | 公開ゲートを一度承認した collection は、やめた（terminated）にならない                   |

## 結果を読む

結果は `/statechart`（pstack の statechart skill）で読む。scratch フォルダにモデルのコピーを置いて `from-spec` にかけ、状態を「企画: 承認・公開: 判定待ち」のような video status の言葉で、段を「人が video publish を叩く」「時計が戻る」で書く。

## 本物のバグか、モデルの誤りか

反例の段を `\* file:line` のコードに当てる。各操作は `inTransaction` の 1 トランザクションなので 1 段。実コードでは `src/collections/gate-operations.test.ts` の形で、`setClock` で時計を戻しながら同じ順で操作を叩いて再現する。再現しなければモデルを疑い、規則は弱めない。

## 意図した変更でモデルを直す

- action をコードと同じ粒度で直し、引用を更新する。
- 守る仕組みを外すと破れることを一度見る。いまの対応: `Record` の `After(now, GateLatest(g))` を `now` に → `DecisionFollowsLastAction`。`Publish` の produce の検査を消す → `PublishNeedsProduce`。`Abandon` の `~HasApproval("publish")` を消す → `PublishedIsNeverTerminated`。
- 一致を確かめた後でだけ同期コミットを進める。

## モデルが省くもの

サムネイルの有無（read model の承認待ちの表示にだけ効く）、collection の作成と存在の検査、`recordApproval`/`recordRejection`（時刻をずらさない書き込み。2922c26 時点でテスト以外から呼ばれていない。呼ばれ始めたらモデルに足す）。
