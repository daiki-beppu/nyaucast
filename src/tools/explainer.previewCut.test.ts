import { createServer } from "node:http";

import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";

import {
  accepts,
  failureFacts,
  publishedAdditionalProperties,
  setClock,
} from "../../test/helpers.ts";
import { explainerConfig } from "../../test/explainer-helpers.ts";
import { recordPlan, rejectProduce, tableRowCounts } from "../../test/narration-helpers.ts";
import {
  centerPixel,
  colorByCallCount,
  compositionHtml,
  endColors,
  exportRows,
  inVideo,
  midColors,
  previewKey,
  previewRows,
  rgbOf,
  slow,
  twoSegments,
  writeComposition,
  writeTrack,
} from "../../test/render-helpers.ts";
import { channelFileExists, readChannelFile } from "../../test/thumbnail-helpers.ts";
import { callTool, rejectionReason, withToolChannel } from "../../test/tool-helpers.ts";
import { ExplainerPreviewCutTool } from "./explainer.previewCut.ts";

// 契約（この issue の計画 D1・D5・D6・D8〜D11）:
//   tool 名 explainer_preview_cut、パラメータ { videoId, force? }（長尺の `long` 固定）。
//   成功値 { cut: "long", compositionHash, frames: [{ key, segment }], previewed, videoId }（segment は 1 始まり）。
//   frames[i] は segment i+1 の終わる直前のフレームの PNG。キーは videos/<id>/cuts/long/previews/<compositionHash>/<segment>.png。
//   事実 explainer_cut_previews の行は、実際に撮ったときだけ積む。音声トラックは要らない。

const noon = "2026-10-04T12:00:00.000Z";

const preview = (extra: { force?: boolean; videoId?: string } = {}) =>
  callTool("explainer_preview_cut", { videoId: "V1", ...extra });

const withComposition = <A, E, R>(
  prefix: string,
  use: (channelRoot: string) => Effect.Effect<A, E, R>,
  html = compositionHtml(),
) =>
  inVideo(prefix, (channelRoot) => {
    writeComposition(channelRoot, html);
    return setClock(noon).pipe(Effect.andThen(use(channelRoot)));
  });

const firstKey = (result: { readonly frames: readonly { readonly key: string }[] }) =>
  result.frames[0]?.key ?? "";

const closeTo = (actual: readonly number[], expected: readonly number[]) => {
  assert.strictEqual(actual.length, expected.length);
  expected.forEach((value, index) => assert.closeTo(actual[index] ?? Number.NaN, value, 12));
};

// 3 segment（[0, 0.4) [0.4, 0.7) [0.7, 1)）。終わる直前の色は区間ごとに違う。
const threeSegments = [
  { duration: 0.4, start: 0, static: false },
  { duration: 0.3, start: 0.4, static: false },
  { duration: 0.3, start: 0.7, static: false },
];
const threeSegmentBody = `
  const ends = [0.4, 0.7, 1];
  const index = t < ends[0] ? 0 : t < ends[1] ? 1 : 2;
  const nearEnd = t >= ends[index] - 0.05;
  const colors = ["rgb(255,0,0)", "rgb(0,255,0)", "rgb(0,0,255)"];
  document.body.style.background = nearEnd ? colors[index] : "rgb(10,10,10)";
`;

describe("explainer.previewCut: parameters", () => {
  it("is named with its wire name", () => {
    assert.strictEqual(ExplainerPreviewCutTool.name, "explainer_preview_cut");
  });

  it("accepts a video and an optional force, and rejects every other key", () => {
    const schema = ExplainerPreviewCutTool.parametersSchema;

    assert.isTrue(accepts(schema, { videoId: "V1" }));
    assert.isTrue(accepts(schema, { force: false, videoId: "V1" }));
    assert.isFalse(accepts(schema, {}));
    assert.isFalse(accepts(schema, { videoId: "V1", force: 1 }));
    assert.isFalse(accepts(schema, { cut: "long", videoId: "V1" }));
    assert.strictEqual(publishedAdditionalProperties(ExplainerPreviewCutTool), false);
  });

  it("accepts the result and rejects action fields in it", () => {
    const result = {
      compositionHash: "a".repeat(64),
      cut: "long",
      frames: [{ key: previewKey("a".repeat(64), 1), segment: 1 }],
      previewed: true,
      videoId: "V1",
    };

    assert.isTrue(accepts(ExplainerPreviewCutTool.successSchema, result));
    assert.isFalse(accepts(ExplainerPreviewCutTool.successSchema, { ...result, next: "render" }));
    assert.isFalse(
      accepts(ExplainerPreviewCutTool.successSchema, {
        ...result,
        frames: [{ ...result.frames[0], next: "x" }],
      }),
    );
  });

  it("describes what it does and the failure tags without telling the agent what to do next", () => {
    const { description } = ExplainerPreviewCutTool;

    for (const tag of ["CompositionNotFound", "InvalidComposition"]) {
      assert.include(description, tag);
    }
    assert.notMatch(description, /\b(next|then run|you should|please)\b/iu);
  });
});

describe("explainer.previewCut: a real preview", () => {
  it.effect(
    "takes one frame per segment, from just before the segment ends, and records one preview",
    () =>
      withComposition("nyaucast-preview-real-", (channelRoot) =>
        Effect.gen(function* () {
          const result = yield* preview();

          assert.strictEqual(result.previewed, true);
          assert.strictEqual(result.cut, "long");
          assert.strictEqual(result.frames.length, twoSegments.length);
          assert.deepStrictEqual(
            result.frames.map((frame) => frame.segment),
            [1, 2],
          );
          for (const [index, frame] of result.frames.entries()) {
            assert.strictEqual(frame.key, previewKey(result.compositionHash, index + 1));
            const pixel = yield* Effect.promise(() =>
              centerPixel(readChannelFile(channelRoot, frame.key)),
            );
            // 終わる直前の色であって、中ほどの色ではない
            closeTo(pixel, rgbOf(endColors[index] ?? ""));
            assert.notDeepEqual([...pixel], rgbOf(midColors[index] ?? ""));
          }
          assert.deepStrictEqual(yield* previewRows, [
            {
              composition_hash: result.compositionHash,
              created_at: noon,
              cut: "long",
              video_id: "V1",
            },
          ]);
        }),
      ),
    slow,
  );

  it.effect(
    "takes as many frames as there are segments, whatever their number",
    () =>
      withComposition(
        "nyaucast-preview-three-",
        (channelRoot) =>
          Effect.gen(function* () {
            const result = yield* preview();

            assert.strictEqual(result.frames.length, 3);
            const pixels = yield* Effect.promise(() =>
              Promise.all(
                result.frames.map((frame) => centerPixel(readChannelFile(channelRoot, frame.key))),
              ),
            );
            closeTo(pixels[0] ?? [], [255, 0, 0]);
            closeTo(pixels[1] ?? [], [0, 255, 0]);
            closeTo(pixels[2] ?? [], [0, 0, 255]);
          }),
        compositionHtml({ seekBody: threeSegmentBody, segments: threeSegments }),
      ),
    slow,
  );

  it.effect(
    "needs no audio track and renders no mp4, adding only a preview row",
    () =>
      withComposition("nyaucast-preview-only-", () =>
        Effect.gen(function* () {
          const before = yield* tableRowCounts;

          yield* preview();

          const after = yield* tableRowCounts;
          assert.deepStrictEqual(
            Object.keys(after).filter((table) => after[table] !== before[table]),
            ["explainer_cut_previews"],
          );
          assert.deepStrictEqual(yield* exportRows, []);
        }),
      ),
    slow,
  );
});

describe("explainer.previewCut: idempotence and force", () => {
  it.effect(
    "returns the existing preview for the same composition and adds no row",
    () =>
      withComposition("nyaucast-preview-again-", () =>
        Effect.gen(function* () {
          const first = yield* preview();

          const second = yield* preview();

          assert.strictEqual(second.previewed, false);
          assert.deepStrictEqual(second.frames, first.frames);
          assert.strictEqual(second.compositionHash, first.compositionHash);
          assert.strictEqual((yield* previewRows).length, 1);
        }),
      ),
    slow,
  );

  it.effect(
    "takes the frames again with force: one more row, later than the first",
    () =>
      withComposition("nyaucast-preview-force-", (channelRoot) =>
        Effect.gen(function* () {
          const first = yield* preview();
          const fs = yield* Effect.promise(() => import("node:fs"));
          // 古い PNG を目印の内容に替えておき、撮り直しで置き換わることを確かめる
          fs.writeFileSync(`${channelRoot}/${firstKey(first)}`, "stale");

          const forced = yield* preview({ force: true });

          assert.strictEqual(forced.previewed, true);
          const pixel = yield* Effect.promise(() =>
            centerPixel(readChannelFile(channelRoot, firstKey(forced))),
          );
          assert.isAbove(pixel[1], 200);
          const rows = yield* previewRows;
          assert.strictEqual(rows.length, 2);
          assert.isTrue((rows[1]?.created_at ?? "") > (rows[0]?.created_at ?? ""));
        }),
      ),
    slow,
  );

  it.effect(
    "takes the frames again when the composition changes, and keeps the old composition's frames apart",
    () =>
      withComposition("nyaucast-preview-changed-", (channelRoot) =>
        Effect.gen(function* () {
          const first = yield* preview();
          const firstBytes = readChannelFile(channelRoot, first.frames[0]?.key ?? "");
          writeComposition(
            channelRoot,
            compositionHtml({ seekBody: threeSegmentBody, segments: threeSegments }),
          );

          const second = yield* preview();

          assert.strictEqual(second.previewed, true);
          assert.notStrictEqual(second.compositionHash, first.compositionHash);
          // 別の composition の frames は別の場所に書かれ、前の 2 枚は変わらない
          assert.strictEqual(second.frames.length, 3);
          assert.isTrue(second.frames.every((frame) => frame.key.includes(second.compositionHash)));
          assert.isTrue(
            Buffer.from(readChannelFile(channelRoot, first.frames[0]?.key ?? "")).equals(
              firstBytes,
            ),
          );
          assert.strictEqual((yield* previewRows).length, 2);
        }),
      ),
    slow,
  );

  it.effect(
    "does not mix an earlier composition's third frame into a two-segment preview",
    () =>
      withComposition(
        "nyaucast-preview-fewer-",
        (channelRoot) =>
          Effect.gen(function* () {
            const three = yield* preview();
            writeComposition(channelRoot, compositionHtml());

            const two = yield* preview();

            assert.strictEqual(three.frames.length, 3);
            assert.strictEqual(two.frames.length, 2);
            assert.isFalse(two.frames.some((frame) => frame.key === three.frames[2]?.key));
          }),
        compositionHtml({ seekBody: threeSegmentBody, segments: threeSegments }),
      ),
    slow,
  );

  it.effect(
    "takes the frames again when a frame file is gone, so the row is never left pointing at nothing",
    () =>
      withComposition("nyaucast-preview-missing-file-", (channelRoot) =>
        Effect.gen(function* () {
          const first = yield* preview();
          const { rmSync } = yield* Effect.promise(() => import("node:fs"));
          rmSync(`${channelRoot}/${first.frames[1]?.key ?? ""}`);

          const again = yield* preview();

          assert.strictEqual(again.previewed, true);
          assert.isTrue(channelFileExists(channelRoot, first.frames[1]?.key ?? ""));
        }),
      ),
    slow,
  );

  it.effect(
    "returns the existing preview without reading the frame files: a frame that cannot be read is still reused",
    () =>
      withComposition("nyaucast-preview-unreadable-", (channelRoot) =>
        Effect.gen(function* () {
          const first = yield* preview();
          const fs = yield* Effect.promise(() => import("node:fs"));
          const file = `${channelRoot}/${first.frames[0]?.key ?? ""}`;
          // root は権限を無視して読めるので、このテストの前提が崩れる。黙って通さず失敗させる
          assert.notStrictEqual(process.getuid?.(), 0);
          fs.chmodSync(file, 0o000);

          const again = yield* preview().pipe(
            Effect.ensuring(Effect.sync(() => fs.chmodSync(file, 0o644))),
          );

          assert.strictEqual(again.previewed, false);
          assert.strictEqual((yield* previewRows).length, 1);
        }),
      ),
    slow,
  );

  it.effect(
    "does not depend on the audio track: changing it leaves the preview as it is",
    () =>
      withComposition("nyaucast-preview-track-", (channelRoot) =>
        Effect.gen(function* () {
          yield* preview();
          writeTrack(channelRoot);

          const again = yield* preview();

          assert.strictEqual(again.previewed, false);
          assert.strictEqual((yield* previewRows).length, 1);
        }),
      ),
    slow,
  );
});

describe("explainer.previewCut: composition contract checks", () => {
  const invalid = (prefix: string, html: string) =>
    withComposition(
      prefix,
      () =>
        Effect.gen(function* () {
          const failure = yield* Effect.flip(preview());

          assert.strictEqual(failure._tag, "InvalidComposition");
          assert.deepStrictEqual(yield* previewRows, []);
          return failureFacts(failure)["violations"] as readonly string[];
        }),
      html,
    );

  it.effect(
    "fails with InvalidComposition listing segments-gap, and adds no row",
    () =>
      invalid(
        "nyaucast-preview-gap-",
        compositionHtml({
          segments: [
            { duration: 0.4, start: 0 },
            { duration: 0.5, start: 0.5 },
          ],
        }),
      ).pipe(Effect.map((violations) => assert.include(violations, "segments-gap"))),
    slow,
  );

  it.effect(
    "fails with InvalidComposition listing segments-end when the segments stop before the duration",
    () =>
      invalid(
        "nyaucast-preview-end-",
        compositionHtml({ segments: [{ duration: 0.5, start: 0 }] }),
      ).pipe(Effect.map((violations) => assert.include(violations, "segments-end"))),
    slow,
  );

  it.effect(
    "fails with InvalidComposition listing segments-duration when a segment has no positive length inside the timeline",
    () =>
      invalid(
        "nyaucast-preview-duration-",
        compositionHtml({
          segments: [
            { duration: 2, start: 0 },
            { duration: -1, start: 2 },
          ],
        }),
      ).pipe(Effect.map((violations) => assert.include(violations, "segments-duration"))),
    slow,
  );

  it.effect(
    "fails with InvalidComposition listing segments-start when the first segment does not start at 0",
    () =>
      invalid(
        "nyaucast-preview-start-",
        compositionHtml({ segments: [{ duration: 0.5, start: 0.5 }] }),
      ).pipe(Effect.map((violations) => assert.include(violations, "segments-start"))),
    slow,
  );

  it.effect(
    "fails with InvalidComposition listing hf-missing when the page defines no window.__hf",
    () =>
      invalid("nyaucast-preview-no-hf-", "<!doctype html><html><body>nothing</body></html>").pipe(
        Effect.map((violations) => assert.include(violations, "hf-missing")),
      ),
    slow,
  );

  it.effect.each(["duration", "fps", "height", "segments", "width"] as const)(
    "fails with InvalidComposition listing %s when the page does not declare it",
    (key) =>
      invalid(`nyaucast-preview-omit-${key}-`, compositionHtml({ omit: [key] })).pipe(
        Effect.map((violations) => assert.include(violations, key)),
      ),
    slow,
  );

  it.effect(
    "does not check seek determinism: a seek that depends on the call count still previews",
    () =>
      withComposition(
        "nyaucast-preview-nondeterministic-",
        () =>
          Effect.gen(function* () {
            const result = yield* preview();

            assert.strictEqual(result.frames.length, twoSegments.length);
          }),
        compositionHtml({ seekBody: colorByCallCount }),
      ),
    slow,
  );
});

describe("explainer.previewCut: preconditions", () => {
  it.effect("rejects an unknown key at the tool boundary and writes nothing", () =>
    withComposition("nyaucast-preview-unknown-key-", () =>
      Effect.gen(function* () {
        assert.strictEqual(
          yield* rejectionReason("explainer_preview_cut", { cut: "long", videoId: "V1" } as never),
          "ToolParameterValidationError",
        );
        assert.deepStrictEqual(yield* previewRows, []);
      }),
    ),
  );

  it.effect("fails with CompositionNotFound when there is no composition, without a row", () =>
    inVideo("nyaucast-preview-no-composition-", () =>
      Effect.gen(function* () {
        const failure = yield* Effect.flip(preview());

        assert.strictEqual(failure._tag, "CompositionNotFound");
        assert.strictEqual(failureFacts(failure)["videoId"], "V1");
        assert.deepStrictEqual(yield* previewRows, []);
      }),
    ),
  );

  it.effect("fails with VideoNotFound for an unknown video", () =>
    inVideo("nyaucast-preview-unknown-video-", () =>
      Effect.gen(function* () {
        const failure = yield* Effect.flip(preview({ videoId: "nope" }));

        assert.strictEqual(failure._tag, "VideoNotFound");
      }),
    ),
  );

  it.effect("fails with ProduceGateNotApproved before the produce gate is approved", () =>
    withToolChannel("nyaucast-preview-unapproved-", { config: explainerConfig }, (channelRoot) =>
      Effect.gen(function* () {
        yield* recordPlan();
        writeComposition(channelRoot, compositionHtml());

        const failure = yield* Effect.flip(preview());

        assert.strictEqual(failure._tag, "ProduceGateNotApproved");
        assert.deepStrictEqual(yield* previewRows, []);
      }),
    ),
  );

  it.effect("fails with ProduceGateNotApproved after a NO-GO", () =>
    withComposition("nyaucast-preview-rejected-", () =>
      Effect.gen(function* () {
        yield* rejectProduce();

        const failure = yield* Effect.flip(preview());

        assert.strictEqual(failure._tag, "ProduceGateNotApproved");
      }),
    ),
  );

  it.effect("fails with NotExplainerChannel on a collection channel", () =>
    withToolChannel(
      "nyaucast-preview-collection-",
      { config: JSON.stringify({ kind: "collection" }) },
      () =>
        Effect.gen(function* () {
          const failure = yield* Effect.flip(preview());

          assert.strictEqual(failure._tag, "NotExplainerChannel");
        }),
    ),
  );
});

// 外部への要求が届いたかを数える、ループバックの HTTP サーバー。スコープが終わると閉じる。
const countingServer = Effect.acquireRelease(
  Effect.promise(
    () =>
      new Promise<{ readonly close: () => void; readonly hits: string[]; readonly port: number }>(
        (resolve) => {
          const hits: string[] = [];
          const server = createServer((request, response) => {
            hits.push(request.url ?? "");
            response.end();
          });
          server.listen(0, "127.0.0.1", () => {
            const address = server.address();
            const port = typeof address === "object" && address !== null ? address.port : 0;
            resolve({ close: () => server.close(), hits, port });
          });
        },
      ),
  ),
  (server) => Effect.sync(server.close),
);

describe("explainer.previewCut: the network while drawing", () => {
  it.effect(
    "sends no request outside the composition file, from an element or from a script",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const server = yield* countingServer;
          const origin = `http://127.0.0.1:${server.port}`;
          const html = compositionHtml({
            seekBody: `fetch("${origin}/fetch").catch(() => {}); document.body.style.background = "rgb(0,0,0)";`,
          }).replace("<body>", `<body><img src="${origin}/img.png">`);

          yield* withComposition(
            "nyaucast-preview-network-",
            () =>
              Effect.gen(function* () {
                const result = yield* preview();

                assert.strictEqual(result.previewed, true);
                assert.deepStrictEqual(server.hits, []);
              }),
            html,
          );
        }),
      ),
    slow,
  );
});
