import { describe, expect, test } from "bun:test";

import { validateReviewPublication } from "../../.takt/scripts/validate-review-publication";
import type { ReviewPublicationEvidence } from "../../.takt/scripts/validate-review-publication";

const target = `# レビュー対象

## PR

| 項目 | 値 |
| --- | --- |
| 番号 | #254 |
| ラウンド | 4 |
`;

const marker =
  "<!-- tayk-review-publication: PR #254 / round 4 / run 20260803-pr-254 -->";

function evidence(
  overrides: Partial<ReviewPublicationEvidence> = {}
): ReviewPublicationEvidence {
  return {
    commentUrl:
      "https://github.com/daiki-beppu/tayk/pull/254#issuecomment-123456",
    publicationMarker: marker,
    reviewTarget: target,
    ...overrides,
  };
}

describe("tayk-review publication evidence", () => {
  test("[REQ-256-01] should derive a canonical identity from matching evidence", () => {
    const result = validateReviewPublication(evidence());

    expect(result).toEqual({
      comment_url:
        "https://github.com/daiki-beppu/tayk/pull/254#issuecomment-123456",
      failure_reason: "",
      pr_number: 254,
      publication_identity:
        "github:daiki-beppu/tayk:pull:254:round:4:comment:123456:run:20260803-pr-254",
      publication_marker: marker,
      round: 4,
      status: "posted",
    });
  });

  test("[REQ-256-02] should reject a marker for another pull request", () => {
    expect(() =>
      validateReviewPublication(
        evidence({
          publicationMarker:
            "<!-- tayk-review-publication: PR #999 / round 4 / run 20260803-pr-254 -->",
        })
      )
    ).toThrow(
      "publication marker PR #999 does not match review target PR #254"
    );
  });

  test("[REQ-256-03] should reject a comment URL for another pull request", () => {
    expect(() =>
      validateReviewPublication(
        evidence({
          commentUrl:
            "https://github.com/daiki-beppu/tayk/pull/999#issuecomment-123456",
        })
      )
    ).toThrow("comment URL PR #999 does not match review target PR #254");
  });

  test("[REQ-256-04] should reject a marker for another round", () => {
    expect(() =>
      validateReviewPublication(
        evidence({
          publicationMarker:
            "<!-- tayk-review-publication: PR #254 / round 7 / run 20260803-pr-254 -->",
        })
      )
    ).toThrow(
      "publication marker round 7 does not match review target round 4"
    );
  });

  test("[REQ-256-05] should reject URLs outside the pull request comment contract", () => {
    expect(() =>
      validateReviewPublication(
        evidence({
          commentUrl: "https://example.test/pull/254#issuecomment-123456",
        })
      )
    ).toThrow("comment URL must identify a github.com pull request comment");
  });
});
