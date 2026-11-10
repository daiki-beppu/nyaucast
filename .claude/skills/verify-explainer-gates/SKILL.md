---
name: verify-explainer-gates
description: 解説動画の承認ゲート（企画 → サムネイル → produce → 描画 → publish → 投稿の鮮度の検査）とやめる操作を TLA+ モデルで検査する。src/videos/gate-operations.ts・publish-gate.ts・produce-gate.ts、src/db/gates.ts・fact-time.ts、video.writePlan・renderCut・サムネイルの選択、post-readiness.ts の鮮度の検査を変えたときに使う。
---

# 解説動画の承認ゲートを検査する

`formal/explainer-gates/ExplainerGates.tla` は、解説動画 1 本の企画の版・サムネイルの選択・企画ゲート（produce）・描画の書き出し・公開ゲート（publish）の対話と承認・やめる操作・投稿の鮮度の検査を、ミリ秒の整数の時刻つきで写し、TLC で全順序を検査する。

## いつ使うか

| コード                                                                                                                             | モデルの中の対応                                                                     |
| ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `src/db/gates.ts` `decideGate`・`latestGateTimestamp`・`recordDecisionIn`・`appendExplainerApproval`・`abandonIn`・`hasApprovalIn` | `Decision`・`GateLatest`・`ProduceVideo`・`Abandon`・`PublishApprove`・`HasApproval` |
| `src/db/fact-time.ts` `afterLatestFact`                                                                                            | `After`                                                                              |
| `src/videos/gate-operations.ts` `produceInTransaction`・`abandonInTransaction`                                                     | `ProduceVideo`・`Abandon`                                                            |
| `src/videos/publish-gate.ts` `readState`・`preparePublish`・`approvePublish`・`snapshotOf`                                         | `PublishShow`・`PublishApprove`                                                      |
| `src/videos/produce-gate.ts`・`src/compositions/composition.ts` `requireProduceApproval`                                           | `RenderStart`                                                                        |
| `src/tools/explainer/video.renderCut.ts`・`src/db/explainer-cuts.ts` `appendFact`・`lastFact`                                      | `RenderFinish`・`LastIdx`・`LastAt`                                                  |
| `src/tools/explainer/video.writePlan.ts` `overwriteInTransaction`                                                                  | `WritePlan`                                                                          |
| `src/videos/thumbnail-selection.ts` `selectionTime`                                                                                | `SelectThumbnail`                                                                    |
| `src/posts/post-readiness.ts` `checkStaleFacts`                                                                                    | `Upload`                                                                             |
| `src/db/video-read-model.ts` `isVideoAbandoned`                                                                                    | `Abandoned`                                                                          |

同期コミット: `2922c2683cc21cc8e440a582a2c1f85eb55e5e52`。

```sh
git diff --stat 2922c2683cc21cc8e440a582a2c1f85eb55e5e52 -- src/db/gates.ts src/db/fact-time.ts src/db/explainer-cuts.ts src/db/video-read-model.ts src/videos src/compositions/composition.ts src/tools/explainer/video.renderCut.ts src/tools/explainer/video.writePlan.ts src/posts/post-readiness.ts
```

に差分があれば、モデルの `\* file:line` の引用を開いて照らし合わせる。

## 走らせる

```sh
scripts/formal/check.sh formal/explainer-gates/ExplainerGates.tla
```

約 7 秒。`ExplainerGates.cfg` の `\* expect:` 行が既知の破れ。反例は `formal/explainer-gates/out/<規則>.txt`。境界: 時刻 1〜4 ms、企画 2 版、選択 2 回、書き出し 2 回、カットは長尺 1 本、投稿 1 件。

## 規則

| 規則                       | 一文                                                                 |
| -------------------------- | -------------------------------------------------------------------- |
| `PlanFrozenAfterProduce`   | 企画ゲートを一度承認した企画は、その後変わらない                     |
| `ProduceHasFreshThumbnail` | 企画ゲートが承認のとき、最後のサムネイルの選択は最後の企画より新しい |
| `PostNeedsBothGates`       | 投稿があるなら、企画ゲートは承認で、公開ゲートの承認がある           |
| `AbandonedHasNoPost`       | やめた動画に投稿は無い                                               |
| `UploadIsWhatWasApproved`  | SNS へ出た書き出しとサムネイルは、公開ゲートで人が見て承認したもの   |

`UploadIsWhatWasApproved` は現在のコードで破れる（既知の発見。下記）。

## 結果を読む

結果は `/statechart`（pstack の statechart skill）で読む。scratch フォルダにモデルのコピーを置いて `from-spec` にかけ、状態を「企画ゲート・公開ゲート・投稿が見る書き出し」の読み手の言葉で、段を「人が video produce を叩く」「描画が書き出しを積む」の言葉で書く。違反は最短経路の物語として、通れば状態の移り方の図として出る。

## 本物のバグか、モデルの誤りか

反例の段を `\* file:line` のコードに当てる。トランザクション（`inTransaction`）は SQLite が直列にするので 1 段、トランザクションの外の読み取りと書き込みは別の段でなければならない。実コードでは `test/` のヘルパーと `setClock` で時刻を固定し、入口（`video produce` / `video publish` の CLI、MCP tool、`runDuePosts`）から段を再生する。再現しなければまずモデルを疑い、規則は弱めない。

## 意図した変更でモデルを直す

- action をコードと同じ粒度で直し、引用を更新する。
- 守る仕組みを外すと破れることを一度見る。いまの対応: `WritePlan` の `~HasApproval("produce")` を消す → `PlanFrozenAfterProduce`。`ProduceVideo` の鮮度の検査を `TRUE` に → `ProduceHasFreshThumbnail`。`PublishShow`/`PublishApprove` の produce の検査を消す → `PostNeedsBothGates`。`Abandon` の `~HasApproval("publish")` を消す → `AbandonedHasNoPost`。
- 既知の破れを直したら `\* expect:` から外す。一致を確かめた後でだけ同期コミットを進める。

## 既知の発見（2922c26 時点、モデルのみ・実コードでは未再現。#904）

**承認の時刻が壁時計より先にずれると、承認の後の書き出しや選択が鮮度の検査を通る。** `approvePublish` は承認の時刻を最後の書き出しと選択より後にずらす（gates.ts:168。同じミリ秒なら +1 ms、時計が戻っていればもっと先）。一方、その後に積む書き出し（explainer-cuts.ts:113）と選択（thumbnail-selection.ts:54）は同じ表の直前の行より後にしかずらさず、承認の時刻を見ない。すると承認より後に積んだ行が承認より古い時刻を持ち、`checkStaleFacts`（post-readiness.ts:75・79）の `>=` を通って、人が見ていない書き出しやサムネイルが upload される。同じミリ秒の中か、時計が戻ったときにだけ起きる。反例: 選択（時刻 2）→ produce → 描画開始 → 公開ゲートの対話（書き出し無し）→ 承認（時刻 3 にずれる）→ 描画が書き出しを時刻 2 で積む → 鮮度の検査を通って upload。

## モデルが省くもの

ショートの候補とそのカット、投稿案、アカウントの照合、`requireNotPast`、プレビュー、時計の逆行（verify-collection-gates が見る）、投稿の実行の並行（verify-posts が見る）。`approvePublish` は書き出しが無くても承認できる（コードのとおり）。
