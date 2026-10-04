import { Effect, Option, Schema, Semaphore } from "effect";
import { Tool } from "effect/ai";

import {
  ChannelConfigNotFound,
  InvalidChannelConfig,
  NotExplainerChannel,
} from "../channel/channel-settings.ts";
import {
  InvalidComposition,
  capturePreviewFrames,
  openComposition,
} from "../compositions/capture.ts";
import {
  CompositionNotFound,
  CompositionStale,
  readCutComposition,
} from "../compositions/composition.ts";
import { appendCutPreview, lastCutPreview } from "../db/explainer-cuts.ts";
import { ShortCandidateNotFound } from "../db/explainer-shorts.ts";
import { VideoNotFound } from "../db/explainer-videos.ts";
import { ChromeUnavailable } from "../lib/chrome.ts";
import { CutField, type CutRequest } from "../videos/cuts.ts";
import { ProduceGateNotApproved } from "../videos/produce-gate.ts";
import { VideoFiles } from "../videos/video-files.ts";

const Frame = Schema.Struct({ key: Schema.String, segment: Schema.Finite });
type Frame = typeof Frame.Type;

const Manifest = Schema.Struct({ frames: Schema.Array(Frame) });
const decodeManifest = Schema.decodeUnknownOption(Schema.fromJsonString(Manifest));

export const ExplainerPreviewCutTool = Tool.make("explainer_preview_cut", {
  description: [
    "Take the preview of a cut of an explainer video (the long cut by default): the composition of the cut (videos/<id>/compositions/<cut>.html) is opened in a headless Chrome ",
    "and one PNG is captured per segment, at the last frame just before the segment ends, so a segment declared static by mistake shows in the picture. ",
    "The composition is checked against docs/reference/composition-contract.md first. ",
    "The frames are written to videos/<id>/cuts/<cut>/previews/<composition hash>/<segment number>.png (segment numbers start at 1, in time order) and one preview is recorded for the cut with the composition hash. ",
    "A preview whose composition hash is unchanged and whose files exist is returned as it is, without recording another; force takes it again. ",
    "The audio track is not used. ",
    "Requires the produce gate to be approved. ",
    "Fails with VideoNotFound for an unknown video, with ProduceGateNotApproved before the produce gate is approved, ",
    "with ShortCandidateNotFound when the cut names a short candidate that was never written or is withdrawn, ",
    "with CompositionNotFound when there is no composition, " +
      "with CompositionStale for a short whose candidate was rewritten after the composition was assembled, ",
    "with InvalidComposition (violations lists every broken rule) when the composition breaks the contract, ",
    "and with ChromeUnavailable when the browser cannot be downloaded, started or driven. ",
    "Nothing is written when it fails. ",
    "Returns the cut, the composition hash, the frames (key and segment number, one per segment) and whether the preview was taken now (false when the existing preview was returned).",
  ].join(""),
  failure: Schema.Union([
    ChannelConfigNotFound,
    InvalidChannelConfig,
    NotExplainerChannel,
    VideoNotFound,
    ProduceGateNotApproved,
    ShortCandidateNotFound,
    CompositionNotFound,
    CompositionStale,
    InvalidComposition,
    ChromeUnavailable,
  ]),
  parameters: Schema.Struct({
    cut: CutField,
    force: Schema.optionalKey(Schema.Boolean).annotate({
      description: "Take the preview again even when the composition is unchanged.",
    }),
    videoId: Schema.String.annotate({ description: "Video ID returned by explainer_write_plan." }),
  }),
  success: Schema.Struct({
    compositionHash: Schema.String,
    cut: Schema.String,
    frames: Schema.Array(Frame),
    previewed: Schema.Boolean,
    videoId: Schema.String,
  }),
}).annotate(Tool.Strict, true);

// プレビューは composition の鍵ごとのディレクトリに置く。segment の数が違う別の composition の PNG と混ざらない。
const previewDirectory = (videoId: string, cut: string, compositionHash: string) =>
  `videos/${videoId}/cuts/${cut}/previews/${compositionHash}`;
const manifestKey = (videoId: string, cut: string, compositionHash: string) =>
  `${previewDirectory(videoId, cut, compositionHash)}/manifest.json`;
const frameKey = (videoId: string, cut: string, compositionHash: string, segment: number) =>
  `${previewDirectory(videoId, cut, compositionHash)}/${segment}.png`;

const readManifest = (videoId: string, cut: string, compositionHash: string) =>
  Effect.gen(function* () {
    const bytes = yield* (yield* VideoFiles).read(manifestKey(videoId, cut, compositionHash));
    return Option.flatMap(bytes, (value) => decodeManifest(new TextDecoder().decode(value)));
  });

// 鍵が一致する最後のプレビューがあり、manifest と全部の PNG が残っていれば再利用できる（欠けていれば撮り直して行を積む）。
const reusableFrames = (videoId: string, cut: string, compositionHash: string) =>
  Effect.gen(function* () {
    const last = yield* lastCutPreview(videoId, cut);
    if (Option.isNone(last) || last.value.compositionHash !== compositionHash) return Option.none();
    const manifest = yield* readManifest(videoId, cut, compositionHash);
    if (Option.isNone(manifest)) return Option.none();
    const files = yield* VideoFiles;
    const present = yield* Effect.forEach(manifest.value.frames, (frame) =>
      files.exists(frame.key),
    );
    return present.every(Boolean) ? Option.some(manifest.value.frames) : Option.none();
  });

const captureFrames = (videoId: string, composition: Uint8Array) =>
  Effect.scoped(
    Effect.gen(function* () {
      return yield* capturePreviewFrames(yield* openComposition(videoId, composition));
    }),
  );

// PNG と manifest を書いてから行を積む。行を積む前に落ちても、次の実行で撮り直して行が積まれる。
const writeFrames = (
  videoId: string,
  cut: string,
  compositionHash: string,
  pngs: readonly Uint8Array[],
) =>
  Effect.gen(function* () {
    const files = yield* VideoFiles;
    const frames: Frame[] = pngs.map((_, index) => ({
      key: frameKey(videoId, cut, compositionHash, index + 1),
      segment: index + 1,
    }));
    yield* Effect.forEach(
      frames,
      (frame, index) => files.write(frame.key, pngs[index] ?? new Uint8Array()),
      {
        discard: true,
      },
    );
    yield* files.write(
      manifestKey(videoId, cut, compositionHash),
      new TextEncoder().encode(JSON.stringify({ frames }, null, 2)),
    );
    return frames;
  });

const previewCut = Effect.fn("explainer.previewCut")(function* ({
  cut,
  force,
  videoId,
}: CutRequest) {
  const composition = yield* readCutComposition(videoId, cut);
  const existing =
    force === true
      ? Option.none()
      : yield* reusableFrames(videoId, composition.cut, composition.hash);
  if (Option.isSome(existing)) {
    return {
      compositionHash: composition.hash,
      cut: composition.cut,
      frames: existing.value,
      previewed: false,
      videoId,
    };
  }
  const pngs = yield* captureFrames(videoId, composition.bytes);
  const frames = yield* writeFrames(videoId, composition.cut, composition.hash, pngs);
  yield* appendCutPreview({ compositionHash: composition.hash, cut: composition.cut, videoId });
  return {
    compositionHash: composition.hash,
    cut: composition.cut,
    frames,
    previewed: true,
    videoId,
  };
});

// 同じ動画への並行する呼び出しが、同じ行を二重に積まないよう、直列にする。
const previewLock = Semaphore.makeUnsafe(1);

export const explainerPreviewCut = (input: CutRequest) =>
  previewLock.withPermits(1)(previewCut(input));
