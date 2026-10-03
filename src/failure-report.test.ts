import { assert, describe, it } from "@effect/vitest";
import { Schema } from "effect";

import { describeFailure } from "./failure-report.ts";

class WithFacts extends Schema.TaggedError<WithFacts>()("WithFacts", {
  collectionId: Schema.String,
}) {}
class WithoutFacts extends Schema.TaggedError<WithoutFacts>()("WithoutFacts", {}) {}

describe("failure report", () => {
  it("shows the tag and the fact fields", () => {
    assert.strictEqual(
      describeFailure(new WithFacts({ collectionId: "01JMISSING" })),
      'WithFacts {"collectionId":"01JMISSING"}',
    );
  });

  it("shows only the tag when there are no facts", () => {
    assert.strictEqual(describeFailure(new WithoutFacts()), "WithoutFacts");
  });

  it("shows no stack, cause, or message", () => {
    const rendered = describeFailure(new WithFacts({ collectionId: "x" }));

    assert.isFalse(/\n|\bat \S+:\d+/u.test(rendered));
  });

  it.each([new Error("secret in message"), "plain string", undefined, null])(
    "reports an untagged value as an unexpected failure without its content",
    (value) => {
      assert.strictEqual(describeFailure(value), "UnexpectedFailure");
    },
  );
});
