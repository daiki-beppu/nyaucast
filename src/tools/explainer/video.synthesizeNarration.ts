import { Effect, Schema, Semaphore } from "effect";
import { Tool } from "effect/ai";

import { SecretNotConfigured, SecretResolutionFailed } from "../../auth/secrets.ts";
import {
  ChannelConfigNotFound,
  ChannelSettings,
  InvalidChannelConfig,
} from "../../channel/channel-settings.ts";
import { ShortCandidateNotFound } from "../../db/explainer-shorts.ts";
import { VideoNotFound, requireLatestPlan } from "../../db/explainer-videos.ts";
import {
  GeminiHttpBoundaryFailed,
  GeminiHttpFailure,
  GeminiResponseInvalid,
} from "../../gemini/generate-content.ts";
import { GeminiSpeechSynthesizer } from "../../narration/gemini-tts.ts";
import { NarrationTooLong, scriptAudio } from "../../narration/paragraph-audio.ts";
import { narrationKey, timingTableKey } from "../../narration/timing-table.ts";
import { assembleTrack } from "../../narration/track.ts";
import { encodeWav } from "../../narration/wav.ts";
import { InvalidReadingMarkup, ParagraphTooLong } from "../../scripts/script.ts";
import { InvalidScriptFile, ScriptNotFound, readScript } from "../../scripts/script-files.ts";
import { Ordinal } from "../../shorts/short-candidate.ts";
import { resolveShortTarget } from "../../videos/cuts.ts";
import { ProduceGateNotApproved, requireProduceApproval } from "../../videos/produce-gate.ts";
import { VideoFiles } from "../../videos/video-files.ts";

class VoiceNotDeclared extends Schema.TaggedError<VoiceNotDeclared>()("VoiceNotDeclared", {}) {}

export const ExplainerVideoSynthesizeNarrationTool = Tool.make("video_synthesize_narration", {
  description:
    "Synthesize the narration of an explainer video from its script, one paragraph at a time with the channel's declared voice " +
    "(adapter, model, voice name, director's notes, characters per second), then join the paragraphs into a narration track (48 kHz mono 16-bit WAV) " +
    "with a timing table (JSON: start and end seconds of every paragraph and phrase). " +
    "The voice speaks the reading of each paragraph. A paragraph whose audio is already synthesized (same reading, adapter, model, voice and director's notes) is reused without calling the provider, " +
    "so correcting only the notation of a paragraph synthesizes nothing. Audio longer than the reading time plus 1.5 seconds is synthesized again, up to 4 provider calls in all. " +
    "The track and the timing table are always rebuilt from the paragraph files and never call the provider by themselves. " +
    "With force, every paragraph is synthesized again. " +
    "With short, the narration is made from the dedicated script of that candidate and written to videos/<id>/shorts/<short>/narration/; the long narration is neither read nor changed. " +
    "Requires the produce gate to be approved. " +
    "Fails with VoiceNotDeclared when the channel declares no voice, with VideoNotFound for an unknown video, " +
    "with ProduceGateNotApproved before the produce gate is approved, with ShortCandidateNotFound when short names a candidate that was never written or is withdrawn, with ScriptNotFound or InvalidScriptFile for the saved script, " +
    "with InvalidReadingMarkup or ParagraphTooLong when the saved script no longer passes the checks of video_write_script, " +
    "and with NarrationTooLong (scene, paragraph and attempts, numbered from 1) when the audio is still too long after 4 calls. " +
    "Paragraphs synthesized before a failure are kept, and a rerun synthesizes only the missing ones. " +
    "Returns the keys of the track and the timing table, and how many paragraphs were synthesized and reused.",
  failure: Schema.Union([
    ChannelConfigNotFound,
    InvalidChannelConfig,
    VideoNotFound,
    ProduceGateNotApproved,
    VoiceNotDeclared,
    ShortCandidateNotFound,
    ScriptNotFound,
    InvalidScriptFile,
    InvalidReadingMarkup,
    ParagraphTooLong,
    NarrationTooLong,
    GeminiHttpFailure,
    GeminiResponseInvalid,
    GeminiHttpBoundaryFailed,
    SecretNotConfigured,
    SecretResolutionFailed,
  ]),
  parameters: Schema.Struct({
    force: Schema.optionalKey(Schema.Boolean).annotate({
      description: "Synthesize every paragraph again instead of reusing the existing audio.",
    }),
    short: Schema.optionalKey(
      Ordinal.annotate({
        description:
          "Candidate number of a dedicated short, to synthesize its script instead of the long script.",
      }),
    ),
    videoId: Schema.String.annotate({ description: "Video ID returned by video_write_plan." }),
  }),
  success: Schema.Struct({
    reused: Schema.Finite,
    synthesized: Schema.Finite,
    timingKey: Schema.String,
    trackKey: Schema.String,
    videoId: Schema.String,
  }),
}).annotate(Tool.Strict, true);

const resolveVoice = Effect.gen(function* () {
  const settings = yield* (yield* ChannelSettings).explainer;
  if (settings.voice === undefined) {
    return yield* new VoiceNotDeclared();
  }
  return settings.voice;
});

// 課金される呼び出しを、同じ動画への並行する呼び出しが二重に行わないよう、直列にする。
const synthesisLock = Semaphore.makeUnsafe(1);

const synthesizeNarration = Effect.fn("video.synthesizeNarration")(function* ({
  force,
  short,
  videoId,
}: {
  readonly force?: boolean;
  readonly short?: number;
  readonly videoId: string;
}) {
  const voice = yield* resolveVoice;
  yield* requireLatestPlan(videoId);
  yield* requireProduceApproval(videoId);
  const target = yield* resolveShortTarget(videoId, short);
  const script = yield* readScript(target);
  const audio = yield* scriptAudio(videoId, voice, script, force === true).pipe(
    Effect.provide(GeminiSpeechSynthesizer.layer),
  );
  const { samples, timing } = assembleTrack(
    script.map((paragraph, index) => ({
      paragraph: paragraph.paragraph,
      samples: audio[index]?.samples ?? new Int16Array(),
      scene: paragraph.scene,
      text: paragraph.text,
    })),
  );
  const files = yield* VideoFiles;
  const trackKey = narrationKey(target, "track.wav");
  const timingKey = timingTableKey(target);
  yield* files.write(trackKey, encodeWav(samples));
  yield* files.write(timingKey, new TextEncoder().encode(JSON.stringify(timing, null, 2)));
  const synthesized = audio.filter((paragraph) => paragraph.synthesized).length;
  return { reused: audio.length - synthesized, synthesized, timingKey, trackKey, videoId };
});

export const explainerVideoSynthesizeNarration = (input: {
  readonly force?: boolean;
  readonly short?: number;
  readonly videoId: string;
}) => synthesisLock.withPermits(1)(synthesizeNarration(input));
