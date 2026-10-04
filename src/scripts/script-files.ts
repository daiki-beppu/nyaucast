import { createHash } from "node:crypto";

import { Effect, Option, Schema } from "effect";

import { VideoFiles } from "../videos/video-files.ts";
import { Scenes, parseScript } from "./script.ts";

export class ScriptNotFound extends Schema.TaggedError<ScriptNotFound>()("ScriptNotFound", {
  videoId: Schema.String,
}) {}

export class InvalidScriptFile extends Schema.TaggedError<InvalidScriptFile>()(
  "InvalidScriptFile",
  { videoId: Schema.String },
) {}

const ScriptFile = Schema.Struct({ scenes: Scenes });
const decodeScriptFile = Schema.decodeUnknownEffect(Schema.fromJsonString(ScriptFile));

/**
 * 台本・図解・ナレーションの置き場を決める対象。short を付けると、その番号のショートの候補が持つ専用の台本の置き場になる。
 * 長尺（short なし）の置き場は動画のディレクトリ。
 */
export interface ScriptTarget {
  readonly short?: number;
  readonly videoId: string;
}

/** 対象のディレクトリの相対キー。 */
export const targetDirectory = ({ short, videoId }: ScriptTarget) =>
  short === undefined ? `videos/${videoId}` : `videos/${videoId}/shorts/${short}`;

/** 対象の台本の相対キー。 */
export const scriptFileKey = (target: ScriptTarget) => `${targetDirectory(target)}/script.json`;

const serialize = (scenes: typeof Scenes.Type) =>
  new TextEncoder().encode(JSON.stringify({ scenes }));

/** 台本の内容のハッシュ。ファイルに書くバイト列と同じ直列化から作る。 */
export const scriptSha256 = (scenes: typeof Scenes.Type) =>
  createHash("sha256").update(serialize(scenes)).digest("hex");

/** 検証済みの台本を、対象のディレクトリに書く（agent が書く入力なので、消さない）。 */
export const writeScriptFile = (target: ScriptTarget, scenes: typeof Scenes.Type) =>
  Effect.gen(function* () {
    const files = yield* VideoFiles;
    const key = scriptFileKey(target);
    yield* files.write(key, serialize(scenes));
    return key;
  });

/** 保存済みの台本ファイルが、書こうとしている台本と同じバイト列か。 */
export const scriptFileMatches = (target: ScriptTarget, scenes: typeof Scenes.Type) =>
  Effect.gen(function* () {
    const bytes = yield* (yield* VideoFiles).read(scriptFileKey(target));
    const expected = serialize(scenes);
    return (
      Option.isSome(bytes) &&
      bytes.value.length === expected.length &&
      bytes.value.every((byte, index) => byte === expected[index])
    );
  });

/** 保存済みの台本を読み、書くときと同じ規則で検証し直す。手で書き換えたファイルも同じ規則で止まる。 */
export const readScript = (target: ScriptTarget) =>
  Effect.gen(function* () {
    const { videoId } = target;
    const bytes = yield* (yield* VideoFiles).read(scriptFileKey(target));
    if (Option.isNone(bytes)) {
      return yield* new ScriptNotFound({ videoId });
    }
    const file = yield* decodeScriptFile(new TextDecoder().decode(bytes.value)).pipe(
      Effect.mapError(() => new InvalidScriptFile({ videoId })),
    );
    return yield* parseScript(file.scenes);
  });
