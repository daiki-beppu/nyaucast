import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";

import {
  accepts,
  publishedAdditionalProperties,
  insertCollection,
  withChannel,
} from "../../test/helpers.ts";
import { PlanCheckTitleTool, planCheckTitle } from "./plan.checkTitle.ts";

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
    withChannel("nyaucast-check-title-100-", () =>
      Effect.gen(function* () {
        assert.deepStrictEqual(yield* planCheckTitle({ title: "😀".repeat(50) }), { ok: true });
      }),
    ),
  );

  it.effect("accepts a title that no collection uses", () =>
    withChannel("nyaucast-check-title-free-", () =>
      Effect.gen(function* () {
        yield* insertCollection({ id: "01JEXISTING00000000000000", title: "Other" });

        assert.deepStrictEqual(yield* planCheckTitle({ title: "Night Drive" }), { ok: true });
      }),
    ),
  );

  it.effect("fails with a declared failure when the UTF-16 length exceeds 100", () =>
    withChannel("nyaucast-check-title-101-", () =>
      Effect.gen(function* () {
        const failure = yield* Effect.flip(planCheckTitle({ title: `${"😀".repeat(50)}a` }));

        assert.strictEqual(failure._tag, "TitleTooLong");
      }),
    ),
  );

  it.effect("fails with a declared failure when a collection already uses the title", () =>
    withChannel("nyaucast-check-title-used-", () =>
      Effect.gen(function* () {
        yield* insertCollection({ id: "01JEXISTING00000000000000", title: "Night Drive" });

        const failure = yield* Effect.flip(planCheckTitle({ title: "Night Drive" }));

        assert.strictEqual(failure._tag, "TitleAlreadyInUse");
      }),
    ),
  );

  it.effect("does not reserve the title (read-only)", () =>
    withChannel("nyaucast-check-title-readonly-", () =>
      Effect.gen(function* () {
        yield* planCheckTitle({ title: "Night Drive" });
        yield* planCheckTitle({ title: "Night Drive" });

        yield* insertCollection({ id: "01JNEW00000000000000000000", title: "Night Drive" });
      }),
    ),
  );
});
