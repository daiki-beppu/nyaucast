import { assert, describe, it } from "@effect/vitest";
import { Clock, Effect } from "effect";
import { SqlClient } from "effect/sql";

import {
  collectionConfig,
  explainerConfig,
  fixedVideoId,
  planInput,
  source,
  withVideoChannel,
} from "../../test/explainer-helpers.ts";
import {
  accepts,
  publishedAdditionalProperties,
  selectAll,
  setClock,
  writeVideoConfig,
} from "../../test/helpers.ts";
import { ExplainerWritePlanTool, explainerWritePlan } from "./explainer.writePlan.ts";

const noon = "2026-10-03T12:00:00.000Z";

const count = (table: "explainer_plans" | "explainer_videos") =>
  selectAll(table).pipe(Effect.map((rows) => rows.length));

const insertGateFact = (
  kind: "approval" | "rejection",
  videoId: string,
  gate: "produce" | "publish",
  at: string,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    if (kind === "approval") {
      yield* sql`INSERT INTO explainer_approvals (video_id, gate, approved_at) VALUES (${videoId}, ${gate}, ${at})`;
      return;
    }
    yield* sql`INSERT INTO explainer_rejections (video_id, gate, rejected_at) VALUES (${videoId}, ${gate}, ${at})`;
  });

describe("explainer.writePlan: parameters and result", () => {
  it("is named with its wire name", () => {
    assert.strictEqual(ExplainerWritePlanTool.name, "explainer_write_plan");
  });

  it("accepts a plan with or without sources and an optional videoId, and rejects every other key", () => {
    const schema = ExplainerWritePlanTool.parametersSchema;

    assert.isTrue(accepts(schema, planInput()));
    assert.isTrue(accepts(schema, planInput({ sources: [source("https://ex.com/a")] })));
    assert.isTrue(accepts(schema, planInput({ videoId: "V1" })));
    assert.isFalse(accepts(schema, { ...planInput(), next: "approve" }));
    assert.isFalse(accepts(schema, { ...planInput(), channelDir: "/channels/x" }));
    assert.strictEqual(publishedAdditionalProperties(ExplainerWritePlanTool), false);
  });

  it("does not accept an article body on a source", () => {
    const withBody = {
      ...planInput(),
      sources: [{ ...source("https://ex.com/a"), body: "full article text" }],
    };

    assert.isFalse(accepts(ExplainerWritePlanTool.parametersSchema, withBody));
  });

  it("rejects a source whose URL or retrieval time is not valid", () => {
    const schema = ExplainerWritePlanTool.parametersSchema;

    assert.isFalse(accepts(schema, planInput({ sources: [source("not a url")] })));
    assert.isFalse(
      accepts(
        schema,
        planInput({ sources: [{ ...source("https://ex.com/a"), retrievedAt: "yesterday" }] }),
      ),
    );
  });

  it("returns only the video ID, whether it was created, and the plan; it rejects action fields", () => {
    const result = {
      created: true,
      plan: {
        hitPattern: "shock",
        points: ["a"],
        sources: [source("https://ex.com/a")],
        title: "T",
        updatedAt: noon,
      },
      videoId: "V1",
    };

    assert.isTrue(accepts(ExplainerWritePlanTool.successSchema, result));
    assert.isFalse(accepts(ExplainerWritePlanTool.successSchema, { ...result, next: "approve" }));
    assert.isFalse(
      accepts(ExplainerWritePlanTool.successSchema, {
        ...result,
        plan: { ...result.plan, recommendation: "approve" },
      }),
    );
  });
});

describe("explainer.writePlan: recording a plan", () => {
  it.effect("records a plan with no sources and returns it with the clock time as updatedAt", () =>
    withVideoChannel("nyaucast-write-plan-new-", explainerConfig, () =>
      Effect.gen(function* () {
        yield* setClock(noon);

        const result = yield* explainerWritePlan(planInput());

        assert.deepStrictEqual(result, {
          created: true,
          plan: {
            hitPattern: "shock",
            points: ["point a", "point b"],
            sources: [],
            title: "Why cats purr",
            updatedAt: noon,
          },
          videoId: "V1",
        });
        assert.strictEqual(yield* count("explainer_videos"), 1);
        assert.strictEqual(yield* count("explainer_plans"), 1);
      }),
    ),
  );

  it.effect("keeps the sources in order, with the first as the primary source", () =>
    withVideoChannel("nyaucast-write-plan-sources-", explainerConfig, () =>
      Effect.gen(function* () {
        yield* setClock(noon);
        const sources = [source("https://ex.com/primary"), source("https://ex.com/second")];

        const result = yield* explainerWritePlan(planInput({ sources }));

        assert.deepStrictEqual(result.plan.sources, sources);
      }),
    ),
  );

  it.effect("stores exactly the plan fields and no article body", () =>
    withVideoChannel("nyaucast-write-plan-columns-", explainerConfig, () =>
      Effect.gen(function* () {
        yield* setClock(noon);
        yield* explainerWritePlan(planInput({ sources: [source("https://ex.com/a")] }));

        const rows = yield* selectAll("explainer_plans");

        assert.deepStrictEqual(rows.length, 1);
        assert.deepStrictEqual(Object.keys(rows[0] ?? {}).toSorted(), [
          "hit_pattern",
          "plan_key",
          "points",
          "recorded_at",
          "sources",
          "title",
          "video_id",
        ]);
      }),
    ),
  );

  it.effect("fails with UndeclaredHitPattern for a hit pattern the channel did not declare", () =>
    withVideoChannel("nyaucast-write-plan-pattern-", explainerConfig, () =>
      Effect.gen(function* () {
        yield* setClock(noon);

        const failure = yield* Effect.flip(
          explainerWritePlan(planInput({ hitPattern: "clickbait" })),
        );

        assert.strictEqual(failure._tag, "UndeclaredHitPattern");
        assert.strictEqual(yield* count("explainer_videos"), 0);
        assert.strictEqual(yield* count("explainer_plans"), 0);
      }),
    ),
  );

  it.effect("records a plan under each declared hit pattern", () =>
    withVideoChannel("nyaucast-write-plan-patterns-", explainerConfig, () =>
      Effect.gen(function* () {
        yield* setClock(noon);

        const first = yield* explainerWritePlan(planInput({ hitPattern: "shock", title: "A" }));
        const second = yield* explainerWritePlan(
          planInput({ hitPattern: "contrarian", title: "B" }),
        );

        assert.strictEqual(first.plan.hitPattern, "shock");
        assert.strictEqual(second.plan.hitPattern, "contrarian");
      }),
    ),
  );
});

describe("explainer.writePlan: idempotency on the primary source", () => {
  it.effect(
    "returns the existing plan when only utm_*, the fragment, and a trailing slash differ",
    () =>
      withVideoChannel("nyaucast-write-plan-dedupe-", explainerConfig, () =>
        Effect.gen(function* () {
          yield* setClock(noon);
          const first = yield* explainerWritePlan(
            planInput({ sources: [source("https://ex.com/a")] }),
          );

          const second = yield* explainerWritePlan(
            planInput({
              sources: [source("https://ex.com/a/?utm_source=x&utm_medium=y#sec")],
              title: "A different title proposal",
            }),
          );

          assert.strictEqual(second.created, false);
          assert.strictEqual(second.videoId, first.videoId);
          assert.deepStrictEqual(second.plan, first.plan);
          assert.strictEqual(yield* count("explainer_videos"), 1);
          assert.strictEqual(yield* count("explainer_plans"), 1);
        }),
      ),
  );

  it.effect("keeps query arguments other than utm_* when matching", () =>
    withVideoChannel("nyaucast-write-plan-dedupe-query-", explainerConfig, () =>
      Effect.gen(function* () {
        yield* setClock(noon);
        const first = yield* explainerWritePlan(
          planInput({ sources: [source("https://ex.com/a?id=1&utm_campaign=z")] }),
        );

        const second = yield* explainerWritePlan(
          planInput({ sources: [source("https://ex.com/a/?id=1")] }),
        );

        assert.strictEqual(second.created, false);
        assert.strictEqual(second.videoId, first.videoId);
      }),
    ),
  );

  it.effect("only the primary source decides the key, not the later sources", () =>
    withVideoChannel("nyaucast-write-plan-dedupe-primary-", explainerConfig, () =>
      Effect.gen(function* () {
        yield* setClock(noon);
        const first = yield* explainerWritePlan(
          planInput({
            sources: [source("https://ex.com/a"), source("https://ex.com/other")],
          }),
        );

        const second = yield* explainerWritePlan(
          planInput({ sources: [source("https://ex.com/a"), source("https://ex.com/different")] }),
        );
        const third = yield* explainerWritePlan(
          planInput({ sources: [source("https://ex.com/other"), source("https://ex.com/a")] }),
        );

        assert.strictEqual(second.videoId, first.videoId);
        assert.strictEqual(second.created, false);
        assert.strictEqual(third.created, true);
        assert.notStrictEqual(third.videoId, first.videoId);
      }),
    ),
  );

  it.effect.each([
    ["a path that contains utm_", "https://ex.com/utm_guide", "https://ex.com/"],
    [
      "a non-utm argument whose value starts with utm_",
      "https://ex.com/a?ref=utm_x",
      "https://ex.com/a",
    ],
    ["an encoded # in the path", "https://ex.com/a%23b", "https://ex.com/a"],
    ["a / inside a query value", "https://ex.com/a?next=/", "https://ex.com/a"],
    ["an upper-case UTM_ argument", "https://ex.com/a?UTM_source=x", "https://ex.com/a"],
  ] as const)("does not treat %s as the same source", ([, otherUrl, existingUrl]) =>
    withVideoChannel("nyaucast-write-plan-dedupe-negative-", explainerConfig, () =>
      Effect.gen(function* () {
        yield* setClock(noon);
        const existing = yield* explainerWritePlan(
          planInput({ sources: [source(existingUrl)], title: "Existing" }),
        );

        const other = yield* explainerWritePlan(
          planInput({ sources: [source(otherUrl)], title: "Other" }),
        );

        assert.strictEqual(other.created, true);
        assert.notStrictEqual(other.videoId, existing.videoId);
        assert.strictEqual(yield* count("explainer_videos"), 2);
      }),
    ),
  );

  it.effect("returns an abandoned video as the existing one instead of creating another", () =>
    withVideoChannel("nyaucast-write-plan-dedupe-abandoned-", explainerConfig, () =>
      Effect.gen(function* () {
        yield* setClock(noon);
        const first = yield* explainerWritePlan(
          planInput({ sources: [source("https://ex.com/a")] }),
        );
        yield* insertGateFact("rejection", first.videoId, "produce", noon);

        const second = yield* explainerWritePlan(
          planInput({ sources: [source("https://ex.com/a/?utm_source=x")] }),
        );

        assert.strictEqual(second.created, false);
        assert.strictEqual(second.videoId, first.videoId);
        assert.strictEqual(yield* count("explainer_videos"), 1);
        assert.strictEqual(yield* count("explainer_plans"), 1);
      }),
    ),
  );
});

describe("explainer.writePlan: concurrent calls", () => {
  it.effect("creates one video when the same primary source is recorded concurrently", () =>
    withVideoChannel("nyaucast-write-plan-concurrent-", explainerConfig, () =>
      Effect.gen(function* () {
        yield* setClock(noon);
        const input = planInput({ sources: [source("https://ex.com/a")] });

        const results = yield* Effect.all(
          [
            explainerWritePlan(input),
            explainerWritePlan({ ...input, sources: [source("https://ex.com/a/?utm_source=x")] }),
            explainerWritePlan(input),
          ],
          { concurrency: "unbounded" },
        );

        assert.strictEqual(new Set(results.map((result) => result.videoId)).size, 1);
        assert.strictEqual(results.filter((result) => result.created).length, 1);
        assert.strictEqual(yield* count("explainer_videos"), 1);
        assert.strictEqual(yield* count("explainer_plans"), 1);
      }),
    ),
  );

  it.effect("appends one version when the same new content overwrites a video concurrently", () =>
    withVideoChannel("nyaucast-write-plan-overwrite-concurrent-", explainerConfig, () =>
      Effect.gen(function* () {
        yield* setClock(noon);
        const first = yield* explainerWritePlan(planInput());
        const revised = planInput({
          points: ["revised"],
          title: "Why cats purr, revised",
          videoId: first.videoId,
        });

        // 読み取りと追記の間にある時刻の取得で実時間の間を置き、全員が旧版を読んだ後に追記する競合を作る。
        const clock = yield* Clock.Clock;
        const slowClock: Clock.Clock = {
          ...clock,
          currentTimeMillis: Effect.andThen(
            Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 50))),
            clock.currentTimeMillis,
          ),
        };
        const overwriteSlowly = explainerWritePlan(revised).pipe(
          Effect.provideService(Clock.Clock, slowClock),
        );

        const results = yield* Effect.all(
          [overwriteSlowly, overwriteSlowly, overwriteSlowly, overwriteSlowly],
          { concurrency: "unbounded" },
        );

        assert.strictEqual(yield* count("explainer_plans"), 2);
        for (const result of results) {
          assert.strictEqual(result.created, false);
          assert.deepStrictEqual(result.plan, results[0]?.plan);
        }
        assert.strictEqual(results[0]?.plan.title, "Why cats purr, revised");
      }),
    ),
  );
});

describe("explainer.writePlan: idempotency without a source", () => {
  it.effect("records a plan with no sources and returns the existing one for the same title", () =>
    withVideoChannel("nyaucast-write-plan-title-", explainerConfig, () =>
      Effect.gen(function* () {
        yield* setClock(noon);
        const first = yield* explainerWritePlan(planInput({ title: "X" }));

        const second = yield* explainerWritePlan(planInput({ points: ["other"], title: "X" }));

        assert.strictEqual(first.created, true);
        assert.strictEqual(second.created, false);
        assert.strictEqual(second.videoId, first.videoId);
        assert.deepStrictEqual(second.plan, first.plan);
        assert.strictEqual(yield* count("explainer_videos"), 1);
        assert.strictEqual(yield* count("explainer_plans"), 1);
      }),
    ),
  );

  it.effect("creates another video for a different title with no sources", () =>
    withVideoChannel("nyaucast-write-plan-title-other-", explainerConfig, () =>
      Effect.gen(function* () {
        yield* setClock(noon);
        const first = yield* explainerWritePlan(planInput({ title: "X" }));

        const second = yield* explainerWritePlan(planInput({ title: "Y" }));

        assert.strictEqual(second.created, true);
        assert.notStrictEqual(second.videoId, first.videoId);
      }),
    ),
  );

  it.effect("does not match a title proposal against the primary source URL of another plan", () =>
    withVideoChannel("nyaucast-write-plan-title-url-", explainerConfig, () =>
      Effect.gen(function* () {
        yield* setClock(noon);
        const sourced = yield* explainerWritePlan(
          planInput({ sources: [source("https://ex.com/a")], title: "Sourced" }),
        );

        const untitledBySource = yield* explainerWritePlan(
          planInput({ title: "https://ex.com/a" }),
        );

        assert.strictEqual(untitledBySource.created, true);
        assert.notStrictEqual(untitledBySource.videoId, sourced.videoId);
        assert.strictEqual(yield* count("explainer_videos"), 2);
      }),
    ),
  );

  it.effect(
    "does not treat a plan with a primary source as matching the same title with no source",
    () =>
      withVideoChannel("nyaucast-write-plan-title-sourced-", explainerConfig, () =>
        Effect.gen(function* () {
          yield* setClock(noon);
          const sourced = yield* explainerWritePlan(
            planInput({ sources: [source("https://ex.com/a")], title: "Same title" }),
          );

          const unsourced = yield* explainerWritePlan(planInput({ title: "Same title" }));

          assert.strictEqual(unsourced.created, true);
          assert.notStrictEqual(unsourced.videoId, sourced.videoId);
        }),
      ),
  );

  it.effect(
    "fails with VideoIdCollision and leaves the existing row alone when the generated ID is taken",
    () =>
      withVideoChannel(
        "nyaucast-write-plan-collision-",
        explainerConfig,
        () =>
          Effect.gen(function* () {
            yield* setClock(noon);
            const first = yield* explainerWritePlan(planInput({ title: "First" }));
            const before = yield* selectAll("explainer_plans");

            const failure = yield* Effect.flip(explainerWritePlan(planInput({ title: "Second" })));

            assert.strictEqual(first.videoId, "V1");
            assert.strictEqual(failure._tag, "VideoIdCollision");
            assert.deepStrictEqual(yield* selectAll("explainer_plans"), before);
            assert.strictEqual(yield* count("explainer_videos"), 1);
          }),
        fixedVideoId("V1"),
      ),
  );
});

describe("explainer.writePlan: overwriting by video ID", () => {
  it.effect("appends a new version, records its time, and returns the latest plan", () =>
    withVideoChannel("nyaucast-write-plan-overwrite-", explainerConfig, () =>
      Effect.gen(function* () {
        yield* setClock(noon);
        const first = yield* explainerWritePlan(planInput());
        const later = "2026-10-04T08:30:00.000Z";
        yield* setClock(later);

        const second = yield* explainerWritePlan(
          planInput({
            points: ["revised"],
            title: "Why cats purr, revised",
            videoId: first.videoId,
          }),
        );

        assert.strictEqual(second.created, false);
        assert.strictEqual(second.videoId, first.videoId);
        assert.deepStrictEqual(second.plan, {
          hitPattern: "shock",
          points: ["revised"],
          sources: [],
          title: "Why cats purr, revised",
          updatedAt: later,
        });
        assert.strictEqual(yield* count("explainer_videos"), 1);
        assert.strictEqual(yield* count("explainer_plans"), 2);
      }),
    ),
  );

  it.effect("does not append a version when the content is identical", () =>
    withVideoChannel("nyaucast-write-plan-overwrite-same-", explainerConfig, () =>
      Effect.gen(function* () {
        yield* setClock(noon);
        const input = planInput({ sources: [source("https://ex.com/a")] });
        const first = yield* explainerWritePlan(input);
        yield* setClock("2026-10-04T08:30:00.000Z");

        const second = yield* explainerWritePlan({ ...input, videoId: first.videoId });

        assert.strictEqual(second.created, false);
        assert.deepStrictEqual(second.plan, first.plan);
        assert.strictEqual(second.plan.updatedAt, noon);
        assert.strictEqual(yield* count("explainer_plans"), 1);
      }),
    ),
  );

  it.effect(
    "puts each new version strictly after the previous one even when the clock has not moved",
    () =>
      withVideoChannel("nyaucast-write-plan-overwrite-tick-", explainerConfig, () =>
        Effect.gen(function* () {
          yield* setClock(noon);
          const first = yield* explainerWritePlan(planInput());

          const second = yield* explainerWritePlan(
            planInput({ title: "Second", videoId: first.videoId }),
          );
          const third = yield* explainerWritePlan(
            planInput({ title: "Third", videoId: first.videoId }),
          );

          assert.isTrue(second.plan.updatedAt > first.plan.updatedAt);
          assert.isTrue(third.plan.updatedAt > second.plan.updatedAt);
          assert.strictEqual(third.plan.title, "Third");
          assert.strictEqual(yield* count("explainer_plans"), 3);
        }),
      ),
  );

  it.effect("fails with VideoNotFound for a video ID that does not exist", () =>
    withVideoChannel("nyaucast-write-plan-overwrite-missing-", explainerConfig, () =>
      Effect.gen(function* () {
        yield* setClock(noon);

        const failure = yield* Effect.flip(explainerWritePlan(planInput({ videoId: "missing" })));

        assert.strictEqual(failure._tag, "VideoNotFound");
        assert.strictEqual(yield* count("explainer_videos"), 0);
        assert.strictEqual(yield* count("explainer_plans"), 0);
      }),
    ),
  );

  it.effect("matches later new plans against the source of the latest version, not the first", () =>
    withVideoChannel("nyaucast-write-plan-overwrite-key-", explainerConfig, () =>
      Effect.gen(function* () {
        yield* setClock(noon);
        const first = yield* explainerWritePlan(
          planInput({ sources: [source("https://ex.com/a")] }),
        );
        yield* explainerWritePlan(
          planInput({ sources: [source("https://ex.com/b")], videoId: first.videoId }),
        );

        const followsLatest = yield* explainerWritePlan(
          planInput({ sources: [source("https://ex.com/b/?utm_source=x")], title: "Other" }),
        );
        const oldSource = yield* explainerWritePlan(
          planInput({ sources: [source("https://ex.com/a")], title: "Other" }),
        );

        assert.strictEqual(followsLatest.created, false);
        assert.strictEqual(followsLatest.videoId, first.videoId);
        assert.strictEqual(oldSource.created, true);
        assert.notStrictEqual(oldSource.videoId, first.videoId);
      }),
    ),
  );

  it.effect("rejects an undeclared hit pattern on overwrite and appends nothing", () =>
    withVideoChannel("nyaucast-write-plan-overwrite-pattern-", explainerConfig, () =>
      Effect.gen(function* () {
        yield* setClock(noon);
        const first = yield* explainerWritePlan(planInput());

        const failure = yield* Effect.flip(
          explainerWritePlan(planInput({ hitPattern: "clickbait", videoId: first.videoId })),
        );

        assert.strictEqual(failure._tag, "UndeclaredHitPattern");
        assert.strictEqual(yield* count("explainer_plans"), 1);
      }),
    ),
  );
});

describe("explainer.writePlan: overwrite locks", () => {
  it.effect("fails with PlanAlreadyApproved after the produce approval and appends nothing", () =>
    withVideoChannel("nyaucast-write-plan-approved-", explainerConfig, () =>
      Effect.gen(function* () {
        yield* setClock(noon);
        const first = yield* explainerWritePlan(planInput());
        yield* insertGateFact("approval", first.videoId, "produce", "2026-10-03T13:00:00.000Z");

        const failure = yield* Effect.flip(
          explainerWritePlan(planInput({ title: "Changed", videoId: first.videoId })),
        );

        assert.strictEqual(failure._tag, "PlanAlreadyApproved");
        assert.strictEqual(yield* count("explainer_plans"), 1);
      }),
    ),
  );

  it.effect("fails with VideoAbandoned after a NO-GO and appends nothing", () =>
    withVideoChannel("nyaucast-write-plan-abandoned-", explainerConfig, () =>
      Effect.gen(function* () {
        yield* setClock(noon);
        const first = yield* explainerWritePlan(planInput());
        yield* insertGateFact("rejection", first.videoId, "produce", "2026-10-03T13:00:00.000Z");

        const failure = yield* Effect.flip(
          explainerWritePlan(planInput({ title: "Changed", videoId: first.videoId })),
        );

        assert.strictEqual(failure._tag, "VideoAbandoned");
        assert.strictEqual(yield* count("explainer_plans"), 1);
      }),
    ),
  );

  it.effect("reports PlanAlreadyApproved when the video is both approved and abandoned", () =>
    withVideoChannel("nyaucast-write-plan-approved-abandoned-", explainerConfig, () =>
      Effect.gen(function* () {
        yield* setClock(noon);
        const first = yield* explainerWritePlan(planInput());
        yield* insertGateFact("approval", first.videoId, "produce", "2026-10-03T13:00:00.000Z");
        yield* insertGateFact("rejection", first.videoId, "publish", "2026-10-03T14:00:00.000Z");

        const failure = yield* Effect.flip(
          explainerWritePlan(planInput({ title: "Changed", videoId: first.videoId })),
        );

        assert.strictEqual(failure._tag, "PlanAlreadyApproved");
      }),
    ),
  );

  it.effect("fails an overwrite with identical content too once the plan is approved", () =>
    withVideoChannel("nyaucast-write-plan-approved-same-", explainerConfig, () =>
      Effect.gen(function* () {
        yield* setClock(noon);
        const input = planInput();
        const first = yield* explainerWritePlan(input);
        yield* insertGateFact("approval", first.videoId, "produce", "2026-10-03T13:00:00.000Z");

        const failure = yield* Effect.flip(
          explainerWritePlan({ ...input, videoId: first.videoId }),
        );

        assert.strictEqual(failure._tag, "PlanAlreadyApproved");
      }),
    ),
  );

  it.effect("does not lock the plan for an approval of the publish gate alone", () =>
    withVideoChannel("nyaucast-write-plan-publish-approval-", explainerConfig, () =>
      Effect.gen(function* () {
        yield* setClock(noon);
        const first = yield* explainerWritePlan(planInput());
        yield* insertGateFact("approval", first.videoId, "publish", "2026-10-03T13:00:00.000Z");

        const second = yield* explainerWritePlan(
          planInput({ title: "Changed", videoId: first.videoId }),
        );

        assert.strictEqual(second.plan.title, "Changed");
      }),
    ),
  );

  it.effect("does not let an approval of another video lock this one", () =>
    withVideoChannel("nyaucast-write-plan-approved-other-", explainerConfig, () =>
      Effect.gen(function* () {
        yield* setClock(noon);
        const first = yield* explainerWritePlan(planInput({ title: "First" }));
        const other = yield* explainerWritePlan(planInput({ title: "Other" }));
        yield* insertGateFact("approval", other.videoId, "produce", "2026-10-03T13:00:00.000Z");

        const second = yield* explainerWritePlan(
          planInput({ title: "First, revised", videoId: first.videoId }),
        );

        assert.strictEqual(second.plan.title, "First, revised");
      }),
    ),
  );
});

describe("explainer.writePlan: channel kind", () => {
  it.effect("fails with NotExplainerChannel when the channel kind is not explainer", () =>
    withVideoChannel("nyaucast-write-plan-collection-", collectionConfig, () =>
      Effect.gen(function* () {
        const failure = yield* Effect.flip(explainerWritePlan(planInput()));

        assert.strictEqual(failure._tag, "NotExplainerChannel");
        assert.strictEqual(yield* count("explainer_videos"), 0);
      }),
    ),
  );

  it.effect("fails with ChannelConfigNotFound when the channel has no video config", () =>
    withVideoChannel("nyaucast-write-plan-noconfig-", undefined, () =>
      Effect.gen(function* () {
        const failure = yield* Effect.flip(explainerWritePlan(planInput()));

        assert.strictEqual(failure._tag, "ChannelConfigNotFound");
      }),
    ),
  );

  it.effect.each([
    ["JSON that does not parse", "{ not json"],
    ["an unknown kind", JSON.stringify({ kind: "podcast" })],
    ["an explainer without a genre", JSON.stringify({ hitPatterns: {}, kind: "explainer" })],
    [
      "an explainer whose hit pattern has no description",
      JSON.stringify({ genre: "tech", hitPatterns: { shock: {} }, kind: "explainer" }),
    ],
  ] as const)("fails with InvalidChannelConfig for %s", ([, content]) =>
    withVideoChannel("nyaucast-write-plan-invalid-", content, () =>
      Effect.gen(function* () {
        const failure = yield* Effect.flip(explainerWritePlan(planInput()));

        assert.strictEqual(failure._tag, "InvalidChannelConfig");
      }),
    ),
  );

  it.effect(
    "reads the config on every call, so a config written after the layer was built is used",
    () =>
      withVideoChannel("nyaucast-write-plan-late-config-", undefined, (channelRoot) =>
        Effect.gen(function* () {
          yield* setClock(noon);
          const before = yield* Effect.flip(explainerWritePlan(planInput()));
          writeVideoConfig(channelRoot, explainerConfig);

          const after = yield* explainerWritePlan(planInput());

          assert.strictEqual(before._tag, "ChannelConfigNotFound");
          assert.strictEqual(after.created, true);
        }),
      ),
  );
});
