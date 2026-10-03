import { Effect } from "effect";

import { VideoFiles } from "../videos/video-files.ts";

const diagramKey = (videoId: string, scene: number) => `videos/${videoId}/diagrams/${scene}.html`;

/** 検証済みの図解を、動画のディレクトリに書く（agent が書く入力なので、消さない）。 */
export const writeDiagramFile = (videoId: string, scene: number, html: string) =>
  Effect.gen(function* () {
    const key = diagramKey(videoId, scene);
    yield* (yield* VideoFiles).write(key, new TextEncoder().encode(html));
    return key;
  });

/** 保存済みの図解のバイト列。無ければ none。 */
export const readDiagramBytes = (videoId: string, scene: number) =>
  Effect.gen(function* () {
    return yield* (yield* VideoFiles).read(diagramKey(videoId, scene));
  });
