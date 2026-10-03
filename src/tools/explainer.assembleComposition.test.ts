import { readdirSync, writeFileSync, appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";

import {
  assertSegmentsCover,
  bodyFontPath,
  captionFontPath,
  compositionHashMeta,
  compositionKey,
  diagramKey,
  explainerConfigWithTheme,
  defined,
  fontBytes,
  loadComposition,
  opacityAt,
  paragraphStart,
  phraseStart,
  readTimingFile,
  sceneOneDiagram,
  sceneTwoDiagram,
  scriptScenes,
  themeDeclaration,
  writeThemeFonts,
} from "../../test/composition-helpers.ts";
import { accepts, failureFacts, publishedAdditionalProperties } from "../../test/helpers.ts";
import {
  approveProduce,
  pcmSeconds,
  recordPlan,
  scriptInput,
  tableRowCounts,
  timingKey,
} from "../../test/narration-helpers.ts";
import {
  bodyBase64,
  channelFileExists,
  fakeGemini,
  readChannelFile,
  writeChannelFile,
  type FakeReply,
} from "../../test/thumbnail-helpers.ts";
import { writeVideoConfig } from "../../test/helpers.ts";
import { callTool, rejectionReason, withToolChannel } from "../../test/tool-helpers.ts";
import { ExplainerAssembleCompositionTool } from "./explainer.assembleComposition.ts";

const speech = (seconds: number): FakeReply => ({ audio: pcmSeconds(seconds) });

// 段落の順（シーン 1 の 2 段落、シーン 2 の 2 段落）の音声の長さ。シーン 2 の 2 段落目は 2 秒で、前の句が 0.5 秒より短くなる。
const defaultReplies = [speech(2), speech(6), speech(3), speech(2)];

interface Preparation {
  /** 台本の前にチャンネル設定を差し替える（既定は themeDeclaration()）。undefined ならテーマを書かない。 */
  readonly theme?: Record<string, unknown> | undefined;
  /** 図解を tool で書かない。 */
  readonly withoutDiagrams?: boolean;
  /** フォントのファイルを置かない。 */
  readonly withoutFonts?: boolean;
  /** 音声を合成しない（タイミング表が無い）。 */
  readonly withoutNarration?: boolean;
  /** 承認しない（台本以降を用意しない）。 */
  readonly unapproved?: boolean;
  readonly replies?: readonly FakeReply[];
  readonly scenes?: readonly (readonly string[])[];
}

// 企画・承認・台本・フォント・図解・音声を、lifecycle の順（図解は音声より前）に用意した動画 V1 で use を動かす。
const prepared = <A, E, R>(
  prefix: string,
  options: Preparation,
  use: (channelRoot: string) => Effect.Effect<A, E, R>,
) => {
  const theme = "theme" in options ? options.theme : themeDeclaration();
  const scenes = options.scenes ?? scriptScenes;
  return withToolChannel(
    prefix,
    {
      config: explainerConfigWithTheme(theme),
      gemini: fakeGemini(options.replies ?? defaultReplies),
    },
    (channelRoot) =>
      Effect.gen(function* () {
        yield* recordPlan();
        if (options.unapproved === true) return yield* use(channelRoot);
        yield* approveProduce();
        yield* callTool("explainer_write_script", scriptInput(scenes));
        if (options.withoutFonts !== true) writeThemeFonts(channelRoot);
        if (options.withoutDiagrams !== true) {
          yield* callTool("explainer_write_diagram", {
            html: sceneOneDiagram,
            scene: 1,
            videoId: "V1",
          });
          yield* callTool("explainer_write_diagram", {
            html: sceneTwoDiagram,
            scene: 2,
            videoId: "V1",
          });
        }
        if (options.withoutNarration !== true) {
          yield* callTool("explainer_synthesize_narration", { videoId: "V1" });
        }
        return yield* use(channelRoot);
      }),
  );
};

const assemble = (extra: { force?: boolean } = {}) =>
  callTool("explainer_assemble_composition", { videoId: "V1", ...extra });

const readComposition = (channelRoot: string) =>
  new TextDecoder().decode(readChannelFile(channelRoot, compositionKey));

const pageOf = (channelRoot: string) => loadComposition(readComposition(channelRoot));

interface Violation {
  readonly rule: string;
  readonly scene: number;
}

const violationsOfAssemble = Effect.gen(function* () {
  const failure = yield* Effect.flip(assemble());
  assert.strictEqual(failure._tag, "InvalidDiagrams");
  assert.strictEqual(failureFacts(failure)["videoId"], "V1");
  return failureFacts(failure)["violations"] as readonly Violation[];
});

const near = (actual: number, expected: number, tolerance = 1e-9) =>
  assert.closeTo(actual, expected, tolerance);

// 境界は 1/1024 秒の格子に丸められる。
const grid = 1 / 1024;
// 時刻の前後に取る微小な幅。
const epsilon = 1e-3;
// 動きの長さの上限（秒）。
const motionSeconds = 0.5;

describe("explainer.assembleComposition: parameters", () => {
  it("is named with its wire name", () => {
    assert.strictEqual(ExplainerAssembleCompositionTool.name, "explainer_assemble_composition");
  });

  it("accepts a video and an optional force, and rejects every other key", () => {
    const schema = ExplainerAssembleCompositionTool.parametersSchema;

    assert.isTrue(accepts(schema, { videoId: "V1" }));
    assert.isTrue(accepts(schema, { force: true, videoId: "V1" }));
    assert.isFalse(accepts(schema, { force: true }));
    assert.isFalse(accepts(schema, { scene: 1, videoId: "V1" }));
    assert.isFalse(accepts(schema, { fps: 60, videoId: "V1" }));
    assert.strictEqual(publishedAdditionalProperties(ExplainerAssembleCompositionTool), false);
  });

  it.effect("rejects an unknown key as invalid parameters, before anything is written", () =>
    prepared("nyaucast-composition-unknown-key-", {}, (channelRoot) =>
      Effect.gen(function* () {
        const request = { fps: 60, videoId: "V1" };

        assert.strictEqual(
          yield* rejectionReason("explainer_assemble_composition", request),
          "ToolParameterValidationError",
        );
        assert.isFalse(channelFileExists(channelRoot, compositionKey));
      }),
    ),
  );
});

describe("explainer.assembleComposition: the composition of the long cut", () => {
  it.effect("writes one composition for the whole cut and returns its key and hash", () =>
    prepared("nyaucast-composition-write-", {}, (channelRoot) =>
      Effect.gen(function* () {
        const result = yield* assemble();

        assert.strictEqual(result.assembled, true);
        assert.strictEqual(result.key, compositionKey);
        assert.strictEqual(result.videoId, "V1");
        assert.match(result.hash, /^[0-9a-f]{64}$/u);
        assert.include(readComposition(channelRoot), compositionHashMeta(result.hash));
        assert.deepStrictEqual(readdirSync(join(channelRoot, "videos/V1/compositions")), [
          "long.html",
        ]);
      }),
    ),
  );

  it.effect("defines window.__hf with the long cut's size, rate and duration", () =>
    prepared("nyaucast-composition-hf-", {}, (channelRoot) =>
      Effect.gen(function* () {
        yield* assemble();

        const { hf } = pageOf(channelRoot);
        assert.strictEqual(hf.width, 1920);
        assert.strictEqual(hf.height, 1080);
        assert.strictEqual(hf.fps, 30);
        near(hf.duration, readTimingFile(channelRoot).durationSeconds, grid);
        assert.strictEqual(typeof hf.seek, "function");
      }),
    ),
  );

  it.effect(
    "cuts the segments at the scene boundaries, covering [0, duration) without gap or overlap",
    () =>
      prepared("nyaucast-composition-segments-", {}, (channelRoot) =>
        Effect.gen(function* () {
          yield* assemble();

          const { hf } = pageOf(channelRoot);
          const timing = readTimingFile(channelRoot);
          assertSegmentsCover(hf);
          assert.strictEqual(hf.segments.length, 2);
          assert.strictEqual(defined(hf.segments[0]).start, 0);
          const sceneOneEnd = defined(
            timing.paragraphs.filter((paragraph) => paragraph.scene === 1).at(-1),
          );
          near(defined(hf.segments[1]).start, sceneOneEnd.endSeconds, grid);
          assert.isTrue(hf.segments.every((segment) => segment.static === false));
        }),
      ),
  );

  it.effect("makes one segment per scene of the script", () =>
    prepared(
      "nyaucast-composition-three-scenes-",
      {
        replies: [speech(2), speech(6), speech(3), speech(2), speech(2)],
        scenes: [...scriptScenes, ["三つ目の場面です。"]],
        withoutDiagrams: true,
      },
      (channelRoot) =>
        Effect.gen(function* () {
          for (const [scene, html] of [
            [1, sceneOneDiagram],
            [2, sceneTwoDiagram],
            [3, '<div data-beat="1">三つ目</div>'],
          ] as const) {
            yield* callTool("explainer_write_diagram", { html, scene, videoId: "V1" });
          }

          yield* assemble();

          const { hf } = pageOf(channelRoot);
          assertSegmentsCover(hf);
          assert.strictEqual(hf.segments.length, 3);
        }),
    ),
  );

  it.effect("shows the diagram of the scene being played and hides the others", () =>
    prepared("nyaucast-composition-scenes-", {}, (channelRoot) =>
      Effect.gen(function* () {
        yield* assemble();

        const page = pageOf(channelRoot);
        const boundary = defined(page.hf.segments[1]).start;
        page.seek(0);
        assert.deepStrictEqual(page.sceneVisibility(), ["visible", "hidden"]);
        page.seek(boundary - epsilon);
        assert.deepStrictEqual(page.sceneVisibility(), ["visible", "hidden"]);
        page.seek(boundary);
        assert.deepStrictEqual(page.sceneVisibility(), ["hidden", "visible"]);
        page.seek(page.hf.duration - epsilon);
        assert.deepStrictEqual(page.sceneVisibility(), ["hidden", "visible"]);
      }),
    ),
  );
});

describe("explainer.assembleComposition: the timing of the motions follows the timing table", () => {
  it.effect(
    "shows a beat of a paragraph at the start of that paragraph (P, written without a phrase)",
    () =>
      prepared("nyaucast-composition-beat-paragraph-", {}, (channelRoot) =>
        Effect.gen(function* () {
          yield* assemble();

          const page = pageOf(channelRoot);
          const timing = readTimingFile(channelRoot);
          // シーン 2 の図解: 動く要素 2 は beat "1"、3 は beat "2"（2 段落目の頭）、4 は beat "2.2"。
          const first = paragraphStart(timing, 2);
          const second = paragraphStart(timing, 3);
          assert.strictEqual(opacityAt(page, 2, first - epsilon), 0);
          assert.isAbove(opacityAt(page, 2, first + epsilon), 0);
          assert.strictEqual(opacityAt(page, 3, second - epsilon), 0);
          assert.isAbove(opacityAt(page, 3, second + epsilon), 0);
          // "2" は "2.1" と同じ時刻、つまり段落の最初の句の頭。
          near(phraseStart(timing, 3, 0), second);
        }),
      ),
  );

  it.effect(
    "shows a beat of a phrase (P.K) at the start of that phrase, in the order of the table",
    () =>
      prepared("nyaucast-composition-beat-phrase-", {}, (channelRoot) =>
        Effect.gen(function* () {
          yield* assemble();

          const page = pageOf(channelRoot);
          const timing = readTimingFile(channelRoot);
          // シーン 1 の図解: 動く要素 1 は beat "2.3"（2 段落目の 3 句目）。
          const third = phraseStart(timing, 1, 2);
          assert.strictEqual(opacityAt(page, 1, third - epsilon), 0);
          assert.isAbove(opacityAt(page, 1, third + epsilon), 0);
          assert.isBelow(opacityAt(page, 1, third + epsilon), 1);
          near(opacityAt(page, 1, third + motionSeconds), 1);
          // 句の頭より前の時刻（直前の句の中）では、まだ現れていない。
          const second = phraseStart(timing, 1, 1);
          assert.strictEqual(opacityAt(page, 1, second), 0);
        }),
      ),
  );

  it.effect("keeps an element visible from the start of its scene when it has no beat", () =>
    prepared("nyaucast-composition-no-beat-", {}, (channelRoot) =>
      Effect.gen(function* () {
        yield* assemble();

        const page = pageOf(channelRoot);
        // 動かない要素には data-nc-motion が付かない。見出しなどが動く要素に数えられていない（2 + 3 = 5 個）。
        assert.strictEqual(page.motionCount(), 5);
        // シーン 1 の見出し（h1）は、シーンの頭から最後まで、seek に隠されない（opacity も visibility も設定されない）。
        for (const t of [0, 1, page.hf.segments[1]?.start ?? 0]) {
          page.seek(t);
          assert.deepStrictEqual(page.styleOf("h1"), {});
        }
        page.seek(0);
        assert.deepStrictEqual(page.sceneVisibility(), ["visible", "hidden"]);
      }),
    ),
  );

  it.effect("dims an element at its dim position, after it has appeared", () =>
    prepared("nyaucast-composition-dim-", {}, (channelRoot) =>
      Effect.gen(function* () {
        yield* assemble();

        const page = pageOf(channelRoot);
        const timing = readTimingFile(channelRoot);
        // シーン 1 の動く要素 0: beat "1"、dim "2.2"。
        const appears = paragraphStart(timing, 0);
        const dims = phraseStart(timing, 1, 1);
        assert.strictEqual(opacityAt(page, 0, appears - epsilon), 0);
        near(opacityAt(page, 0, appears + motionSeconds), 1);
        near(opacityAt(page, 0, dims - epsilon), 1);
        assert.isBelow(opacityAt(page, 0, dims + epsilon), 1);
        near(opacityAt(page, 0, dims + motionSeconds), 0.3);
      }),
    ),
  );

  it.effect.each([
    ["left", /^translate\(-[\d.]+px, 0px\)$/u],
    ["right", /^translate\([\d.]+px, 0px\)$/u],
    ["top", /^translate\(0px, -[\d.]+px\)$/u],
    ["bottom", /^translate\(0px, [\d.]+px\)$/u],
  ] as const)("slides an element in from the %s, as its data-from says", ([from, midway]) =>
    prepared("nyaucast-composition-slide-from-", { withoutDiagrams: true }, (channelRoot) =>
      Effect.gen(function* () {
        yield* callTool("explainer_write_diagram", {
          html: `<div data-beat="1" data-enter="slide" data-from="${from}">一つ目</div>`,
          scene: 1,
          videoId: "V1",
        });
        yield* callTool("explainer_write_diagram", {
          html: sceneTwoDiagram,
          scene: 2,
          videoId: "V1",
        });
        yield* assemble();

        const page = pageOf(channelRoot);
        const start = paragraphStart(readTimingFile(channelRoot), 0);
        page.seek(start + motionSeconds / 2);

        assert.match(page.motionStyle(0, "transform") ?? "", midway);
      }),
    ),
  );

  it.effect("moves a slide-in element while it appears, and settles it when it is done", () =>
    prepared("nyaucast-composition-slide-", {}, (channelRoot) =>
      Effect.gen(function* () {
        yield* assemble();

        const page = pageOf(channelRoot);
        const start = phraseStart(readTimingFile(channelRoot), 1, 2);
        page.seek(start + motionSeconds / 2);
        const midway = page.motionStyle(1, "transform");
        page.seek(start + motionSeconds);
        const settled = page.motionStyle(1, "transform");

        assert.isDefined(midway);
        assert.isDefined(settled);
        assert.notStrictEqual(midway, settled);
      }),
    ),
  );

  it.effect("scales a pop element while it appears, and settles it when it is done", () =>
    prepared("nyaucast-composition-pop-", { withoutDiagrams: true }, (channelRoot) =>
      Effect.gen(function* () {
        yield* callTool("explainer_write_diagram", {
          html: '<div data-beat="1" data-enter="pop">一つ目</div>',
          scene: 1,
          videoId: "V1",
        });
        yield* callTool("explainer_write_diagram", {
          html: sceneTwoDiagram,
          scene: 2,
          videoId: "V1",
        });
        yield* assemble();

        const page = pageOf(channelRoot);
        const start = paragraphStart(readTimingFile(channelRoot), 0);
        page.seek(start + motionSeconds / 2);
        const midway = page.motionStyle(0, "transform");
        page.seek(start + motionSeconds);

        assert.match(midway ?? "", /^scale\(/u);
        assert.strictEqual(page.motionStyle(0, "transform"), "none");
        near(opacityAt(page, 0, start + motionSeconds), 1);
      }),
    ),
  );

  it.effect("never lets two motions overlap: a motion ends when the next one begins", () =>
    prepared("nyaucast-composition-one-at-a-time-", {}, (channelRoot) =>
      Effect.gen(function* () {
        yield* assemble();

        const page = pageOf(channelRoot);
        // シーン 2 の動く要素 3（beat "2"）と 4（beat "2.2"）。2 段落目の最初の句は 0.5 秒より短い。
        const timing = readTimingFile(channelRoot);
        const begins = phraseStart(timing, 3, 0);
        const next = phraseStart(timing, 3, 1);
        assert.isBelow(next - begins, motionSeconds);
        assert.isBelow(opacityAt(page, 3, next - epsilon), 1);
        near(opacityAt(page, 3, next), 1);
        assert.strictEqual(opacityAt(page, 4, next - epsilon), 0);
        assert.isAbove(opacityAt(page, 4, next + epsilon), 0);
      }),
    ),
  );

  it.effect(
    "numbers the moving elements across the whole composition, so scenes do not collide",
    () =>
      prepared("nyaucast-composition-motion-numbers-", {}, (channelRoot) =>
        Effect.gen(function* () {
          yield* assemble();

          const html = readComposition(channelRoot);
          const numbers = [...html.matchAll(/data-nc-motion="(\d+)"/gu)].map((match) => match[1]);
          assert.deepStrictEqual(numbers, ["0", "1", "2", "3", "4"]);
        }),
      ),
  );
});

describe("explainer.assembleComposition: the subtitles", () => {
  it.effect("shows the notation of each phrase from its start up to, not including, its end", () =>
    prepared("nyaucast-composition-captions-", {}, (channelRoot) =>
      Effect.gen(function* () {
        yield* assemble();

        const page = pageOf(channelRoot);
        for (const paragraph of readTimingFile(channelRoot).paragraphs) {
          for (const phrase of paragraph.phrases) {
            page.seek(phrase.startSeconds + epsilon);
            assert.strictEqual(page.caption(), phrase.text);
            page.seek(phrase.endSeconds - epsilon);
            assert.strictEqual(page.caption(), phrase.text);
          }
          // 段落の終わりの時刻には、段落の間の無音が始まっている。
          page.seek(paragraph.endSeconds);
          assert.strictEqual(page.caption(), "");
        }
      }),
    ),
  );

  it.effect("shows no subtitle before the narration begins and after it ends", () =>
    prepared("nyaucast-composition-captions-silence-", {}, (channelRoot) =>
      Effect.gen(function* () {
        yield* assemble();

        const page = pageOf(channelRoot);
        page.seek(0.1);
        assert.strictEqual(page.caption(), "");
        page.seek(page.hf.duration - epsilon);
        assert.strictEqual(page.caption(), "");
      }),
    ),
  );

  it.effect("shows the notation of a reading mark, never its reading", () =>
    prepared("nyaucast-composition-captions-notation-", {}, (channelRoot) =>
      Effect.gen(function* () {
        yield* assemble();

        const page = pageOf(channelRoot);
        page.seek(phraseStart(readTimingFile(channelRoot), 2, 0) + epsilon);

        assert.strictEqual(page.caption(), "APIの二つ目の場面です。");
        assert.notInclude(readComposition(channelRoot), "エーピーアイ");
      }),
    ),
  );
});

describe("explainer.assembleComposition: seek is a pure function of t", () => {
  const sampleTimes = (channelRoot: string) => {
    const timing = readTimingFile(channelRoot);
    return [
      0,
      ...timing.paragraphs.flatMap((paragraph) => [
        paragraph.startSeconds - epsilon,
        paragraph.startSeconds + epsilon,
        paragraph.startSeconds + 0.2,
        ...paragraph.phrases.map((phrase) => phrase.startSeconds + 0.1),
        paragraph.endSeconds,
      ]),
      timing.durationSeconds - epsilon,
    ];
  };

  it.effect(
    "gives the same state for the same t, whatever was sought before (forward, backward, again)",
    () =>
      prepared("nyaucast-composition-pure-", {}, (channelRoot) =>
        Effect.gen(function* () {
          yield* assemble();

          const times = sampleTimes(channelRoot);
          const forward = pageOf(channelRoot);
          const expected = times.map((t) => {
            forward.seek(t);
            return forward.snapshot();
          });
          const backward = pageOf(channelRoot);
          const reversed = times.toReversed().map((t) => {
            backward.seek(t);
            return backward.snapshot();
          });
          const again = pageOf(channelRoot);
          const shuffled = times.map((_, index) => defined(times[(index * 7) % times.length]));
          const fresh = times.map((t) => {
            const page = pageOf(channelRoot);
            page.seek(t);
            return page.snapshot();
          });

          assert.deepStrictEqual(reversed.toReversed(), expected);
          assert.deepStrictEqual(fresh, expected);
          // 同じ t へ続けて何度 seek しても、間に別の時刻を挟んでも変わらない。
          for (const t of shuffled) {
            again.seek(t);
            again.seek(defined(times[1]));
            again.seek(t);
            assert.strictEqual(again.snapshot(), expected[times.indexOf(t)]);
          }
        }),
      ),
  );

  it.effect("reads no clock, random number, timer or network while it is loaded and sought", () =>
    prepared("nyaucast-composition-no-clock-", {}, (channelRoot) =>
      Effect.gen(function* () {
        yield* assemble();

        const page = pageOf(channelRoot);
        for (const t of sampleTimes(channelRoot)) page.seek(t);

        assert.deepStrictEqual(page.traps, []);
      }),
    ),
  );
});

describe("explainer.assembleComposition: the theme and the fonts", () => {
  it.effect("puts the colors and sizes of the theme into the composition", () =>
    prepared("nyaucast-composition-theme-", {}, (channelRoot) =>
      Effect.gen(function* () {
        yield* assemble();

        const html = readComposition(channelRoot);
        for (const color of ["#ffb400", "#101820", "#000000cc", "#ffffff", "#8899aa", "#f5f5f5"]) {
          assert.include(html, color);
        }
        assert.match(html, /--nc-color-background:\s*#101820/u);
        assert.match(html, /--nc-color-accent:\s*#ffb400/u);
        assert.match(html, /--nc-size-caption-font-size:\s*44px/u);
        assert.match(html, /--nc-size-caption-margin:\s*48px/u);
        assert.match(html, /--nc-size-stage-padding:\s*64px/u);
      }),
    ),
  );

  it.effect("embeds the font files as base64 data, so that the composition is one file", () =>
    prepared("nyaucast-composition-fonts-", {}, (channelRoot) =>
      Effect.gen(function* () {
        yield* assemble();

        const html = readComposition(channelRoot);
        assert.include(html, `data:font/woff2;base64,${bodyBase64(fontBytes(1))}`);
        assert.include(html, `data:font/woff2;base64,${bodyBase64(fontBytes(2))}`);
        assert.notMatch(html, /<link\b|@import|https?:\/\//u);
      }),
    ),
  );

  it.effect("embeds a font file used for both the body and the captions only once", () =>
    prepared(
      "nyaucast-composition-font-once-",
      { theme: themeDeclaration({ fonts: { body: bodyFontPath, caption: bodyFontPath } }) },
      (channelRoot) =>
        Effect.gen(function* () {
          yield* assemble();

          const html = readComposition(channelRoot);
          assert.strictEqual(html.split(bodyBase64(fontBytes(1))).length - 1, 1);
        }),
    ),
  );

  it.effect(
    "leaves a scene without paragraphs out of the cut, and the segments still cover it",
    () =>
      prepared(
        "nyaucast-composition-empty-scene-",
        { scenes: [scriptScenes[0], [], scriptScenes[1]], withoutDiagrams: true },
        (channelRoot) =>
          Effect.gen(function* () {
            yield* callTool("explainer_write_diagram", {
              html: sceneOneDiagram,
              scene: 1,
              videoId: "V1",
            });
            yield* callTool("explainer_write_diagram", {
              html: sceneTwoDiagram,
              scene: 3,
              videoId: "V1",
            });

            yield* assemble();

            const { hf } = pageOf(channelRoot);
            assertSegmentsCover(hf);
            assert.strictEqual(hf.segments.length, 2);
          }),
      ),
  );

  it.effect(
    "fails with InvalidTimingTable for a script without any paragraph, and writes nothing",
    () =>
      prepared(
        "nyaucast-composition-no-paragraph-",
        { replies: [], scenes: [[]], withoutDiagrams: true },
        (channelRoot) =>
          Effect.gen(function* () {
            const failure = yield* Effect.flip(assemble());

            assert.strictEqual(failure._tag, "InvalidTimingTable");
            assert.isFalse(channelFileExists(channelRoot, compositionKey));
          }),
      ),
  );

  it.effect("fails with ThemeNotDeclared when the channel declares no theme", () =>
    prepared("nyaucast-composition-no-theme-", { theme: undefined }, (channelRoot) =>
      Effect.gen(function* () {
        const failure = yield* Effect.flip(assemble());

        assert.strictEqual(failure._tag, "ThemeNotDeclared");
        assert.isFalse(channelFileExists(channelRoot, compositionKey));
      }),
    ),
  );

  it.effect("fails with FontNotFound, naming the path, when a font file is missing", () =>
    prepared("nyaucast-composition-font-missing-", { withoutFonts: true }, (channelRoot) =>
      Effect.gen(function* () {
        writeChannelFile(channelRoot, captionFontPath, fontBytes(2));

        const failure = yield* Effect.flip(assemble());

        assert.strictEqual(failure._tag, "FontNotFound");
        assert.strictEqual(failureFacts(failure)["path"], bodyFontPath);
        assert.isFalse(channelFileExists(channelRoot, compositionKey));
      }),
    ),
  );

  it.effect("fails with FontUnsupported, naming the path, for a file that is not a font", () =>
    prepared(
      "nyaucast-composition-font-unsupported-",
      { theme: themeDeclaration({ fonts: { body: "assets/fonts/body.exe" } }) },
      (channelRoot) =>
        Effect.gen(function* () {
          writeChannelFile(channelRoot, "assets/fonts/body.exe", fontBytes(3));

          const failure = yield* Effect.flip(assemble());

          assert.strictEqual(failure._tag, "FontUnsupported");
          assert.strictEqual(failureFacts(failure)["path"], "assets/fonts/body.exe");
          assert.isFalse(channelFileExists(channelRoot, compositionKey));
        }),
    ),
  );
});

describe("explainer.assembleComposition: the diagrams become markup, not code", () => {
  const hostile =
    "<div><!-- COMMENT-MARKER <script>go()</script> -->" +
    "<p><![CDATA[<script>alert(1)</script>]]></p>" +
    "<p>&lt;script&gt;alert(2)&lt;/script&gt;</p>" +
    "<p>url(https://example.com/a.png)</p>" +
    "<p title='a\"b'>quoted</p>" +
    '<div id="empty-one"/><br/><span id="empty-two"/><p>after</p></div>';

  it.effect(
    "escapes text that looks like markup, drops comments, and keeps the quotes of attributes",
    () =>
      prepared("nyaucast-composition-escape-", { withoutDiagrams: true }, (channelRoot) =>
        Effect.gen(function* () {
          yield* callTool("explainer_write_diagram", { html: hostile, scene: 1, videoId: "V1" });
          yield* callTool("explainer_write_diagram", {
            html: sceneTwoDiagram,
            scene: 2,
            videoId: "V1",
          });

          yield* assemble();

          const html = readComposition(channelRoot);
          // 危険に見える文字列は、どれもエスケープされた形でしか出てこない。
          assert.include(html, "&lt;script&gt;alert(1)&lt;/script&gt;");
          assert.include(html, "&lt;script&gt;alert(2)&lt;/script&gt;");
          const unescaped = html
            .replaceAll("&lt;script&gt;alert(1)&lt;/script&gt;", "")
            .replaceAll("&lt;script&gt;alert(2)&lt;/script&gt;", "");
          assert.notInclude(unescaped, "alert(");
          assert.notInclude(html, "COMMENT-MARKER");
          assert.match(html, /title="a&(?:quot|#34|#x22);b"/u);
        }),
      ),
  );

  it.effect(
    "closes every element but the void ones, so that a self-closed div cannot swallow its siblings",
    () =>
      prepared("nyaucast-composition-void-", { withoutDiagrams: true }, (channelRoot) =>
        Effect.gen(function* () {
          yield* callTool("explainer_write_diagram", { html: hostile, scene: 1, videoId: "V1" });
          yield* callTool("explainer_write_diagram", {
            html: sceneTwoDiagram,
            scene: 2,
            videoId: "V1",
          });

          yield* assemble();

          const html = readComposition(channelRoot);
          assert.include(html, '<div id="empty-one"></div>');
          assert.include(html, '<span id="empty-two"></span>');
          assert.notInclude(html, "</br>");
          assert.notInclude(html, "<div/>");
        }),
      ),
  );
});

describe("explainer.assembleComposition: every violation of every scene is listed in one failure", () => {
  it.effect(
    "lists the violations of all scenes, a missing diagram, and an id shared by two scenes",
    () =>
      prepared(
        "nyaucast-composition-violations-",
        {
          replies: [speech(2), speech(6), speech(3), speech(2), speech(2)],
          scenes: [...scriptScenes, ["三つ目の場面です。"]],
          withoutDiagrams: true,
        },
        (channelRoot) =>
          Effect.gen(function* () {
            writeChannelFile(
              channelRoot,
              diagramKey(1),
              new TextEncoder().encode('<div><script>go()</script><p id="dup"></p></div>'),
            );
            writeChannelFile(
              channelRoot,
              diagramKey(2),
              new TextEncoder().encode('<div><p onclick="go()"></p><p id="dup"></p></div>'),
            );

            const violations = yield* violationsOfAssemble;

            assert.isTrue(violations.some((v) => v.scene === 1 && v.rule === "forbidden-element"));
            assert.isTrue(violations.some((v) => v.scene === 2 && v.rule === "event-handler"));
            assert.isTrue(violations.some((v) => v.rule === "duplicate-id"));
            assert.isTrue(violations.some((v) => v.scene === 3 && v.rule === "missing"));
            assert.deepStrictEqual(
              violations.map((violation) => violation.scene),
              violations.map((violation) => violation.scene).toSorted((a, b) => a - b),
            );
            assert.isFalse(channelFileExists(channelRoot, compositionKey));
          }),
      ),
  );

  it.effect("lists every scene without a diagram, not only the first", () =>
    prepared("nyaucast-composition-missing-", { withoutDiagrams: true }, (channelRoot) =>
      Effect.gen(function* () {
        const violations = yield* violationsOfAssemble;

        assert.deepStrictEqual(
          violations.map((violation) => [violation.scene, violation.rule]),
          [
            [1, "missing"],
            [2, "missing"],
          ],
        );
        assert.isFalse(channelFileExists(channelRoot, compositionKey));
      }),
    ),
  );

  it.effect("stops a slide without a direction written by hand, which seek could not run", () =>
    prepared("nyaucast-composition-slide-no-from-", {}, (channelRoot) =>
      Effect.gen(function* () {
        writeFileSync(
          join(channelRoot, diagramKey(2)),
          '<div data-beat="1" data-enter="slide"></div>',
        );

        const violations = yield* violationsOfAssemble;

        assert.deepStrictEqual(
          violations.map((violation) => [violation.scene, violation.rule]),
          [[2, "invalid-from"]],
        );
        assert.isFalse(channelFileExists(channelRoot, compositionKey));
      }),
    ),
  );

  it.effect("checks the diagrams again at assembly, so a diagram edited by hand is stopped", () =>
    prepared("nyaucast-composition-edited-", {}, (channelRoot) =>
      Effect.gen(function* () {
        writeFileSync(join(channelRoot, diagramKey(2)), "<div><script>go()</script></div>");

        const violations = yield* violationsOfAssemble;

        assert.deepStrictEqual(
          violations.map((violation) => [violation.scene, violation.rule]),
          [[2, "forbidden-element"]],
        );
        assert.isFalse(channelFileExists(channelRoot, compositionKey));
      }),
    ),
  );

  it.effect(
    "judges the diagrams by the phrases of the timing table, not by what the script said when they were written",
    () =>
      prepared("nyaucast-composition-shape-", {}, (channelRoot) =>
        Effect.gen(function* () {
          // 2.3 はシーン 1 でだけ正しい。シーン 2 の図解のファイルを手で差し替えると、タイミング表の形で止まる。
          writeFileSync(join(channelRoot, diagramKey(2)), '<div data-beat="2.3"></div>');

          const violations = yield* violationsOfAssemble;

          assert.deepStrictEqual(
            violations.map((violation) => [violation.scene, violation.rule]),
            [[2, "position-out-of-range"]],
          );
        }),
      ),
  );
});

describe("explainer.assembleComposition: preconditions", () => {
  it.effect("fails with ProduceGateNotApproved before the produce gate is approved", () =>
    prepared("nyaucast-composition-unapproved-", { unapproved: true }, (channelRoot) =>
      Effect.gen(function* () {
        const failure = yield* Effect.flip(assemble());

        assert.strictEqual(failure._tag, "ProduceGateNotApproved");
        assert.isFalse(channelFileExists(channelRoot, compositionKey));
      }),
    ),
  );

  it.effect("fails with VideoNotFound for an unknown video", () =>
    prepared("nyaucast-composition-unknown-video-", {}, () =>
      Effect.gen(function* () {
        const failure = yield* Effect.flip(
          callTool("explainer_assemble_composition", { videoId: "nope" }),
        );

        assert.strictEqual(failure._tag, "VideoNotFound");
      }),
    ),
  );

  it.effect("fails with TimingTableNotFound before the narration is synthesized", () =>
    prepared("nyaucast-composition-no-timing-", { withoutNarration: true }, (channelRoot) =>
      Effect.gen(function* () {
        const failure = yield* Effect.flip(assemble());

        assert.strictEqual(failure._tag, "TimingTableNotFound");
        assert.strictEqual(failureFacts(failure)["videoId"], "V1");
        assert.isFalse(channelFileExists(channelRoot, compositionKey));
      }),
    ),
  );

  it.effect(
    "fails with InvalidTimingTable for a timing table that is not of the form it is written in",
    () =>
      prepared("nyaucast-composition-bad-timing-", {}, (channelRoot) =>
        Effect.gen(function* () {
          writeFileSync(join(channelRoot, timingKey), JSON.stringify({ paragraphs: "none" }));

          const failure = yield* Effect.flip(assemble());

          assert.strictEqual(failure._tag, "InvalidTimingTable");
          assert.strictEqual(failureFacts(failure)["videoId"], "V1");
          assert.isFalse(channelFileExists(channelRoot, compositionKey));
        }),
      ),
  );
});

describe("explainer.assembleComposition: the same inputs give the existing composition back", () => {
  it.effect("returns the existing composition on the second call, without writing it again", () =>
    prepared("nyaucast-composition-fresh-", {}, (channelRoot) =>
      Effect.gen(function* () {
        const first = yield* assemble();
        // ファイルに印を書き足す。書き直されれば消える。
        appendFileSync(join(channelRoot, compositionKey), "\n<!-- written by hand -->");

        const second = yield* assemble();

        assert.strictEqual(first.assembled, true);
        assert.strictEqual(second.assembled, false);
        assert.strictEqual(second.hash, first.hash);
        assert.strictEqual(second.key, first.key);
        assert.include(readComposition(channelRoot), "<!-- written by hand -->");
      }),
    ),
  );

  it.effect("builds the same bytes from the same inputs every time (force twice)", () =>
    prepared("nyaucast-composition-deterministic-", {}, (channelRoot) =>
      Effect.gen(function* () {
        yield* assemble({ force: true });
        const first = readFileSync(join(channelRoot, compositionKey));

        const second = yield* assemble({ force: true });

        assert.strictEqual(second.assembled, true);
        assert.isTrue(first.equals(readFileSync(join(channelRoot, compositionKey))));
      }),
    ),
  );

  it.effect("builds it again with force, even when nothing changed", () =>
    prepared("nyaucast-composition-force-", {}, (channelRoot) =>
      Effect.gen(function* () {
        const first = yield* assemble();
        appendFileSync(join(channelRoot, compositionKey), "\n<!-- written by hand -->");

        const forced = yield* assemble({ force: true });

        assert.strictEqual(forced.assembled, true);
        assert.strictEqual(forced.hash, first.hash);
        assert.notInclude(readComposition(channelRoot), "<!-- written by hand -->");
      }),
    ),
  );

  it.effect("builds it again when a diagram changes", () =>
    prepared("nyaucast-composition-change-diagram-", {}, (channelRoot) =>
      Effect.gen(function* () {
        const first = yield* assemble();
        yield* callTool("explainer_write_diagram", {
          html: '<div><p data-beat="1">差し替え</p></div>',
          scene: 2,
          videoId: "V1",
        });

        const second = yield* assemble();

        assert.strictEqual(second.assembled, true);
        assert.notStrictEqual(second.hash, first.hash);
        assert.include(readComposition(channelRoot), "差し替え");
        assert.include(readComposition(channelRoot), compositionHashMeta(second.hash));
      }),
    ),
  );

  it.effect("builds it again when the timing table changes", () =>
    prepared("nyaucast-composition-change-timing-", {}, (channelRoot) =>
      Effect.gen(function* () {
        const first = yield* assemble();
        const before = pageOf(channelRoot).hf.duration;
        const timing = readTimingFile(channelRoot);
        writeFileSync(
          join(channelRoot, timingKey),
          JSON.stringify({ ...timing, durationSeconds: timing.durationSeconds + 1 }),
        );

        const second = yield* assemble();

        assert.strictEqual(second.assembled, true);
        assert.notStrictEqual(second.hash, first.hash);
        near(pageOf(channelRoot).hf.duration, before + 1, grid);
      }),
    ),
  );

  it.effect("builds it again when a token of the theme changes", () =>
    prepared("nyaucast-composition-change-theme-", {}, (channelRoot) =>
      Effect.gen(function* () {
        const first = yield* assemble();
        writeVideoConfig(
          channelRoot,
          explainerConfigWithTheme(themeDeclaration({ colors: { accent: "#00aa55" } })),
        );

        const second = yield* assemble();

        assert.strictEqual(second.assembled, true);
        assert.notStrictEqual(second.hash, first.hash);
        assert.include(readComposition(channelRoot), "#00aa55");
      }),
    ),
  );

  it.effect("builds it again when the bytes of a font file change", () =>
    prepared("nyaucast-composition-change-font-", {}, (channelRoot) =>
      Effect.gen(function* () {
        const first = yield* assemble();
        writeChannelFile(channelRoot, bodyFontPath, fontBytes(9));

        const second = yield* assemble();

        assert.strictEqual(second.assembled, true);
        assert.notStrictEqual(second.hash, first.hash);
        assert.include(readComposition(channelRoot), bodyBase64(fontBytes(9)));
      }),
    ),
  );

  it.effect("adds no row to the local store, whether it builds or returns the existing one", () =>
    prepared("nyaucast-composition-no-rows-", {}, () =>
      Effect.gen(function* () {
        const before = yield* tableRowCounts;

        yield* assemble();
        yield* assemble();
        yield* assemble({ force: true });

        assert.deepStrictEqual(yield* tableRowCounts, before);
      }),
    ),
  );
});
