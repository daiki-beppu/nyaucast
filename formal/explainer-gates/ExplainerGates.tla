--------------------------- MODULE ExplainerGates ---------------------------
\* 解説動画 1 本が、企画（writePlan）→ サムネイルの選択 → 企画ゲート（produce）→ 描画
\* （renderCut）→ 公開ゲート（publish の対話と承認）→ 投稿の実行、と進む間の承認の事実と、
\* やめる（abandon）操作の関係。ゲートの判定は承認と NO-GO の表の最新の時刻から毎回導く
\* （src/db/gates.ts）。事実の時刻はミリ秒の整数で、afterLatestFact（src/db/fact-time.ts）が
\* 直前の事実より後にずらす。
\*
\* モデルが省くもの:
\*  - カットは長尺 1 本、投稿は 1 件。ショート、投稿案、アカウントの照合は省く。
\*  - 時計は戻らない（戻る場合は collection-gates のモデルが見る）。
\*  - 投稿の実行の並行（獲得・取り消しなど）は posts のモデルが見る。ここでは鮮度の検査
\*    （post-readiness.ts の checkStaleFacts）を通った upload だけを写す。
\*  - トランザクション（inTransaction）は SQLite が直列にするので、1 つの段として扱う。

EXTENDS Integers, Sequences

CONSTANTS MaxTime, MaxPlans, MaxSelections, MaxExports

VARIABLES
    now,          \* Clock.currentTimeMillis
    plans,        \* explainer の企画の版の数
    planAt,       \* 最後の企画の版の時刻（plan.updatedAt）
    frozenPlan,   \* 最初の企画ゲートの承認の時点の企画の版（0 は未承認）
    sels,         \* サムネイルの選択の時刻の列（explainer_thumbnail_selections）
    gates,        \* [produce, publish] → <<kind, at>> の列（explainer_approvals / _rejections）
    exports,      \* 長尺のカットの書き出しの時刻の列（explainer_cut_exports）
    rpc,          \* 描画（video.renderCut）の位置
    dpc,          \* 公開ゲートの対話の位置
    shown,        \* 対話が見せた最後の書き出しと選択（番号。0 は無し）
    post,         \* 公開ゲートが書いた投稿（created_at と、承認した時に見えていた番号）
    uploaded      \* 鮮度の検査を通って SNS へ出た書き出しと選択の番号

vars == <<now, plans, planAt, frozenPlan, sels, gates, exports, rpc, dpc, shown, post, uploaded>>

None == -1
Max(a, b) == IF a > b THEN a ELSE b

\* fact-time.ts:2 afterLatestFact
After(n, latest) == IF latest < n THEN n ELSE latest + 1

\* 時刻の列の最後の行（created_at DESC, rowid DESC。explainer-cuts.ts:78）。無ければ 0。
LastIdx(s) ==
    IF Len(s) = 0 THEN 0
    ELSE CHOOSE i \in 1..Len(s): \A j \in 1..Len(s): s[j] < s[i] \/ (s[j] = s[i] /\ j <= i)
LastAt(s) == IF Len(s) = 0 THEN None ELSE s[LastIdx(s)]

KindAt(g, k) ==
    LET ts == {gates[g][i][2] : i \in {i \in 1..Len(gates[g]) : gates[g][i][1] = k}}
    IN IF ts = {} THEN None ELSE CHOOSE t \in ts: \A u \in ts: u <= t

\* gates.ts:58 decideGate
Decision(g) ==
    LET a == KindAt(g, "approval")
        r == KindAt(g, "rejection")
    IN IF r = None THEN (IF a = None THEN "pending" ELSE "approved")
       ELSE IF a # None /\ a > r THEN "approved" ELSE "rejected"

\* gates.ts:68 latestGateTimestamp
GateLatest(g) == Max(KindAt(g, "approval"), KindAt(g, "rejection"))

HasApproval(g) == KindAt(g, "approval") # None

\* video-read-model.ts:83 isVideoAbandoned
Abandoned == Decision("produce") = "rejected" \/ Decision("publish") = "rejected"

Init ==
    /\ now = 1
    /\ plans = 1
    /\ planAt = 1
    /\ frozenPlan = 0
    /\ sels = <<>>
    /\ gates = [g \in {"produce", "publish"} |-> <<>>]
    /\ exports = <<>>
    /\ rpc = "idle"
    /\ dpc = "idle"
    /\ shown = [exp |-> 0, sel |-> 0]
    /\ post = [exists |-> FALSE, at |-> None, exp |-> 0, sel |-> 0]
    /\ uploaded = [done |-> FALSE, exp |-> 0, sel |-> 0]

Tick ==
    /\ now < MaxTime
    /\ now' = now + 1
    /\ UNCHANGED <<plans, planAt, frozenPlan, sels, gates, exports, rpc, dpc, shown, post, uploaded>>

\* video.writePlan.ts:97 overwriteInTransaction（承認済み・やめた動画には書かない）
WritePlan ==
    /\ plans < MaxPlans
    /\ ~HasApproval("produce")                       \* video.writePlan.ts:100
    /\ ~Abandoned                                    \* video.writePlan.ts:103
    /\ plans' = plans + 1                            \* video.writePlan.ts:110
    /\ planAt' = After(now, planAt)
    /\ UNCHANGED <<now, frozenPlan, sels, gates, exports, rpc, dpc, shown, post, uploaded>>

\* thumbnail-selection.ts:68 選択は、最後の選択と企画の更新のどちらよりも後の時刻で積む。
SelectThumbnail ==
    /\ Len(sels) < MaxSelections
    /\ sels' = Append(sels, After(now, Max(LastAt(sels), planAt)))  \* thumbnail-selection.ts:54
    /\ UNCHANGED <<now, plans, planAt, frozenPlan, gates, exports, rpc, dpc, shown, post, uploaded>>

\* gate-operations.ts:40 produceInTransaction
ProduceVideo ==
    /\ Decision("produce") # "approved" => LastAt(sels) > planAt   \* gate-operations.ts:44
    /\ IF Decision("produce") = "approved"                          \* gates.ts:142
       THEN UNCHANGED <<gates, frozenPlan>>
       ELSE /\ gates' = [gates EXCEPT !["produce"] =
                 Append(@, <<"approval", After(now, GateLatest("produce"))>>)]  \* gates.ts:145
            /\ frozenPlan' = IF frozenPlan = 0 THEN plans ELSE frozenPlan
    /\ UNCHANGED <<now, plans, planAt, sels, exports, rpc, dpc, shown, post, uploaded>>

\* gate-operations.ts:57 abandonInTransaction。公開ゲートの承認がある動画はやめられない。
Abandon ==
    /\ ~HasApproval("publish")                                       \* gate-operations.ts:60
    /\ LET g == IF Decision("produce") = "approved" THEN "publish" ELSE "produce"  \* gates.ts:178
       IN IF Decision(g) = "rejected"                               \* gates.ts:142
          THEN UNCHANGED gates
          ELSE gates' = [gates EXCEPT ![g] = Append(@, <<"rejection", After(now, GateLatest(g))>>)]
    /\ UNCHANGED <<now, plans, planAt, frozenPlan, sels, exports, rpc, dpc, shown, post, uploaded>>

\* composition.ts:58 requireProduceApproval（描画の始まり）
RenderStart ==
    /\ rpc = "idle"
    /\ Decision("produce") = "approved"
    /\ rpc' = "rendering"
    /\ UNCHANGED <<now, plans, planAt, frozenPlan, sels, gates, exports, dpc, shown, post, uploaded>>

\* video.renderCut.ts:213 appendCutExport。時刻は直前の書き出しより後（explainer-cuts.ts:113）。
RenderFinish ==
    /\ rpc = "rendering"
    /\ Len(exports) < MaxExports
    /\ exports' = Append(exports, After(now, LastAt(exports)))
    /\ rpc' = "idle"
    /\ UNCHANGED <<now, plans, planAt, frozenPlan, sels, gates, dpc, shown, post, uploaded>>

\* publish-gate.ts:219 preparePublish（企画ゲートの承認が前提。publish-gate.ts:123）
PublishShow ==
    /\ dpc = "idle"
    /\ ~post.exists
    /\ Decision("produce") = "approved"              \* publish-gate.ts:123
    /\ dpc' = "shown"
    /\ shown' = [exp |-> LastIdx(exports), sel |-> LastIdx(sels)]
    /\ UNCHANGED <<now, plans, planAt, frozenPlan, sels, gates, exports, rpc, post, uploaded>>

\* publish-gate.ts:376 approvePublish（1 つのトランザクション）。表示した内容が変わっていたら
\* 書かない（publish-gate.ts:377）。承認は、最後の書き出しと選択のどれよりも後の時刻で積み
\* （publish-gate.ts:386・gates.ts:168）、投稿の created_at にする（publish-gate.ts:390）。
PublishApprove ==
    /\ dpc = "shown"
    /\ dpc' = "idle"
    /\ IF /\ Decision("produce") = "approved"                        \* publish-gate.ts:123
          /\ shown = [exp |-> LastIdx(exports), sel |-> LastIdx(sels)]  \* publish-gate.ts:377
       THEN LET at == After(now, Max(GateLatest("publish"), Max(LastAt(exports), LastAt(sels))))
            IN /\ gates' = [gates EXCEPT !["publish"] = Append(@, <<"approval", at>>)]
               /\ post' = [exists |-> TRUE, at |-> at, exp |-> shown.exp, sel |-> shown.sel]
       ELSE UNCHANGED <<gates, post>>
    /\ UNCHANGED <<now, plans, planAt, frozenPlan, sels, exports, rpc, shown, uploaded>>

\* post-readiness.ts:70-80 checkStaleFacts を通った投稿だけが upload する。送信前処理は
\* 検査で読んだ書き出しと選択をそのまま使う（ReadyFacts。due-posts.ts:110）。
Upload ==
    /\ post.exists /\ ~uploaded.done
    /\ Len(exports) > 0
    /\ LastAt(exports) < post.at                    \* post-readiness.ts:75
    /\ LastAt(sels) < post.at                       \* post-readiness.ts:79
    /\ uploaded' = [done |-> TRUE, exp |-> LastIdx(exports), sel |-> LastIdx(sels)]
    /\ UNCHANGED <<now, plans, planAt, frozenPlan, sels, gates, exports, rpc, dpc, shown, post>>

Next ==
    \/ Tick \/ WritePlan \/ SelectThumbnail \/ ProduceVideo \/ Abandon
    \/ RenderStart \/ RenderFinish \/ PublishShow \/ PublishApprove \/ Upload

Spec == Init /\ [][Next]_vars

TypeOK ==
    /\ now \in 1..MaxTime
    /\ plans \in 1..MaxPlans
    /\ rpc \in {"idle", "rendering"}
    /\ dpc \in {"idle", "shown"}

\* 企画ゲートを一度承認した企画は、その後変わらない。
PlanFrozenAfterProduce == frozenPlan # 0 => plans = frozenPlan

\* 企画ゲートが承認のとき、最後のサムネイルの選択は最後の企画より新しい。
ProduceHasFreshThumbnail == Decision("produce") = "approved" => LastAt(sels) > planAt

\* 投稿があるなら、企画ゲートは承認で、公開ゲートの承認がある。
PostNeedsBothGates == post.exists => Decision("produce") = "approved" /\ HasApproval("publish")

\* やめた動画に投稿は無い。
AbandonedHasNoPost == Abandoned => ~post.exists

\* SNS へ出た書き出しとサムネイルは、公開ゲートで人が見て承認したもの。
UploadIsWhatWasApproved == uploaded.done => uploaded.exp = post.exp /\ uploaded.sel = post.sel

=============================================================================
