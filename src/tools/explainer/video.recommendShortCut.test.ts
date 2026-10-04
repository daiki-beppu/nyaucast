import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";

import { scriptScenes } from "../../../test/composition-helpers.ts";
import { explainerConfig } from "../../../test/explainer-helpers.ts";
import {
  accepts,
  failureFacts,
  publishedAdditionalProperties,
  selectAll,
} from "../../../test/helpers.ts";
import { approveProduce, recordPlan, scriptInput } from "../../../test/narration-helpers.ts";
import { withdrawShort, writeShort } from "../../../test/short-helpers.ts";
import { callTool, rejectionReason, withToolChannel } from "../../../test/tool-helpers.ts";
import { ExplainerVideoRecommendShortCutTool } from "./video.recommendShortCut.ts";

// 契約（この issue の計画 D1）:
//   tool 名 video_recommend_short_cut、パラメータ { videoId, number, cut }。cut は clip / dedicated / none。
//   agent が公開ゲートの対話の既定値にする推奨を、ショートの候補ごとに append-only の事実として積む。
//   最後の推奨と同じなら何も積まず recorded: false。成功値 { cut, number, recorded, videoId }。
//   企画ゲートの承認があること、取り下げていない候補があることが前提。満たさなければ何も書かない。
//   推奨は候補の版に縛らない（候補を書き直しても最後の推奨のまま）。

interface ChannelOptions {
  /** 企画ゲートを承認しない。 */
  readonly unapproved?: boolean;
}

const inChannel = <A, E, R>(
  prefix: string,
  options: ChannelOptions,
  use: (channelRoot: string) => Effect.Effect<A, E, R>,
) =>
  withToolChannel(prefix, { config: explainerConfig }, (channelRoot) =>
    Effect.gen(function* () {
      yield* recordPlan();
      if (options.unapproved !== true) {
        yield* approveProduce();
        yield* callTool("video_write_script", scriptInput(scriptScenes));
      }
      return yield* use(channelRoot);
    }),
  );

const recommend = (number: number, cut: "clip" | "dedicated" | "none", videoId = "V1") =>
  callTool("video_recommend_short_cut", { cut, number, videoId });

const recommendationRows = selectAll("explainer_short_recommendations").pipe(
  Effect.map((rows) => rows.map((row) => [row["video_id"], Number(row["number"]), row["cut"]])),
);

describe("video.recommendShortCut: parameters", () => {
  const schema = ExplainerVideoRecommendShortCutTool.parametersSchema;
  const valid = { cut: "clip", number: 1, videoId: "V1" };

  it("is named with its wire name", () => {
    assert.strictEqual(ExplainerVideoRecommendShortCutTool.name, "video_recommend_short_cut");
  });

  it("accepts each recommendation, and rejects every other key", () => {
    for (const cut of ["clip", "dedicated", "none"]) {
      assert.isTrue(accepts(schema, { ...valid, cut }), cut);
    }
    assert.isFalse(accepts(schema, { ...valid, force: true }));
    for (const key of ["videoId", "number", "cut"] as const) {
      const without = Object.fromEntries(Object.entries(valid).filter(([name]) => name !== key));
      assert.isFalse(accepts(schema, without), `without ${key}`);
    }
    assert.strictEqual(publishedAdditionalProperties(ExplainerVideoRecommendShortCutTool), false);
  });

  it.each(["long", "short-1-clip", "both", ""])("does not accept the cut %j", (cut) => {
    assert.isFalse(accepts(schema, { ...valid, cut }));
  });

  it.each([0, -1, 1.5])("does not accept the number %j (a positive integer from 1)", (number) => {
    assert.isFalse(accepts(schema, { ...valid, number }));
  });

  it("accepts the result and rejects action fields in it", () => {
    const result = { cut: "clip", number: 1, recorded: true, videoId: "V1" };

    assert.isTrue(accepts(ExplainerVideoRecommendShortCutTool.successSchema, result));
    assert.isFalse(
      accepts(ExplainerVideoRecommendShortCutTool.successSchema, { ...result, next: "publish" }),
    );
    assert.isFalse(
      accepts(ExplainerVideoRecommendShortCutTool.successSchema, { ...result, recorded: "yes" }),
    );
  });

  it("describes the failure tags without telling the agent what to do next", () => {
    const { description } = ExplainerVideoRecommendShortCutTool;

    for (const tag of ["ProduceGateNotApproved", "ShortCandidateNotFound", "VideoNotFound"]) {
      assert.include(description, tag);
    }
    assert.notMatch(description, /\b(next|then run|you should|please)\b/iu);
  });

  it.effect("rejects an unknown key as invalid parameters, before anything is written", () =>
    inChannel("nyaucast-recommend-unknown-key-", {}, () =>
      Effect.gen(function* () {
        yield* writeShort({ number: 1 });

        assert.strictEqual(
          yield* rejectionReason("video_recommend_short_cut", {
            cut: "clip",
            force: true,
            number: 1,
            videoId: "V1",
          } as never),
          "ToolParameterValidationError",
        );
        assert.deepStrictEqual(yield* recommendationRows, []);
      }),
    ),
  );
});

describe("video.recommendShortCut: recording a recommendation", () => {
  it.effect("records one recommendation for the candidate and returns what was recorded", () =>
    inChannel("nyaucast-recommend-record-", {}, () =>
      Effect.gen(function* () {
        yield* writeShort({ number: 1 });

        const result = yield* recommend(1, "dedicated");

        assert.deepStrictEqual(result, {
          cut: "dedicated",
          number: 1,
          recorded: true,
          videoId: "V1",
        });
        assert.deepStrictEqual(yield* recommendationRows, [["V1", 1, "dedicated"]]);
      }),
    ),
  );

  it.effect("records nothing when the recommendation is the same as the last one", () =>
    inChannel("nyaucast-recommend-same-", {}, () =>
      Effect.gen(function* () {
        yield* writeShort({ number: 1 });
        yield* recommend(1, "clip");

        const again = yield* recommend(1, "clip");

        assert.isFalse(again.recorded);
        assert.deepStrictEqual(yield* recommendationRows, [["V1", 1, "clip"]]);
      }),
    ),
  );

  it.effect("records a change, and a return to an earlier recommendation is a change too", () =>
    inChannel("nyaucast-recommend-change-", {}, () =>
      Effect.gen(function* () {
        yield* writeShort({ number: 1 });

        const results = [
          yield* recommend(1, "clip"),
          yield* recommend(1, "dedicated"),
          yield* recommend(1, "clip"),
          yield* recommend(1, "none"),
        ];

        assert.deepStrictEqual(
          results.map((result) => result.recorded),
          [true, true, true, true],
        );
        assert.deepStrictEqual(
          (yield* recommendationRows).map((row) => row[2]),
          ["clip", "dedicated", "clip", "none"],
        );
      }),
    ),
  );

  it.effect("takes the row written later as the last one when two rows share a time", () =>
    inChannel("nyaucast-recommend-same-time-", {}, () =>
      Effect.gen(function* () {
        yield* writeShort({ number: 1 });
        const sql = yield* SqlClient.SqlClient;
        const at = "2026-10-04T12:00:00.000Z";
        yield* sql.unsafe(
          `INSERT INTO explainer_short_recommendations (video_id, number, cut, recommended_at) VALUES ('V1', 1, 'clip', '${at}'), ('V1', 1, 'dedicated', '${at}')`,
        );

        const same = yield* recommend(1, "dedicated");
        const change = yield* recommend(1, "clip");

        assert.isFalse(same.recorded);
        assert.isTrue(change.recorded);
      }),
    ),
  );

  it.effect("keeps the last recommendation of each candidate apart", () =>
    inChannel("nyaucast-recommend-candidates-", {}, () =>
      Effect.gen(function* () {
        yield* writeShort({ number: 1 });
        yield* writeShort({ number: 2 });
        yield* recommend(1, "clip");
        yield* recommend(2, "dedicated");

        const again = yield* recommend(1, "clip");

        assert.isFalse(again.recorded);
        assert.deepStrictEqual(yield* recommendationRows, [
          ["V1", 1, "clip"],
          ["V1", 2, "dedicated"],
        ]);
      }),
    ),
  );

  it.effect("keeps the last recommendation when the candidate is written again", () =>
    inChannel("nyaucast-recommend-rewrite-", {}, () =>
      Effect.gen(function* () {
        yield* writeShort({ number: 1 });
        yield* recommend(1, "dedicated");
        yield* writeShort({ hook: "別のフック", number: 1 });

        const again = yield* recommend(1, "dedicated");

        assert.isFalse(again.recorded);
        assert.deepStrictEqual(yield* recommendationRows, [["V1", 1, "dedicated"]]);
      }),
    ),
  );
});

describe("video.recommendShortCut: what it refuses", () => {
  it.effect("fails with ShortCandidateNotFound for a number that was never written", () =>
    inChannel("nyaucast-recommend-never-written-", {}, () =>
      Effect.gen(function* () {
        yield* writeShort({ number: 1 });

        const failure = yield* Effect.flip(recommend(2, "clip"));

        assert.strictEqual(failure._tag, "ShortCandidateNotFound");
        assert.strictEqual(failureFacts(failure)["videoId"], "V1");
        assert.strictEqual(failureFacts(failure)["number"], 2);
        assert.deepStrictEqual(yield* recommendationRows, []);
      }),
    ),
  );

  it.effect("fails with ShortCandidateNotFound for a withdrawn candidate", () =>
    inChannel("nyaucast-recommend-withdrawn-", {}, () =>
      Effect.gen(function* () {
        yield* writeShort({ number: 1 });
        yield* withdrawShort(1);

        const failure = yield* Effect.flip(recommend(1, "clip"));

        assert.strictEqual(failure._tag, "ShortCandidateNotFound");
        assert.deepStrictEqual(yield* recommendationRows, []);
      }),
    ),
  );

  it.effect("fails with ProduceGateNotApproved before the produce gate is approved", () =>
    inChannel("nyaucast-recommend-unapproved-", { unapproved: true }, () =>
      Effect.gen(function* () {
        const failure = yield* Effect.flip(recommend(1, "clip"));

        assert.strictEqual(failure._tag, "ProduceGateNotApproved");
        assert.strictEqual(failureFacts(failure)["videoId"], "V1");
        assert.deepStrictEqual(yield* recommendationRows, []);
      }),
    ),
  );

  it.effect("fails with VideoNotFound for an unknown video", () =>
    inChannel("nyaucast-recommend-unknown-video-", {}, () =>
      Effect.gen(function* () {
        const failure = yield* Effect.flip(recommend(1, "clip", "V9"));

        assert.strictEqual(failure._tag, "VideoNotFound");
        assert.deepStrictEqual(yield* recommendationRows, []);
      }),
    ),
  );
});
