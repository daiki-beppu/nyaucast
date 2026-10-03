import { Effect, FileSystem, Path, Schema } from "effect";

/** 認証に対応する SNS。Instagram と X は後続の issue でここへ足す。 */
export const platforms = ["youtube"] as const;
export type Platform = (typeof platforms)[number];

// 失敗は、タグと事実だけを持つ。
export class InvalidChannel extends Schema.TaggedError<InvalidChannel>()("InvalidChannel", {
  channel: Schema.String,
}) {}

const isPathSegment = (channel: string) =>
  channel.length > 0 && channel !== "." && channel !== ".." && !/[/\\]/u.test(channel);

/** チャンネル名はファイル名の一部になる。パスの区切りや相対指定を含む名前は、使う前にここで拒否する。 */
export const requireChannel = (channel: string): Effect.Effect<string, InvalidChannel> =>
  isPathSegment(channel) ? Effect.succeed(channel) : Effect.fail(new InvalidChannel({ channel }));

/** 特定のアカウント（チャンネル × SNS）に関する失敗が持つ事実。 */
export const accountFacts = { channel: Schema.String, platform: Schema.String };

/** 設定とトークンを読み書きするサービスが共通で要るファイル系のサービス。 */
export const fileServices = Effect.all({ fileSystem: FileSystem.FileSystem, path: Path.Path });
