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

const scriptKey = (videoId: string) => `videos/${videoId}/script.json`;

/** 検証済みの台本を、動画のディレクトリに書く（agent が書く入力なので、消さない）。 */
export const writeScriptFile = (videoId: string, scenes: typeof Scenes.Type) =>
  Effect.gen(function* () {
    const files = yield* VideoFiles;
    const key = scriptKey(videoId);
    yield* files.write(key, new TextEncoder().encode(JSON.stringify({ scenes })));
    return key;
  });

/** 保存済みの台本を読み、書くときと同じ規則で検証し直す。手で書き換えたファイルも同じ規則で止まる。 */
export const readScript = (videoId: string) =>
  Effect.gen(function* () {
    const bytes = yield* (yield* VideoFiles).read(scriptKey(videoId));
    if (Option.isNone(bytes)) {
      return yield* new ScriptNotFound({ videoId });
    }
    const file = yield* decodeScriptFile(new TextDecoder().decode(bytes.value)).pipe(
      Effect.mapError(() => new InvalidScriptFile({ videoId })),
    );
    return yield* parseScript(file.scenes);
  });
