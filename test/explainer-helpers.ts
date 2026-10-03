import { Effect, Layer, Ref } from "effect";

import { ChannelSettings } from "../src/channel/channel-settings.ts";
import { VideoIds } from "../src/videos/video-ids.ts";
import { withChannel, writeVideoConfig } from "./helpers.ts";

export const explainerConfig = JSON.stringify({
  genre: "tech",
  hitPatterns: { contrarian: { description: "常識への反論" }, shock: { description: "驚き" } },
  kind: "explainer",
});

export const collectionConfig = JSON.stringify({ kind: "collection" });

/** 呼ぶたびに V1, V2, ... を返す VideoIds。 */
const sequentialVideoIds = Layer.effect(
  VideoIds,
  Effect.gen(function* () {
    const counter = yield* Ref.make(0);
    return VideoIds.of({
      next: Ref.updateAndGet(counter, (n) => n + 1).pipe(Effect.map((n) => `V${n}`)),
    });
  }),
);

export const fixedVideoId = (id: string) =>
  Layer.succeed(VideoIds, VideoIds.of({ next: Effect.succeed(id) }));

/**
 * 一時チャンネル（実ファイルの libSQL）で use を動かす。設定ファイルは config が undefined なら書かない。
 * 設定は ChannelSettings が呼び出しのたびに読むので、use の中で書き換えられる。
 */
export const withVideoChannel = <A, E, R>(
  prefix: string,
  config: string | undefined,
  use: (channelRoot: string) => Effect.Effect<A, E, R>,
  ids: Layer.Layer<VideoIds> = sequentialVideoIds,
) =>
  withChannel(prefix, (channelRoot) => {
    if (config !== undefined) {
      writeVideoConfig(channelRoot, config);
    }
    return use(channelRoot).pipe(
      Effect.provide(Layer.mergeAll(ChannelSettings.layer(channelRoot), ids)),
    );
  });

export const source = (url: string) => ({
  retrievedAt: "2026-10-01T00:00:00.000Z",
  title: "Article",
  url,
});

interface PlanInput {
  readonly hitPattern: string;
  readonly points: readonly string[];
  readonly sources: readonly ReturnType<typeof source>[];
  readonly title: string;
  readonly videoId?: string;
}

export const planInput = (overrides: Partial<PlanInput> = {}): PlanInput => ({
  hitPattern: "shock",
  points: ["point a", "point b"],
  sources: [],
  title: "Why cats purr",
  ...overrides,
});
