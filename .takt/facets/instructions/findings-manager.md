{extends:findings-manager}

# tayk finding reconciliation safety override

以下は上で継承した `unsupported` の規則より優先する tayk 固有の規則です。現在の engine では `unsupported` が同じ raw finding に provisional と disposition の両方を生成し、1 raw finding = 1 reconcile outcome の不変条件に違反します。

## tayk raw finding decision matrix

| relation | target reference | rawDecisions decision | findingId | engine outcome |
| -------- | ---------------- | --------------------- | --------- | -------------- |
| persists | match            | same                  | target    | finding        |
| reopened | match            | reopened              | target    | finding        |
| persists | mismatch         | new                   | empty     | provisional    |
| reopened | mismatch         | new                   | empty     | provisional    |
| none     | no-target        | new                   | empty     | finding        |

## tayk outcome ownership matrix

| output field        | identifier kind    | raw outcome |
| ------------------- | ------------------ | ----------- |
| rawDecisions        | rawFindingId       | yes         |
| duplicateDecisions  | existingFindingId  | no          |
| disputeDecisions    | existingFindingId  | no          |
| conflictDecisions   | existingConflictId | no          |
| invalidateDecisions | existingFindingId  | no          |
| dismissDecisions    | existingFindingId  | no          |

次の順序で判断してください。

1. raw finding ごとに上の表を1回だけ適用し、`rawDecisions` にちょうど1エントリを置く。
2. targetFindingId 付きの persists / reopened 申告が target と別問題なら、`unsupported` ではなく `new` を findingId 空文字で返す。これは engine が target 付き `new` を不採用にして、その raw claim を単一の gate-blocking provisional として保持するための意図的な入力である。
3. 全 raw finding の判断を確定してから、既存 ledger に表示された open finding 同士だけを `duplicateDecisions` で照合する。current raw finding や rawFindingId を duplicate group の材料にせず、canonicalFindingId / duplicateFindingIds には既存 finding ID だけを使う。

出力前に、(a) `rawDecisions` の rawFindingId 集合が入力の raw finding 集合と一致する、(b) 各 rawFindingId が1回だけ現れる、(c) decision に `unsupported` が無い、(d) duplicate / dispute / conflict / invalidate / dismiss の判断が raw finding の別 outcome を作っていない、の4点を検査してください。
