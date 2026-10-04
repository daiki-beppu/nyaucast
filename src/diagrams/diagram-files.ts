import { Effect } from "effect";

import { targetDirectory, type ScriptTarget } from "../scripts/script-files.ts";
import { VideoFiles } from "../videos/video-files.ts";

// 長尺の図解は diagrams/、専用ショートの図解は shorts/<n>/scenes/ に置く。
const diagramKey = (target: ScriptTarget, scene: number) =>
  target.short === undefined
    ? `${targetDirectory(target)}/diagrams/${scene}.html`
    : `${targetDirectory(target)}/scenes/${scene}.html`;

/** 検証済みの図解を、対象のディレクトリに書く（agent が書く入力なので、消さない）。 */
export const writeDiagramFile = (target: ScriptTarget, scene: number, html: string) =>
  Effect.gen(function* () {
    const key = diagramKey(target, scene);
    yield* (yield* VideoFiles).write(key, new TextEncoder().encode(html));
    return key;
  });

/** 保存済みの図解のバイト列。無ければ none。 */
export const readDiagramBytes = (target: ScriptTarget, scene: number) =>
  Effect.gen(function* () {
    return yield* (yield* VideoFiles).read(diagramKey(target, scene));
  });
