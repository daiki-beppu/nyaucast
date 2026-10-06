import { join } from "node:path";

import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { ALL_FORMATS, BufferSource, Input, VideoSampleSink } from "mediabunny";
import { decodeStereo } from "../../audio/media.ts";
import { tonePower } from "../../../test/bgm-helpers.ts";

import {
  accepts,
  failureFacts,
  publishedAdditionalProperties,
  setClock,
} from "../../../test/helpers.ts";
import {
  recordPlan,
  rejectProduce,
  scriptInput,
  tableRowCounts,
} from "../../../test/narration-helpers.ts";
import { scriptScenes } from "../../../test/composition-helpers.ts";
import {
  clipCut,
  cutAudioKey,
  cutCompositionKey,
  dedicatedCut,
  shortCutExportKey,
  stampShortVersion,
  versionRows,
  withdrawShort,
  writeShort,
} from "../../../test/short-helpers.ts";
import {
  colorByCallCount,
  compositionHtml,
  cutDirectory,
  cutExportKey,
  exportRows,
  inVideo,
  slow,
  audioTrackKey,
  startPeakBufferGrowth,
  trackWav,
  twoSegments,
  writeComposition,
  writeTrack,
} from "../../../test/render-helpers.ts";
import {
  channelFileExists,
  readChannelFile,
  writeChannelFile,
} from "../../../test/thumbnail-helpers.ts";
import { callTool, rejectionReason, withToolChannel } from "../../../test/tool-helpers.ts";
import { explainerConfig } from "../../../test/explainer-helpers.ts";
import { VideoFiles } from "../../videos/video-files.ts";
import { ExplainerVideoRenderCutTool } from "./video.renderCut.ts";

// 契約（この issue の計画 D1・D3〜D9）:
//   tool 名 video_render_cut、パラメータ { videoId, cut?, force? }（cut は "long" か "short-<n>-clip" / "short-<n>-dedicated"。省略は "long"）。
//   成功値 { cut: "long", compositionHash, key, renderHash, rendered, videoId }。
//   成果物は videos/<id>/cuts/long/long.mp4。事実 explainer_cut_exports の行は、実際に作ったときだけ積む。
//   失敗のタグ: CompositionNotFound / AudioTrackNotFound / InvalidComposition{violations} / NondeterministicComposition{seconds} /
//   VideoNotFound / ProduceGateNotApproved（Chrome を使わずに決まる失敗は Chrome を起動しない）。

const noon = "2026-10-04T12:00:00.000Z";

const render = (extra: { force?: boolean; videoId?: string } = {}) =>
  callTool("video_render_cut", { videoId: "V1", ...extra });

// 合成した composition（320x180・1 秒・2 segment）と音声トラック（1 秒）を置いた動画 V1。
const withInputs = <A, E, R>(
  prefix: string,
  use: (channelRoot: string) => Effect.Effect<A, E, R>,
  html = compositionHtml(),
  videoFiles?: Parameters<typeof inVideo>[2],
) =>
  inVideo(
    prefix,
    (channelRoot) => {
      writeComposition(channelRoot, html);
      writeTrack(channelRoot);
      return setClock(noon).pipe(Effect.andThen(use(channelRoot)));
    },
    videoFiles,
  );

const readMp4 = async (channelRoot: string, key = cutExportKey) => {
  const input = new Input({
    formats: ALL_FORMATS,
    source: new BufferSource(readChannelFile(channelRoot, key)),
  });
  const video = await input.getPrimaryVideoTrack();
  const audio = await input.getPrimaryAudioTrack();
  return {
    audio,
    duration: await input.computeDuration(),
    video,
  };
};

const codecsOf = async (channelRoot: string) => {
  const mp4 = await readMp4(channelRoot);
  return [mp4.video?.codec, mp4.audio?.codec];
};

describe.concurrent("video.renderCut: parameters", () => {
  it("is named with its wire name", () => {
    assert.strictEqual(ExplainerVideoRenderCutTool.name, "video_render_cut");
  });

  it("accepts a video and an optional force, and rejects every other key", () => {
    const schema = ExplainerVideoRenderCutTool.parametersSchema;

    assert.isTrue(accepts(schema, { videoId: "V1" }));
    assert.isTrue(accepts(schema, { force: true, videoId: "V1" }));
    assert.isFalse(accepts(schema, {}));
    assert.isFalse(accepts(schema, { videoId: "V1", force: "yes" }));
    assert.isFalse(accepts(schema, { next: "publish", videoId: "V1" }));
    assert.strictEqual(publishedAdditionalProperties(ExplainerVideoRenderCutTool), false);
  });

  it("accepts the result and rejects action fields in it", () => {
    const result = {
      compositionHash: "a".repeat(64),
      cut: "long",
      key: cutExportKey,
      renderHash: "b".repeat(64),
      rendered: true,
      videoId: "V1",
    };

    assert.isTrue(accepts(ExplainerVideoRenderCutTool.successSchema, result));
    assert.isFalse(
      accepts(ExplainerVideoRenderCutTool.successSchema, { ...result, next: "preview" }),
    );
    assert.isFalse(
      accepts(ExplainerVideoRenderCutTool.successSchema, { ...result, rendered: "yes" }),
    );
  });

  it("describes what it does and the failure tags without telling the agent what to do next", () => {
    const { description } = ExplainerVideoRenderCutTool;

    for (const tag of [
      "CompositionNotFound",
      "AudioTrackNotFound",
      "InvalidComposition",
      "NondeterministicComposition",
    ]) {
      assert.include(description, tag);
    }
    assert.notMatch(description, /\b(next|then run|you should|please)\b/iu);
  });
});

describe.concurrent("video.renderCut: a real render", () => {
  it.effect(
    "writes an mp4 with an H.264 video and an AAC audio track of the composition's size and length, and records one export",
    () =>
      withInputs("nyaucast-render-real-", (channelRoot) =>
        Effect.gen(function* () {
          const result = yield* render();

          assert.strictEqual(result.rendered, true);
          assert.strictEqual(result.cut, "long");
          assert.strictEqual(result.videoId, "V1");
          assert.strictEqual(result.key, cutExportKey);
          assert.isTrue(channelFileExists(channelRoot, cutExportKey));
          const mp4 = yield* Effect.promise(() => readMp4(channelRoot));
          assert.strictEqual(mp4.video?.codec, "avc");
          assert.strictEqual(mp4.audio?.codec, "aac");
          assert.strictEqual(mp4.video?.displayWidth, 320);
          assert.strictEqual(mp4.video?.displayHeight, 180);
          assert.closeTo(mp4.duration, 1, 0.1);
          const frames = yield* Effect.promise(
            async () => (await mp4.video?.computePacketStats())?.packetCount,
          );
          assert.strictEqual(frames, 30);
        }),
      ),
    slow,
  );

  it.effect(
    "records the cut, the relative key, the composition hash, the render hash and the creation time",
    () =>
      withInputs("nyaucast-render-row-", () =>
        Effect.gen(function* () {
          const result = yield* render();

          const rows = yield* exportRows;
          assert.deepStrictEqual(rows, [
            {
              composition_hash: result.compositionHash,
              created_at: noon,
              cut: "long",
              key: cutExportKey,
              render_hash: result.renderHash,
              video_id: "V1",
            },
          ]);
          assert.match(result.compositionHash, /^[0-9a-f]{64}$/u);
          assert.match(result.renderHash, /^[0-9a-f]{64}$/u);
          assert.notStrictEqual(result.renderHash, result.compositionHash);
        }),
      ),
    slow,
  );

  it.effect(
    "keeps every artifact under the cut's directory",
    () =>
      withInputs("nyaucast-render-location-", (channelRoot) =>
        Effect.gen(function* () {
          const result = yield* render();

          assert.isTrue(result.key.startsWith(`${cutDirectory}/`));
          assert.isTrue(channelFileExists(channelRoot, join(cutDirectory, "long.mp4")));
        }),
      ),
    slow,
  );
});

// 復号した内容を確かめる: 映像は時刻ごとの色（前半は赤系、後半は青系）、音声は 440 Hz の音が残っている。
describe.concurrent("video.renderCut: the encoded content", () => {
  const centerOf = async (channelRoot: string, seconds: number) => {
    const input = new Input({
      formats: ALL_FORMATS,
      source: new BufferSource(readChannelFile(channelRoot, cutExportKey)),
    });
    const track = await input.getPrimaryVideoTrack();
    const sample = await new VideoSampleSink(track as NonNullable<typeof track>).getSample(seconds);
    const frame = sample as NonNullable<typeof sample>;
    const width = frame.displayWidth;
    const buffer = new Uint8Array(frame.allocationSize({ format: "RGBA" }));
    await frame.copyTo(buffer, { format: "RGBA" });
    const offset = (Math.floor(frame.displayHeight / 2) * width + Math.floor(width / 2)) * 4;
    frame.close();
    return [buffer[offset] ?? -1, buffer[offset + 1] ?? -1, buffer[offset + 2] ?? -1];
  };

  it.effect(
    "carries each time's picture and the audio track into the mp4",
    () =>
      withInputs("nyaucast-render-content-", (channelRoot) =>
        Effect.gen(function* () {
          yield* render();

          const early = yield* Effect.promise(() => centerOf(channelRoot, 0.1));
          const late = yield* Effect.promise(() => centerOf(channelRoot, 0.75));
          // 前半の中ほどは赤、後半の中ほどは青（H.264 の色の誤差を許す）
          assert.isAbove(early[0] ?? 0, 200);
          assert.isBelow(early[2] ?? 255, 60);
          assert.isAbove(late[2] ?? 0, 200);
          assert.isBelow(late[0] ?? 255, 60);
          const audio = yield* decodeStereo(readChannelFile(channelRoot, cutExportKey));
          // 無音ではなく、入力の 440 Hz の音が、別の周波数よりはるかに強く残っている
          assert.isAbove(tonePower(audio[0], 440), 0.001);
          assert.isAbove(tonePower(audio[0], 440), tonePower(audio[0], 3000) * 100);
        }),
      ),
    slow,
  );
});

describe.concurrent("video.renderCut: idempotence and force", () => {
  it.effect(
    "returns the existing export for the same input and adds no row",
    () =>
      withInputs("nyaucast-render-again-", (channelRoot) =>
        Effect.gen(function* () {
          const first = yield* render();
          const bytes = readChannelFile(channelRoot, cutExportKey);

          const second = yield* render();

          assert.strictEqual(second.rendered, false);
          assert.strictEqual(second.key, first.key);
          assert.strictEqual(second.renderHash, first.renderHash);
          assert.strictEqual(second.compositionHash, first.compositionHash);
          assert.strictEqual((yield* exportRows).length, 1);
          assert.isTrue(Buffer.from(readChannelFile(channelRoot, cutExportKey)).equals(bytes));
        }),
      ),
    slow,
  );

  it.effect(
    "builds again with force: one more row, later than the first, and the same keys",
    () =>
      withInputs("nyaucast-render-force-", (channelRoot) =>
        Effect.gen(function* () {
          const first = yield* render();
          const fs = yield* Effect.promise(() => import("node:fs"));
          // 古い成果物を目印の内容に替えておき、作り直しで置き換わることを確かめる
          fs.writeFileSync(join(channelRoot, cutExportKey), "stale");

          const forced = yield* render({ force: true });

          assert.strictEqual(forced.rendered, true);
          assert.deepStrictEqual(yield* Effect.promise(() => codecsOf(channelRoot)), [
            "avc",
            "aac",
          ]);
          assert.strictEqual(forced.renderHash, first.renderHash);
          const rows = yield* exportRows;
          assert.strictEqual(rows.length, 2);
          // 時計が動いていなくても、後の行の時刻は前の行より後になる
          assert.isTrue((rows[1]?.created_at ?? "") > (rows[0]?.created_at ?? ""));
        }),
      ),
    slow,
  );

  it.effect(
    "returns the existing export without reading the file: an export that cannot be read is still reused",
    () =>
      withInputs("nyaucast-render-unreadable-", (channelRoot) =>
        Effect.gen(function* () {
          yield* render();
          const fs = yield* Effect.promise(() => import("node:fs"));
          const file = join(channelRoot, cutExportKey);
          // root は権限を無視して読めるので、このテストの前提が崩れる。黙って通さず失敗させる
          assert.notStrictEqual(process.getuid?.(), 0);
          fs.chmodSync(file, 0o000);

          const again = yield* render().pipe(
            Effect.ensuring(Effect.sync(() => fs.chmodSync(file, 0o644))),
          );

          assert.strictEqual(again.rendered, false);
          assert.strictEqual((yield* exportRows).length, 1);
        }),
      ),
    slow,
  );

  it.effect(
    "builds again when only the audio track changes, with a different render hash and the same composition hash",
    () =>
      withInputs("nyaucast-render-track-", (channelRoot) =>
        Effect.gen(function* () {
          const first = yield* render();
          writeTrack(channelRoot, trackWav(1, 880));

          const second = yield* render();

          assert.strictEqual(second.rendered, true);
          assert.strictEqual(second.compositionHash, first.compositionHash);
          assert.notStrictEqual(second.renderHash, first.renderHash);
          assert.strictEqual((yield* exportRows).length, 2);
        }),
      ),
    slow,
  );

  it.effect(
    "builds again when only the composition changes, with different hashes",
    () =>
      withInputs("nyaucast-render-composition-", (channelRoot) =>
        Effect.gen(function* () {
          const first = yield* render();
          writeComposition(
            channelRoot,
            compositionHtml({
              seekBody: 'document.body.style.background = "rgb(1,2,3)";',
            }),
          );

          const second = yield* render();

          assert.strictEqual(second.rendered, true);
          assert.notStrictEqual(second.compositionHash, first.compositionHash);
          assert.notStrictEqual(second.renderHash, first.renderHash);
        }),
      ),
    slow,
  );

  it.effect(
    "builds again when the export file is gone, so the row is never left pointing at nothing",
    () =>
      withInputs("nyaucast-render-missing-file-", (channelRoot) =>
        Effect.gen(function* () {
          yield* render();
          const { rmSync } = yield* Effect.promise(() => import("node:fs"));
          rmSync(join(channelRoot, cutExportKey));

          const again = yield* render();

          assert.strictEqual(again.rendered, true);
          assert.isTrue(channelFileExists(channelRoot, cutExportKey));
        }),
      ),
    slow,
  );
});

describe.concurrent("video.renderCut: composition contract checks", () => {
  const failsWith = (html: string, tag: string) =>
    withInputs(
      `nyaucast-render-invalid-${tag}-`,
      (channelRoot) =>
        Effect.gen(function* () {
          const failure = yield* Effect.flip(render());

          assert.strictEqual(failure._tag, tag);
          assert.isFalse(channelFileExists(channelRoot, cutExportKey));
          assert.deepStrictEqual(yield* exportRows, []);
          return failure;
        }),
      html,
    );

  it.effect(
    "fails with InvalidComposition listing segments-gap when the segments leave a gap, and writes nothing",
    () =>
      failsWith(
        compositionHtml({
          segments: [
            { duration: 0.4, start: 0 },
            { duration: 0.5, start: 0.5 },
          ],
        }),
        "InvalidComposition",
      ).pipe(
        Effect.map((failure) => {
          assert.include(failureFacts(failure)["violations"], "segments-gap");
        }),
      ),
    slow,
  );

  it.effect(
    "fails with InvalidComposition listing fps-encoding when the composition's fps is not the encoding fps",
    () =>
      failsWith(compositionHtml({ fps: 24 }), "InvalidComposition").pipe(
        Effect.map((failure) => {
          assert.include(failureFacts(failure)["violations"], "fps-encoding");
        }),
      ),
    slow,
  );

  it.effect(
    "fails with InvalidComposition listing duration when the page does not declare it, and writes nothing",
    () =>
      failsWith(compositionHtml({ omit: ["duration"] }), "InvalidComposition").pipe(
        Effect.map((failure) => {
          assert.include(failureFacts(failure)["violations"], "duration");
        }),
      ),
    slow,
  );

  it.effect(
    "fails with NondeterministicComposition when seeking the same time again gives a different picture, and writes nothing",
    () =>
      failsWith(
        compositionHtml({ seekBody: colorByCallCount, segments: twoSegments }),
        "NondeterministicComposition",
      ).pipe(
        Effect.map((failure) => {
          const seconds = failureFacts(failure)["seconds"] as readonly number[];
          assert.isAbove(seconds.length, 0);
        }),
      ),
    slow,
  );
});

describe.concurrent("video.renderCut: failures while encoding", () => {
  const writesNothing = (channelRoot: string) =>
    Effect.gen(function* () {
      const fs = yield* Effect.promise(() => import("node:fs"));
      const directory = join(channelRoot, cutDirectory);
      assert.deepStrictEqual(fs.existsSync(directory) ? fs.readdirSync(directory) : [], []);
      assert.deepStrictEqual(yield* exportRows, []);
    });

  it.effect(
    "leaves no file, not even a temporary one, when the picture check fails after the encoding",
    () =>
      withInputs(
        "nyaucast-render-no-residue-",
        (channelRoot) =>
          Effect.gen(function* () {
            const failure = yield* Effect.flip(render());

            assert.strictEqual(failure._tag, "NondeterministicComposition");
            yield* writesNothing(channelRoot);
          }),
        compositionHtml({ seekBody: colorByCallCount, segments: twoSegments }),
      ),
    slow,
  );

  it.effect(
    "fails with AudioTrackUnreadable when the audio track cannot be decoded, and writes nothing",
    () =>
      withInputs("nyaucast-render-broken-track-", (channelRoot) =>
        Effect.gen(function* () {
          writeTrack(channelRoot, Uint8Array.from([1, 2, 3, 4]));

          const failure = yield* Effect.flip(render());

          assert.strictEqual(failure._tag, "AudioTrackUnreadable");
          assert.strictEqual(failureFacts(failure)["videoId"], "V1");
          yield* writesNothing(channelRoot);
        }),
      ),
    slow,
  );

  it.effect(
    "fails with EncodeFailed when the encoding breaks after it has started, and writes nothing",
    () =>
      withInputs("nyaucast-render-encode-failed-", (channelRoot) =>
        Effect.gen(function* () {
          const fs = yield* Effect.promise(() => import("node:fs"));
          // 一時ファイルの場所に、書けないファイルがある（出力を始めた時点で書き込みが拒否される）
          const temporary = join(channelRoot, `${cutExportKey}.tmp`);
          fs.mkdirSync(join(channelRoot, cutDirectory), { recursive: true });
          fs.writeFileSync(temporary, "occupied", { mode: 0o444 });
          // root は権限を無視して書けるので、このテストの前提が崩れる。黙って通さず失敗させる
          assert.notStrictEqual(process.getuid?.(), 0);

          const failure = yield* Effect.flip(render());

          assert.strictEqual(failure._tag, "EncodeFailed");
          assert.strictEqual(failureFacts(failure)["videoId"], "V1");
          yield* writesNothing(channelRoot);
        }),
      ),
    slow,
  );
});

// 音声トラックを開いた直後に、mix が同じキーを別の内容（880 Hz）へ置き換える（rename）。
const replacedAfterFirstRead = (channelRoot: string) =>
  Layer.effect(
    VideoFiles,
    Effect.gen(function* () {
      const real = yield* VideoFiles;
      let replaced = false;
      const replaceOnce = (key: string) =>
        key === audioTrackKey && !replaced
          ? Effect.suspend(() => {
              replaced = true;
              return real.write(key, trackWav(1, 880));
            })
          : Effect.void;
      return VideoFiles.of({
        ...real,
        openReader: (key) => real.openReader(key).pipe(Effect.tap(() => replaceOnce(key))),
      });
    }),
  ).pipe(Layer.provide(VideoFiles.layer(channelRoot)));

describe.concurrent("video.renderCut: the audio track replaced during a render", () => {
  it.effect(
    "encodes the same audio the render hash was made from, so the recorded key matches the mp4",
    () =>
      withInputs(
        "nyaucast-render-replaced-track-",
        (channelRoot) =>
          Effect.gen(function* () {
            const first = yield* render();

            const audio = yield* decodeStereo(readChannelFile(channelRoot, cutExportKey));
            // 鍵は元の音声（440 Hz）から作られたので、mp4 の音声も元の音声のまま
            assert.isAbove(tonePower(audio[0], 440), tonePower(audio[0], 880) * 100);
            // 元の音声を戻すと、記録した鍵と一致して再利用される
            writeTrack(channelRoot);
            const again = yield* render();
            assert.strictEqual(again.rendered, false);
            assert.strictEqual(again.renderHash, first.renderHash);
            assert.strictEqual((yield* exportRows).length, 1);
          }),
        compositionHtml(),
        replacedAfterFirstRead,
      ),
    slow,
  );
});

// プロセス全体の arrayBuffers の伸びを測るので、並走させない。並列ではないスイートは並列のまとまりを区切るので、単独で走る。
describe("video.renderCut: memory on a long audio track", () => {
  it.effect(
    "does not hold the audio track or the mp4 in memory while rendering 10 minutes of audio",
    () =>
      withInputs("nyaucast-render-memory-", (channelRoot) =>
        Effect.gen(function* () {
          // ネイティブのライブラリの初回の読み込みを測定に含めないよう、先に短い音声で 1 度書き出しておく
          yield* render();
          writeTrack(channelRoot, trackWav(600));
          const stop = startPeakBufferGrowth();

          // 失敗・中断でも計測のタイマーを止める（止めないとテストプロセスが終わらない）
          const result = yield* render().pipe(Effect.ensuring(Effect.sync(stop)));

          const growthMegabytes = stop();
          assert.strictEqual(result.rendered, true);
          // 600 秒の音声は約 115 MB（float に展開すると約 230 MB）。全体を持つ実装は、これらを足した分だけ増える。
          // 流して書く実装は、入力の長さによらず約 60 MB（計測値。600 秒でも 1500 秒でも同じ）で収まる
          assert.isBelow(growthMegabytes, 150);
        }),
      ),
    slow,
  );
});

describe.concurrent("video.renderCut: preconditions", () => {
  it.effect("rejects an unknown key at the tool boundary and writes nothing", () =>
    withInputs("nyaucast-render-unknown-key-", () =>
      Effect.gen(function* () {
        const request = { fps: 60, videoId: "V1" };

        assert.strictEqual(
          yield* rejectionReason("video_render_cut", request as never),
          "ToolParameterValidationError",
        );
        assert.deepStrictEqual(yield* exportRows, []);
      }),
    ),
  );

  it.effect("fails with CompositionNotFound when there is no composition, without a row", () =>
    inVideo("nyaucast-render-no-composition-", (channelRoot) =>
      Effect.gen(function* () {
        writeTrack(channelRoot);

        const failure = yield* Effect.flip(render());

        assert.strictEqual(failure._tag, "CompositionNotFound");
        assert.strictEqual(failureFacts(failure)["videoId"], "V1");
        assert.deepStrictEqual(yield* exportRows, []);
      }),
    ),
  );

  it.effect("fails with AudioTrackNotFound when there is no audio track, without a row", () =>
    inVideo("nyaucast-render-no-track-", (channelRoot) =>
      Effect.gen(function* () {
        writeComposition(channelRoot, compositionHtml());

        const failure = yield* Effect.flip(render());

        assert.strictEqual(failure._tag, "AudioTrackNotFound");
        assert.strictEqual(failureFacts(failure)["videoId"], "V1");
        assert.isFalse(channelFileExists(channelRoot, audioTrackKey));
        assert.deepStrictEqual(yield* exportRows, []);
      }),
    ),
  );

  it.effect("fails with VideoNotFound for an unknown video", () =>
    inVideo("nyaucast-render-unknown-video-", () =>
      Effect.gen(function* () {
        const failure = yield* Effect.flip(render({ videoId: "nope" }));

        assert.strictEqual(failure._tag, "VideoNotFound");
      }),
    ),
  );

  it.effect("fails with ProduceGateNotApproved before the produce gate is approved", () =>
    withToolChannel("nyaucast-render-unapproved-", { config: explainerConfig }, (channelRoot) =>
      Effect.gen(function* () {
        yield* recordPlan();
        writeComposition(channelRoot, compositionHtml());
        writeTrack(channelRoot);

        const failure = yield* Effect.flip(render());

        assert.strictEqual(failure._tag, "ProduceGateNotApproved");
        assert.strictEqual(failureFacts(failure)["videoId"], "V1");
        assert.deepStrictEqual(yield* exportRows, []);
      }),
    ),
  );

  it.effect("fails with ProduceGateNotApproved after a NO-GO", () =>
    inVideo("nyaucast-render-rejected-", (channelRoot) =>
      Effect.gen(function* () {
        writeComposition(channelRoot, compositionHtml());
        writeTrack(channelRoot);
        yield* rejectProduce();

        const failure = yield* Effect.flip(render());

        assert.strictEqual(failure._tag, "ProduceGateNotApproved");
        assert.isFalse(channelFileExists(channelRoot, cutExportKey));
      }),
    ),
  );

  it.effect(
    "adds no row in any table other than the cut facts when it renders",
    () =>
      withInputs("nyaucast-render-only-exports-", () =>
        Effect.gen(function* () {
          const before = yield* tableRowCounts;

          yield* render();

          const after = yield* tableRowCounts;
          assert.deepStrictEqual(
            Object.keys(after).filter((table) => after[table] !== before[table]),
            ["explainer_cut_exports"],
          );
        }),
      ),
    slow,
  );
});

// ---- ショートのカット（#550）----
// 契約（この issue の計画 C7・C8）:
//   パラメータに cut?（"long" か "short-<n>-clip" / "short-<n>-dedicated"）が増える。省略は "long"。
//   ショートのカットは compositions/<cut>.html と audio/<cut>.wav（長尺の最終トラックではない）から、cuts/<cut>/<cut>.mp4 を書く。
//   事実 explainer_cut_exports の行には、そのカットの名前が入る。1 つの候補から 2 つのカットの行が積まれる。
//   候補が無い・取り下げ済みなら ShortCandidateNotFound。composition か音声が無ければ CompositionNotFound / AudioTrackNotFound。

// 縦型 mp4 の要約（コーデック・寸法・長さ。長さは 0.1 秒に丸める）。
const verticalMp4Summary = async (channelRoot: string, key: string) => {
  const mp4 = await readMp4(channelRoot, key);
  return {
    codecs: [mp4.video?.codec, mp4.audio?.codec],
    seconds: Math.round(mp4.duration * 10) / 10,
    size: [mp4.video?.displayWidth, mp4.video?.displayHeight],
  };
};

const renderCut = (cut: string, extra: { force?: boolean } = {}) =>
  callTool("video_render_cut", { cut, videoId: "V1", ...extra });

// 縦型（180x320）の小さな composition。
const verticalHtml = () => compositionHtml({ height: 320, width: 180 });

const writeCutInputs = (channelRoot: string, cut: string, html = verticalHtml()) =>
  stampShortVersion(cut, html).pipe(
    Effect.map((stamped) => {
      writeChannelFile(channelRoot, cutCompositionKey(cut), new TextEncoder().encode(stamped));
      writeChannelFile(channelRoot, cutAudioKey(cut), trackWav());
    }),
  );

// 企画・承認・長尺の台本・候補 1 を用意した動画 V1（composition と音声は置かない）。
const withShort = <A, E, R>(prefix: string, use: (channelRoot: string) => Effect.Effect<A, E, R>) =>
  inVideo(prefix, (channelRoot) =>
    Effect.gen(function* () {
      yield* callTool("video_write_script", scriptInput(scriptScenes));
      yield* writeShort();
      yield* setClock(noon);
      return yield* use(channelRoot);
    }),
  );

describe.concurrent("video.renderCut: the cut parameter", () => {
  const schema = ExplainerVideoRenderCutTool.parametersSchema;

  it.each([
    "long",
    "short-1-clip",
    "short-1-dedicated",
    "short-12-clip",
    "short-100-dedicated",
    "short-9007199254740991-clip",
  ])("accepts the cut %j", (cut) => {
    assert.isTrue(accepts(schema, { cut, videoId: "V1" }));
    assert.isTrue(accepts(schema, { cut, force: true, videoId: "V1" }));
  });

  it.each([
    "short-01-clip",
    "short-0-clip",
    "short-1-vertical",
    "short-1.5-clip",
    "short-9007199254740992-clip",
    "short-9999999999999999-dedicated",
    "short--1-clip",
    "Long",
    "short-1-clip ",
    "",
  ])("does not accept the cut %j", (cut) => {
    assert.isFalse(accepts(schema, { cut, videoId: "V1" }));
  });

  it("describes the short failure tag", () => {
    assert.include(ExplainerVideoRenderCutTool.description, "ShortCandidateNotFound");
  });

  it.effect(
    "renders the long cut for the cut long, as when the cut is omitted",
    () =>
      withInputs("nyaucast-render-cut-long-", () =>
        Effect.gen(function* () {
          const result = yield* renderCut("long");

          assert.strictEqual(result.cut, "long");
          assert.strictEqual(result.key, cutExportKey);
          assert.deepStrictEqual(
            (yield* exportRows).map((row) => row.cut),
            ["long"],
          );
        }),
      ),
    slow,
  );
});

describe.concurrent("video.renderCut: the two cuts of a short candidate", () => {
  it.effect(
    "records one export for each of short-1-clip and short-1-dedicated, with an mp4 of the composition's size under each cut's directory",
    () =>
      withShort("nyaucast-render-short-two-cuts-", (channelRoot) =>
        Effect.gen(function* () {
          yield* writeCutInputs(channelRoot, clipCut(1));
          yield* writeCutInputs(channelRoot, dedicatedCut(1));

          const clip = yield* renderCut(clipCut(1));
          const dedicated = yield* renderCut(dedicatedCut(1));

          assert.strictEqual(clip.cut, clipCut(1));
          assert.strictEqual(clip.key, shortCutExportKey(clipCut(1)));
          assert.strictEqual(dedicated.cut, dedicatedCut(1));
          assert.strictEqual(dedicated.key, shortCutExportKey(dedicatedCut(1)));
          assert.isTrue(clip.rendered);
          assert.isTrue(dedicated.rendered);
          const rows = yield* exportRows;
          assert.deepStrictEqual(
            rows.map((row) => [row.cut, row.key, row.video_id]),
            [
              [clipCut(1), shortCutExportKey(clipCut(1)), "V1"],
              [dedicatedCut(1), shortCutExportKey(dedicatedCut(1)), "V1"],
            ],
          );
          assert.strictEqual(rows[0]?.composition_hash, clip.compositionHash);
          assert.strictEqual(rows[1]?.render_hash, dedicated.renderHash);
          for (const key of [clip.key, dedicated.key]) {
            assert.isTrue(channelFileExists(channelRoot, key));
            assert.deepStrictEqual(
              yield* Effect.promise(() => verticalMp4Summary(channelRoot, key)),
              {
                codecs: ["avc", "aac"],
                seconds: 1,
                size: [180, 320],
              },
            );
          }
          assert.isFalse(channelFileExists(channelRoot, cutExportKey));
        }),
      ),
    slow,
  );

  it.effect(
    "records an export of a short later than the last version of its candidate, even at the same clock time",
    () =>
      withShort("nyaucast-render-short-after-version-", (channelRoot) =>
        Effect.gen(function* () {
          yield* writeCutInputs(channelRoot, clipCut(1));
          const [version] = yield* versionRows;
          const versionTime = String(version?.["created_at"]);
          yield* setClock(versionTime);

          yield* renderCut(clipCut(1));

          const [row] = yield* exportRows;
          assert.isTrue((row?.created_at ?? "") > versionTime);
        }),
      ),
    slow,
  );

  it.effect(
    "refuses a composition assembled before the candidate was written again, and renders once it is assembled again",
    () =>
      withShort("nyaucast-render-short-stale-", (channelRoot) =>
        Effect.gen(function* () {
          yield* writeCutInputs(channelRoot, dedicatedCut(1));
          yield* renderCut(dedicatedCut(1));
          yield* writeShort({ hook: "新しいフック" });

          const stale = yield* Effect.flip(renderCut(dedicatedCut(1)));

          assert.deepStrictEqual(failureFacts(stale), {
            _tag: "CompositionStale",
            cut: dedicatedCut(1),
            videoId: "V1",
          });
          assert.strictEqual((yield* exportRows).length, 1);

          // 組み立て直すと、composition の版が候補の最後の版になる
          yield* writeCutInputs(channelRoot, dedicatedCut(1));
          const again = yield* renderCut(dedicatedCut(1));

          const versions = yield* versionRows;
          const lastVersion = String(versions[versions.length - 1]?.["created_at"]);
          const rows = yield* exportRows;
          assert.isTrue(again.rendered);
          assert.strictEqual(rows.length, 2);
          assert.isTrue((rows[1]?.created_at ?? "") > lastVersion);
        }),
      ),
    slow,
  );

  it.effect(
    "reports both cuts in the video's status, in name order",
    () =>
      withShort("nyaucast-render-short-status-", (channelRoot) =>
        Effect.gen(function* () {
          yield* writeCutInputs(channelRoot, dedicatedCut(1));
          yield* writeCutInputs(channelRoot, clipCut(1));
          yield* renderCut(dedicatedCut(1));
          yield* renderCut(clipCut(1));

          const status = yield* callTool("video_status", { videoId: "V1" });

          assert.deepStrictEqual(
            status.cuts.map((cut) => [cut.cut, cut.lastExport?.key]),
            [
              [clipCut(1), shortCutExportKey(clipCut(1))],
              [dedicatedCut(1), shortCutExportKey(dedicatedCut(1))],
            ],
          );
        }),
      ),
    slow,
  );

  it.effect(
    "returns the existing export of a cut for the same input, and one cut does not reuse the other's",
    () =>
      withShort("nyaucast-render-short-again-", (channelRoot) =>
        Effect.gen(function* () {
          yield* writeCutInputs(channelRoot, clipCut(1));
          yield* writeCutInputs(channelRoot, dedicatedCut(1));
          const first = yield* renderCut(clipCut(1));

          const again = yield* renderCut(clipCut(1));
          const other = yield* renderCut(dedicatedCut(1));

          assert.strictEqual(again.rendered, false);
          assert.strictEqual(again.key, first.key);
          assert.isTrue(other.rendered);
          assert.strictEqual((yield* exportRows).length, 2);
        }),
      ),
    slow,
  );

  it.effect("reads the audio of the cut, not the final track of the long cut", () =>
    withShort("nyaucast-render-short-audio-", (channelRoot) =>
      Effect.gen(function* () {
        writeChannelFile(
          channelRoot,
          cutCompositionKey(clipCut(1)),
          new TextEncoder().encode(yield* stampShortVersion(clipCut(1), verticalHtml())),
        );
        writeTrack(channelRoot);

        const failure = yield* Effect.flip(renderCut(clipCut(1)));

        assert.strictEqual(failure._tag, "AudioTrackNotFound");
        assert.strictEqual((yield* exportRows).length, 0);
        assert.isFalse(channelFileExists(channelRoot, shortCutExportKey(clipCut(1))));
      }),
    ),
  );

  it.effect("reads the composition of the cut, not the long composition", () =>
    withShort("nyaucast-render-short-composition-", (channelRoot) =>
      Effect.gen(function* () {
        writeComposition(channelRoot, compositionHtml());
        writeChannelFile(channelRoot, cutAudioKey(clipCut(1)), trackWav());

        const failure = yield* Effect.flip(renderCut(clipCut(1)));

        assert.strictEqual(failure._tag, "CompositionNotFound");
        assert.strictEqual((yield* exportRows).length, 0);
      }),
    ),
  );

  it.effect(
    "fails with ShortCandidateNotFound for a number that was never written, and records nothing",
    () =>
      withShort("nyaucast-render-short-no-candidate-", (channelRoot) =>
        Effect.gen(function* () {
          yield* writeCutInputs(channelRoot, clipCut(2));

          const failure = yield* Effect.flip(renderCut(clipCut(2)));

          assert.strictEqual(failure._tag, "ShortCandidateNotFound");
          assert.strictEqual(failureFacts(failure)["videoId"], "V1");
          assert.strictEqual(failureFacts(failure)["number"], 2);
          assert.strictEqual((yield* exportRows).length, 0);
          assert.isFalse(channelFileExists(channelRoot, shortCutExportKey(clipCut(2))));
        }),
      ),
  );

  it.effect("fails with ShortCandidateNotFound for a withdrawn candidate, for both cuts", () =>
    withShort("nyaucast-render-short-withdrawn-", (channelRoot) =>
      Effect.gen(function* () {
        yield* writeCutInputs(channelRoot, clipCut(1));
        yield* writeCutInputs(channelRoot, dedicatedCut(1));
        yield* withdrawShort(1);

        for (const cut of [clipCut(1), dedicatedCut(1)]) {
          const failure = yield* Effect.flip(renderCut(cut));
          assert.strictEqual(failure._tag, "ShortCandidateNotFound");
        }
        assert.strictEqual((yield* exportRows).length, 0);
      }),
    ),
  );

  it.effect(
    "fails with ProduceGateNotApproved for a short after a NO-GO, and records nothing",
    () =>
      withShort("nyaucast-render-short-rejected-", (channelRoot) =>
        Effect.gen(function* () {
          yield* writeCutInputs(channelRoot, clipCut(1));
          yield* rejectProduce();

          const failure = yield* Effect.flip(renderCut(clipCut(1)));

          assert.strictEqual(failure._tag, "ProduceGateNotApproved");
          assert.strictEqual((yield* exportRows).length, 0);
        }),
      ),
  );
});
