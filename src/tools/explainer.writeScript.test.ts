import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";

import { accepts, failureFacts, publishedAdditionalProperties } from "../../test/helpers.ts";
import {
  approveProduce,
  explainerConfigWithVoice,
  narrationDirectory,
  recordPlan,
  scriptInput,
  tableRowCounts,
  voiceDeclaration,
} from "../../test/narration-helpers.ts";
import { channelFileExists, readChannelFile } from "../../test/thumbnail-helpers.ts";
import { callTool, rejectionReason, withToolChannel } from "../../test/tool-helpers.ts";
import { maxParagraphReadingCharacters } from "../scripts/script.ts";
import { ExplainerWriteScriptTool } from "./explainer.writeScript.ts";

const scriptKey = "videos/V1/script.json";

const inChannel = <A, E, R>(prefix: string, use: (channelRoot: string) => Effect.Effect<A, E, R>) =>
  withToolChannel(prefix, { config: explainerConfigWithVoice(voiceDeclaration()) }, (channelRoot) =>
    Effect.gen(function* () {
      yield* recordPlan();
      return yield* use(channelRoot);
    }),
  );

const writtenScenes = (channelRoot: string) =>
  (
    JSON.parse(new TextDecoder().decode(readChannelFile(channelRoot, scriptKey))) as {
      scenes: unknown;
    }
  ).scenes;

describe("explainer.writeScript: parameters", () => {
  it("is named with its wire name", () => {
    assert.strictEqual(ExplainerWriteScriptTool.name, "explainer_write_script");
  });

  it("accepts a video and scenes of paragraphs, and rejects every other key", () => {
    const schema = ExplainerWriteScriptTool.parametersSchema;

    assert.isTrue(accepts(schema, scriptInput([["猫は鳴く。"], ["犬は吠える。"]])));
    assert.isFalse(accepts(schema, { scenes: scriptInput([["a"]]).scenes }));
    assert.isFalse(accepts(schema, { videoId: "V1" }));
    assert.isFalse(accepts(schema, { ...scriptInput([["a"]]), force: true }));
    assert.isFalse(accepts(schema, { ...scriptInput([["a"]]), voice: "Kore" }));
    assert.strictEqual(publishedAdditionalProperties(ExplainerWriteScriptTool), false);
  });

  it("does not accept a paragraph that carries anything but its text", () => {
    const schema = ExplainerWriteScriptTool.parametersSchema;

    assert.isFalse(
      accepts(schema, {
        scenes: [{ paragraphs: [{ reading: "ねこ", text: "猫" }] }],
        videoId: "V1",
      }),
    );
  });
});

describe("explainer.writeScript: writing the script", () => {
  it.effect("writes the scenes, paragraphs and texts of the script to the video's directory", () =>
    inChannel("nyaucast-script-write-", (channelRoot) =>
      Effect.gen(function* () {
        yield* approveProduce();
        const input = scriptInput([
          ["{API|エーピーアイ}を使う。", "猫は、喉を鳴らす。"],
          ["犬は吠える。"],
        ]);

        const result = yield* callTool("explainer_write_script", input);

        assert.strictEqual(result.videoId, "V1");
        assert.isTrue(channelFileExists(channelRoot, scriptKey));
        assert.deepStrictEqual<unknown>(writtenScenes(channelRoot), input.scenes);
        assert.isTrue(accepts(ExplainerWriteScriptTool.successSchema, result));
      }),
    ),
  );

  it.effect(
    "replaces the earlier script when it is written again (the script is agent input)",
    () =>
      inChannel("nyaucast-script-replace-", (channelRoot) =>
        Effect.gen(function* () {
          yield* approveProduce();
          yield* callTool("explainer_write_script", scriptInput([["最初の台本です。"]]));
          const second = scriptInput([["二度目の台本です。"], ["続きの場面です。"]]);

          yield* callTool("explainer_write_script", second);

          assert.deepStrictEqual<unknown>(writtenScenes(channelRoot), second.scenes);
        }),
      ),
  );

  it.effect("writes the same script twice without a failure or a second file", () =>
    inChannel("nyaucast-script-idempotent-", (channelRoot) =>
      Effect.gen(function* () {
        yield* approveProduce();
        const input = scriptInput([["同じ台本です。"]]);

        yield* callTool("explainer_write_script", input);
        const first = readChannelFile(channelRoot, scriptKey);
        yield* callTool("explainer_write_script", input);

        assert.deepStrictEqual(readChannelFile(channelRoot, scriptKey), first);
      }),
    ),
  );

  it.effect("writes no row to the local store", () =>
    inChannel("nyaucast-script-no-rows-", () =>
      Effect.gen(function* () {
        yield* approveProduce();
        const before = yield* tableRowCounts;

        yield* callTool("explainer_write_script", scriptInput([["台本には行を持たない。"]]));

        assert.deepStrictEqual(yield* tableRowCounts, before);
      }),
    ),
  );

  it.effect("returns facts only; the result rejects action fields", () =>
    inChannel("nyaucast-script-facts-", () =>
      Effect.gen(function* () {
        yield* approveProduce();

        const result = yield* callTool("explainer_write_script", scriptInput([["事実だけ。"]]));

        const schema = ExplainerWriteScriptTool.successSchema;
        assert.isTrue(accepts(schema, result));
        assert.isFalse(accepts(schema, { ...result, next: "synthesize" }));
      }),
    ),
  );
});

describe("explainer.writeScript: the produce gate", () => {
  it.effect("fails with ProduceGateNotApproved for a video whose produce gate is pending", () =>
    inChannel("nyaucast-script-pending-", (channelRoot) =>
      Effect.gen(function* () {
        const before = yield* tableRowCounts;

        const failure = yield* Effect.flip(
          callTool("explainer_write_script", scriptInput([["承認の前。"]])),
        );

        assert.strictEqual(failure._tag, "ProduceGateNotApproved");
        assert.strictEqual(failureFacts(failure)["videoId"], "V1");
        assert.isFalse(channelFileExists(channelRoot, scriptKey));
        assert.deepStrictEqual(yield* tableRowCounts, before);
      }),
    ),
  );

  it.effect("fails with VideoNotFound for an unknown video", () =>
    inChannel("nyaucast-script-unknown-", (channelRoot) =>
      Effect.gen(function* () {
        const failure = yield* Effect.flip(
          callTool("explainer_write_script", scriptInput([["どこにもない動画。"]], "nope")),
        );

        assert.strictEqual(failure._tag, "VideoNotFound");
        assert.isFalse(channelFileExists(channelRoot, "videos/nope/script.json"));
      }),
    ),
  );
});

describe("explainer.writeScript: the length of a paragraph", () => {
  const limit = maxParagraphReadingCharacters;

  it.effect("writes a paragraph whose reading is exactly the limit", () =>
    inChannel("nyaucast-script-limit-", (channelRoot) =>
      Effect.gen(function* () {
        yield* approveProduce();

        yield* callTool("explainer_write_script", scriptInput([["あ".repeat(limit)]]));

        assert.isTrue(channelFileExists(channelRoot, scriptKey));
      }),
    ),
  );

  it.effect("fails with ParagraphTooLong for one character over, before writing anything", () =>
    inChannel("nyaucast-script-over-", (channelRoot) =>
      Effect.gen(function* () {
        yield* approveProduce();

        const failure = yield* Effect.flip(
          callTool(
            "explainer_write_script",
            scriptInput([["短い段落。"], ["あ".repeat(limit + 1)]]),
          ),
        );

        assert.strictEqual(failure._tag, "ParagraphTooLong");
        assert.strictEqual(failureFacts(failure)["scene"], 2);
        assert.strictEqual(failureFacts(failure)["paragraph"], 1);
        assert.isFalse(channelFileExists(channelRoot, scriptKey));
        assert.isFalse(channelFileExists(channelRoot, narrationDirectory));
      }),
    ),
  );

  it.effect("leaves the earlier script as it was when the new one is too long", () =>
    inChannel("nyaucast-script-over-keeps-", (channelRoot) =>
      Effect.gen(function* () {
        yield* approveProduce();
        const earlier = scriptInput([["前の台本です。"]]);
        yield* callTool("explainer_write_script", earlier);

        const failure = yield* Effect.flip(
          callTool("explainer_write_script", scriptInput([["い".repeat(limit + 1)]])),
        );

        assert.strictEqual(failure._tag, "ParagraphTooLong");
        assert.deepStrictEqual<unknown>(writtenScenes(channelRoot), earlier.scenes);
      }),
    ),
  );

  it.effect("counts the reading, not the notation, against the limit", () =>
    inChannel("nyaucast-script-limit-reading-", (channelRoot) =>
      Effect.gen(function* () {
        yield* approveProduce();
        const longNotation = `{${"漢".repeat(limit + 10)}|あ}`;
        const longReading = `{漢|${"あ".repeat(limit + 1)}}`;

        yield* callTool("explainer_write_script", scriptInput([[longNotation]]));
        assert.isTrue(channelFileExists(channelRoot, scriptKey));

        const failure = yield* Effect.flip(
          callTool("explainer_write_script", scriptInput([[longReading]])),
        );
        assert.strictEqual(failure._tag, "ParagraphTooLong");
      }),
    ),
  );
});

describe("explainer.writeScript: the reading mark {notation|reading}", () => {
  it.effect.each([
    ["a mark that is not closed", "{API|エーピーアイ"],
    ["a mark nested in a mark", "{A|{B|C}}"],
    ["a mark with two readings", "{A|B|C}"],
    ["a mark with an empty notation", "{|よみ}"],
    ["a mark with an empty reading", "{API|}"],
    ["a closing brace outside a mark", "APIを使う}"],
    ["a bar outside a mark", "APIを|使う"],
  ] as const)("fails with InvalidReadingMarkup for %s, before writing anything", ([, body]) =>
    inChannel("nyaucast-script-markup-", (channelRoot) =>
      Effect.gen(function* () {
        yield* approveProduce();

        const failure = yield* Effect.flip(
          callTool(
            "explainer_write_script",
            scriptInput([["正しい段落。"], ["正しい段落。", body]]),
          ),
        );

        assert.strictEqual(failure._tag, "InvalidReadingMarkup");
        assert.strictEqual(failureFacts(failure)["scene"], 2);
        assert.strictEqual(failureFacts(failure)["paragraph"], 2);
        assert.isFalse(channelFileExists(channelRoot, scriptKey));
      }),
    ),
  );

  it.effect("writes the full-width ｛表記｜読み｝ as plain characters, not as a reading mark", () =>
    inChannel("nyaucast-script-fullwidth-", (channelRoot) =>
      Effect.gen(function* () {
        yield* approveProduce();
        const input = scriptInput([["｛API｜エーピーアイ｝を使う。"]]);

        yield* callTool("explainer_write_script", input);

        assert.deepStrictEqual<unknown>(writtenScenes(channelRoot), input.scenes);
      }),
    ),
  );

  it.effect("rejects an unknown key as invalid parameters, before anything is written", () =>
    inChannel("nyaucast-script-unknown-key-", (channelRoot) =>
      Effect.gen(function* () {
        yield* approveProduce();

        const request = { ...scriptInput([["台本。"]]), next: "synthesize" };

        assert.strictEqual(
          yield* rejectionReason("explainer_write_script", request),
          "ToolParameterValidationError",
        );
        assert.isFalse(channelFileExists(channelRoot, scriptKey));
      }),
    ),
  );
});
