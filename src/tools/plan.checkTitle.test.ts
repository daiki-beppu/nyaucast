import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";

import { accepts, publishedAdditionalProperties, insertCollection } from "../../test/helpers.ts";
import { callTool, rejectionReason, withToolChannel } from "../../test/tool-helpers.ts";
import { PlanCheckTitleTool } from "./plan.checkTitle.ts";

describe("plan.checkTitle", () => {
  it("is named with its wire name", () => {
    assert.strictEqual(PlanCheckTitleTool.name, "plan_check_title");
  });

  it("exposes title as its only input, and rejects every other key", () => {
    assert.isTrue(accepts(PlanCheckTitleTool.parametersSchema, { title: "Night Drive" }));
    assert.isFalse(
      accepts(PlanCheckTitleTool.parametersSchema, {
        channelDir: "/channels/deepfocus365",
        title: "Night Drive",
      }),
    );
    assert.strictEqual(publishedAdditionalProperties(PlanCheckTitleTool), false);
  });

  it.effect("accepts an unused title whose UTF-16 length is exactly 100", () =>
    withToolChannel("nyaucast-check-title-100-", {}, () =>
      Effect.gen(function* () {
        assert.deepStrictEqual(yield* callTool("plan_check_title", { title: "😀".repeat(50) }), {
          ok: true,
        });
      }),
    ),
  );

  it.effect("accepts a title that no collection uses", () =>
    withToolChannel("nyaucast-check-title-free-", {}, () =>
      Effect.gen(function* () {
        yield* insertCollection({ id: "01JEXISTING00000000000000", title: "Other" });

        assert.deepStrictEqual(yield* callTool("plan_check_title", { title: "Night Drive" }), {
          ok: true,
        });
      }),
    ),
  );

  it.effect("fails with a declared failure when the UTF-16 length exceeds 100", () =>
    withToolChannel("nyaucast-check-title-101-", {}, () =>
      Effect.gen(function* () {
        const failure = yield* Effect.flip(
          callTool("plan_check_title", { title: `${"😀".repeat(50)}a` }),
        );

        assert.strictEqual(failure._tag, "TitleTooLong");
      }),
    ),
  );

  it.effect("fails with a declared failure when a collection already uses the title", () =>
    withToolChannel("nyaucast-check-title-used-", {}, () =>
      Effect.gen(function* () {
        yield* insertCollection({ id: "01JEXISTING00000000000000", title: "Night Drive" });

        const failure = yield* Effect.flip(callTool("plan_check_title", { title: "Night Drive" }));

        assert.strictEqual(failure._tag, "TitleAlreadyInUse");
      }),
    ),
  );

  it.effect("does not reserve the title (read-only)", () =>
    withToolChannel("nyaucast-check-title-readonly-", {}, () =>
      Effect.gen(function* () {
        yield* callTool("plan_check_title", { title: "Night Drive" });
        yield* callTool("plan_check_title", { title: "Night Drive" });

        yield* insertCollection({ id: "01JNEW00000000000000000000", title: "Night Drive" });
      }),
    ),
  );
});

describe("plan.checkTitle: unknown keys", () => {
  it.effect("rejects an unknown key as invalid parameters, as the MCP entry does", () =>
    withToolChannel("nyaucast-check-title-unknown-", {}, () =>
      Effect.gen(function* () {
        const input = { channelDir: "/channels/deepfocus365", title: "Night Drive" };

        assert.strictEqual(
          yield* rejectionReason("plan_check_title", input),
          "ToolParameterValidationError",
        );
      }),
    ),
  );
});
