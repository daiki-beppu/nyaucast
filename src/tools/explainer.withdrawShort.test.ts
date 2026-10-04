import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";

import { scriptScenes } from "../../test/composition-helpers.ts";
import { explainerConfig } from "../../test/explainer-helpers.ts";
import {
  accepts,
  failureFacts,
  publishedAdditionalProperties,
  setClock,
} from "../../test/helpers.ts";
import { approveProduce, recordPlan, scriptInput } from "../../test/narration-helpers.ts";
import {
  shortFactCounts,
  shortScriptKey,
  statusShorts,
  withdrawalRows,
  withdrawShort,
  writeShort,
} from "../../test/short-helpers.ts";
import { channelFileExists } from "../../test/thumbnail-helpers.ts";
import { callTool, rejectionReason, withToolChannel } from "../../test/tool-helpers.ts";
import { ExplainerWithdrawShortTool } from "./explainer.withdrawShort.ts";

// 契約（この issue の計画 C2・D1・D2）:
//   tool 名 explainer_withdraw_short、パラメータ { videoId, number }。成功値 { number, recorded, videoId }。
//   事実 explainer_short_withdrawals の行（番号・取り下げの時刻）は、取り下げたときだけ積む。ファイルは消さない。
//   取り下げ済みの候補をもう一度取り下げても行は増えず（recorded: false）、書かれていない番号は ShortCandidateNotFound。

const at = "2026-10-04T03:00:00.000Z";

const inChannel = <A, E, R>(prefix: string, use: (channelRoot: string) => Effect.Effect<A, E, R>) =>
  withToolChannel(prefix, { config: explainerConfig }, (channelRoot) =>
    Effect.gen(function* () {
      yield* recordPlan();
      yield* approveProduce();
      yield* callTool("explainer_write_script", scriptInput(scriptScenes));
      return yield* use(channelRoot);
    }),
  );

describe("explainer.withdrawShort: parameters", () => {
  const schema = ExplainerWithdrawShortTool.parametersSchema;

  it("is named with its wire name", () => {
    assert.strictEqual(ExplainerWithdrawShortTool.name, "explainer_withdraw_short");
  });

  it("accepts a video and a number, and rejects every other key", () => {
    assert.isTrue(accepts(schema, { number: 1, videoId: "V1" }));
    assert.isFalse(accepts(schema, { videoId: "V1" }));
    assert.isFalse(accepts(schema, { number: 1 }));
    assert.isFalse(accepts(schema, { force: true, number: 1, videoId: "V1" }));
    assert.strictEqual(publishedAdditionalProperties(ExplainerWithdrawShortTool), false);
  });

  it.each([0, -1, 1.5, 9_007_199_254_740_992])(
    "does not accept the number %j (a positive safe integer from 1)",
    (number) => {
      assert.isFalse(accepts(schema, { number, videoId: "V1" }));
    },
  );

  it("accepts the result and rejects action fields in it", () => {
    const result = { number: 1, recorded: true, videoId: "V1" };

    assert.isTrue(accepts(ExplainerWithdrawShortTool.successSchema, result));
    assert.isFalse(accepts(ExplainerWithdrawShortTool.successSchema, { ...result, next: "write" }));
  });

  it("describes the failure tags without telling the agent what to do next", () => {
    const { description } = ExplainerWithdrawShortTool;

    assert.include(description, "ShortCandidateNotFound");
    assert.include(description, "VideoNotFound");
    assert.notMatch(description, /\b(next|then run|you should|please)\b/iu);
  });

  it.effect("rejects an unknown key as invalid parameters, before anything is recorded", () =>
    inChannel("nyaucast-withdraw-unknown-key-", () =>
      Effect.gen(function* () {
        yield* writeShort();

        const request = { force: true, number: 1, videoId: "V1" };

        assert.strictEqual(
          yield* rejectionReason("explainer_withdraw_short", request),
          "ToolParameterValidationError",
        );
        assert.deepStrictEqual(yield* shortFactCounts, { versions: 1, withdrawals: 0 });
      }),
    ),
  );
});

describe("explainer.withdrawShort: withdrawing a candidate", () => {
  it.effect("removes the candidate from the read model, and keeps its file and its versions", () =>
    inChannel("nyaucast-withdraw-read-model-", (channelRoot) =>
      Effect.gen(function* () {
        yield* writeShort();
        assert.strictEqual((yield* statusShorts).length, 1);
        yield* setClock(at);

        const result = yield* withdrawShort(1);

        assert.deepStrictEqual(result, { number: 1, recorded: true, videoId: "V1" });
        assert.deepStrictEqual(yield* statusShorts, []);
        assert.isTrue(channelFileExists(channelRoot, shortScriptKey(1)));
        assert.deepStrictEqual(yield* shortFactCounts, { versions: 1, withdrawals: 1 });
      }),
    ),
  );

  it.effect("records the number and the time of the withdrawal", () =>
    inChannel("nyaucast-withdraw-row-", () =>
      Effect.gen(function* () {
        yield* writeShort({ number: 2 });
        yield* setClock(at);

        yield* withdrawShort(2);

        assert.deepStrictEqual(yield* withdrawalRows, [
          { number: 2, video_id: "V1", withdrawn_at: at },
        ]);
      }),
    ),
  );

  it.effect("withdraws only the number it names", () =>
    inChannel("nyaucast-withdraw-one-of-two-", () =>
      Effect.gen(function* () {
        yield* writeShort({ hook: "一つ目", number: 1 });
        yield* writeShort({ hook: "二つ目", number: 2 });

        yield* withdrawShort(1);

        assert.deepStrictEqual(
          (yield* statusShorts).map((candidate) => [candidate.number, candidate.hook]),
          [[2, "二つ目"]],
        );
      }),
    ),
  );

  it.effect("records nothing when the candidate is already withdrawn", () =>
    inChannel("nyaucast-withdraw-twice-", () =>
      Effect.gen(function* () {
        yield* writeShort();
        yield* withdrawShort(1);

        const again = yield* withdrawShort(1);

        assert.deepStrictEqual(again, { number: 1, recorded: false, videoId: "V1" });
        assert.deepStrictEqual(yield* shortFactCounts, { versions: 1, withdrawals: 1 });
      }),
    ),
  );

  it.effect(
    "puts a withdrawal strictly after the version it withdraws, even at the same clock time",
    () =>
      inChannel("nyaucast-withdraw-same-time-", () =>
        Effect.gen(function* () {
          yield* setClock(at);
          yield* writeShort();
          yield* withdrawShort(1);

          const [row] = yield* withdrawalRows;

          assert.isTrue(String(row?.["withdrawn_at"]) > at);
          assert.deepStrictEqual(yield* statusShorts, []);
        }),
      ),
  );
});

describe("explainer.withdrawShort: what it refuses", () => {
  it.effect("fails with ShortCandidateNotFound for a number that was never written", () =>
    inChannel("nyaucast-withdraw-never-written-", () =>
      Effect.gen(function* () {
        yield* writeShort({ number: 1 });

        const failure = yield* Effect.flip(withdrawShort(2));

        assert.strictEqual(failure._tag, "ShortCandidateNotFound");
        assert.strictEqual(failureFacts(failure)["videoId"], "V1");
        assert.strictEqual(failureFacts(failure)["number"], 2);
        assert.deepStrictEqual(yield* shortFactCounts, { versions: 1, withdrawals: 0 });
      }),
    ),
  );

  it.effect("fails with VideoNotFound for an unknown video", () =>
    inChannel("nyaucast-withdraw-unknown-video-", () =>
      Effect.gen(function* () {
        const failure = yield* Effect.flip(withdrawShort(1, "V9"));

        assert.strictEqual(failure._tag, "VideoNotFound");
      }),
    ),
  );
});
