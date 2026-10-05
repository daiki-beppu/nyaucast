import { mkdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";

import {
  concat,
  decodeWav,
  explainerConfigWithBgm,
  loudness,
  loudnessBetween,
  narration,
  noise,
  poolPath,
  poolSong,
  pulseNarration,
  rmsDb,
  sampleRate,
  silence,
  sine,
  songOf,
  stereoWav,
  tonePower,
  truePeakDbtp,
  type NarrationFixture,
} from "../../../test/bgm-helpers.ts";
import {
  accepts,
  failureFacts,
  publishedAdditionalProperties,
  writeVideoConfig,
} from "../../../test/helpers.ts";
import { source } from "../../../test/explainer-helpers.ts";
import {
  approveProduce,
  recordPlan,
  rejectProduce,
  scriptInput,
} from "../../../test/narration-helpers.ts";
import {
  clipCut,
  cutAudioFactsKey,
  cutAudioKey,
  dedicatedCut,
  paragraphRange,
  shortTimingKey,
  shortTrackKey,
  withdrawShort,
  writeShort,
} from "../../../test/short-helpers.ts";
import {
  channelFileExists,
  readChannelFile,
  writeChannelFile,
} from "../../../test/thumbnail-helpers.ts";
import { callTool, rejectionReason, withToolChannel } from "../../../test/tool-helpers.ts";
import { duckingGain, ExplainerVideoMixAudioTrackTool } from "./video.mixAudioTrack.ts";

// 契約（この issue の計画 D1・D7・D8）:
//   tool 名 video_mix_audio_track、パラメータ { videoId, song?, force? }。
//   成果物は videos/<id>/audio/track.wav（48 kHz・2ch・16-bit PCM）と videos/<id>/audio/track.json（{ key, song }）。
//   duckingGain({ duckingDb, durationSeconds, paragraphs: [{ startSeconds, endSeconds }], sampleRate }): Float32Array
//     — BGM に掛ける線形のゲインをサンプルごとに返す。1.0 は戻した状態、10 ** (-duckingDb / 20) は沈めた状態。
//   ダッキングの時間の値（立ち上がり・戻り・しきい値 1.5 秒・フェード）はコードの定数で、設定からは変えられない。

const slow = 120_000;
// 60 秒ちょうどの音声を合成・正規化するテストは単独で約 12 秒かかる（他は 3 秒前後）。境界を確かめるので
// 入力は短くできない。負荷で 10 倍遅れても落ちないよう、描画のテストと同じ 300 秒を渡す（#644）。
const sixtySecondMix = 300_000;
const audioKey = "videos/V1/audio/track.wav";
const factsKey = "videos/V1/audio/track.json";

// ---- 信号の fixture ----

// 段落の間は 0.35 秒（段落の間合い）と 5.85 秒（1.5 秒を超える無音）。声は 440 Hz の正弦波。
const gapParagraphs = [
  [0.8, 2.8],
  [3.15, 5.15],
  [11, 12.5],
] as const;
const gapDuration = 13.9;
const plainNarration = narration({ duration: gapDuration, paragraphs: gapParagraphs });
// 1 秒ごとの鋭いピークを持つ声。目標の音量へ増幅すると 0 dBFS を超える。
const spikyNarration = narration({
  duration: gapDuration,
  paragraphs: gapParagraphs,
  spikes: true,
});
const shortNarration = narration({ duration: 4, paragraphs: [[0.8, 2]] });

// 両チャンネルが別のノイズで、頭と尾に無音がある曲。
const noiseSong = (seed: number, seconds = 5, edge = 0.3) =>
  stereoWav(
    concat(silence(edge), noise(seconds, seed, 0.2), silence(edge)),
    concat(silence(edge), noise(seconds, seed + 1, 0.2), silence(edge)),
  );

const songA = "bgm/a.wav";
const songB = "bgm/b.wav";
const twoSongs = { [songA]: noiseSong(1), [songB]: noiseSong(7) };

// ---- チャンネルの準備 ----

interface ChannelOptions {
  /** config/channel/video.json の bgm。キーを書かない（`"bgm" in`）と宣言しない。 */
  readonly bgm?: Record<string, unknown> | undefined;
  readonly narration?: NarrationFixture | undefined;
  /** プール。文字列はそのまま書く。キーを書かないと、songs の全曲を並べたプールを書く。undefined なら書かない。 */
  readonly pool?: unknown;
  readonly songs?: Readonly<Record<string, Uint8Array>>;
  readonly unapproved?: boolean;
}

const writeNarration = (channelRoot: string, fixture: NarrationFixture, videoId = "V1") => {
  writeChannelFile(channelRoot, `videos/${videoId}/narration/track.wav`, fixture.track);
  writeChannelFile(
    channelRoot,
    `videos/${videoId}/narration/timing.json`,
    new TextEncoder().encode(fixture.timing),
  );
};

const poolContent = (options: ChannelOptions, songs: Readonly<Record<string, Uint8Array>>) => {
  if (!("pool" in options))
    return JSON.stringify({ songs: Object.keys(songs).map((file) => poolSong(file)) });
  if (options.pool === undefined) return undefined;
  return typeof options.pool === "string" ? options.pool : JSON.stringify(options.pool);
};

const writeSongs = (channelRoot: string, songs: Readonly<Record<string, Uint8Array>>) => {
  for (const [file, bytes] of Object.entries(songs)) writeChannelFile(channelRoot, file, bytes);
};

// ナレーション・曲・プールを、チャンネルのファイルとして置く。
const seedFiles = (channelRoot: string, options: ChannelOptions) => {
  const fixture = "narration" in options ? options.narration : plainNarration;
  if (fixture !== undefined) writeNarration(channelRoot, fixture);
  const songs = options.songs ?? twoSongs;
  writeSongs(channelRoot, songs);
  const pool = poolContent(options, songs);
  if (pool !== undefined) writeChannelFile(channelRoot, poolPath, new TextEncoder().encode(pool));
};

// 企画を書いて produce ゲートを承認した動画 V1 に、ナレーションと BGM のプール・曲を置いて use を動かす。
const inChannel = <A, E, R>(
  prefix: string,
  options: ChannelOptions,
  use: (channelRoot: string) => Effect.Effect<A, E, R>,
) =>
  withToolChannel(
    prefix,
    { config: explainerConfigWithBgm("bgm" in options ? options.bgm : { enabled: true }) },
    (channelRoot) =>
      Effect.gen(function* () {
        yield* recordPlan();
        if (options.unapproved !== true) yield* approveProduce();
        seedFiles(channelRoot, options);
        return yield* use(channelRoot);
      }),
  );

const mix = (extra: { force?: boolean; song?: string; videoId?: string } = {}) =>
  callTool("video_mix_audio_track", { videoId: "V1", ...extra });

interface TrackFacts {
  readonly key: string;
  readonly song: string | null;
}

const readFacts = (channelRoot: string) =>
  JSON.parse(new TextDecoder().decode(readChannelFile(channelRoot, factsKey))) as TrackFacts;

const readTrack = (channelRoot: string) => decodeWav(readChannelFile(channelRoot, audioKey));

const trackBytes = (channelRoot: string) => readChannelFile(channelRoot, audioKey);

const sameBytes = (left: Uint8Array, right: Uint8Array) =>
  left.length === right.length && left.every((byte, index) => byte === right[index]);

const noArtifacts = (channelRoot: string) => {
  assert.isFalse(channelFileExists(channelRoot, audioKey));
  assert.isFalse(channelFileExists(channelRoot, factsKey));
};

describe("video.mixAudioTrack: parameters", () => {
  it("is named with its wire name", () => {
    assert.strictEqual(ExplainerVideoMixAudioTrackTool.name, "video_mix_audio_track");
  });

  it("accepts a video, an optional song and an optional force, and rejects every other key", () => {
    const schema = ExplainerVideoMixAudioTrackTool.parametersSchema;

    assert.isTrue(accepts(schema, { videoId: "V1" }));
    assert.isTrue(accepts(schema, { force: true, song: songA, videoId: "V1" }));
    assert.isFalse(accepts(schema, { song: songA }));
    assert.isFalse(accepts(schema, { song: 3, videoId: "V1" }));
    assert.isFalse(accepts(schema, { videoId: "V1", volumeDb: -6 }));
    assert.isFalse(accepts(schema, { duckingDb: 3, videoId: "V1" }));
    assert.strictEqual(publishedAdditionalProperties(ExplainerVideoMixAudioTrackTool), false);
  });

  it.effect("rejects an unknown key as invalid parameters, before anything is written", () =>
    inChannel("nyaucast-mix-unknown-key-", { narration: shortNarration }, (channelRoot) =>
      Effect.gen(function* () {
        const request = { gain: 3, videoId: "V1" };

        assert.strictEqual(
          yield* rejectionReason("video_mix_audio_track", request),
          "ToolParameterValidationError",
        );
        noArtifacts(channelRoot);
      }),
    ),
  );
});

describe("video.mixAudioTrack: the final audio track", () => {
  it.effect(
    "is a 48 kHz stereo 16-bit PCM WAV as long as the narration, and says where it is",
    () =>
      inChannel("nyaucast-mix-format-", {}, (channelRoot) =>
        Effect.gen(function* () {
          const result = yield* mix();

          const track = readTrack(channelRoot);
          assert.strictEqual(result.trackKey, audioKey);
          assert.strictEqual(result.videoId, "V1");
          assert.isFalse(result.reused);
          assert.strictEqual(track.format, 1);
          assert.strictEqual(track.bitsPerSample, 16);
          assert.strictEqual(track.sampleRate, sampleRate);
          assert.strictEqual(track.channels.length, 2);
          assert.strictEqual(track.channels[0]?.length, Math.round(gapDuration * sampleRate));
        }),
      ),
    slow,
  );

  it.effect(
    "has an integrated loudness of -14 LUFS ± 0.5 and a true peak of -2 dBTP or less, with BGM laid under a peaky narration",
    () =>
      inChannel("nyaucast-mix-loudness-bgm-", { narration: spikyNarration }, (channelRoot) =>
        Effect.gen(function* () {
          yield* mix();

          const { channels } = readTrack(channelRoot);
          assert.closeTo(loudness(channels) ?? Number.NaN, -14, 0.5);
          assert.isAtMost(truePeakDbtp(channels), -2);
        }),
      ),
    slow,
  );

  it.effect(
    "goes through the same normalization when BGM is off: -14 LUFS ± 0.5, -2 dBTP or less, the pool is not read, and the narration stays digitally silent between paragraphs",
    () =>
      inChannel(
        "nyaucast-mix-loudness-off-",
        { bgm: { enabled: false }, narration: spikyNarration, pool: undefined, songs: {} },
        (channelRoot) =>
          Effect.gen(function* () {
            const result = yield* mix();

            const { channels } = readTrack(channelRoot);
            assert.isFalse(result.reused);
            assert.closeTo(loudness(channels) ?? Number.NaN, -14, 0.5);
            assert.isAtMost(truePeakDbtp(channels), -2);
            const gap = channels[0]?.slice(
              Math.round(2.9 * sampleRate),
              Math.round(3.05 * sampleRate),
            );
            assert.isTrue(gap?.every((value) => Math.abs(value) < 1e-3));
          }),
      ),
    slow,
  );

  it.effect(
    "brings a narration that needs no limiting to -14 LUFS ± 0.5 as well",
    () =>
      inChannel(
        "nyaucast-mix-loudness-plain-",
        { bgm: { enabled: false }, pool: undefined, songs: {} },
        (channelRoot) =>
          Effect.gen(function* () {
            yield* mix();

            assert.closeTo(loudness(readTrack(channelRoot).channels) ?? Number.NaN, -14, 0.5);
          }),
      ),
    slow,
  );

  it.effect(
    "lays the BGM at the declared volume below the narration (default -12 dB)",
    () =>
      inChannel("nyaucast-mix-volume-default-", {}, (channelRoot) =>
        Effect.gen(function* () {
          yield* mix();

          const { channels } = readTrack(channelRoot);
          const speech = loudnessBetween(channels, 1.0, 2.6);
          const bed = loudnessBetween(channels, 8.3, 9.3);
          assert.closeTo(bed - speech, -12, 1);
        }),
      ),
    slow,
  );

  it.effect(
    "lays the BGM at the volume the channel declares",
    () =>
      inChannel(
        "nyaucast-mix-volume-override-",
        { bgm: { enabled: true, volumeDb: -6 } },
        (channelRoot) =>
          Effect.gen(function* () {
            yield* mix();

            const { channels } = readTrack(channelRoot);
            const speech = loudnessBetween(channels, 1.0, 2.6);
            const bed = loudnessBetween(channels, 8.3, 9.3);
            assert.closeTo(bed - speech, -6, 1);
          }),
      ),
    slow,
  );

  it.effect(
    "keeps the BGM under the narration down by the default 6 dB through a paragraph pause, and brings it back in a long silence",
    () =>
      inChannel("nyaucast-mix-ducking-default-", {}, (channelRoot) =>
        Effect.gen(function* () {
          yield* mix();

          const left = readTrack(channelRoot).channels[0] as Float32Array;
          const duckedPause = rmsDb(left, 2.85, 3.1);
          const restored = rmsDb(left, 8.3, 9.3);
          assert.closeTo(restored - duckedPause, 6, 1.5);
        }),
      ),
    slow,
  );

  it.effect(
    "ducks by the depth the channel declares",
    () =>
      inChannel(
        "nyaucast-mix-ducking-override-",
        { bgm: { duckingDb: 12, enabled: true } },
        (channelRoot) =>
          Effect.gen(function* () {
            yield* mix();

            const left = readTrack(channelRoot).channels[0] as Float32Array;
            const duckedPause = rmsDb(left, 2.85, 3.1);
            const restored = rmsDb(left, 8.3, 9.3);
            assert.closeTo(restored - duckedPause, 12, 1.5);
          }),
      ),
    slow,
  );
});

describe("video.mixAudioTrack: the loop", () => {
  // 頭と尾に 1.5 秒の無音がある 4 秒の曲を、無音を削って繰り返す。削っていなければ、周期ごとに BGM が途切れる。
  it.effect(
    "trims the silence at the head and the tail of a song before it loops",
    () => {
      const song = noiseSong(3, 4, 1.5);
      const tail = narration({ duration: 14, paragraphs: [[0.8, 1.4]] });
      return inChannel(
        "nyaucast-mix-loop-trim-",
        { narration: tail, songs: { [songA]: song } },
        (channelRoot) =>
          Effect.gen(function* () {
            yield* mix();

            const left = readTrack(channelRoot).channels[0] as Float32Array;
            const blocks = Array.from({ length: 28 }, (_, index) =>
              rmsDb(left, 4 + index * 0.25, 4.25 + index * 0.25),
            );
            const median = blocks.toSorted((a, b) => a - b)[14] ?? Number.NaN;
            assert.isAtLeast(Math.min(...blocks), median - 6);
          }),
      );
    },
    slow,
  );

  // 200 Hz → 1000 Hz → 3000 Hz（各 2 秒）。尾（3000 Hz）が頭（200 Hz）へ重なる継ぎ目では、両方が同時に鳴る。単純に切って繰り返すだけなら重ならない。
  it.effect(
    "overlaps the tail onto the head with a crossfade at the loop seam",
    () => {
      const song = songOf(concat(sine(2, 200, 0.2), sine(2, 1000, 0.2), sine(2, 3000, 0.2)));
      const late = narration({ duration: 7, hertz: 700, paragraphs: [[5, 6.5]] });
      return inChannel(
        "nyaucast-mix-loop-crossfade-",
        { narration: late, songs: { [songA]: song } },
        (channelRoot) =>
          Effect.gen(function* () {
            yield* mix();

            const left = readTrack(channelRoot).channels[0] as Float32Array;
            const seam = left.slice(Math.round(0.6 * sampleRate), Math.round(1.8 * sampleRate));
            const head = tonePower(seam, 200);
            const tail = tonePower(seam, 3000);
            assert.isAbove(Math.min(head, tail) / Math.max(head, tail), 0.05);
          }),
      );
    },
    slow,
  );

  // 3 秒の 200 Hz に続く 3 秒の 3000 Hz。ループ点が 3〜6 秒なら、200 Hz は一度も鳴らない。
  const halves = songOf(concat(sine(3, 200, 0.2), sine(3, 3000, 0.2)));
  const voice = narration({ duration: gapDuration, hertz: 1000, paragraphs: gapParagraphs });

  it.effect(
    "loops the whole song when the pool records no loop point",
    () =>
      inChannel(
        "nyaucast-mix-loop-auto-",
        { narration: voice, songs: { [songA]: halves } },
        (channelRoot) =>
          Effect.gen(function* () {
            yield* mix();

            const left = readTrack(channelRoot).channels[0] as Float32Array;
            assert.isAbove(tonePower(left, 200) / tonePower(left, 3000), 0.05);
          }),
      ),
    slow,
  );

  it.effect(
    "prefers the loop point the pool records: only the looped part is heard",
    () =>
      inChannel(
        "nyaucast-mix-loop-point-",
        {
          narration: voice,
          pool: {
            songs: [poolSong(songA, { loop: { endSeconds: 6, startSeconds: 3 } })],
          },
          songs: { [songA]: halves },
        },
        (channelRoot) =>
          Effect.gen(function* () {
            yield* mix();

            const left = readTrack(channelRoot).channels[0] as Float32Array;
            assert.isBelow(tonePower(left, 200) / tonePower(left, 3000), 0.002);
          }),
      ),
    slow,
  );
});

describe("video.mixAudioTrack: choosing the song", () => {
  const shortSongs = { [songA]: noiseSong(1, 3), [songB]: noiseSong(7, 3) };
  const inShortChannel = <A, E, R>(
    prefix: string,
    use: (channelRoot: string) => Effect.Effect<A, E, R>,
  ) => inChannel(prefix, { narration: shortNarration, songs: shortSongs }, use);

  it.effect(
    "picks the same song for the same video id in separate channels",
    () =>
      Effect.gen(function* () {
        const first = yield* inShortChannel("nyaucast-mix-same-id-1-", (channelRoot) =>
          mix().pipe(Effect.map(() => readFacts(channelRoot))),
        );
        const second = yield* inShortChannel("nyaucast-mix-same-id-2-", (channelRoot) =>
          mix().pipe(Effect.map(() => readFacts(channelRoot))),
        );

        assert.include([songA, songB], first.song);
        assert.strictEqual(second.song, first.song);
        assert.strictEqual(second.key, first.key);
      }),
    slow,
  );

  it.effect(
    "rotates through the pool as video ids change",
    () =>
      inShortChannel("nyaucast-mix-rotation-", (channelRoot) =>
        Effect.gen(function* () {
          const songs = new Set<string | null>();
          for (const id of ["V1", "V2", "V3", "V4"]) {
            if (id !== "V1") {
              yield* recordPlan({ sources: [source(`https://example.com/${id}`)] });
              yield* approveProduce(id);
              writeNarration(channelRoot, shortNarration, id);
            }
            yield* mix({ videoId: id });
            const facts = JSON.parse(
              new TextDecoder().decode(
                readChannelFile(channelRoot, `videos/${id}/audio/track.json`),
              ),
            ) as TrackFacts;
            songs.add(facts.song);
          }

          assert.isAtLeast(songs.size, 2);
        }),
      ),
    slow,
  );

  it.effect(
    "uses the song the agent names, changes the freshness key, and goes back to the rotation when the song is no longer named",
    () =>
      inShortChannel("nyaucast-mix-named-song-", (channelRoot) =>
        Effect.gen(function* () {
          const rotated = yield* mix();
          const rotatedFacts = readFacts(channelRoot);
          const rotatedBytes = trackBytes(channelRoot);
          const named = rotatedFacts.song === songA ? songB : songA;

          const chosen = yield* mix({ song: named });
          const chosenFacts = readFacts(channelRoot);
          const chosenBytes = trackBytes(channelRoot);
          const again = yield* mix({ song: named });
          const back = yield* mix();

          assert.isFalse(rotated.reused);
          assert.isFalse(chosen.reused);
          assert.strictEqual(chosenFacts.song, named);
          assert.notStrictEqual(chosenFacts.key, rotatedFacts.key);
          assert.isFalse(sameBytes(chosenBytes, rotatedBytes));
          assert.isTrue(again.reused);
          assert.isFalse(back.reused);
          assert.deepStrictEqual(readFacts(channelRoot), rotatedFacts);
          assert.isTrue(sameBytes(trackBytes(channelRoot), rotatedBytes));
        }),
      ),
    slow,
  );

  it.effect(
    "fails with BgmSongNotInPool for a song the pool does not list",
    () =>
      inShortChannel("nyaucast-mix-not-in-pool-", (channelRoot) =>
        Effect.gen(function* () {
          const failure = yield* Effect.flip(mix({ song: "bgm/other.wav" }));

          assert.strictEqual(failure._tag, "BgmSongNotInPool");
          assert.strictEqual(failureFacts(failure)["file"], "bgm/other.wav");
          noArtifacts(channelRoot);
        }),
      ),
    slow,
  );

  it.effect(
    "fails with BgmNotEnabled when a song is named but the channel turned BGM off",
    () =>
      inChannel(
        "nyaucast-mix-named-while-off-",
        { bgm: { enabled: false }, narration: shortNarration },
        (channelRoot) =>
          Effect.gen(function* () {
            const failure = yield* Effect.flip(mix({ song: songA }));

            assert.strictEqual(failure._tag, "BgmNotEnabled");
            noArtifacts(channelRoot);
          }),
      ),
    slow,
  );
});

describe("video.mixAudioTrack: idempotence and freshness", () => {
  const inShortChannel = <A, E, R>(
    prefix: string,
    use: (channelRoot: string) => Effect.Effect<A, E, R>,
  ) => inChannel(prefix, { narration: shortNarration, songs: { [songA]: noiseSong(1, 3) } }, use);

  it.effect(
    "reuses a track whose inputs are unchanged without writing it, and rebuilds only with force",
    () =>
      inShortChannel("nyaucast-mix-reuse-", (channelRoot) =>
        Effect.gen(function* () {
          const first = yield* mix();
          const written = statSync(join(channelRoot, audioKey)).mtimeMs;
          const bytes = trackBytes(channelRoot);

          const second = yield* mix();
          const unchanged = statSync(join(channelRoot, audioKey)).mtimeMs;
          const forced = yield* mix({ force: true });

          assert.isFalse(first.reused);
          assert.isTrue(second.reused);
          assert.strictEqual(unchanged, written);
          assert.isFalse(forced.reused);
          assert.isAbove(statSync(join(channelRoot, audioKey)).mtimeMs, written);
          assert.isTrue(sameBytes(trackBytes(channelRoot), bytes));
        }),
      ),
    slow,
  );

  it.effect(
    "rebuilds when the song file, the narration, the timing table or the declared volume changes",
    () =>
      inShortChannel("nyaucast-mix-fresh-", (channelRoot) =>
        Effect.gen(function* () {
          yield* mix();
          const base = readFacts(channelRoot).key;

          writeChannelFile(channelRoot, songA, noiseSong(99, 3));
          const songChanged = yield* mix();
          const afterSong = readFacts(channelRoot).key;

          writeNarration(
            channelRoot,
            narration({ duration: 4, hertz: 330, paragraphs: [[0.8, 2]] }),
          );
          const narrationChanged = yield* mix();
          const afterNarration = readFacts(channelRoot).key;
          const beforeTiming = trackBytes(channelRoot);

          // 音声のファイルは変えず、段落の時刻だけを変える（ダッキングの曲線が変わる）。
          const table = JSON.parse(
            narration({ duration: 4, hertz: 330, paragraphs: [[0.8, 2]] }).timing,
          ) as { paragraphs: { endSeconds: number }[] };
          writeChannelFile(
            channelRoot,
            "videos/V1/narration/timing.json",
            new TextEncoder().encode(
              JSON.stringify({
                ...table,
                paragraphs: table.paragraphs.map((paragraph) => ({ ...paragraph, endSeconds: 1 })),
              }),
            ),
          );
          const timingChanged = yield* mix();
          const afterTiming = readFacts(channelRoot).key;
          assert.isFalse(timingChanged.reused);
          assert.isFalse(sameBytes(trackBytes(channelRoot), beforeTiming));

          writeVideoConfig(channelRoot, explainerConfigWithBgm({ enabled: true, volumeDb: -8 }));
          const volumeChanged = yield* mix();
          const afterVolume = readFacts(channelRoot).key;

          assert.isFalse(songChanged.reused);
          assert.isFalse(narrationChanged.reused);
          assert.isFalse(volumeChanged.reused);
          assert.strictEqual(
            new Set([base, afterSong, afterNarration, afterTiming, afterVolume]).size,
            5,
          );
        }),
      ),
    slow,
  );

  it.effect(
    "leaves a valid track when two calls for the same video run at once",
    () =>
      inShortChannel("nyaucast-mix-concurrent-", (channelRoot) =>
        Effect.gen(function* () {
          const results = yield* Effect.all([mix(), mix()], { concurrency: 2 });

          assert.strictEqual(results.length, 2);
          assert.strictEqual(readTrack(channelRoot).channels.length, 2);
          assert.isString(readFacts(channelRoot).key);
        }),
      ),
    slow,
  );
});

describe("video.mixAudioTrack: BGM that cannot be used is a failure, never a track without BGM", () => {
  const failsWith = (
    prefix: string,
    options: ChannelOptions,
    tag: string,
    facts: Record<string, unknown> = {},
  ) =>
    it.effect(
      `fails with ${tag} and writes nothing (${prefix})`,
      () =>
        inChannel(
          `nyaucast-mix-${prefix}-`,
          { narration: shortNarration, ...options },
          (channelRoot) =>
            Effect.gen(function* () {
              const failure = yield* Effect.flip(mix());

              assert.strictEqual(failure._tag, tag);
              for (const [name, value] of Object.entries(facts)) {
                assert.deepStrictEqual(failureFacts(failure)[name], value);
              }
              noArtifacts(channelRoot);
            }),
        ),
      slow,
    );

  failsWith("empty-pool", { pool: { songs: [] } }, "BgmPoolEmpty");
  failsWith("no-pool", { pool: undefined }, "BgmPoolNotFound", { path: poolPath });
  failsWith(
    "forbidden-source",
    {
      pool: {
        songs: [
          poolSong(songA, {
            source: {
              generatedOn: "2026-10-01",
              kind: "generated",
              model: "suno-v5",
              plan: "free",
              service: "suno",
            },
          }),
        ],
      },
    },
    "InvalidBgmPool",
    { path: poolPath },
  );
  failsWith(
    "missing-song",
    { pool: { songs: [poolSong("bgm/missing.wav")] }, songs: {} },
    "BgmSongNotFound",
    {
      file: "bgm/missing.wav",
    },
  );
  failsWith(
    "unreadable-song",
    { songs: { [songA]: new TextEncoder().encode("this is not audio") } },
    "BgmSongUnreadable",
    { file: songA },
  );
  it.effect(
    "fails with BgmSongUnreadable when the song file exists but cannot be read",
    () =>
      inChannel(
        "nyaucast-mix-unreadable-file-",
        { narration: shortNarration, pool: { songs: [poolSong("bgm/dir")] }, songs: {} },
        (channelRoot) =>
          Effect.gen(function* () {
            mkdirSync(join(channelRoot, "bgm", "dir"), { recursive: true });

            const failure = yield* Effect.flip(mix());

            assert.strictEqual(failure._tag, "BgmSongUnreadable");
            assert.strictEqual(failureFacts(failure)["file"], "bgm/dir");
            noArtifacts(channelRoot);
          }),
      ),
    slow,
  );
  failsWith("short-song", { songs: { [songA]: songOf(noise(0.45, 5, 0.2)) } }, "BgmLoopTooShort", {
    file: songA,
  });
  failsWith(
    "loop-out-of-range",
    {
      pool: { songs: [poolSong(songA, { loop: { endSeconds: 60, startSeconds: 1 } })] },
      songs: { [songA]: noiseSong(1, 5) },
    },
    "BgmLoopOutOfRange",
    { file: songA },
  );
  failsWith("not-declared", { bgm: undefined }, "BgmNotDeclared");
  failsWith("no-narration", { narration: undefined }, "NarrationNotFound");

  it.effect(
    "keeps an earlier track when a later call fails",
    () =>
      inChannel(
        "nyaucast-mix-keep-",
        { narration: shortNarration, songs: { [songA]: noiseSong(1, 3) } },
        (channelRoot) =>
          Effect.gen(function* () {
            yield* mix();
            const bytes = trackBytes(channelRoot);
            const facts = readFacts(channelRoot);

            const failure = yield* Effect.flip(mix({ song: "bgm/other.wav" }));

            assert.strictEqual(failure._tag, "BgmSongNotInPool");
            assert.isTrue(sameBytes(trackBytes(channelRoot), bytes));
            assert.deepStrictEqual(readFacts(channelRoot), facts);
          }),
      ),
    slow,
  );
});

describe("video.mixAudioTrack: preconditions", () => {
  it.effect("fails with VideoNotFound for an unknown video", () =>
    inChannel("nyaucast-mix-unknown-video-", { narration: shortNarration }, () =>
      Effect.gen(function* () {
        const failure = yield* Effect.flip(mix({ videoId: "nope" }));

        assert.strictEqual(failure._tag, "VideoNotFound");
      }),
    ),
  );

  it.effect("fails with ProduceGateNotApproved before the produce gate is approved", () =>
    inChannel(
      "nyaucast-mix-unapproved-",
      { narration: shortNarration, unapproved: true },
      (channelRoot) =>
        Effect.gen(function* () {
          const failure = yield* Effect.flip(mix());

          assert.strictEqual(failure._tag, "ProduceGateNotApproved");
          assert.strictEqual(failureFacts(failure)["videoId"], "V1");
          noArtifacts(channelRoot);
        }),
    ),
  );

  it.effect("fails with ProduceGateNotApproved after a NO-GO", () =>
    inChannel("nyaucast-mix-rejected-", { narration: shortNarration }, (channelRoot) =>
      Effect.gen(function* () {
        yield* rejectProduce();

        const failure = yield* Effect.flip(mix());

        assert.strictEqual(failure._tag, "ProduceGateNotApproved");
        noArtifacts(channelRoot);
      }),
    ),
  );
});

describe("video.mixAudioTrack: the ducking curve", () => {
  const ducked = (depth: number) => 10 ** (-depth / 20);
  const at = (seconds: number) => Math.round(seconds * sampleRate);

  const curve = (
    paragraphs: readonly (readonly [number, number])[],
    duration: number,
    duckingDb = 6,
  ) =>
    duckingGain({
      duckingDb,
      durationSeconds: duration,
      paragraphs: paragraphs.map(([startSeconds, endSeconds]) => ({ endSeconds, startSeconds })),
      sampleRate,
    });

  // 2 つの段落の間に gap 秒の無音を置いた曲線。段落は [2, 4] と [4 + gap, 6 + gap]、末尾は 1.4 秒。
  const withGap = (gap: number, duckingDb = 6) =>
    curve(
      [
        [2, 4],
        [4 + gap, 6 + gap],
      ],
      7.4 + gap,
      duckingDb,
    );

  const region = (gain: Float32Array, from: number, to: number) =>
    Array.from(gain.slice(at(from), at(to) + 1));

  const allCloseTo = (values: readonly number[], expected: number) =>
    values.every((value) => Math.abs(value - expected) < 1e-4);

  it("has one gain per sample of the track", () => {
    assert.strictEqual(withGap(0.35).length, at(7.4 + 0.35));
  });

  it("keeps the BGM down by the declared depth while the narration speaks", () => {
    const gain = withGap(0.35);

    assert.isTrue(allCloseTo(region(gain, 2, 4), ducked(6)));
    assert.isTrue(allCloseTo(region(gain, 4.35, 6.35), ducked(6)));
  });

  it("keeps the BGM down through a paragraph pause of 0.35 seconds", () => {
    assert.isTrue(allCloseTo(region(withGap(0.35), 4, 4.35), ducked(6)));
  });

  it("keeps the BGM down through a scene pause of 0.6 seconds", () => {
    assert.isTrue(allCloseTo(region(withGap(0.6), 4, 4.6), ducked(6)));
  });

  it("keeps the BGM down through a silence of exactly 1.5 seconds", () => {
    assert.isTrue(allCloseTo(region(withGap(1.5), 4, 5.5), ducked(6)));
  });

  it("brings the BGM back in a silence of 2 seconds, and is down again when the next paragraph starts", () => {
    const gain = withGap(2);

    assert.closeTo(Math.max(...region(gain, 4, 6)), 1, 1e-4);
    assert.closeTo(gain[at(4)] ?? Number.NaN, ducked(6), 1e-4);
    assert.closeTo(gain[at(6)] ?? Number.NaN, ducked(6), 1e-4);
  });

  it("holds the BGM at full level in the middle of a long silence", () => {
    const gain = withGap(6);

    assert.isTrue(allCloseTo(region(gain, 6, 8), 1));
  });

  it("never exceeds the full level and never goes negative", () => {
    const gain = withGap(6);

    assert.isTrue(gain.every((value) => value >= 0 && value <= 1 + 1e-6));
  });

  it("fades in at the start and fades out at the end of the track", () => {
    const gain = withGap(6);

    assert.isBelow(gain[0] ?? Number.NaN, 0.05);
    assert.isBelow(gain[gain.length - 1] ?? Number.NaN, 0.05);
  });

  it("follows the declared depth", () => {
    assert.isTrue(allCloseTo(region(withGap(0.35, 12), 4, 4.35), ducked(12)));
    assert.isTrue(allCloseTo(region(withGap(0.35, 3), 4, 4.35), ducked(3)));
  });

  it("does not duck at all when the depth is 0 dB", () => {
    assert.isTrue(allCloseTo(region(withGap(0.35, 0), 2, 4), 1));
  });

  it("is deterministic", () => {
    assert.deepStrictEqual(withGap(2), withGap(2));
  });
});

describe("video.mixAudioTrack: a track that misses the target is not saved", () => {
  // 孤立したパルスにエネルギーが集まる信号。リミッターで削られて、-14 LUFS に届かない。
  const pulses = pulseNarration({ duration: 6, paragraphs: [[0.8, 4]] }, 200);
  const withoutBgm = { bgm: { enabled: false }, pool: undefined, songs: {} } as const;

  it.effect(
    "fails with LoudnessTargetMissed and writes nothing",
    () =>
      inChannel("nyaucast-mix-missed-", { ...withoutBgm, narration: pulses }, (channelRoot) =>
        Effect.gen(function* () {
          const failure = yield* Effect.flip(mix());

          assert.strictEqual(failure._tag, "LoudnessTargetMissed");
          assert.strictEqual(failureFacts(failure)["videoId"], "V1");
          noArtifacts(channelRoot);
        }),
      ),
    slow,
  );

  it.effect(
    "keeps the earlier track when a later mix misses the target",
    () =>
      inChannel(
        "nyaucast-mix-missed-keep-",
        { ...withoutBgm, narration: shortNarration },
        (channelRoot) =>
          Effect.gen(function* () {
            yield* mix();
            const bytes = trackBytes(channelRoot);
            const facts = readFacts(channelRoot);
            writeNarration(channelRoot, pulses);

            const failure = yield* Effect.flip(mix());

            assert.strictEqual(failure._tag, "LoudnessTargetMissed");
            assert.isTrue(sameBytes(trackBytes(channelRoot), bytes));
            assert.deepStrictEqual(readFacts(channelRoot), facts);
          }),
      ),
    slow,
  );
});

describe("video.mixAudioTrack: a track and its facts that do not belong together", () => {
  it.effect(
    "does not reuse a track whose audio is not the one the facts describe",
    () =>
      inChannel(
        "nyaucast-mix-partial-",
        {
          narration: shortNarration,
          songs: { [songA]: noiseSong(1, 3), [songB]: noiseSong(7, 3) },
        },
        (channelRoot) =>
          Effect.gen(function* () {
            const first = yield* mix();
            const factsBytes = readChannelFile(channelRoot, factsKey);
            const firstBytes = trackBytes(channelRoot);
            const other = readFacts(channelRoot).song === songA ? songB : songA;
            yield* mix({ song: other });
            // WAV は別の曲のもの、JSON は最初の曲の鍵のまま（片方だけが書けた状態）。
            writeChannelFile(channelRoot, factsKey, factsBytes);

            const again = yield* mix();

            assert.isFalse(first.reused);
            assert.isFalse(again.reused);
            assert.isTrue(sameBytes(trackBytes(channelRoot), firstBytes));
          }),
      ),
    slow,
  );
});

describe("video.mixAudioTrack: the loop length boundary", () => {
  // 無音の無い、一定の振幅の素材。クロスフェード長は 2 秒（96,000 サンプル）。
  const material = (frames: number) =>
    songOf(
      Float32Array.from(
        { length: frames },
        (_, index) => 0.2 * Math.cos((2 * Math.PI * 440 * index) / sampleRate + 0.5),
      ),
    );

  it.effect(
    "fails with BgmLoopTooShort for material exactly as long as the crossfade",
    () =>
      inChannel(
        "nyaucast-mix-boundary-equal-",
        { narration: shortNarration, songs: { [songA]: material(96_000) } },
        (channelRoot) =>
          Effect.gen(function* () {
            const failure = yield* Effect.flip(mix());

            assert.strictEqual(failure._tag, "BgmLoopTooShort");
            assert.strictEqual(failureFacts(failure)["file"], songA);
            noArtifacts(channelRoot);
          }),
      ),
    slow,
  );

  it.effect(
    "makes the track from material one sample longer than the crossfade",
    () =>
      inChannel(
        "nyaucast-mix-boundary-over-",
        { narration: shortNarration, songs: { [songA]: material(96_001) } },
        (channelRoot) =>
          Effect.gen(function* () {
            yield* mix();

            assert.isTrue(channelFileExists(channelRoot, audioKey));
          }),
      ),
    slow,
  );
});

// ---- ショートのカット（#550）----
// 契約（この issue の計画 C3・C4・C8・D4・D7）:
//   パラメータに cut?（"long" か "short-<n>-clip" / "short-<n>-dedicated"。省略は "long"）が増える。
//   切り抜き: 長尺の narration/track.wav と timing.json から、段落の範囲（最初の段落の頭から最後の段落の終わり）を切り出して混ぜ直す。
//     長尺の最終トラック（audio/track.wav）は読まず、書き換えない。成果物は audio/<cut>.wav と audio/<cut>.json。長さは範囲の長さに一致する。
//   専用: shorts/<n>/narration/{track.wav,timing.json} を同じ手順で混ぜる。長さはそのナレーションの長さ。
//   ショートは 60 秒まで。超えたら ShortTooLong（videoId・cut・seconds・limit）で、何も書かない。
//   範囲が長尺のタイミング表に無ければ InvalidShortRange、候補が無い・取り下げ済みなら ShortCandidateNotFound。
//   鮮度の鍵には、切り抜きでは範囲を含める（フックは読み上げないので含めない）。

const shortSeconds = 60;
// シーン i が 1 段落の台本とタイミング表。切り抜きは scene 2 から 3 まで: 3.35 秒から 9 秒（5.65 秒）。
const clipParagraphs = [
  [0.8, 3],
  [3.35, 6],
  [6.35, 9],
  [9.35, 12],
] as const;
const clipNarration = narration({ duration: 14, paragraphs: clipParagraphs, spikes: true });
const clipRange = paragraphRange([2, 1], [3, 1]);
const clipSamples = Math.round((9 - 3.35) * sampleRate);

interface ShortChannelOptions extends ChannelOptions {
  /** 長尺の台本の段落数（シーンごとに 1 段落）。省略はナレーションの段落数。 */
  readonly scriptScenes?: number;
  /** 書く候補。undefined なら候補を書かない。 */
  readonly candidate?: Parameters<typeof writeShort>[0] | undefined;
}

// 長尺の台本（シーンごとに 1 段落）と候補を書いた動画 V1 で use を動かす。
const inShortChannel = <A, E, R>(
  prefix: string,
  options: ShortChannelOptions,
  use: (channelRoot: string) => Effect.Effect<A, E, R>,
) =>
  inChannel(prefix, options, (channelRoot) =>
    Effect.gen(function* () {
      const scenes = options.scriptScenes ?? clipParagraphs.length;
      yield* callTool(
        "video_write_script",
        scriptInput(Array.from({ length: scenes }, () => ["あ"])),
      );
      if (!("candidate" in options) || options.candidate !== undefined) {
        yield* writeShort({ range: clipRange, ...options.candidate });
      }
      return yield* use(channelRoot);
    }),
  );

const mixCut = (cut: string, extra: { force?: boolean } = {}) =>
  callTool("video_mix_audio_track", { cut, videoId: "V1", ...extra });

const readCutTrack = (channelRoot: string, cut: string) =>
  decodeWav(readChannelFile(channelRoot, cutAudioKey(cut)));

const noCutArtifacts = (channelRoot: string, cut: string) => {
  assert.isFalse(channelFileExists(channelRoot, cutAudioKey(cut)));
  assert.isFalse(channelFileExists(channelRoot, cutAudioFactsKey(cut)));
};

const writeDedicatedNarration = (channelRoot: string, fixture: NarrationFixture, number = 1) => {
  writeChannelFile(channelRoot, shortTrackKey(number), fixture.track);
  writeChannelFile(channelRoot, shortTimingKey(number), new TextEncoder().encode(fixture.timing));
};

describe("video.mixAudioTrack: the cut parameter", () => {
  const schema = ExplainerVideoMixAudioTrackTool.parametersSchema;

  it.each(["long", "short-1-clip", "short-1-dedicated", "short-12-clip", "short-100-dedicated"])(
    "accepts the cut %j",
    (cut) => {
      assert.isTrue(accepts(schema, { cut, videoId: "V1" }));
    },
  );

  it.each([
    "short-01-clip",
    "short-0-clip",
    "short-1-vertical",
    "short-1.5-clip",
    "short--1-clip",
    "Long",
    "short-1-clip ",
    "",
  ])("does not accept the cut %j", (cut) => {
    assert.isFalse(accepts(schema, { cut, videoId: "V1" }));
  });

  it("describes the short failure tags", () => {
    for (const tag of ["ShortTooLong", "InvalidShortRange", "ShortCandidateNotFound"]) {
      assert.include(ExplainerVideoMixAudioTrackTool.description, tag);
    }
  });

  it.effect(
    "mixes the long track for the cut long, as when the cut is omitted",
    () =>
      inChannel("nyaucast-mix-cut-long-", {}, (channelRoot) =>
        Effect.gen(function* () {
          const result = yield* mixCut("long");

          assert.strictEqual(result.trackKey, audioKey);
          assert.isTrue(channelFileExists(channelRoot, audioKey));
        }),
      ),
    slow,
  );
});

describe("video.mixAudioTrack: the audio of a clip short", () => {
  it.effect(
    "is -14 LUFS ± 0.5 and -2 dBTP or less, as long as the paragraph range, with BGM laid under a peaky narration",
    () =>
      inShortChannel("nyaucast-mix-clip-loudness-", { narration: clipNarration }, (channelRoot) =>
        Effect.gen(function* () {
          const result = yield* mixCut(clipCut(1));

          const track = readCutTrack(channelRoot, clipCut(1));
          assert.strictEqual(result.trackKey, cutAudioKey(clipCut(1)));
          assert.strictEqual(result.videoId, "V1");
          assert.isFalse(result.reused);
          assert.strictEqual(track.format, 1);
          assert.strictEqual(track.bitsPerSample, 16);
          assert.strictEqual(track.sampleRate, sampleRate);
          assert.strictEqual(track.channels.length, 2);
          assert.strictEqual(track.channels[0]?.length, clipSamples);
          assert.closeTo(loudness(track.channels) ?? Number.NaN, -14, 0.5);
          assert.isAtMost(truePeakDbtp(track.channels), -2);
          assert.isTrue(channelFileExists(channelRoot, cutAudioFactsKey(clipCut(1))));
        }),
      ),
    slow,
  );

  it.effect(
    "goes through the same normalization when BGM is off, and keeps the narration of the range only",
    () =>
      inShortChannel(
        "nyaucast-mix-clip-off-",
        { bgm: { enabled: false }, narration: clipNarration, pool: undefined, songs: {} },
        (channelRoot) =>
          Effect.gen(function* () {
            yield* mixCut(clipCut(1));

            const { channels } = readCutTrack(channelRoot, clipCut(1));
            const left = channels[0] as Float32Array;
            assert.strictEqual(left.length, clipSamples);
            assert.closeTo(loudness(channels) ?? Number.NaN, -14, 0.5);
            assert.isAtMost(truePeakDbtp(channels), -2);
            // 範囲の最初の段落の頭から声が始まる（長尺の先頭の無音や、範囲より前の段落が残っていない）
            assert.isAbove(rmsDb(left, 0.1, 0.4), -40);
            // 範囲の 2 つの段落の間（切り出し後の 2.65〜3.0 秒）は完全な無音
            const gap = left.slice(Math.round(2.7 * sampleRate), Math.round(2.95 * sampleRate));
            assert.isTrue(gap.every((value) => Math.abs(value) < 1e-3));
            // 範囲の 2 つ目の段落（切り出し後の 3.0〜5.65 秒）は声がある
            assert.isAbove(rmsDb(left, 3.2, 5.4), -40);
          }),
      ),
    slow,
  );

  it.effect(
    "needs no final track of the long cut, and leaves one that exists byte for byte as it is",
    () =>
      inShortChannel("nyaucast-mix-clip-long-track-", { narration: clipNarration }, (channelRoot) =>
        Effect.gen(function* () {
          yield* mixCut(clipCut(1));
          assert.isFalse(channelFileExists(channelRoot, audioKey));

          yield* mix();
          const longTrack = trackBytes(channelRoot);
          yield* mixCut(clipCut(1), { force: true });

          assert.isTrue(sameBytes(trackBytes(channelRoot), longTrack));
        }),
      ),
    slow,
  );

  it.effect(
    "is as long as the range the candidate was last written with",
    () =>
      inShortChannel(
        "nyaucast-mix-clip-other-range-",
        { bgm: { enabled: false }, narration: clipNarration, pool: undefined, songs: {} },
        (channelRoot) =>
          Effect.gen(function* () {
            yield* writeShort({ range: paragraphRange([1, 1], [2, 1]) });

            yield* mixCut(clipCut(1));

            const left = readCutTrack(channelRoot, clipCut(1)).channels[0] as Float32Array;
            assert.strictEqual(left.length, Math.round((6 - 0.8) * sampleRate));
          }),
      ),
    slow,
  );

  it.effect(
    "is reused while the range is unchanged (a new hook is not read aloud), mixed again for a new range or force",
    () =>
      inShortChannel("nyaucast-mix-clip-reuse-", { narration: clipNarration }, (channelRoot) =>
        Effect.gen(function* () {
          const first = yield* mixCut(clipCut(1));
          const before = readChannelFile(channelRoot, cutAudioKey(clipCut(1)));
          yield* writeShort({ hook: "新しいフック", range: clipRange });
          const sameRange = yield* mixCut(clipCut(1));
          yield* writeShort({ hook: "新しいフック", range: paragraphRange([2, 1], [4, 1]) });
          const newRange = yield* mixCut(clipCut(1));
          const forced = yield* mixCut(clipCut(1), { force: true });

          assert.isFalse(first.reused);
          assert.isTrue(sameRange.reused);
          assert.isFalse(newRange.reused);
          assert.isFalse(forced.reused);
          assert.isFalse(sameBytes(readChannelFile(channelRoot, cutAudioKey(clipCut(1))), before));
        }),
      ),
    slow,
  );

  it.effect(
    "is mixed per cut: two candidates write their own tracks",
    () =>
      inShortChannel("nyaucast-mix-clip-two-", { narration: clipNarration }, (channelRoot) =>
        Effect.gen(function* () {
          yield* writeShort({ number: 2, range: paragraphRange([1, 1], [1, 1]) });

          yield* mixCut(clipCut(1));
          yield* mixCut(clipCut(2));

          assert.strictEqual(
            readCutTrack(channelRoot, clipCut(1)).channels[0]?.length,
            clipSamples,
          );
          assert.strictEqual(
            readCutTrack(channelRoot, clipCut(2)).channels[0]?.length,
            Math.round((3 - 0.8) * sampleRate),
          );
        }),
      ),
    slow,
  );
});

describe("video.mixAudioTrack: the 60 second limit of a short", () => {
  // 範囲の長さは「最初の段落の頭から最後の段落の終わり」。2 進で正確な秒数にして、ちょうど 60 秒を作る。
  const limitNarration = (end: number) =>
    narration({
      duration: end + 1,
      paragraphs: [
        [0.75, 30],
        [30.5, end],
      ],
    });
  const wholeRange = paragraphRange([1, 1], [2, 1]);

  it.effect(
    "fails with ShortTooLong for a range longer than 60 seconds, and writes nothing",
    () =>
      inShortChannel(
        "nyaucast-mix-clip-too-long-",
        { candidate: { range: wholeRange }, narration: limitNarration(60.8), scriptScenes: 2 },
        (channelRoot) =>
          Effect.gen(function* () {
            const failure = yield* Effect.flip(mixCut(clipCut(1)));

            assert.strictEqual(failure._tag, "ShortTooLong");
            assert.strictEqual(failureFacts(failure)["videoId"], "V1");
            assert.strictEqual(failureFacts(failure)["cut"], clipCut(1));
            assert.strictEqual(failureFacts(failure)["limit"], shortSeconds);
            assert.closeTo(Number(failureFacts(failure)["seconds"]), 60.05, 1e-6);
            noCutArtifacts(channelRoot, clipCut(1));
          }),
      ),
    sixtySecondMix,
  );

  it.effect(
    "accepts a range of exactly 60 seconds",
    () =>
      inShortChannel(
        "nyaucast-mix-clip-exactly-60-",
        { candidate: { range: wholeRange }, narration: limitNarration(60.75), scriptScenes: 2 },
        (channelRoot) =>
          Effect.gen(function* () {
            const result = yield* mixCut(clipCut(1));

            assert.isFalse(result.reused);
            assert.strictEqual(
              readCutTrack(channelRoot, clipCut(1)).channels[0]?.length,
              shortSeconds * sampleRate,
            );
          }),
      ),
    sixtySecondMix,
  );

  it.effect(
    "fails with ShortTooLong for a dedicated narration longer than 60 seconds, and accepts one of exactly 60",
    () =>
      inShortChannel("nyaucast-mix-dedicated-limit-", { narration: undefined }, (channelRoot) =>
        Effect.gen(function* () {
          writeDedicatedNarration(
            channelRoot,
            narration({ duration: 61, paragraphs: [[0.8, 30]] }),
          );
          const failure = yield* Effect.flip(mixCut(dedicatedCut(1)));
          assert.strictEqual(failure._tag, "ShortTooLong");
          assert.strictEqual(failureFacts(failure)["cut"], dedicatedCut(1));
          assert.strictEqual(failureFacts(failure)["limit"], shortSeconds);
          noCutArtifacts(channelRoot, dedicatedCut(1));

          writeDedicatedNarration(
            channelRoot,
            narration({ duration: 60, paragraphs: [[0.8, 30]] }),
          );
          const accepted = yield* mixCut(dedicatedCut(1));
          assert.isFalse(accepted.reused);
        }),
      ),
    sixtySecondMix,
  );
});

describe("video.mixAudioTrack: the audio of a dedicated short", () => {
  const dedicatedNarration = narration({
    duration: 6,
    paragraphs: [
      [0.8, 2.5],
      [2.85, 4.5],
    ],
    spikes: true,
  });

  it.effect(
    "is made from the dedicated narration alone: -14 LUFS ± 0.5, -2 dBTP or less, as long as that narration",
    () =>
      inShortChannel("nyaucast-mix-dedicated-", { narration: undefined }, (channelRoot) =>
        Effect.gen(function* () {
          writeDedicatedNarration(channelRoot, dedicatedNarration);

          const result = yield* mixCut(dedicatedCut(1));

          const track = readCutTrack(channelRoot, dedicatedCut(1));
          assert.strictEqual(result.trackKey, cutAudioKey(dedicatedCut(1)));
          assert.isFalse(result.reused);
          assert.strictEqual(track.channels.length, 2);
          assert.strictEqual(track.channels[0]?.length, 6 * sampleRate);
          assert.closeTo(loudness(track.channels) ?? Number.NaN, -14, 0.5);
          assert.isAtMost(truePeakDbtp(track.channels), -2);
          assert.isFalse(channelFileExists(channelRoot, audioKey));
        }),
      ),
    slow,
  );

  it.effect(
    "fails with NarrationNotFound when the dedicated narration is not synthesized, and writes nothing",
    () =>
      inShortChannel("nyaucast-mix-dedicated-no-narration-", {}, (channelRoot) =>
        Effect.gen(function* () {
          const failure = yield* Effect.flip(mixCut(dedicatedCut(1)));

          assert.strictEqual(failure._tag, "NarrationNotFound");
          noCutArtifacts(channelRoot, dedicatedCut(1));
        }),
      ),
    slow,
  );
});

describe("video.mixAudioTrack: what a short refuses", () => {
  it.effect("fails with InvalidShortRange when the long timing table no longer has the range", () =>
    inShortChannel(
      "nyaucast-mix-clip-stale-range-",
      {
        narration: narration({
          duration: 7,
          paragraphs: [
            [0.8, 3],
            [3.35, 6],
          ],
        }),
      },
      (channelRoot) =>
        Effect.gen(function* () {
          const failure = yield* Effect.flip(mixCut(clipCut(1)));

          assert.strictEqual(failure._tag, "InvalidShortRange");
          assert.strictEqual(failureFacts(failure)["videoId"], "V1");
          assert.strictEqual(failureFacts(failure)["number"], 1);
          noCutArtifacts(channelRoot, clipCut(1));
        }),
    ),
  );

  it.effect(
    "fails with NarrationNotFound for a clip when the long narration is not synthesized",
    () =>
      inShortChannel("nyaucast-mix-clip-no-narration-", { narration: undefined }, (channelRoot) =>
        Effect.gen(function* () {
          const failure = yield* Effect.flip(mixCut(clipCut(1)));

          assert.strictEqual(failure._tag, "NarrationNotFound");
          noCutArtifacts(channelRoot, clipCut(1));
        }),
      ),
  );

  it.effect("fails with ShortCandidateNotFound for a number that was never written", () =>
    inShortChannel("nyaucast-mix-clip-no-candidate-", { narration: clipNarration }, (channelRoot) =>
      Effect.gen(function* () {
        const failure = yield* Effect.flip(mixCut(clipCut(2)));

        assert.strictEqual(failure._tag, "ShortCandidateNotFound");
        assert.strictEqual(failureFacts(failure)["number"], 2);
        noCutArtifacts(channelRoot, clipCut(2));
      }),
    ),
  );

  it.effect("fails with ShortCandidateNotFound for a withdrawn candidate, for both cuts", () =>
    inShortChannel("nyaucast-mix-withdrawn-", { narration: clipNarration }, (channelRoot) =>
      Effect.gen(function* () {
        yield* withdrawShort(1);

        for (const cut of [clipCut(1), dedicatedCut(1)]) {
          const failure = yield* Effect.flip(mixCut(cut));
          assert.strictEqual(failure._tag, "ShortCandidateNotFound");
          noCutArtifacts(channelRoot, cut);
        }
      }),
    ),
  );

  it.effect("fails with ProduceGateNotApproved for a short after a NO-GO, and writes nothing", () =>
    inShortChannel("nyaucast-mix-clip-rejected-", { narration: clipNarration }, (channelRoot) =>
      Effect.gen(function* () {
        yield* rejectProduce();

        const failure = yield* Effect.flip(mixCut(clipCut(1)));

        assert.strictEqual(failure._tag, "ProduceGateNotApproved");
        noCutArtifacts(channelRoot, clipCut(1));
      }),
    ),
  );
});
