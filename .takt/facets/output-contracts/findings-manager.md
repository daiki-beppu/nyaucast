{extends:findings-manager}

# tayk finding reconciliation safety override

この節は継承元の `unsupported` に関する例・規則を置き換えます。tayk の finding manager 出力では `rawDecisions[].decision` に `unsupported` を使いません。

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

targetFindingId 付きの persists / reopened 申告で参照が成立しない場合は、次の形を使ってください。

```json
{
  "rawFindingId": "raw-target-mismatch",
  "decision": "new",
  "findingId": "",
  "evidence": "参照先とは failure mode・発生条件・影響・必要な修正が異なる"
}
```

engine は target 付き `new` を confirmed finding として採用せず、raw claim を単一の gate-blocking provisional にします。`unsupported` を使うと同じ raw finding に provisional と disposition が重なるため禁止です。

`duplicateDecisions` は current raw finding の分類とは別です。入力に表示された既存 open finding 同士の統合だけを表し、canonicalFindingId / duplicateFindingIds には既存 finding ID を設定します。rawFindingId を設定したり、current raw finding を duplicate group に含めたりしないでください。

出力前に次の不変条件を満たしてください。

- 入力 raw finding 1件につき `rawDecisions` はちょうど1件で、rawFindingId の重複・欠落・余剰がない。
- `rawDecisions[].decision` に `unsupported` がない。
- target 参照不成立は `decision: "new"` かつ `findingId: ""` である。
- `duplicateDecisions` など他の decision 配列は raw finding の第2 outcome を表さない。
