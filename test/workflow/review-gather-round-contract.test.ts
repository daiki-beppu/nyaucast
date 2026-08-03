import { describe, expect, test } from "bun:test";

import Ajv from "ajv";

import { readRepositoryFile } from "../helpers";

const schemaPath = ".takt/schemas/tayk-review-gather.json";
const schema = JSON.parse(readRepositoryFile(schemaPath)) as Record<
  string,
  unknown
>;
const validate = new Ajv({ allErrors: true }).compile(schema);

function gatherResult(previousReview: string, round: number): object {
  return {
    failure_reason: "",
    pr_number: 254,
    previous_review: previousReview,
    round,
    status: "ready",
  };
}

describe("tayk-review gather round contract", () => {
  test.each(["none", "malformed"])(
    "[REQ-257-01] should require round 1 when previous_review is %s",
    (previousReview) => {
      expect(validate(gatherResult(previousReview, 1))).toBeTrue();
      expect(validate(gatherResult(previousReview, 2))).toBeFalse();
    }
  );

  test("[REQ-257-02] should require round 2 or later when previous_review is valid", () => {
    expect(validate(gatherResult("valid", 1))).toBeFalse();
    expect(validate(gatherResult("valid", 2))).toBeTrue();
    expect(validate(gatherResult("valid", 9))).toBeTrue();
  });
});
