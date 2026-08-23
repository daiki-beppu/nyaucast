import { describe, expect, test } from "bun:test";

import {
  checkPlanTitle,
  planCheckTitleInputSchema,
  planCheckTitleOutputSchema,
} from "./plan.check-title";
import type { PlanCheckTitleDependencies } from "./plan.check-title";

const dependencies = (
  existingTitles: readonly string[] = []
): {
  deps: PlanCheckTitleDependencies;
  getLookupCount: () => number;
} => {
  let lookupCount = 0;

  return {
    deps: {
      titleExists: async (title: string) => {
        lookupCount += 1;
        await Promise.resolve();
        return existingTitles.includes(title);
      },
    },
    getLookupCount: () => lookupCount,
  };
};

const expectRejection = async (operation: Promise<unknown>): Promise<void> => {
  let rejected = false;
  try {
    await operation;
  } catch {
    rejected = true;
  }
  expect(rejected).toBeTrue();
};

describe("plan.checkTitle", () => {
  test("returns the structured success object for an unused title", async () => {
    const { deps } = dependencies();

    const result = await checkPlanTitle({ title: "Night Drive" }, deps);

    expect(result).toEqual({ ok: true });
    expect(planCheckTitleOutputSchema.parse(result)).toEqual({ ok: true });
  });

  test("counts Unicode codepoints rather than UTF-16 code units", async () => {
    const { deps } = dependencies();
    const title = "🌙".repeat(100);

    expect(await checkPlanTitle({ title }, deps)).toEqual({ ok: true });
  });

  test("rejects 101 Unicode codepoints before consulting the store", async () => {
    const fixture = dependencies();
    const title = "🌙".repeat(101);

    await expectRejection(checkPlanTitle({ title }, fixture.deps));
    expect(fixture.getLookupCount()).toBe(0);
  });

  test("rejects an exact duplicate without introducing write dependencies", async () => {
    const { deps } = dependencies(["Night Drive"]);

    await expectRejection(checkPlanTitle({ title: "Night Drive" }, deps));
  });

  test.each(["", "   ", "night drive", "e\u0301", "é"])(
    "preserves the specified string identity for %j",
    async (title) => {
      const { deps } = dependencies(["Night Drive"]);

      expect(await checkPlanTitle({ title }, deps)).toEqual({ ok: true });
    }
  );

  test("exposes only title as input", () => {
    expect(
      planCheckTitleInputSchema.safeParse({ title: "Night Drive" }).success
    ).toBeTrue();
    expect(
      planCheckTitleInputSchema.safeParse({
        channelDir: "/another-channel",
        title: "Night Drive",
      }).success
    ).toBeFalse();
    expect(
      planCheckTitleInputSchema.safeParse({
        collectionId: "caller-selected",
        title: "Night Drive",
      }).success
    ).toBeFalse();
  });

  test("throws from the handler instead of returning an error result", async () => {
    const { deps } = dependencies(["Night Drive"]);

    const outcome = checkPlanTitle({ title: "Night Drive" }, deps);

    await expectRejection(outcome);
  });
});
