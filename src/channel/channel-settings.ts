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
// ボイス（音声合成）。全チャンネル共有の既定値は持たず、すべての項目を宣言する。adapter は gemini の 1 本だけ。
const Voice = Schema.Struct({
  adapter: Schema.Literal("gemini"),
  charactersPerSecond: Schema.Finite.check(Schema.isGreaterThan(0)),
  directorNotes: Schema.String,
  model: Schema.String,
  name: Schema.String,
});
export type Voice = typeof Voice.Type;

// テーマ（動画の色・書体・寸法のトークン）。色は CSS にそのまま入るので、16 進の記法だけを受ける。
const HexColor = Schema.String.check(
  Schema.isPattern(/^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/u),
);
// チャンネルルートの中の相対パスだけ。絶対パスと `..` の区間は、ルートの外のファイルを composition に埋め込めてしまうので拒否する。
const FontPath = Schema.String.check(
  Schema.isPattern(/^(?![/\\])(?!(?:.*[/\\])?\.\.(?:[/\\]|$)).+$/u),
);
const Theme = Schema.Struct({
  colors: Schema.Struct({
    accent: HexColor,
    background: HexColor,
    captionBackground: HexColor,
    captionText: HexColor,
    muted: HexColor,
    text: HexColor,
  }),
  // フォントのファイルは、チャンネルルートからの相対パス。
  fonts: Schema.Struct({ body: FontPath, caption: FontPath }),
  sizes: Schema.Struct({
    captionFontSize: PositiveInteger,
    captionMargin: PositiveInteger,
    stagePadding: PositiveInteger,
  }),
});
export type Theme = typeof Theme.Type;
// BGM。有効・無効は必ず宣言する。上書きできるのは音量（ナレーション比の dB）と下げ幅（dB）だけで、時間の値はコードの定数。
const Bgm = Schema.Struct({
  duckingDb: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(6)),
  ),
  enabled: Schema.Boolean,
  volumeDb: Schema.Finite.pipe(Schema.withDecodingDefaultKey(Effect.succeed(-12))),
});
export type Bgm = typeof Bgm.Type;

const ExplainerSettings = Schema.Struct({
  bgm: Schema.optionalKey(Bgm),
  feeds: Schema.Array(Feed).pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
  genre: Schema.String,
  hitPatterns: Schema.Record(Schema.String, Schema.Struct({ description: Schema.String })),
  kind: Schema.Literal("explainer"),
  theme: Schema.optionalKey(Theme),
  thumbnail: Schema.optionalKey(ThumbnailType),
  voice: Schema.optionalKey(Voice),
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
    readonly kind: Effect.Effect<
      "collection" | "explainer",
      ChannelConfigNotFound | InvalidChannelConfig
    >;
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

        const kind = read.pipe(Effect.map((settings) => settings.kind));

        return ChannelSettings.of({ kind, requireExplainer });
      }),
    );
  }
}
