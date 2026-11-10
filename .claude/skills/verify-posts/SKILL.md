---
name: verify-posts
description: SNS 投稿 1 件の状態機械（post run / run-now / cancel / mark-published / 公開の確認）を TLA+ モデルで検査する。src/posts/ の投稿の実行・取り消し・状態の導出、または src/db/explainer-post-attempts.ts・explainer-post-facts.ts を変えたときに使う。
---

# 投稿の状態機械を検査する

`formal/posts/Posts.tla` は、投稿 1 件が `nyaucast post run`（cron が重なって 2 本）・`post run-now`・`post cancel`・`post mark-published`・公開の確認の並行の中でどう動くかを、TLC で全順序を尽くして検査する。テストが書かれた順序だけを見るのに対し、これは境界の中のすべての割り込みを見る。

## いつ使うか

次のファイルを変える差分は、このモデルが写すコードに触れている。変えたら必ず走らせる。

| コード                                                                                                                                                               | モデルの中の対応                                                                                                                                                   |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/posts/post-state.ts` `derivePostState` と各 `derive*`                                                                                                           | `Derive`                                                                                                                                                           |
| `src/posts/due-posts.ts` `selectDuePosts`・`isStillDue`・`acquirableOutcomes`・`prepareAndCheckDue`・`acquireAndCheckDue`・`uploadAndRecord`・`recordPrepareFailure` | `Classify`・`StillDue`・`Allowed`・`PrepareAndCheck`・`PrepareFails`・`AcquireForFailure`・`Acquire`・`StartSend`・`Send*`・`ResendDeadlinePassed`・`RecordResult` |
| `src/db/explainer-post-attempts.ts` `acquireAttempt`・`readLastAttempt`                                                                                              | `Acquirable`・`LastOf`                                                                                                                                             |
| `src/posts/run-post-now.ts` `runPostNow`                                                                                                                             | `Classify`（`NowRunner`）                                                                                                                                          |
| `src/posts/cancel-post.ts` `cancelPost`                                                                                                                              | `CancelRead`・`CancelWrite`                                                                                                                                        |
| `src/posts/record-publication.ts` `recordPostPublished`                                                                                                              | `MarkPublished`                                                                                                                                                    |
| `src/posts/publication-check.ts` `isPublicationCheckTarget`・`classifyVideoStatus`                                                                                   | `CheckSelect`・`CheckRemote`                                                                                                                                       |
| `src/posts/cli.ts` `run`（公開の確認 → due の実行の順）                                                                                                              | 実行の並び                                                                                                                                                         |

最後にモデルとコードの一致を確かめたコミット（同期コミット）: `2922c2683cc21cc8e440a582a2c1f85eb55e5e52`。

```sh
git diff --stat 2922c2683cc21cc8e440a582a2c1f85eb55e5e52 -- src/posts src/db/explainer-post-attempts.ts src/db/explainer-post-facts.ts
```

に差分があれば、モデルの各段の `\* file:line` の引用を開き、コードがまだそのとおりかを確かめる。

## 走らせる

```sh
scripts/formal/check.sh formal/posts/Posts.tla
```

java（21 以上）が要る。TLC 1.7.4 は初回に `~/.cache/tla` へ落としてチェックサムを確かめる。各規則を別の TLC で検査し、約 25 秒。`Posts.cfg` の `\* expect:` 行が既知の破れ。既知の破れだけが破れ、残りが成り立てば exit 0。反例は `formal/posts/out/<規則>.txt`（gitignore 済み）。

境界: `Runners = {"cron1","cron2","now"}`、試行は 2 行まで、プラットフォームは YouTube と X の両方（Instagram は X と同じ即時投稿の扱い）。

## 規則

| 規則                   | 一文                                                                                            | 破れたときの害                 |
| ---------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------ |
| `AtMostOneUpload`      | 1 件の投稿が SNS 上に作られるのは高々 1 回                                                      | 二重投稿                       |
| `NoLateYouTubeUpload`  | YouTube の upload は予定時刻を過ぎてから始めない                                                | private の予約が即時公開になる |
| `PublishedIsPublic`    | 「公開済み」と表示するとき、SNS 上に公開された投稿がある                                        | 未公開を公開済みと誤認する     |
| `CanceledStaysOffline` | 取り消しが「残っているかもしれない」と言わずに終わったなら、その投稿は SNS 上に公開されていない | 取り消したはずの投稿が出る     |

`CanceledStaysOffline` は現在のコードで破れる（既知の発見。下記）。直すまで `expect` に残す。規則を弱めて通さない。

## 結果を読む

結果は必ず `/statechart`（pstack の statechart skill）で読む。モデルのコピーを作業用の scratch フォルダに置き、`from-spec` にかけると、各違反を読み手の言葉の最短経路として書き出し、修正のモデルを渡せばどの違反が直るかも示す。通ったときは状態の移り方の図を描く。ラベルの写像（map）は、状態を「YouTube/X: video.status に出る状態・SNS 上の実体」、段を「post run が due の投稿を拾う」「人が post cancel を叩く」のような運営者の言葉にする。読み手の操作は `CancelRead`・`CancelWrite`・`MarkPublished`。

## 本物のバグか、モデルの誤りか

1. 反例の各段を、その段の `\* file:line` のコードに当てる。コードがその分岐を本当に持つか、モデルが 1 段にまとめた所でコードは間に I/O を挟んでいないかを見る。
2. 実コードで再現する。`src/posts/due-posts.test.ts` の C7 のテストの形（`VideoFiles.exists` を `Deferred` で止めて `runDuePosts` を途中で待たせ、その間に `Command.runWith(postCommand, …)(["cancel", id])` を叩く）で、モデルの段を 1 つずつ入口から再生する。再現しなければ、まずモデルを疑う。
3. モデルの誤りなら、コードに合わせてモデルを直す。規則は変えない。

## 意図した変更でモデルを直す

- コードの段を足す・消す・順番を変えたら、対応する action を同じ粒度で直し、`\* file:line` を更新する。コードの 1 つの不可分な書き込み（1 文の SQL、1 つのトランザクション）がモデルの 1 段。
- 変えたコードが規則を守る仕組みだったなら、その仕組みを外した変種で規則が破れることを一度見る。いまの対応: `Allowed` に `"succeeded"` を足す → `AtMostOneUpload` が破れる。`StartSend` の `StillDue(r)` を `TRUE` に → `NoLateYouTubeUpload`。`Derive` で YouTube の succeeded も `published` に → `PublishedIsPublic`。
- 既知の破れを直したら `Posts.cfg` の `\* expect:` から外す。
- コードとモデルの一致を確かめた後でだけ、上の同期コミットを新しいコミットに進める。

## 既知の発見（2922c26 時点）

1. **取り消しと実行の競合（#902）。** `post run` が投稿を due と読んだ（`classifyPost`）後に人が `post cancel` を叩くと、取り消しは警告なしで `canceled` と表示する。`isStillDue`（due-posts.ts:133）は `classifyPost` が読んだ終端の事実を読み直さず、`acquireAttempt` の SQL（explainer-post-attempts.ts:39）も取り消しを見ないので、`post run` はそのまま upload する。YouTube なら予約どおり公開される。2922c26 で、YouTube の投稿について、テストの入口（`runDuePosts` と `post cancel` の CLI）から再現した（`canceled: post 1` の後に `succeeded remoteId=VIDEO-A`）。
2. **公開済みの投稿の取り消し（#903）。** 公開済み（X/Instagram は成功の試行、YouTube は公開の確認）の投稿に `post cancel` を叩くと、SNS の投稿を消さず警告もなしに取り消し済みにする（cancel-post.ts:78-85）。意図かどうかは未判断。

## モデルが省くもの

readiness（アカウントの照合・鮮度。常に通るとする。鮮度は verify-explainer-gates が見る）、`classifyPost` の複数 SELECT の読みのちぎれ、upload の拒否/失敗の事実、サムネイル、認証の失敗によるアカウントの停止、upload にかかる時間の中での YouTube の予約時刻の扱い（`NoLateYouTubeUpload` は開始だけを見る）。時刻は 3 区間に丸める。`MarkPublished` は人が SNS 上の公開を確かめてから叩く前提（コードは検査しない）。
