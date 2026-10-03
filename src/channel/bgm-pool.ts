import { Context, Effect, FileSystem, Layer, Path, Schema } from "effect";

import { HttpUrl } from "../db/explainer-videos.ts";

export class BgmPoolNotFound extends Schema.TaggedError<BgmPoolNotFound>()("BgmPoolNotFound", {
  path: Schema.String,
}) {}

export class InvalidBgmPool extends Schema.TaggedError<InvalidBgmPool>()("InvalidBgmPool", {
  issue: Schema.String,
  path: Schema.String,
}) {}

export class BgmSongNotFound extends Schema.TaggedError<BgmSongNotFound>()("BgmSongNotFound", {
  file: Schema.String,
}) {}

export class BgmSongUnreadable extends Schema.TaggedError<BgmSongUnreadable>()(
  "BgmSongUnreadable",
  { file: Schema.String },
) {}

const poolPath = "config/channel/bgm-pool.json";

// 生成元は 3 つだけ。許される条件（プラン・経路）を列挙するので、条件に合わない `generated` は構造上入らない（ADR-0009 決定 12）。
// 条件は 2026-10-03 時点の各サービスの規約による。規約が変わったら、ここと ADR を一緒に直す。
// モデルと生成日は許諾の根拠なので、空や空白だけは拒否する。
const NonBlank = Schema.String.check(
  Schema.makeFilter((value: string) => value.trim().length > 0, {
    description: "a non-blank string",
  }),
);
const generation = {
  generatedOn: NonBlank,
  kind: Schema.Literal("generated"),
  model: NonBlank,
};

const Source = Schema.Union([
  Schema.Struct({
    ...generation,
    plan: Schema.Literals(["pro", "premier"]),
    service: Schema.Literal("suno"),
  }),
  Schema.Struct({
    ...generation,
    plan: Schema.Literals(["starter", "creator", "pro", "scale", "business", "enterprise"]),
    service: Schema.Literal("elevenlabs-music"),
  }),
  Schema.Struct({
    ...generation,
    route: Schema.Literals(["gemini-api", "vertex-ai"]),
    service: Schema.Literal("lyria"),
  }),
  Schema.Struct({ kind: Schema.Literal("licensed"), licenseUrl: HttpUrl }),
]);

const LoopPoint = Schema.Struct({
  endSeconds: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
  startSeconds: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
}).check(
  Schema.makeFilter((loop) => loop.startSeconds < loop.endSeconds, {
    description: "a loop that ends after it starts",
  }),
);

// チャンネルルートからの相対パス。ルートの外は指せない。
const RelativeFile = Schema.String.check(
  Schema.makeFilter(
    (file: string) =>
      file.length > 0 && !file.startsWith("/") && !file.split(/[\\/]/u).includes(".."),
    { description: "a path inside the channel" },
  ),
);

const Song = Schema.Struct({
  file: RelativeFile,
  loop: Schema.optionalKey(LoopPoint),
  source: Source,
});
export type BgmSong = typeof Song.Type;

const Pool = Schema.Struct({ songs: Schema.Array(Song) });
type BgmPoolContent = typeof Pool.Type;

const decodePool = Schema.decodeUnknownEffect(Schema.fromJsonString(Pool));

/**
 * BGM プール（config/channel/bgm-pool.json、git 管理の人間が書く JSON）と、曲のファイルの置き場。
 * プールは呼び出しのたびに読む。Layer を作るときには読まないので、プールの無いチャンネルでも MCP は起動できる。
 */
export class BgmPool extends Context.Service<
  BgmPool,
  {
    readonly read: Effect.Effect<BgmPoolContent, BgmPoolNotFound | InvalidBgmPool>;
    /** プールに書かれた曲のファイル（チャンネルルートからの相対パス）の中身。 */
    readSong(file: string): Effect.Effect<Uint8Array, BgmSongNotFound | BgmSongUnreadable>;
  }
>()("nyaucast/BgmPool") {
  static layer(channelRoot: string) {
    return Layer.effect(
      BgmPool,
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;

        const read = Effect.gen(function* () {
          const file = path.join(channelRoot, poolPath);
          if (!(yield* fileSystem.exists(file).pipe(Effect.orDie))) {
            return yield* new BgmPoolNotFound({ path: poolPath });
          }
          const text = yield* fileSystem.readFileString(file).pipe(Effect.orDie);
          return yield* decodePool(text).pipe(
            Effect.mapError(
              (error) => new InvalidBgmPool({ issue: error.message, path: poolPath }),
            ),
          );
        });

        const readSong = (relativePath: string) =>
          Effect.gen(function* () {
            const file = path.join(channelRoot, relativePath);
            if (!(yield* fileSystem.exists(file).pipe(Effect.orDie))) {
              return yield* new BgmSongNotFound({ file: relativePath });
            }
            return yield* fileSystem
              .readFile(file)
              .pipe(Effect.mapError(() => new BgmSongUnreadable({ file: relativePath })));
          });

        return BgmPool.of({ read, readSong });
      }),
    );
  }
}
