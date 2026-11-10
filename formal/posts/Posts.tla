------------------------------- MODULE Posts -------------------------------
\* 投稿 1 件（explainer_posts の 1 行）が、時刻が来た投稿の実行（`nyaucast post run`）、
\* 今すぐ実行（`post run-now`）、取り消し（`post cancel`）、公開済みの記録
\* （`post mark-published`）、公開の確認（`post run` の前段）の並行の中でどう動くか。
\* 状態は事実の表から毎回導出する（src/posts/post-state.ts の derivePostState）。
\* このモデルは、その導出と、事実の表への書き込みの順序を写す。
\*
\* モデルが省くもの:
\*  - readiness（アカウントの照合・鮮度）は常に通るとする（isStillReady は常に Some）。
\*  - classifyPost の複数の SELECT は 1 つの読み取りとして扱う（読みのちぎれは見ない）。
\*  - upload の拒否/失敗（explainer_post_upload_failures）、サムネイル、認証の停止は省く。
\*  - 時刻は 3 区間（予定時刻の前・許容時間の中・許容時間の後）に丸める。
\*  - YouTube の 401 の後の再送は、期限切れの分岐（YouTubeResendDeadlinePassed）だけを写す。

EXTENDS Naturals, Sequences, FiniteSets

CONSTANTS
    Runners,      \* 並行する実行。cron の `post run` の重なりと `post run-now`
    NowRunner,    \* Runners のうち `post run-now`（forced の方針）のもの
    MaxAttempts   \* 試行の行の上限（状態空間を有限にする境界）

VARIABLES
    platform,     \* explainer_posts.platform
    clock,        \* "before" | "window" | "late"（予定時刻の前 / 許容時間の中 / 後）
    attempts,     \* explainer_post_attempts と _results: 各試行の結果。"none" は結果の行が無い
    canceled,     \* explainer_post_cancellations に行がある
    published,    \* explainer_post_publications に行がある
    remote,       \* SNS 上の実体: "none" | "private" | "public" | "deleted"
    created,      \* SNS 上に実体を作った upload の回数
    lateStart,    \* 予定時刻を過ぎてから YouTube の upload を始めたか
    cancelWarned, \* 取り消しが "(remote may still remain)" と表示したか
    pc,           \* 各実行の位置
    snap,         \* 各実行が classifyPost で読んだ事実（終端の事実と最後の試行）
    mine,         \* 各実行が取った試行の番号（0 は未取得）
    outcome,      \* 各実行が書く予定の試行の結果
    cpc,          \* 取り消しの CLI の位置
    csnap,        \* 取り消しの CLI が読んだ状態
    kpc           \* 公開の確認の位置

vars == <<platform, clock, attempts, canceled, published, remote, created, lateStart,
          cancelWarned, pc, snap, mine, outcome, cpc, csnap, kpc>>

Platforms == {"youtube", "x"}

\* explainer-post-attempts.ts:68 readLastAttempt
LastOf(att) ==
    IF Len(att) = 0 THEN "none"
    ELSE IF att[Len(att)] = "none" THEN "resultless"
    ELSE att[Len(att)]

\* post-state.ts:210 derivePostState。優先順位は 終端の事実 → 最後の試行 → (readiness) → 時刻。
\* 戻り値は <<status, reason>>。
Derive(plat, last, isCanceled, isPublished, clk) ==
    IF isCanceled THEN <<"canceled", "">>                                \* post-state.ts:189
    ELSE IF isPublished THEN <<"published", "">>                         \* post-state.ts:192
    ELSE IF last = "resultless" THEN <<"awaiting_check", "resultless_attempt">> \* post-state.ts:161
    ELSE IF last = "succeeded" THEN                                      \* post-state.ts:164
        IF plat # "youtube" THEN <<"published", "">>                     \* post-state.ts:149
        ELSE IF clk = "late" THEN <<"awaiting_check", "publication_unconfirmed">> \* post-state.ts:153
        ELSE <<"reserved", "">>
    ELSE IF last = "permanent" THEN <<"failed", "">>                     \* post-state.ts:167
    ELSE IF plat = "youtube" THEN                                        \* post-state.ts:117
        IF clk = "before" THEN <<"due", "">> ELSE <<"awaiting_check", "tolerance_exceeded">>
    ELSE IF clk = "before" THEN <<"scheduled", "">>                      \* post-state.ts:124
    ELSE IF clk = "window" THEN <<"due", "">>                            \* post-state.ts:128
    ELSE <<"awaiting_check", "tolerance_exceeded">>

Now == Derive(platform, LastOf(attempts), canceled, published, clock)
Status == Now[1]
Reason == Now[2]

\* due-posts.ts:87 acquirableOutcomes
Allowed(r) == IF r = NowRunner THEN {"permanent", "temporary"} ELSE {"temporary"}

\* explainer-post-attempts.ts:39-45 の 1 文の INSERT ... WHERE。結果の無い試行（NULL）は IN に当たらない。
Acquirable(r) == Len(attempts) = 0 \/ attempts[Len(attempts)] \in Allowed(r)

\* due-posts.ts:133 isStillDue。forced は YouTube の予定時刻超過だけを見る。
\* due は classifyPost が読んだ終端の事実と最後の試行（snap）に、今の時刻を合わせて導き直す。
StillDue(r) ==
    IF r = NowRunner THEN platform # "youtube" \/ clock = "before"
    ELSE Derive(platform, snap[r].last, snap[r].canceled, snap[r].published, clock)[1] = "due"

Init ==
    /\ platform \in Platforms
    /\ clock = "before"
    /\ attempts = <<>>
    /\ canceled = FALSE
    /\ published = FALSE
    /\ remote = "none"
    /\ created = 0
    /\ lateStart = FALSE
    /\ cancelWarned = FALSE
    /\ pc = [r \in Runners |-> "idle"]
    /\ snap = [r \in Runners |-> [last |-> "none", canceled |-> FALSE, published |-> FALSE]]
    /\ mine = [r \in Runners |-> 0]
    /\ outcome = [r \in Runners |-> "none"]
    /\ cpc = "idle"
    /\ csnap = [status |-> "none", last |-> "none"]
    /\ kpc = "idle"

RunnerVars == <<pc, snap, mine, outcome>>
Untouched == <<cpc, csnap, kpc>>

\* ---- 時刻と YouTube 側 ----

Tick ==
    /\ clock # "late"
    /\ clock' = IF clock = "before" THEN "window" ELSE "late"
    /\ UNCHANGED <<platform, attempts, canceled, published, remote, created, lateStart,
                   cancelWarned, RunnerVars, Untouched>>

\* YouTube は予約（publishAt）の時刻に private の動画を公開する。
YouTubePublishes ==
    /\ remote = "private"
    /\ clock # "before"
    /\ remote' = "public"
    /\ UNCHANGED <<platform, clock, attempts, canceled, published, created, lateStart,
                   cancelWarned, RunnerVars, Untouched>>

\* ---- `post run` / `post run-now` の 1 件の処理 ----

\* due-posts.ts:63-68 selectDuePosts（classifyPost で due を選ぶ）。
\* run-post-now.ts:30 今すぐ実行は awaiting_check か failed だけ。
Classify(r) ==
    /\ pc[r] = "idle"
    /\ IF r = NowRunner THEN Status \in {"awaiting_check", "failed"}  \* run-post-now.ts:30
                        ELSE Status = "due"                          \* due-posts.ts:68
    /\ pc' = [pc EXCEPT ![r] = "classified"]
    /\ snap' = [snap EXCEPT ![r] = [last |-> LastOf(attempts), canceled |-> canceled,
                                    published |-> published]]
    /\ UNCHANGED <<platform, clock, attempts, canceled, published, remote, created, lateStart,
                   cancelWarned, mine, outcome, Untouched>>

\* due-posts.ts:279 prepareAdapterInput が成功し、due-posts.ts:285 の予定時刻の再確認を通る。
PrepareAndCheck(r) ==
    /\ pc[r] = "classified"
    /\ pc' = [pc EXCEPT ![r] = IF StillDue(r) THEN "prepared" ELSE "idle"]  \* due-posts.ts:285
    /\ UNCHANGED <<platform, clock, attempts, canceled, published, remote, created, lateStart,
                   cancelWarned, snap, mine, outcome, Untouched>>

\* due-posts.ts:279 送信前処理の失敗。recordPrepareFailure（due-posts.ts:248）が試行を取って結果を書く。
PrepareFails(r) ==
    /\ pc[r] = "classified"
    /\ \E o \in {"permanent", "temporary"}:
        /\ pc' = [pc EXCEPT ![r] = "prepFailed"]
        /\ outcome' = [outcome EXCEPT ![r] = o]
    /\ UNCHANGED <<platform, clock, attempts, canceled, published, remote, created, lateStart,
                   cancelWarned, snap, mine, Untouched>>

\* due-posts.ts:254 acquireNow（送信前処理の失敗を記録するための獲得）
AcquireForFailure(r) ==
    /\ pc[r] = "prepFailed"
    /\ Len(attempts) < MaxAttempts
    /\ IF Acquirable(r)                                       \* explainer-post-attempts.ts:39
       THEN /\ attempts' = Append(attempts, "none")
            /\ mine' = [mine EXCEPT ![r] = Len(attempts) + 1]
            /\ pc' = [pc EXCEPT ![r] = "recording"]
       ELSE /\ pc' = [pc EXCEPT ![r] = "idle"]
            /\ UNCHANGED <<attempts, mine>>
    /\ UNCHANGED <<platform, clock, canceled, published, remote, created, lateStart,
                   cancelWarned, snap, outcome, Untouched>>

\* due-posts.ts:304 acquireNow。1 文の INSERT ... SELECT ... WHERE で原子的に取る。
Acquire(r) ==
    /\ pc[r] = "prepared"
    /\ Len(attempts) < MaxAttempts
    /\ IF Acquirable(r)                                       \* explainer-post-attempts.ts:39
       THEN /\ attempts' = Append(attempts, "none")
            /\ mine' = [mine EXCEPT ![r] = Len(attempts) + 1]
            /\ pc' = [pc EXCEPT ![r] = "acquired"]
       ELSE /\ pc' = [pc EXCEPT ![r] = "idle"]
            /\ UNCHANGED <<attempts, mine>>
    /\ UNCHANGED <<platform, clock, canceled, published, remote, created, lateStart,
                   cancelWarned, snap, outcome, Untouched>>

\* due-posts.ts:308 獲得の直後の予定時刻の再確認と、due-posts.ts:321 sendPreparedPost の開始。
\* 間に I/O は無いので 1 つの段にする。落ちたら結果を書かずに抜ける（結果の無い試行が残る）。
StartSend(r) ==
    /\ pc[r] = "acquired"
    /\ IF StillDue(r)                                         \* due-posts.ts:308
       THEN /\ pc' = [pc EXCEPT ![r] = "sending"]
            /\ lateStart' = (lateStart \/ (platform = "youtube" /\ clock # "before"))
       ELSE /\ pc' = [pc EXCEPT ![r] = "idle"]
            /\ UNCHANGED lateStart
    /\ UNCHANGED <<platform, clock, attempts, canceled, published, remote, created,
                   cancelWarned, snap, mine, outcome, Untouched>>

\* SNS が投稿を作る。YouTube は予約付きの private、X は即時公開。
Made == IF platform = "youtube" THEN "private" ELSE "public"

\* due-posts.ts:321-334 sendPreparedPost の結果。
SendSucceeds(r) ==
    /\ pc[r] = "sending"
    /\ remote' = Made
    /\ created' = created + 1
    /\ outcome' = [outcome EXCEPT ![r] = "succeeded"]
    /\ pc' = [pc EXCEPT ![r] = "recording"]
    /\ UNCHANGED <<platform, clock, attempts, canceled, published, lateStart, cancelWarned,
                   snap, mine, Untouched>>

SendFails(r) ==
    /\ pc[r] = "sending"
    /\ \E o \in {"permanent", "temporary"}:
        outcome' = [outcome EXCEPT ![r] = o]
    /\ pc' = [pc EXCEPT ![r] = "recording"]
    /\ UNCHANGED <<platform, clock, attempts, canceled, published, remote, created, lateStart,
                   cancelWarned, snap, mine, Untouched>>

\* due-posts.ts:333 完了可否が分からない。結果を書かない（SNS 側に作られたかどうかは分からない）。
SendIndeterminate(r) ==
    /\ pc[r] = "sending"
    /\ \/ /\ remote' = Made
          /\ created' = created + 1
       \/ UNCHANGED <<remote, created>>
    /\ pc' = [pc EXCEPT ![r] = "idle"]
    /\ UNCHANGED <<platform, clock, attempts, canceled, published, lateStart, cancelWarned,
                   snap, mine, outcome, Untouched>>

\* due-posts.ts:323 401 の後の再送の前に予定時刻を過ぎた。動画は作られず、結果も書かない。
ResendDeadlinePassed(r) ==
    /\ pc[r] = "sending"
    /\ platform = "youtube"
    /\ clock # "before"
    /\ pc' = [pc EXCEPT ![r] = "idle"]
    /\ UNCHANGED <<platform, clock, attempts, canceled, published, remote, created, lateStart,
                   cancelWarned, snap, mine, outcome, Untouched>>

\* due-posts.ts:175 / 202 appendAttemptResult（開始とは別の書き込み）。
RecordResult(r) ==
    /\ pc[r] = "recording"
    /\ attempts' = [attempts EXCEPT ![mine[r]] = outcome[r]]
    /\ pc' = [pc EXCEPT ![r] = "idle"]
    /\ UNCHANGED <<platform, clock, canceled, published, remote, created, lateStart,
                   cancelWarned, snap, mine, outcome, Untouched>>

\* ---- 公開の確認（cli.ts:89 runPublicationChecks。`post run` の前段） ----

\* publication-check.ts:27 対象は予定時刻を過ぎた reserved の YouTube の投稿。
CheckSelect ==
    /\ kpc = "idle"
    /\ Status = "reserved" /\ platform = "youtube" /\ clock # "before"
    /\ kpc' = "selected"
    /\ UNCHANGED <<platform, clock, attempts, canceled, published, remote, created, lateStart,
                   cancelWarned, RunnerVars, cpc, csnap>>

\* publication-check.ts:77 videos.list が public なら、publication-check.ts:89 公開済みを積む。
CheckRemote ==
    /\ kpc = "selected"
    /\ published' = (published \/ remote = "public")
    /\ kpc' = "idle"
    /\ UNCHANGED <<platform, clock, attempts, canceled, remote, created, lateStart,
                   cancelWarned, RunnerVars, cpc, csnap>>

\* ---- 取り消し（cli.ts cancel → cancel-post.ts） ----

\* post-target.ts:26 classifyPost で対象を読み、表示する。
CancelRead ==
    /\ cpc = "idle"
    /\ cpc' = "read"
    /\ csnap' = [status |-> Status, last |-> LastOf(attempts)]
    /\ UNCHANGED <<platform, clock, attempts, canceled, published, remote, created, lateStart,
                   cancelWarned, RunnerVars, kpc>>

\* cancel-post.ts:78 取り消し済みなら何もしない。cancel-post.ts:81 予約済みの YouTube なら
\* cancel-post.ts:53 リモートを消してから cancel-post.ts:54 取り消しを積む。それ以外は
\* cancel-post.ts:84 取り消しだけを積み、cancel-post.ts:61 結果の無い試行なら警告を出す。
CancelWrite ==
    /\ cpc = "read"
    /\ cpc' = "done"
    /\ IF csnap.status = "canceled" THEN                                   \* cancel-post.ts:78
            UNCHANGED <<canceled, remote, cancelWarned>>
       ELSE IF platform = "youtube" /\ csnap.last = "succeeded"
               /\ csnap.status # "published" THEN                          \* cancel-post.ts:23
            /\ remote' = IF remote = "none" THEN "none" ELSE "deleted"     \* cancel-post.ts:53
            /\ canceled' = TRUE                                            \* cancel-post.ts:54
            /\ UNCHANGED cancelWarned
       ELSE /\ canceled' = TRUE                                            \* cancel-post.ts:84
            /\ cancelWarned' = (csnap.last = "resultless")                 \* cancel-post.ts:61
            /\ UNCHANGED remote
    /\ UNCHANGED <<platform, clock, attempts, published, created, lateStart, RunnerVars,
                   csnap, kpc>>

\* ---- 公開済みの記録（cli.ts markPublished → record-publication.ts） ----

\* record-publication.ts:45 確認待ちの理由が公開済みの記録で解けるもの。人間は SNS 上で公開を
\* 確かめた URL を渡す（remote = "public" は人間の前提であって、コードの検査ではない）。
MarkPublished ==
    /\ Status = "awaiting_check"
    /\ Reason \in {"resultless_attempt", "publication_unconfirmed"}       \* record-publication.ts:45
    /\ remote = "public"
    /\ published' = TRUE                                                  \* record-publication.ts:49
    /\ UNCHANGED <<platform, clock, attempts, canceled, remote, created, lateStart,
                   cancelWarned, RunnerVars, Untouched>>

Runner(r) ==
    \/ Classify(r) \/ PrepareAndCheck(r) \/ PrepareFails(r) \/ AcquireForFailure(r)
    \/ Acquire(r) \/ StartSend(r) \/ SendSucceeds(r) \/ SendFails(r)
    \/ SendIndeterminate(r) \/ ResendDeadlinePassed(r) \/ RecordResult(r)

Next ==
    \/ Tick \/ YouTubePublishes
    \/ \E r \in Runners: Runner(r)
    \/ CheckSelect \/ CheckRemote
    \/ CancelRead \/ CancelWrite
    \/ MarkPublished

Spec == Init /\ [][Next]_vars

\* ---- 型 ----

TypeOK ==
    /\ platform \in Platforms
    /\ clock \in {"before", "window", "late"}
    /\ remote \in {"none", "private", "public", "deleted"}
    /\ created \in 0..MaxAttempts
    /\ Len(attempts) <= MaxAttempts

\* ---- 規則 ----

\* 1 件の投稿が SNS 上に作られるのは高々 1 回（二重投稿しない）。
AtMostOneUpload == created <= 1

\* YouTube の upload は予定時刻を過ぎてから始めない（private の予約が即時公開になるため）。
NoLateYouTubeUpload == ~lateStart

\* 「公開済み」と表示するとき、SNS 上に公開された投稿がある。
PublishedIsPublic == Status = "published" => remote = "public"

\* 取り消しが「残っているかもしれない」と言わずに終わったなら、その投稿は SNS 上に公開されていない。
CanceledStaysOffline == (canceled /\ ~cancelWarned) => remote # "public"

=============================================================================
