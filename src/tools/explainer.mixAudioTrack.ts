import { createHash } from "node:crypto";

import { Effect, Option, Schema, Semaphore } from "effect";
import { Tool } from "effect/ai";

import { integratedLoudness, truePeak } from "../audio/loudness.ts";
import { decodeStereo, encodeStereoWav, type StereoAudio } from "../audio/media.ts";
import {
  BgmPool,
  BgmPoolNotFound,
  BgmSongNotFound,
  BgmSongUnreadable,
  InvalidBgmPool,
  type BgmSong,
} from "../channel/bgm-pool.ts";
import {
  ChannelConfigNotFound,
  ChannelSettings,
  InvalidChannelConfig,
  NotExplainerChannel,
  type Bgm,
} from "../channel/channel-settings.ts";
import { ShortCandidateNotFound } from "../db/explainer-shorts.ts";
import { VideoNotFound, requireLatestPlan } from "../db/explainer-videos.ts";
import {
  decodeTimingTableBytes,
  narrationKey,
  type TimingTable,
} from "../narration/timing-table.ts";
import { outputSampleRate, parseWav } from "../narration/wav.ts";
import type { ScriptTarget } from "../scripts/script-files.ts";
import {
  InvalidShortRange,
  ShortTooLong,
  clipSpan,
  rangeKey,
  requireShortLength,
  type ParagraphRange,
  type ShortRef,
} from "../shorts/short-candidate.ts";
import { audioFactsKey, audioTrackKey } from "../videos/audio-track.ts";
import { CutField, resolveCut, sourceTarget, type CutTarget } from "../videos/cuts.ts";
import { ProduceGateNotApproved, requireProduceApproval } from "../videos/produce-gate.ts";
import { VideoFiles } from "../videos/video-files.ts";

class BgmNotDeclared extends Schema.TaggedError<BgmNotDeclared>()("BgmNotDeclared", {}) {}
class BgmNotEnabled extends Schema.TaggedError<BgmNotEnabled>()("BgmNotEnabled", {}) {}
class NarrationNotFound extends Schema.TaggedError<NarrationNotFound>()("NarrationNotFound", {
  videoId: Schema.String,
}) {}
class NarrationSilent extends Schema.TaggedError<NarrationSilent>()("NarrationSilent", {
  videoId: Schema.String,
}) {}
class LoudnessTargetMissed extends Schema.TaggedError<LoudnessTargetMissed>()(
  "LoudnessTargetMissed",
  { videoId: Schema.String },
) {}
class BgmPoolEmpty extends Schema.TaggedError<BgmPoolEmpty>()("BgmPoolEmpty", {}) {}
class BgmSongNotInPool extends Schema.TaggedError<BgmSongNotInPool>()("BgmSongNotInPool", {
  file: Schema.String,
}) {}
class BgmLoopTooShort extends Schema.TaggedError<BgmLoopTooShort>()("BgmLoopTooShort", {
  file: Schema.String,
}) {}
class BgmLoopOutOfRange extends Schema.TaggedError<BgmLoopOutOfRange>()("BgmLoopOutOfRange", {
  file: Schema.String,
}) {}

export const ExplainerMixAudioTrackTool = Tool.make("explainer_mix_audio_track", {
  description: [
    "Mix the final audio track of a cut of an explainer video (the long cut by default; 48 kHz stereo 16-bit WAV with a freshness key): ",
    "the narration track laid over a looped song of the channel's BGM pool, ducked under the narration by the paragraph times of the timing table, ",
    "then normalized to -14 LUFS with a true peak of -2 dBTP or less. The narration is measured and brought to the target first, the BGM is laid at the declared volume below it, ",
    "and the mix gets a simple gain to the target. When the channel declares BGM disabled, the narration alone goes through the same normalization. ",
    "The song is chosen from the video ID by rotation through the pool, or is the pool song named by song. The chosen song is part of the freshness key. ",
    "A track whose key is unchanged (narration, timing table, song file, loop point, volume, ducking depth) is reused without being written; force mixes it again. ",
    "For a clip short (cut short-<n>-clip) the narration is cut from the long narration track (never from the final track of the long cut) to the paragraph range of the candidate, from the start of its first paragraph to the end of its last, and mixed again; the track is audio/<cut>.wav, its length is the length of the range, and the range is part of the freshness key. ",
    "For a dedicated short the narration of the candidate (shorts/<n>/narration/) is mixed. A short is at most 60 seconds long. ",
    "Requires the produce gate to be approved. ",
    "Fails with BgmNotDeclared when the channel declares no BGM, with BgmNotEnabled when a song is named while BGM is disabled, ",
    "with VideoNotFound for an unknown video, with ProduceGateNotApproved before the produce gate is approved, ",
    "with ShortCandidateNotFound when the cut names a candidate that was never written or is withdrawn, with InvalidShortRange when the range of a clip is not in the long timing table any more, with ShortTooLong when a short is over 60 seconds, ",
    "with NarrationNotFound or NarrationSilent for the narration track and timing table, with LoudnessTargetMissed when the mixed track does not reach -14 LUFS ± 0.5 and -2 dBTP or less, ",
    "with BgmPoolNotFound or InvalidBgmPool for the pool, with BgmPoolEmpty for a pool without songs, with BgmSongNotInPool for a named song the pool does not list, ",
    "with BgmSongNotFound or BgmSongUnreadable for a song file, and with BgmLoopTooShort or BgmLoopOutOfRange when no loop can be made from the song. ",
    "Nothing is written when it fails, and the track is never mixed without the BGM that is enabled. ",
    "Returns the key of the track, the song used (null when BGM is disabled) and whether the existing track was reused.",
  ].join(""),
  failure: Schema.Union([
    ChannelConfigNotFound,
    InvalidChannelConfig,
    NotExplainerChannel,
    BgmNotDeclared,
    BgmNotEnabled,
    VideoNotFound,
    ProduceGateNotApproved,
    ShortCandidateNotFound,
    InvalidShortRange,
    ShortTooLong,
    NarrationNotFound,
    NarrationSilent,
    LoudnessTargetMissed,
    BgmPoolNotFound,
    InvalidBgmPool,
    BgmPoolEmpty,
    BgmSongNotInPool,
    BgmSongNotFound,
    BgmSongUnreadable,
    BgmLoopTooShort,
    BgmLoopOutOfRange,
  ]),
  parameters: Schema.Struct({
    cut: CutField,
    force: Schema.optionalKey(Schema.Boolean).annotate({
      description: "Mix the track again even when its inputs are unchanged.",
    }),
    song: Schema.optionalKey(Schema.String).annotate({
      description:
        "File of a song in the BGM pool (as written in the pool) to use instead of the rotation.",
    }),
    videoId: Schema.String.annotate({ description: "Video ID returned by explainer_write_plan." }),
  }),
  success: Schema.Struct({
    reused: Schema.Boolean,
    song: Schema.NullOr(Schema.String),
    trackKey: Schema.String,
    videoId: Schema.String,
  }),
}).annotate(Tool.Strict, true);

// ---- 定数（設定には出さない） ----

/** 処理の版。ミックスの手順を変えたら上げる（鮮度の鍵に入る）。 */
const processVersion = 1;
const rate = outputSampleRate;
const targetLufs = -14;
const truePeakCeilingDb = -2;
// 先読みリミッターの上限は、サンプル間のピークの分だけ true peak の上限より低くする。
const limiterCeilingDb = -2.6;
const limiterLookaheadSeconds = 0.003;
const loudnessToleranceLu = 0.1;
// 保存してよい音声の許容（受入条件）。収束の目標（loudnessToleranceLu）とは別の定数。
const acceptedToleranceLu = 0.5;
const maxNormalizationPasses = 4;
const loopCrossfadeSeconds = 2;
const silenceThreshold = 10 ** (-60 / 20);
// ダッキング。立ち上がり（沈める傾き）と戻りの和は、無音のしきい値より短くする。
const duckingReturnSeconds = 1.5;
const duckingAttackSeconds = 0.3;
const duckingReleaseSeconds = 0.6;
const fadeInSeconds = 0.5;
const fadeOutSeconds = 1;

const toLinear = (db: number) => 10 ** (db / 20);
const seconds = (value: number) => Math.round(value * rate);

// ---- ダッキングの曲線（純粋・決定的） ----

interface Paragraph {
  readonly endSeconds: number;
  readonly startSeconds: number;
}

type Keyframe = readonly [time: number, gain: number];

// ナレーションのない区間（先頭・段落の間・末尾）。しきい値以下の無音では沈めたまま、超えたときだけ戻す。
const silences = (paragraphs: readonly Paragraph[], duration: number) =>
  [0, ...paragraphs.map((paragraph) => paragraph.endSeconds)].map(
    (start, index) => [start, paragraphs[index]?.startSeconds ?? duration] as const,
  );

const shortSilence = ([start, end]: readonly [number, number], ducked: number): Keyframe[] => [
  [start, ducked],
  [end, ducked],
];

// 先頭の無音は戻した状態から始まり、末尾の無音は戻したまま終わる。
const longSilence = (
  [start, end]: readonly [number, number],
  position: { readonly first: boolean; readonly last: boolean },
  ducked: number,
): Keyframe[] => {
  const entry: Keyframe[] = position.first
    ? [[start, 1]]
    : [
        [start, ducked],
        [start + duckingReleaseSeconds, 1],
      ];
  const exit: Keyframe[] = position.last
    ? [[end, 1]]
    : [
        [end - duckingAttackSeconds, 1],
        [end, ducked],
      ];
  return [...entry, ...exit];
};

const silenceKeyframes = (
  silence: readonly [number, number],
  position: { readonly first: boolean; readonly last: boolean },
  ducked: number,
): Keyframe[] =>
  silence[1] - silence[0] <= duckingReturnSeconds
    ? shortSilence(silence, ducked)
    : longSilence(silence, position, ducked);

const keyframesOf = (paragraphs: readonly Paragraph[], duration: number, ducked: number) =>
  silences(paragraphs, duration).flatMap((silence, index, all) => [
    ...silenceKeyframes(silence, { first: index === 0, last: index === all.length - 1 }, ducked),
    ...(paragraphs[index] === undefined
      ? []
      : ([
          [paragraphs[index].startSeconds, ducked],
          [paragraphs[index].endSeconds, ducked],
        ] as const)),
  ]);

const renderKeyframes = (keyframes: readonly Keyframe[], length: number): Float32Array => {
  const gain = new Float32Array(length).fill(1);
  keyframes.slice(1).forEach(([time, value], index) => {
    const [previousTime, previousValue] = keyframes[index] ?? [0, 1];
    const from = Math.min(length - 1, seconds(previousTime));
    const to = Math.min(length - 1, seconds(time));
    for (let sample = from; sample <= to; sample += 1) {
      const progress = to === from ? 1 : (sample - from) / (to - from);
      gain[sample] = previousValue + (value - previousValue) * progress;
    }
  });
  return gain;
};

const applyFades = (gain: Float32Array, duration: number): Float32Array =>
  gain.map((value, index) => {
    const time = index / rate;
    return value * Math.min(1, time / fadeInSeconds, (duration - time) / fadeOutSeconds);
  });

/**
 * BGM に掛ける線形のゲインを、サンプルごとに返す。1.0 は戻した状態、`10 ** (-duckingDb / 20)` は沈めた状態。
 * ナレーションの段落の区間だけから決まる。0.35 秒の段落の間・0.6 秒のシーンの間・ちょうど 1.5 秒の無音では沈めたままで、1.5 秒を超える無音でだけ戻る。
 */
export const duckingGain = (input: {
  readonly duckingDb: number;
  readonly durationSeconds: number;
  readonly paragraphs: readonly Paragraph[];
  readonly sampleRate: number;
}): Float32Array => {
  const length = Math.round(input.durationSeconds * input.sampleRate);
  if (input.paragraphs.length === 0) {
    return applyFades(new Float32Array(length).fill(1), input.durationSeconds);
  }
  const keyframes = keyframesOf(
    input.paragraphs,
    input.durationSeconds,
    toLinear(-input.duckingDb),
  );
  return applyFades(renderKeyframes(keyframes, length), input.durationSeconds);
};

// ---- 音声の部品（引数は書き換えず、新しい配列を返す） ----

const perChannel = (audio: StereoAudio, transform: (channel: Float32Array) => Float32Array) =>
  [transform(audio[0]), transform(audio[1])] as const satisfies StereoAudio;

const scale = (audio: StereoAudio, gain: number) =>
  perChannel(audio, (channel) => channel.map((value) => value * gain));

const addChannel = (left: Float32Array, right: Float32Array) =>
  left.map((value, index) => value + (right[index] ?? 0));

const add = (left: StereoAudio, right: StereoAudio): StereoAudio => [
  addChannel(left[0], right[0]),
  addChannel(left[1], right[1]),
];

// 1 サンプルあたりの、上限を超えないために必要なゲイン（超えなければ 1）。
const requiredGain = (audio: StereoAudio, ceiling: number) =>
  audio[0].map((value, index) => {
    const peak = Math.max(Math.abs(value), Math.abs(audio[1][index] ?? 0));
    return peak > ceiling ? ceiling / peak : 1;
  });

// 先読み: 各サンプルのゲインを、そのサンプルを含む先読みの窓すべてに行き渡らせる（窓の最小値）。
const spreadBackwards = (required: Float32Array, window: number) => {
  const spread = new Float32Array(required.length).fill(1);
  required.forEach((gain, index) => {
    if (gain >= 1) {
      return;
    }
    for (let at = Math.max(0, index - window + 1); at <= index; at += 1) {
      spread[at] = Math.min(spread[at] ?? 1, gain);
    }
  });
  return spread;
};

// 直近の窓の平均（窓の外は 1）。ピークのサンプルでは、窓すべてがそのサンプルのゲイン以下なので、上限を超えない。
const smoothGain = (spread: Float32Array, window: number) => {
  const smooth = new Float32Array(spread.length);
  // 窓の外は 1。最初の窓は、1 が window 個並んでいるものとして始める。
  let sum = window;
  spread.forEach((gain, index) => {
    sum += gain - (spread[index - window] ?? 1);
    smooth[index] = sum / window;
  });
  return smooth;
};

const limit = (audio: StereoAudio): StereoAudio => {
  const window = Math.max(1, seconds(limiterLookaheadSeconds));
  const required = requiredGain(audio, toLinear(limiterCeilingDb));
  const gain = smoothGain(spreadBackwards(required, window), window);
  return perChannel(audio, (channel) => channel.map((value, index) => value * (gain[index] ?? 1)));
};

// ---- ループ素材 ----

const loudest = (audio: StereoAudio, index: number) =>
  Math.max(Math.abs(audio[0][index] ?? 0), Math.abs(audio[1][index] ?? 0));

const firstAudible = (audio: StereoAudio): number => {
  const length = audio[0].length;
  let index = 0;
  while (index < length && loudest(audio, index) <= silenceThreshold) {
    index += 1;
  }
  return index;
};

const lastAudible = (audio: StereoAudio): number => {
  let index = audio[0].length - 1;
  while (index >= 0 && loudest(audio, index) <= silenceThreshold) {
    index -= 1;
  }
  return index;
};

const slice = (audio: StereoAudio, from: number, to: number) =>
  perChannel(audio, (channel) => channel.slice(from, to));

// 尾を頭へ、等パワーのクロスフェードで重ねる。1 周期の長さは「素材の長さ - クロスフェード長」。
const crossfaded = (material: StereoAudio, fade: number) =>
  perChannel(material, (channel) => {
    const period = channel.length - fade;
    return Float32Array.from({ length: period }, (_, index) => {
      if (index >= fade) {
        return channel[index] ?? 0;
      }
      const angle = (Math.PI / 2) * (index / fade);
      return (
        (channel[index] ?? 0) * Math.sin(angle) + (channel[period + index] ?? 0) * Math.cos(angle)
      );
    });
  });

// プールの記録のループ点。人間が決めた継ぎ目なので、クロスフェードなしでそのまま繰り返す。
const recordedLoop = (audio: StereoAudio, song: BgmSong, loop: NonNullable<BgmSong["loop"]>) =>
  Effect.gen(function* () {
    const end = seconds(loop.endSeconds);
    if (end > audio[0].length) {
      return yield* new BgmLoopOutOfRange({ file: song.file });
    }
    const unit = slice(audio, seconds(loop.startSeconds), end);
    return unit[0].length === 0 ? yield* new BgmLoopTooShort({ file: song.file }) : unit;
  });

// 頭と尾の無音を削り、尾を頭へクロスフェードで重ねる。素材がクロスフェード長以下なら作れない。
const trimmedLoop = (audio: StereoAudio, song: BgmSong) =>
  Effect.gen(function* () {
    const from = firstAudible(audio);
    const to = lastAudible(audio) + 1;
    if (to <= from) {
      return yield* new BgmSongUnreadable({ file: song.file });
    }
    const material = slice(audio, from, to);
    if (material[0].length <= seconds(loopCrossfadeSeconds)) {
      return yield* new BgmLoopTooShort({ file: song.file });
    }
    return crossfaded(
      material,
      Math.min(seconds(loopCrossfadeSeconds), Math.floor(material[0].length / 2)),
    );
  });

const loopUnit = (audio: StereoAudio, song: BgmSong) =>
  song.loop === undefined ? trimmedLoop(audio, song) : recordedLoop(audio, song, song.loop);

const tile = (unit: StereoAudio, length: number) =>
  perChannel(unit, (channel) =>
    Float32Array.from({ length }, (_, index) => channel[index % channel.length] ?? 0),
  );

// ---- 選曲 ----

const rotationIndex = (videoId: string, count: number) =>
  createHash("sha256").update(videoId).digest().readUInt32BE(0) % count;

const chooseSong = (songs: readonly BgmSong[], videoId: string, named: string | undefined) =>
  Effect.gen(function* () {
    if (songs.length === 0) {
      return yield* new BgmPoolEmpty();
    }
    if (named === undefined) {
      return songs[rotationIndex(videoId, songs.length)] as BgmSong;
    }
    const found = songs.find((song) => song.file === named);
    return found ?? (yield* new BgmSongNotInPool({ file: named }));
  });

// ---- 設定・入力 ----

// BGM の宣言。無効のチャンネルは undefined（プールは読まない）。宣言が無い・無効なのに曲を指定した、は失敗。
const resolveBgm = (named: string | undefined) =>
  Effect.gen(function* () {
    const bgm = (yield* (yield* ChannelSettings).requireExplainer).bgm;
    if (bgm === undefined) {
      return yield* new BgmNotDeclared();
    }
    if (bgm.enabled) {
      return bgm;
    }
    return named === undefined ? undefined : yield* new BgmNotEnabled();
  });

interface Narration {
  readonly paragraphs: readonly Paragraph[];
  readonly samples: Float32Array;
  /** 長尺以外の、鮮度の鍵に足すもの（ショートのカットの名前と、切り抜きの範囲）。 */
  readonly scope: unknown;
  readonly table: TimingTable;
  readonly timingBytes: Uint8Array;
  readonly trackBytes: Uint8Array;
}

// 置き場のナレーション（track.wav と timing.json）をそのまま読む。
const readNarrationFiles = (videoId: string, source: ScriptTarget) =>
  Effect.gen(function* () {
    const files = yield* VideoFiles;
    const found = Option.all({
      timing: yield* files.read(narrationKey(source, "timing.json")),
      track: yield* files.read(narrationKey(source, "track.wav")),
    });
    const pcm = Option.flatMap(found, ({ track }) => Option.fromNullishOr(parseWav(track))).pipe(
      Option.filter((wav) => wav.sampleRate === rate),
    );
    if (Option.isNone(found) || Option.isNone(pcm)) {
      return yield* new NarrationNotFound({ videoId });
    }
    const table = yield* decodeTimingTableBytes(videoId, found.value.timing).pipe(
      Effect.mapError(() => new NarrationNotFound({ videoId })),
    );
    return {
      paragraphs: table.paragraphs,
      samples: Float32Array.from(pcm.value.samples, (sample) => sample / 32_768),
      scope: undefined,
      table,
      timingBytes: found.value.timing,
      trackBytes: found.value.track,
    } satisfies Narration;
  });

// 切り抜き: 範囲の最初の段落の頭から最後の段落の終わりまでのサンプルを、長尺のナレーションのトラックから切り出す。段落の時刻は区間の頭からの時刻にする。
const clipNarration = (ref: ShortRef, range: ParagraphRange, narration: Narration) =>
  Effect.gen(function* () {
    const span = yield* clipSpan(ref, narration.table, range);
    const from = seconds(span.startSeconds);
    return {
      ...narration,
      paragraphs: span.paragraphs.map((paragraph) => ({
        endSeconds: paragraph.endSeconds - span.startSeconds,
        startSeconds: paragraph.startSeconds - span.startSeconds,
      })),
      samples: narration.samples.slice(from, from + seconds(span.endSeconds - span.startSeconds)),
      scope: { cut: ref.cut, range: rangeKey(range) },
    } satisfies Narration;
  });

// カットのナレーション。長尺は長尺のナレーション、専用は専用のナレーション（60 秒まで）、切り抜きは長尺のナレーションの範囲。
const readNarration = (videoId: string, target: CutTarget) =>
  Effect.gen(function* () {
    const narration = yield* readNarrationFiles(videoId, sourceTarget(videoId, target));
    if (target.kind === "long") {
      return narration;
    }
    const ref = { cut: target.cut, number: target.number, videoId };
    if (target.kind === "clip") {
      return yield* clipNarration(ref, target.version.range, narration);
    }
    yield* requireShortLength(ref, narration.samples.length / rate);
    return { ...narration, scope: { cut: target.cut } } satisfies Narration;
  });

// ---- 鮮度の鍵と成果物 ----

const sha256 = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");

interface ChosenSong {
  readonly bytes: Uint8Array;
  readonly song: BgmSong;
}

const freshnessKey = (narration: Narration, bgm: Bgm | undefined, chosen: ChosenSong | undefined) =>
  sha256(
    JSON.stringify([
      processVersion,
      sha256(narration.trackBytes),
      sha256(narration.timingBytes),
      bgm === undefined || chosen === undefined
        ? "off"
        : {
            duckingDb: bgm.duckingDb,
            file: chosen.song.file,
            hash: sha256(chosen.bytes),
            loop: chosen.song.loop ?? null,
            volumeDb: bgm.volumeDb,
          },
      ...(narration.scope === undefined ? [] : [narration.scope]),
    ]),
  );

// audioSha256 は、書いた WAV の中身のハッシュ。WAV と JSON は別々に書くので、片方だけが新しい状態を再利用しないために持つ。
const Facts = Schema.Struct({
  audioSha256: Schema.String,
  key: Schema.String,
  song: Schema.NullOr(Schema.String),
});
const decodeFacts = Schema.decodeUnknownOption(Schema.fromJsonString(Facts));

const existingTrack = (videoId: string, cut: string, key: string) =>
  Effect.gen(function* () {
    const files = yield* VideoFiles;
    const facts = Option.flatMap(yield* files.read(audioFactsKey(videoId, cut)), (bytes) =>
      decodeFacts(new TextDecoder().decode(bytes)),
    );
    const wav = yield* files.read(audioTrackKey(videoId, cut));
    return Option.filter(
      facts,
      (found) => found.key === key && Option.isSome(wav) && sha256(wav.value) === found.audioSha256,
    );
  });

// ---- ミックス ----

const measure = (audio: StereoAudio) => integratedLoudness(audio, rate);

// BGM の床: ループ素材を並べ、ナレーション比の音量に合わせ、ダッキングの曲線を掛ける。
const bgmBed = (chosen: ChosenSong, bgm: Bgm, narration: Narration) =>
  Effect.gen(function* () {
    const file = chosen.song.file;
    const decoded = yield* decodeStereo(chosen.bytes).pipe(
      Effect.mapError(() => new BgmSongUnreadable({ file })),
    );
    const length = narration.samples.length;
    const stream = tile(yield* loopUnit(decoded, chosen.song), length);
    const loudness = measure(stream);
    if (loudness === null) {
      return yield* new BgmSongUnreadable({ file });
    }
    const gain = toLinear(targetLufs + bgm.volumeDb - loudness);
    const curve = duckingGain({
      duckingDb: bgm.duckingDb,
      durationSeconds: length / rate,
      paragraphs: narration.paragraphs,
      sampleRate: rate,
    });
    return perChannel(stream, (channel) =>
      channel.map((value, index) => value * gain * (curve[index] ?? 1)),
    );
  });

// 目標のゲインでリミッターを通し、loudness が外れたらゲインを直して繰り返す。
const settle = (mix: StereoAudio, gain: number, passes: number): StereoAudio => {
  const limited = limit(scale(mix, gain));
  const loudness = measure(limited);
  if (loudness === null || passes <= 1 || Math.abs(loudness - targetLufs) <= loudnessToleranceLu) {
    return limited;
  }
  return settle(mix, gain * toLinear(targetLufs - loudness), passes - 1);
};

// 最後に実測し、true peak が上限を超えていれば、一定のゲインで下げる。
const holdTruePeak = (audio: StereoAudio): StereoAudio => {
  const peak = truePeak(audio);
  return peak <= truePeakCeilingDb
    ? audio
    : scale(audio, toLinear(truePeakCeilingDb - 0.05 - peak));
};

const normalize = (mix: StereoAudio, videoId: string) =>
  Effect.gen(function* () {
    const loudness = measure(mix);
    if (loudness === null) {
      return yield* new NarrationSilent({ videoId });
    }
    return holdTruePeak(settle(mix, toLinear(targetLufs - loudness), maxNormalizationPasses));
  });

const withinTarget = (audio: StereoAudio): boolean => {
  const loudness = measure(audio);
  return (
    loudness !== null &&
    Math.abs(loudness - targetLufs) <= acceptedToleranceLu &&
    truePeak(audio) <= truePeakCeilingDb
  );
};

// 書く直前に、エンコードしたバイト列を読み戻して測る。目標に届かない音声は保存しない。
const requireTarget = (videoId: string, wav: Uint8Array) =>
  Effect.gen(function* () {
    const audio = yield* decodeStereo(wav).pipe(Effect.orDie);
    return withinTarget(audio) ? wav : yield* new LoudnessTargetMissed({ videoId });
  });

const silent = (length: number): StereoAudio => [
  new Float32Array(length),
  new Float32Array(length),
];

// ナレーションを測って目標へ寄せる → BGM を敷く → ミックスを目標へ単純ゲイン → true peak を抑える。BGM が無効でも同じ手順。
const mixDown = (
  videoId: string,
  narration: Narration,
  bgm: Bgm | undefined,
  chosen: ChosenSong | undefined,
) =>
  Effect.gen(function* () {
    const voice: StereoAudio = [narration.samples, narration.samples];
    const loudness = measure(voice);
    if (loudness === null) {
      return yield* new NarrationSilent({ videoId });
    }
    const bed =
      bgm === undefined || chosen === undefined
        ? silent(narration.samples.length)
        : yield* bgmBed(chosen, bgm, narration);
    return yield* normalize(add(scale(voice, toLinear(targetLufs - loudness)), bed), videoId);
  });

const loadChosen = (bgm: Bgm | undefined, videoId: string, named: string | undefined) =>
  Effect.gen(function* () {
    if (bgm === undefined) {
      return undefined;
    }
    const pool = yield* BgmPool;
    const song = yield* chooseSong((yield* pool.read).songs, videoId, named);
    return { bytes: yield* pool.readSong(song.file), song } satisfies ChosenSong;
  });

const mixAudioTrack = Effect.fn("explainer.mixAudioTrack")(function* ({
  cut,
  force,
  song,
  videoId,
}: {
  readonly cut?: string;
  readonly force?: boolean;
  readonly song?: string;
  readonly videoId: string;
}) {
  const bgm = yield* resolveBgm(song);
  yield* requireLatestPlan(videoId);
  yield* requireProduceApproval(videoId);
  const target = yield* resolveCut(videoId, cut);
  const narration = yield* readNarration(videoId, target);
  const chosen = yield* loadChosen(bgm, videoId, song);
  const key = freshnessKey(narration, bgm, chosen);
  const trackKey = audioTrackKey(videoId, target.cut);
  const existing = force === true ? Option.none() : yield* existingTrack(videoId, target.cut, key);
  if (Option.isSome(existing)) {
    return { reused: true, song: existing.value.song, trackKey, videoId };
  }
  const encoded = yield* encodeStereoWav(yield* mixDown(videoId, narration, bgm, chosen));
  const wav = yield* requireTarget(videoId, encoded);
  const files = yield* VideoFiles;
  const used = chosen?.song.file ?? null;
  yield* files.write(trackKey, wav);
  yield* files.write(
    audioFactsKey(videoId, target.cut),
    new TextEncoder().encode(
      JSON.stringify({ audioSha256: sha256(wav), key, song: used }, null, 2),
    ),
  );
  return { reused: false, song: used, trackKey, videoId };
});

// 同じ動画への並行する呼び出しが、同じ一時ファイルへ書いてぶつからないよう、直列にする。
const mixLock = Semaphore.makeUnsafe(1);

export const explainerMixAudioTrack = (input: {
  readonly cut?: string;
  readonly force?: boolean;
  readonly song?: string;
  readonly videoId: string;
}) => mixLock.withPermits(1)(mixAudioTrack(input));
