import { Context, Effect, FileSystem, Layer, Path, Schema } from "effect";

import { HttpUrl } from "../db/explainer-videos.ts";

export class ChannelConfigNotFound extends Schema.TaggedError<ChannelConfigNotFound>()(
  "ChannelConfigNotFound",
  { path: Schema.String },
) {}

export class InvalidChannelConfig extends Schema.TaggedError<InvalidChannelConfig>()(
  "InvalidChannelConfig",
  { issue: Schema.String, path: Schema.String },
) {}

export class NotExplainerChannel extends Schema.TaggedError<NotExplainerChannel>()(
  "NotExplainerChannel",
  { kind: Schema.String },
) {}

const PositiveInteger = Schema.Finite.check(Schema.isInt(), Schema.isGreaterThan(0));

// サムネイルの型。provider は必ず選ぶ（既定値なし）。provider は gemini と codex の 2 本。
const ThumbnailType = Schema.Struct({
  bannedWords: Schema.Array(Schema.String),
  candidates: PositiveInteger.pipe(Schema.withDecodingDefaultKey(Effect.succeed(3))),
  provider: Schema.Literals(["gemini", "codex"]),
  referenceImages: Schema.Array(Schema.String),
  style: Schema.String,
  textInstructions: Schema.String,
});
export type ThumbnailType = typeof ThumbnailType.Type;

// 題材を取るフィード（RSS / Atom）。省略した設定は、フィードを登録していないものとして扱う。
const Feed = Schema.Struct({ name: Schema.String, url: HttpUrl });

const ExplainerSettings = Schema.Struct({
  feeds: Schema.Array(Feed).pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
  genre: Schema.String,
  hitPatterns: Schema.Record(Schema.String, Schema.Struct({ description: Schema.String })),
  kind: Schema.Literal("explainer"),
  thumbnail: Schema.optionalKey(ThumbnailType),
});
type ExplainerSettings = typeof ExplainerSettings.Type;

// config/channel/video.json（git 管理の人間が書く設定）。動画の種類ごとに宣言の形が違う。
const VideoChannelSettings = Schema.fromJsonString(
  Schema.Union([ExplainerSettings, Schema.Struct({ kind: Schema.Literal("collection") })]),
);
const decodeSettings = Schema.decodeUnknownEffect(VideoChannelSettings);

/**
 * チャンネルの動画の種類と、解説動画の宣言（ジャンル・当たる型）。
 * 設定は呼び出しのたびに読む。Layer を作るときには読まないので、設定の無いチャンネルでも MCP は起動できる。
 */
export class ChannelSettings extends Context.Service<
  ChannelSettings,
  {
    readonly requireExplainer: Effect.Effect<
      ExplainerSettings,
      ChannelConfigNotFound | InvalidChannelConfig | NotExplainerChannel
    >;
  }
>()("nyaucast/ChannelSettings") {
  static layer(channelRoot: string) {
    return Layer.effect(
      ChannelSettings,
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const configPath = path.join(channelRoot, "config", "channel", "video.json");
        const relativePath = "config/channel/video.json";

        const read = Effect.gen(function* () {
          if (!(yield* fileSystem.exists(configPath).pipe(Effect.orDie))) {
            return yield* new ChannelConfigNotFound({ path: relativePath });
          }
          const text = yield* fileSystem.readFileString(configPath).pipe(Effect.orDie);
          return yield* decodeSettings(text).pipe(
            Effect.mapError(
              (error) => new InvalidChannelConfig({ issue: error.message, path: relativePath }),
            ),
          );
        });

        const requireExplainer = Effect.gen(function* () {
          const settings = yield* read;
          if (settings.kind !== "explainer") {
            return yield* new NotExplainerChannel({ kind: settings.kind });
          }
          return settings;
        });

        return ChannelSettings.of({ requireExplainer });
      }),
    );
  }
}
