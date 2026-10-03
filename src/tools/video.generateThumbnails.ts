import { Clock, Effect, Option, Schema, Semaphore } from "effect";
import { Tool } from "effect/ai";

import { SecretNotConfigured, SecretResolutionFailed } from "../auth/secrets.ts";
import {
  ChannelConfigNotFound,
  ChannelSettings,
  InvalidChannelConfig,
  NotExplainerChannel,
  type ThumbnailType,
} from "../channel/channel-settings.ts";
import {
  ThumbnailCandidate,
  appendCandidate,
  generatedCandidateCount,
  latestGeneratedRound,
  maxRound,
  numbersInRound,
  readThumbnailFacts,
  thumbnailKey,
} from "../db/explainer-thumbnails.ts";
import { VideoNotFound, requireLatestPlan } from "../db/explainer-videos.ts";
import {
  GeminiHttpBoundaryFailed,
  GeminiHttpFailure,
  GeminiImageGenerator,
  GeminiResponseInvalid,
} from "../thumbnails/gemini.ts";
import {
  CodexExecFailed,
  CodexImageMissing,
  CodexImageGenerator,
  CodexNotLoggedIn,
  CodexUnavailable,
} from "../thumbnails/codex.ts";
import {
  ReferenceImageNotFound,
  ReferenceImageUnsupported,
  ThumbnailFiles,
  type ReferenceImage,
} from "../thumbnails/thumbnail-files.ts";
import { ThumbnailImageRejected, processThumbnail } from "../thumbnails/thumbnail-image.ts";

class ThumbnailTypeNotDeclared extends Schema.TaggedError<ThumbnailTypeNotDeclared>()(
  "ThumbnailTypeNotDeclared",
  {},
) {}

class BannedThumbnailWords extends Schema.TaggedError<BannedThumbnailWords>()(
  "BannedThumbnailWords",
  { words: Schema.Array(Schema.String) },
) {}

// 設定では外せない。tool が、provider へ渡すプロンプトに必ず付ける。
export const copyrightAvoidancePhrase =
  "Create original artwork only. Do not copy or imitate copyrighted characters, logos, trademarks, or recognizable existing artwork.";

export const VideoGenerateThumbnailsTool = Tool.make("video_generate_thumbnails", {
  description:
    "Generate thumbnail candidates for an explainer video from the thumbnail text and a description of the background, " +
    "following the channel's declared thumbnail type (style, reference images, banned words, text instructions, provider, number of candidates). " +
    "Each candidate is checked (16:9 within 0.06, at least 1280x720, at most 2 MB after being written as a 1920x1080 JPG) and written with a 320x180 small version and a row. " +
    "Without force, only the candidates missing from the latest generated round are made, with the text and background given in this call; a complete round makes no provider call. " +
    "With force, a new round of all candidates is made. " +
    "Fails with ThumbnailTypeNotDeclared when the channel declares no thumbnail type, with VideoNotFound for an unknown video, " +
    "with BannedThumbnailWords before any provider call when the text or the background contains a banned word, " +
    "with ReferenceImageNotFound or ReferenceImageUnsupported for a declared reference image, and with ThumbnailImageRejected " +
    "(reason unreadable, too_small, not_16_9 or too_large) for a generated image that cannot become a candidate; candidates written before the failure are kept. " +
    "When the provider is codex, the candidates are made one at a time with the codex CLI after checking that codex is logged in: " +
    "fails with CodexNotLoggedIn (no image is generated), CodexUnavailable, CodexExecFailed (with the exit code) or CodexImageMissing. " +
    "Returns the round, how many candidates this call made, and every candidate of the round.",
  failure: Schema.Union([
    ChannelConfigNotFound,
    InvalidChannelConfig,
    NotExplainerChannel,
    VideoNotFound,
    ThumbnailTypeNotDeclared,
    BannedThumbnailWords,
    ReferenceImageNotFound,
    ReferenceImageUnsupported,
    ThumbnailImageRejected,
    GeminiHttpFailure,
    GeminiResponseInvalid,
    GeminiHttpBoundaryFailed,
    CodexNotLoggedIn,
    CodexUnavailable,
    CodexExecFailed,
    CodexImageMissing,
    SecretNotConfigured,
    SecretResolutionFailed,
  ]),
  parameters: Schema.Struct({
    background: Schema.String.annotate({ description: "Description of the thumbnail background." }),
    force: Schema.optionalKey(Schema.Boolean).annotate({
      description: "Make a new round of all candidates instead of completing the latest one.",
    }),
    text: Schema.String.annotate({ description: "The text to show on the thumbnail." }),
    videoId: Schema.String.annotate({ description: "Video ID returned by explainer_write_plan." }),
  }),
  success: Schema.Struct({
    candidates: Schema.Array(ThumbnailCandidate),
    created: Schema.Finite,
    round: Schema.Finite,
  }),
}).annotate(Tool.Strict, true);

interface ThumbnailInput {
  readonly background: string;
  readonly text: string;
}

const normalize = (value: string) => value.normalize("NFKC").toLowerCase();

const findBannedWords = (thumbnail: ThumbnailType, input: ThumbnailInput) => {
  const haystack = normalize(`${input.text}\n${input.background}`);
  return thumbnail.bannedWords.filter((word) => word !== "" && haystack.includes(normalize(word)));
};

const buildPrompt = (thumbnail: ThumbnailType, input: ThumbnailInput) =>
  [
    copyrightAvoidancePhrase,
    thumbnail.style,
    thumbnail.textInstructions,
    `Thumbnail text: ${input.text}`,
    `Background: ${input.background}`,
  ]
    .filter((line) => line !== "")
    .join("\n");

// 不足番号の決定から行の追記までを直列にする。並行する呼び出しが同じ番号に二重に課金し、同じキーへ書くのを防ぐ。
const generationLock = Semaphore.makeUnsafe(1);

const numbersUpTo = (count: number) => Array.from({ length: count }, (_, index) => index + 1);

// force が無ければ、出所が生成の最後の回の足りない番号。回が無ければ（force なら常に）新しい回の全番号。
const planRound = (videoId: string, candidates: number, force: boolean) =>
  Effect.gen(function* () {
    const latest = force ? Option.none<number>() : yield* latestGeneratedRound(videoId);
    if (Option.isNone(latest)) {
      return { missing: numbersUpTo(candidates), round: (yield* maxRound(videoId)) + 1 };
    }
    const present = new Set(yield* numbersInRound(videoId, latest.value));
    return {
      missing: numbersUpTo(candidates).filter((number) => !present.has(number)),
      round: latest.value,
    };
  });

// チャンネル全体の生成の候補の行数で回すので、直近に使った参照画像の次を使い、事実から決まる。
const pickReference = (references: readonly ReferenceImage[]) =>
  Effect.gen(function* () {
    const count = yield* generatedCandidateCount;
    return references.length === 0 ? undefined : references[count % references.length];
  });

interface GenerateRequest {
  readonly prompt: string;
  readonly referenceImage?: ReferenceImage;
}

type GenerateFailure =
  | CodexExecFailed
  | CodexImageMissing
  | CodexUnavailable
  | GeminiHttpBoundaryFailed
  | GeminiHttpFailure
  | GeminiResponseInvalid
  | SecretNotConfigured
  | SecretResolutionFailed;

type Generate<E, R> = (
  request: GenerateRequest,
) => Effect.Effect<{ readonly bytes: Uint8Array }, E, R>;

const makeCandidate = <E, R>(
  slot: { number: number; round: number; videoId: string },
  prompt: string,
  references: readonly ReferenceImage[],
  generate: Generate<E, R>,
) =>
  Effect.gen(function* () {
    const referenceImage = yield* pickReference(references);
    const generated = yield* generate({
      prompt,
      ...(referenceImage === undefined ? {} : { referenceImage }),
    });
    const processed = yield* processThumbnail(generated.bytes);
    const key = thumbnailKey(slot.videoId, slot.round, slot.number);
    yield* (yield* ThumbnailFiles).write(key, processed);
    const createdAt = new Date(yield* Clock.currentTimeMillis).toISOString();
    yield* appendCandidate({ ...slot, createdAt, key, origin: "generated" });
  });

// provider は設定で必ず選ばれる 2 本だけ。codex は生成の前に、1 回の呼び出しで 1 度だけログインを確かめる。
const withGenerator = <A, E, R>(
  provider: ThumbnailType["provider"],
  use: (generate: Generate<GenerateFailure, never>) => Effect.Effect<A, E, R>,
) =>
  provider === "gemini"
    ? Effect.gen(function* () {
        return yield* use((yield* GeminiImageGenerator).generate);
      }).pipe(Effect.provide(GeminiImageGenerator.layer))
    : Effect.gen(function* () {
        const codex = yield* CodexImageGenerator;
        yield* codex.requireLogin;
        return yield* use(codex.generate);
      }).pipe(Effect.provide(CodexImageGenerator.layer));

const resolveThumbnailType = Effect.gen(function* () {
  const settings = yield* (yield* ChannelSettings).requireExplainer;
  if (settings.thumbnail === undefined) {
    return yield* new ThumbnailTypeNotDeclared();
  }
  return settings.thumbnail;
});

const generateThumbnails = Effect.fn("video.generateThumbnails")(function* ({
  force,
  videoId,
  ...input
}: ThumbnailInput & { readonly force?: boolean; readonly videoId: string }) {
  const thumbnail = yield* resolveThumbnailType;
  yield* requireLatestPlan(videoId);
  const words = findBannedWords(thumbnail, input);
  if (words.length > 0) {
    return yield* new BannedThumbnailWords({ words });
  }
  const files = yield* ThumbnailFiles;
  const references = yield* Effect.forEach(thumbnail.referenceImages, files.readReference);
  const { missing, round } = yield* planRound(videoId, thumbnail.candidates, force === true);
  const prompt = buildPrompt(thumbnail, input);
  if (missing.length > 0) {
    yield* withGenerator(thumbnail.provider, (generate) =>
      Effect.forEach(
        missing,
        (number) => makeCandidate({ number, round, videoId }, prompt, references, generate),
        { discard: true },
      ),
    );
  }
  const facts = yield* readThumbnailFacts(videoId);
  return {
    candidates: facts.candidates.filter((candidate) => candidate.round === round),
    created: missing.length,
    round,
  };
});

export const videoGenerateThumbnails = (input: Parameters<typeof generateThumbnails>[0]) =>
  generationLock.withPermits(1)(generateThumbnails(input));
