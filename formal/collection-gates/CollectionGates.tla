-------------------------- MODULE CollectionGates --------------------------
\* BGM 動画（collection）1 本の企画ゲート（produce）と公開ゲート（publish）。`nyaucast video
\* produce / publish / abandon`（src/videos/cli.ts）が src/collections/gate-operations.ts を通して
\* 承認と NO-GO の事実を積み、判定は表の最新の時刻から毎回導く（src/db/gates.ts）。事実の時刻は
\* 壁時計のミリ秒で、afterLatestFact（src/db/fact-time.ts）が直前の事実より後にずらす。
\* このモデルは、時計が戻る（NTP の補正など）ときも判定が最後の操作に従うかを見る。
\*
\* モデルが省くもの:
\*  - サムネイルの有無は read model の承認待ちの表示にだけ効くので、判定の規則からは省く。
\*  - 各操作は inTransaction の 1 つのトランザクションで、SQLite が直列にする。1 つの段として扱う。

EXTENDS Integers, Sequences

CONSTANTS MaxTime, MaxFacts

VARIABLES
    now,     \* Clock.currentTimeMillis（戻ることがある）
    gates,   \* [produce, publish] → <<kind, at>> の列（approvals / rejections の表）
    intent   \* 各ゲートについて、最後に事実を積んだ操作が望んだ判定（"none" は未操作）

vars == <<now, gates, intent>>

None == -1
Max(a, b) == IF a > b THEN a ELSE b

\* fact-time.ts:2 afterLatestFact
After(n, latest) == IF latest < n THEN n ELSE latest + 1

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

Facts == Len(gates["produce"]) + Len(gates["publish"])

\* gates.ts:139 recordDecisionIn: 判定が望む判定と違うときだけ、直前の事実より後の時刻で積む。
Record(g, d) ==
    IF Decision(g) = d                                                     \* gates.ts:142
    THEN UNCHANGED <<gates, intent>>
    ELSE /\ gates' = [gates EXCEPT ![g] = Append(@, <<IF d = "approved" THEN "approval"
                                                      ELSE "rejection",
                                                      After(now, GateLatest(g))>>)]  \* gates.ts:145
         /\ intent' = [intent EXCEPT ![g] = d]

Init ==
    /\ now \in 1..MaxTime
    /\ gates = [g \in {"produce", "publish"} |-> <<>>]
    /\ intent = [g \in {"produce", "publish"} |-> "none"]

ClockForward ==
    /\ now < MaxTime
    /\ now' = now + 1
    /\ UNCHANGED <<gates, intent>>

ClockBack ==
    /\ now > 1
    /\ now' = now - 1
    /\ UNCHANGED <<gates, intent>>

\* gate-operations.ts:31 produceCollection
Produce ==
    /\ Facts < MaxFacts
    /\ Record("produce", "approved")                                       \* gate-operations.ts:34
    /\ UNCHANGED now

\* gate-operations.ts:40 publishCollection（企画ゲートが承認であることが前提）
Publish ==
    /\ Facts < MaxFacts
    /\ Decision("produce") = "approved"                                    \* gate-operations.ts:44
    /\ Record("publish", "approved")                                       \* gate-operations.ts:47
    /\ UNCHANGED now

\* gate-operations.ts:54 abandonCollection。公開ゲートの承認があればやめられない。
\* まだ承認されていない最初のゲートに NO-GO を積む（gates.ts:175 abandonIn）。
Abandon ==
    /\ Facts < MaxFacts
    /\ ~HasApproval("publish")                                             \* gate-operations.ts:57
    /\ Record(IF Decision("produce") = "approved" THEN "publish" ELSE "produce", "rejected")  \* gates.ts:178
    /\ UNCHANGED now

Next == ClockForward \/ ClockBack \/ Produce \/ Publish \/ Abandon

Spec == Init /\ [][Next]_vars

TypeOK ==
    /\ now \in 1..MaxTime
    /\ \A g \in {"produce", "publish"}: intent[g] \in {"none", "approved", "rejected"}

\* 各ゲートの判定は、そのゲートに最後に事実を積んだ操作が望んだ判定と同じ（時計が戻っても）。
DecisionFollowsLastAction ==
    \A g \in {"produce", "publish"}:
        Decision(g) = IF intent[g] = "none" THEN "pending" ELSE intent[g]

\* 公開ゲートが承認なら、企画ゲートも承認。
PublishNeedsProduce == Decision("publish") = "approved" => Decision("produce") = "approved"

\* 公開ゲートを一度承認した collection は、やめた（terminated）にならない。
PublishedIsNeverTerminated ==
    HasApproval("publish") =>
        Decision("produce") # "rejected" /\ Decision("publish") # "rejected"   \* read-model.ts:32

=============================================================================
