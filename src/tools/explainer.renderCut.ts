import { Effect, Option, Schema, Semaphore } from "effect";
import { Tool } from "effect/ai";

import { encodeMp4 } from "../audio/media.ts";
import {
  ChannelConfigNotFound,
  InvalidChannelConfig,
  NotExplainerChannel,
} from "../channel/channel-settings.ts";
import { CompositionNotFound, readCutComposition, sha256 } from "../compositions/composition.ts";
import {
  InvalidComposition,
  NondeterministicComposition,
  captureAllFrames,
  openComposition,
  reseekMismatches,
} from "../compositions/capture.ts";
import { appendCutExport, lastCutExport, longCut } from "../db/explainer-cuts.ts";
import { VideoNotFound } from "../db/explainer-videos.ts";
import { ChromeUnavailable } from "../lib/chrome.ts";
import { audioTrackKey } from "../videos/audio-track.ts";
import { ProduceGateNotApproved } from "../videos/produce-gate.ts";
import { type FileReader, VideoFiles } from "../videos/video-files.ts";

class AudioTrackNotFound extends Schema.TaggedError<AudioTrackNotFound>()("AudioTrackNotFound", {
  videoId: Schema.String,
}) {}

class AudioTrackUnreadable extends Schema.TaggedError<AudioTrackUnreadable>()(
  "AudioTrackUnreadable",
  { videoId: Schema.String },
) {}

class EncodeFailed extends Schema.TaggedError<EncodeFailed>()("EncodeFailed", {
  videoId: Schema.String,
}) {}

export const ExplainerRenderCutTool = Tool.make("explainer_render_cut", {
  description: [
    "Render the long cut of an explainer video to an mp4 (H.264 video and AAC audio, 30 fps): ",
    "the composition (videos/<id>/compositions/long.html) is opened in a headless Chrome, every frame is captured by seeking to its time, ",
    "and the frames are encoded together with the final audio track (videos/<id>/audio/track.wav). ",
    "The composition is checked against docs/reference/composition-contract.md first, and seeking again to the end of every segment must give the same picture as the first time. ",
    "The mp4 is written to videos/<id>/cuts/long/long.mp4 and one export is recorded for the cut with the key, the composition hash and the render hash. ",
    "An export whose render hash (composition, audio track and encoding settings) is unchanged and whose file exists is returned as it is, without recording another; force renders it again. ",
    "Requires the produce gate to be approved. ",
    "Fails with VideoNotFound for an unknown video, with ProduceGateNotApproved before the produce gate is approved, ",
    "with CompositionNotFound or AudioTrackNotFound when an input is missing, ",
    "with AudioTrackUnreadable when the audio track cannot be decoded, with EncodeFailed when the encoding fails part way, ",
    "with InvalidComposition (violations lists every broken rule) when the composition breaks the contract or its fps is not 30, ",
    "with NondeterministicComposition (seconds lists the times that differed) when seeking is not a pure function of the time, ",
    "and with ChromeUnavailable when the browser cannot be downloaded, started or driven. ",
    "Nothing is written when it fails. ",
    "Returns the cut, the key of the mp4, the composition hash, the render hash and whether it was rendered now (false when the existing export was returned).",
  ].join(""),
  failure: Schema.Union([
    ChannelConfigNotFound,
    InvalidChannelConfig,
    NotExplainerChannel,
    VideoNotFound,
    ProduceGateNotApproved,
    CompositionNotFound,
    AudioTrackNotFound,
    AudioTrackUnreadable,
    EncodeFailed,
    InvalidComposition,
    NondeterministicComposition,
    ChromeUnavailable,
  ]),
  parameters: Schema.Struct({
    force: Schema.optionalKey(Schema.Boolean).annotate({
      description: "Render the mp4 again even when its inputs are unchanged.",
    }),
    videoId: Schema.String.annotate({ description: "Video ID returned by explainer_write_plan." }),
  }),
  success: Schema.Struct({
    compositionHash: Schema.String,
    cut: Schema.String,
    key: Schema.String,
    renderHash: Schema.String,
    rendered: Schema.Boolean,
    videoId: Schema.String,
  }),
}).annotate(Tool.Strict, true);

// ---- エンコードの設定（tool の定数。設定には出さない） ----

/** 処理の版。書き出しの手順を変えたら上げる（render の鍵に入る）。 */
const processVersion = 1;
const encoding = {
  audioBitrate: 192_000,
  audioCodec: "aac",
  container: "mp4",
  fps: 30,
  videoBitrate: 8_000_000,
  videoCodec: "avc",
} as const;

const cutExportKey = (videoId: string) => `videos/${videoId}/cuts/${longCut}/long.mp4`;

const renderKey = (compositionHash: string, trackHash: string) =>
  sha256(JSON.stringify([processVersion, compositionHash, trackHash, encoding]));

// 音声トラックを 1 つのハンドルで開く。鍵の hash と、エンコードに使う音声が、同じ内容を指す。無ければ AudioTrackNotFound。
const openTrack = (videoId: string) =>
  Effect.gen(function* () {
    const reader = yield* (yield* VideoFiles).openReader(audioTrackKey(videoId));
    return Option.isSome(reader) ? reader.value : yield* new AudioTrackNotFound({ videoId });
  });

// 鍵が一致する最後の書き出しがあり、ファイルも残っていれば再利用できる（ファイルが無ければ作り直して行を積む）。
const reusableExport = (videoId: string, renderHash: string) =>
  Effect.gen(function* () {
    const last = yield* lastCutExport(videoId, longCut);
    if (Option.isNone(last) || last.value.renderHash !== renderHash) return Option.none();
    return (yield* (yield* VideoFiles).exists(last.value.key)) ? last : Option.none();
  });

// Chrome で全フレームを撮りながらキーのファイルへエンコードし、seek の決定論を確かめる。
// ファイルは一時ファイルへ書き、このスコープが成功で閉じたときだけキーへ置く（失敗・中断では消す）。
const renderMp4 = (videoId: string, composition: Uint8Array, key: string, track: FileReader) =>
  Effect.scoped(
    Effect.gen(function* () {
      const files = yield* VideoFiles;
      const outputPath = yield* files.stage(key);
      const opened = yield* openComposition(videoId, composition, encoding.fps);
      const capture = captureAllFrames(opened);
      yield* encodeMp4({
        audioBitrate: encoding.audioBitrate,
        audioSource: track,
        fps: encoding.fps,
        frames: capture.frames,
        outputPath,
        videoBitrate: encoding.videoBitrate,
      }).pipe(
        Effect.catchTag("AudioDecodeFailed", () => new AudioTrackUnreadable({ videoId })),
        Effect.catchTag("Mp4EncodeFailed", () => new EncodeFailed({ videoId })),
      );
      const seconds = yield* reseekMismatches(opened, capture.samples);
      if (seconds.length > 0) {
        return yield* new NondeterministicComposition({ seconds, videoId });
      }
    }),
  );

const renderCut = Effect.fn("explainer.renderCut")(function* ({
  force,
  videoId,
}: {
  readonly force?: boolean;
  readonly videoId: string;
}) {
  const composition = yield* readCutComposition(videoId);
  const track = yield* openTrack(videoId);
  const renderHash = renderKey(composition.hash, yield* track.sha256);
  const existing = force === true ? Option.none() : yield* reusableExport(videoId, renderHash);
  if (Option.isSome(existing)) {
    const { compositionHash, key } = existing.value;
    return { compositionHash, cut: longCut, key, renderHash, rendered: false, videoId };
  }
  const key = cutExportKey(videoId);
  // ファイル → 行の順に書く。行を積む前に落ちても、次の実行で作り直して行が積まれる。
  yield* renderMp4(videoId, composition.bytes, key, track);
  yield* appendCutExport({
    compositionHash: composition.hash,
    cut: longCut,
    key,
    renderHash,
    videoId,
  });
  return {
    compositionHash: composition.hash,
    cut: longCut,
    key,
    renderHash,
    rendered: true,
    videoId,
  };
});

// 同じ動画への並行する呼び出しが、同じ一時ファイルへ書いてぶつからず、同じ行を二重に積まないよう、直列にする。
const renderLock = Semaphore.makeUnsafe(1);

export const explainerRenderCut = (input: { readonly force?: boolean; readonly videoId: string }) =>
  renderLock.withPermits(1)(Effect.scoped(renderCut(input)));
