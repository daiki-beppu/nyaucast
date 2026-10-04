import { createHash } from "node:crypto";

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
  crossSceneRange,
  dedicatedScript,
  defaultHook,
  paragraphRange,
  shortFactCounts,
  shortInput,
  shortScriptKey,
  statusShorts,
  versionRows,
  withdrawShort,
  writeShort,
} from "../../test/short-helpers.ts";
import {
  channelFileExists,
  readChannelFile,
  writeChannelFile,
} from "../../test/thumbnail-helpers.ts";
import { callTool, rejectionReason, withToolChannel } from "../../test/tool-helpers.ts";
import { ExplainerWriteShortTool } from "./explainer.writeShort.ts";

// 契約（この issue の計画 C1・C8・D1〜D3・D7）:
//   tool 名 explainer_write_short、パラメータ { videoId, number, range: { start, end }, hook, scenes }。
//   range の両端は { scene, paragraph }（1 始まり、両端を含む、シーンをまたいでよい）で、長尺の台本の段落を指す。
//   成功値 { key, number, recorded, videoId }。key は videos/<id>/shorts/<number>/script.json。
//   recorded は版の行を積んだときだけ true（同じ内容の書き直しは false）。
//   事実 explainer_short_versions の行（番号・段落の範囲・フック・script_key・作成時刻）は、書いたときだけ積む。

const first = "2026-10-04T01:00:00.000Z";
const second = "2026-10-04T02:00:00.000Z";

interface ChannelOptions {
  /** 承認しない。 */
  readonly unapproved?: boolean;
  /** 長尺の台本を書かない。 */
  readonly withoutScript?: boolean;
}

// 企画・承認・長尺の台本（scriptScenes: シーン 1 は 2 段落、シーン 2 は 2 段落）を用意した動画 V1 で use を動かす。
const inChannel = <A, E, R>(
  prefix: string,
  options: ChannelOptions,
  use: (channelRoot: string) => Effect.Effect<A, E, R>,
) =>
  withToolChannel(prefix, { config: explainerConfig }, (channelRoot) =>
    Effect.gen(function* () {
      yield* recordPlan();
      if (options.unapproved !== true) yield* approveProduce();
      if (options.unapproved !== true && options.withoutScript !== true) {
        yield* callTool("explainer_write_script", scriptInput(scriptScenes));
      }
      return yield* use(channelRoot);
    }),
  );

const readScriptFile = (channelRoot: string, number = 1) =>
  JSON.parse(new TextDecoder().decode(readChannelFile(channelRoot, shortScriptKey(number)))) as {
    readonly scenes: readonly { readonly paragraphs: readonly { readonly text: string }[] }[];
  };

describe("explainer.writeShort: parameters", () => {
  const schema = ExplainerWriteShortTool.parametersSchema;
  const valid = shortInput();

  it("is named with its wire name", () => {
    assert.strictEqual(ExplainerWriteShortTool.name, "explainer_write_short");
  });

  it("accepts a video, a number, a paragraph range, a hook and the dedicated script, and rejects every other key", () => {
    assert.isTrue(accepts(schema, valid));
    assert.isFalse(accepts(schema, { ...valid, force: true }));
    assert.isFalse(accepts(schema, { ...valid, seconds: 30 }));
    assert.isFalse(accepts(schema, { ...valid, range: { ...valid.range, extra: 1 } }));
    for (const key of ["videoId", "number", "range", "hook", "scenes"] as const) {
      const without = Object.fromEntries(Object.entries(valid).filter(([name]) => name !== key));
      assert.isFalse(accepts(schema, without), `without ${key}`);
    }
    assert.strictEqual(publishedAdditionalProperties(ExplainerWriteShortTool), false);
  });

  it.each([0, -1, 1.5, 9_007_199_254_740_992])(
    "does not accept the number %j (a positive safe integer from 1)",
    (number) => {
      assert.isFalse(accepts(schema, { ...valid, number }));
    },
  );

  it("accepts the largest safe integer as a number", () => {
    assert.isTrue(accepts(schema, { ...valid, number: Number.MAX_SAFE_INTEGER }));
  });

  it("does not accept an empty hook", () => {
    assert.isFalse(accepts(schema, { ...valid, hook: "" }));
  });

  it.each([
    ["a scene below 1", { ...valid.range, start: { paragraph: 1, scene: 0 } }],
    ["a paragraph below 1", { ...valid.range, end: { paragraph: 0, scene: 2 } }],
    ["a fractional scene", { ...valid.range, start: { paragraph: 1, scene: 1.5 } }],
    ["a range without its end", { start: valid.range.start }],
  ])("does not accept %s in the range", (_name, range) => {
    assert.isFalse(accepts(schema, { ...valid, range }));
  });

  it("accepts the result and rejects action fields in it", () => {
    const result = { key: shortScriptKey(1), number: 1, recorded: true, videoId: "V1" };

    assert.isTrue(accepts(ExplainerWriteShortTool.successSchema, result));
    assert.isFalse(accepts(ExplainerWriteShortTool.successSchema, { ...result, next: "render" }));
    assert.isFalse(accepts(ExplainerWriteShortTool.successSchema, { ...result, recorded: "yes" }));
  });

  it("describes the failure tags without telling the agent what to do next", () => {
    const { description } = ExplainerWriteShortTool;

    for (const tag of ["InvalidShortRange", "ProduceGateNotApproved", "ScriptNotFound"]) {
      assert.include(description, tag);
    }
    assert.notMatch(description, /\b(next|then run|you should|please)\b/iu);
  });

  it.effect("rejects an unknown key as invalid parameters, before anything is written", () =>
    inChannel("nyaucast-short-unknown-key-", {}, (channelRoot) =>
      Effect.gen(function* () {
        const request = { ...valid, seconds: 30 };

        assert.strictEqual(
          yield* rejectionReason("explainer_write_short", request),
          "ToolParameterValidationError",
        );
        assert.isFalse(channelFileExists(channelRoot, shortScriptKey(1)));
        assert.deepStrictEqual(yield* shortFactCounts, { versions: 0, withdrawals: 0 });
      }),
    ),
  );
});

describe("explainer.writeShort: writing a candidate", () => {
  it.effect("writes the dedicated script under the short's directory and records one version", () =>
    inChannel("nyaucast-short-write-", {}, (channelRoot) =>
      Effect.gen(function* () {
        yield* setClock(first);

        const result = yield* writeShort();

        assert.deepStrictEqual(result, {
          key: shortScriptKey(1),
          number: 1,
          recorded: true,
          videoId: "V1",
        });
        assert.deepStrictEqual(readScriptFile(channelRoot), {
          scenes: dedicatedScript.map((paragraphs) => ({
            paragraphs: paragraphs.map((text) => ({ text })),
          })),
        });
        assert.deepStrictEqual(yield* versionRows, [
          {
            created_at: first,
            end_paragraph: 1,
            end_scene: 2,
            hook: defaultHook,
            number: 1,
            script_key: shortScriptKey(1),
            script_sha256: createHash("sha256")
              .update(readChannelFile(channelRoot, shortScriptKey(1)))
              .digest("hex"),
            start_paragraph: 2,
            start_scene: 1,
            video_id: "V1",
          },
        ]);
      }),
    ),
  );

  it.effect(
    "accepts a range inside one scene, a single paragraph, and the whole of the long script",
    () =>
      inChannel("nyaucast-short-ranges-", {}, () =>
        Effect.gen(function* () {
          const inScene = yield* writeShort({ number: 1, range: paragraphRange([1, 1], [1, 2]) });
          const single = yield* writeShort({ number: 2, range: paragraphRange([2, 2], [2, 2]) });
          const whole = yield* writeShort({ number: 3, range: paragraphRange([1, 1], [2, 2]) });

          assert.isTrue(inScene.recorded);
          assert.isTrue(single.recorded);
          assert.isTrue(whole.recorded);
        }),
      ),
  );

  it.effect("keeps each number as its own candidate with its own script", () =>
    inChannel("nyaucast-short-numbers-", {}, (channelRoot) =>
      Effect.gen(function* () {
        yield* writeShort({ number: 1, scenes: [["一つ目の台本。"]] });
        yield* writeShort({ number: 2, scenes: [["二つ目の台本。"]], hook: "別のフック" });

        assert.strictEqual(
          readScriptFile(channelRoot, 1).scenes[0]?.paragraphs[0]?.text,
          "一つ目の台本。",
        );
        assert.strictEqual(
          readScriptFile(channelRoot, 2).scenes[0]?.paragraphs[0]?.text,
          "二つ目の台本。",
        );
        assert.deepStrictEqual(
          (yield* statusShorts).map((candidate) => [candidate.number, candidate.hook]),
          [
            [1, defaultHook],
            [2, "別のフック"],
          ],
        );
      }),
    ),
  );
});

describe("explainer.writeShort: writing a candidate again", () => {
  it.effect("adds one version per change, and the read model returns the last version", () =>
    inChannel("nyaucast-short-versions-", {}, (channelRoot) =>
      Effect.gen(function* () {
        yield* setClock(first);
        yield* writeShort({ hook: "最初のフック" });
        yield* setClock(second);

        const again = yield* writeShort({
          hook: "書き直したフック",
          range: paragraphRange([2, 1], [2, 2]),
          scenes: [["書き直した台本。"]],
        });

        assert.isTrue(again.recorded);
        const rows = yield* versionRows;
        assert.strictEqual(rows.length, 2);
        assert.deepStrictEqual(
          rows.map((row) => [row["hook"], row["created_at"]]),
          [
            ["最初のフック", first],
            ["書き直したフック", second],
          ],
        );
        assert.deepStrictEqual(yield* statusShorts, [
          {
            createdAt: second,
            hook: "書き直したフック",
            number: 1,
            range: paragraphRange([2, 1], [2, 2]),
            scriptKey: shortScriptKey(1),
          },
        ]);
        assert.strictEqual(
          readScriptFile(channelRoot).scenes[0]?.paragraphs[0]?.text,
          "書き直した台本。",
        );
      }),
    ),
  );

  it.effect.each([
    ["the hook", { hook: "違うフック" }],
    ["the range", { range: paragraphRange([1, 1], [1, 1]) }],
    ["the dedicated script", { scenes: [["違う台本。"]] }],
  ] as const)("adds a version when only %s changes", ([_name, change]) =>
    inChannel("nyaucast-short-each-change-", {}, () =>
      Effect.gen(function* () {
        yield* writeShort();

        const result = yield* writeShort(change);

        assert.isTrue(result.recorded);
        assert.strictEqual((yield* shortFactCounts).versions, 2);
      }),
    ),
  );

  it.effect("records nothing and leaves the file as it is when the content is unchanged", () =>
    inChannel("nyaucast-short-unchanged-", {}, (channelRoot) =>
      Effect.gen(function* () {
        yield* setClock(first);
        yield* writeShort();
        const before = readChannelFile(channelRoot, shortScriptKey(1));
        yield* setClock(second);

        const again = yield* writeShort();

        assert.isFalse(again.recorded);
        assert.strictEqual(again.key, shortScriptKey(1));
        assert.deepStrictEqual(readChannelFile(channelRoot, shortScriptKey(1)), before);
        assert.strictEqual((yield* shortFactCounts).versions, 1);
        assert.strictEqual((yield* statusShorts)[0]?.createdAt, first);
      }),
    ),
  );

  it.effect(
    "records a version when only the script file was replaced, as after a write that stopped before its version",
    () =>
      inChannel("nyaucast-short-file-ahead-", {}, (channelRoot) =>
        Effect.gen(function* () {
          yield* setClock(first);
          yield* writeShort();
          const rewritten = [["書き直した台本。"]] as const;
          writeChannelFile(
            channelRoot,
            shortScriptKey(1),
            new TextEncoder().encode(
              JSON.stringify({ scenes: [{ paragraphs: [{ text: "書き直した台本。" }] }] }),
            ),
          );
          yield* setClock(second);

          const again = yield* writeShort({ scenes: rewritten });

          assert.isTrue(again.recorded);
          assert.strictEqual((yield* versionRows).length, 2);
          assert.strictEqual((yield* statusShorts)[0]?.createdAt, second);
        }),
      ),
  );

  it.effect(
    "puts a later version strictly after the previous one even at the same clock time",
    () =>
      inChannel("nyaucast-short-same-time-", {}, () =>
        Effect.gen(function* () {
          yield* setClock(first);
          yield* writeShort({ hook: "一つ目" });
          yield* writeShort({ hook: "二つ目" });

          const [one, two] = (yield* versionRows).map((row) => String(row["created_at"]));

          assert.isTrue((one ?? "") < (two ?? ""));
          assert.strictEqual((yield* statusShorts)[0]?.hook, "二つ目");
        }),
      ),
  );

  it.effect("brings a withdrawn number back as a candidate when it is written again", () =>
    inChannel("nyaucast-short-rewrite-withdrawn-", {}, () =>
      Effect.gen(function* () {
        yield* setClock(first);
        yield* writeShort();
        yield* withdrawShort(1);
        assert.deepStrictEqual(yield* statusShorts, []);
        yield* setClock(second);

        const again = yield* writeShort();

        assert.isTrue(again.recorded);
        assert.deepStrictEqual(
          (yield* statusShorts).map((candidate) => candidate.number),
          [1],
        );
        assert.deepStrictEqual(yield* shortFactCounts, { versions: 2, withdrawals: 1 });
      }),
    ),
  );
});

describe("explainer.writeShort: what it refuses", () => {
  const refused = (name: string, change: Parameters<typeof shortInput>[0]) =>
    it.effect(`fails with InvalidShortRange for ${name}, and writes nothing`, () =>
      inChannel("nyaucast-short-invalid-range-", {}, (channelRoot) =>
        Effect.gen(function* () {
          const failure = yield* Effect.flip(writeShort(change));

          assert.strictEqual(failure._tag, "InvalidShortRange");
          assert.strictEqual(failureFacts(failure)["videoId"], "V1");
          assert.strictEqual(failureFacts(failure)["number"], 1);
          assert.isFalse(channelFileExists(channelRoot, shortScriptKey(1)));
          assert.deepStrictEqual(yield* shortFactCounts, { versions: 0, withdrawals: 0 });
        }),
      ),
    );

  refused("a reversed range across scenes", { range: paragraphRange([2, 1], [1, 2]) });
  refused("a reversed range inside a scene", { range: paragraphRange([1, 2], [1, 1]) });
  refused("a scene the long script does not have", { range: paragraphRange([3, 1], [3, 1]) });
  refused("a paragraph the long script does not have", { range: paragraphRange([1, 1], [1, 3]) });
  refused("an end past the last paragraph", { range: paragraphRange([1, 1], [2, 3]) });

  it.effect(
    "fails with ScriptNotFound when the long script is not written, and writes nothing",
    () =>
      inChannel("nyaucast-short-no-script-", { withoutScript: true }, (channelRoot) =>
        Effect.gen(function* () {
          const failure = yield* Effect.flip(writeShort());

          assert.strictEqual(failure._tag, "ScriptNotFound");
          assert.isFalse(channelFileExists(channelRoot, shortScriptKey(1)));
          assert.deepStrictEqual(yield* shortFactCounts, { versions: 0, withdrawals: 0 });
        }),
      ),
  );

  it.effect("checks the dedicated script like a long script: a broken reading mark fails", () =>
    inChannel("nyaucast-short-bad-markup-", {}, (channelRoot) =>
      Effect.gen(function* () {
        const failure = yield* Effect.flip(writeShort({ scenes: [["{閉じ忘れ|よみ"]] }));

        assert.strictEqual(failure._tag, "InvalidReadingMarkup");
        assert.isFalse(channelFileExists(channelRoot, shortScriptKey(1)));
        assert.deepStrictEqual(yield* shortFactCounts, { versions: 0, withdrawals: 0 });
      }),
    ),
  );

  it.effect("fails with ProduceGateNotApproved before the produce gate is approved", () =>
    inChannel("nyaucast-short-unapproved-", { unapproved: true }, (channelRoot) =>
      Effect.gen(function* () {
        const failure = yield* Effect.flip(writeShort());

        assert.strictEqual(failure._tag, "ProduceGateNotApproved");
        assert.isFalse(channelFileExists(channelRoot, shortScriptKey(1)));
        assert.deepStrictEqual(yield* shortFactCounts, { versions: 0, withdrawals: 0 });
      }),
    ),
  );

  it.effect("fails with VideoNotFound for an unknown video", () =>
    inChannel("nyaucast-short-unknown-video-", {}, () =>
      Effect.gen(function* () {
        const failure = yield* Effect.flip(writeShort({ videoId: "V9" }));

        assert.strictEqual(failure._tag, "VideoNotFound");
      }),
    ),
  );
});

describe("explainer.writeShort: the range is read against the long script as it is now", () => {
  it.effect("refuses a range the long script no longer has after the script was shortened", () =>
    inChannel("nyaucast-short-script-shrinks-", {}, () =>
      Effect.gen(function* () {
        yield* callTool("explainer_write_script", scriptInput([["猫は鳴く。"]]));

        const failure = yield* Effect.flip(writeShort({ range: crossSceneRange }));

        assert.strictEqual(failure._tag, "InvalidShortRange");
      }),
    ),
  );
});
