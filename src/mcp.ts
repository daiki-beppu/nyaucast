import { Effect } from "effect";
import { Toolkit } from "effect/ai";
import type { HttpClient } from "effect/http";
import type { SqlClient } from "effect/sql";

import type { StaticSecrets } from "./auth/secrets.ts";

import type { ChannelSettings } from "./channel/channel-settings.ts";
import type { CollectionIds } from "./collections/collection-ids.ts";
import type { CollectionDirectories } from "./collections/directories.ts";
import type { ThumbnailFiles } from "./thumbnails/thumbnail-files.ts";
import { CollectionStatusTool, collectionStatus } from "./tools/collection.status.ts";
import { PlanCheckTitleTool, planCheckTitle } from "./tools/plan.checkTitle.ts";
import { ExplainerWritePlanTool, explainerWritePlan } from "./tools/explainer.writePlan.ts";
import { PlanInitTool, planInit } from "./tools/plan.init.ts";
import {
  VideoExcludeThumbnailTool,
  videoExcludeThumbnail,
} from "./tools/video.excludeThumbnail.ts";
import {
  VideoGenerateThumbnailsTool,
  videoGenerateThumbnails,
} from "./tools/video.generateThumbnails.ts";
import { VideoStatusTool, videoStatus } from "./tools/video.status.ts";
import type { VideoIds } from "./videos/video-ids.ts";

// registry は置かない。tool 一覧は、ここで import した tool を並べるだけ。
export const NyaucastToolkit = Toolkit.make(
  PlanInitTool,
  PlanCheckTitleTool,
  CollectionStatusTool,
  ExplainerWritePlanTool,
  VideoStatusTool,
  VideoGenerateThumbnailsTool,
  VideoExcludeThumbnailTool,
);

// handler の Layer。service の Layer は組み立てず、必要な service を要求するだけにする（合成は entry point）。
export const NyaucastToolHandlers = NyaucastToolkit.toLayer(
  Effect.gen(function* () {
    const context = yield* Effect.context<
      | ChannelSettings
      | CollectionDirectories
      | CollectionIds
      | HttpClient.HttpClient
      | SqlClient.SqlClient
      | StaticSecrets
      | ThumbnailFiles
      | VideoIds
    >();
    return NyaucastToolkit.of({
      collection_status: (input) => collectionStatus(input).pipe(Effect.provideContext(context)),
      explainer_write_plan: (input) =>
        explainerWritePlan(input).pipe(Effect.provideContext(context)),
      plan_check_title: (input) => planCheckTitle(input).pipe(Effect.provideContext(context)),
      plan_init: (input) => planInit(input).pipe(Effect.provideContext(context)),
      video_exclude_thumbnail: (input) =>
        videoExcludeThumbnail(input).pipe(Effect.provideContext(context)),
      video_generate_thumbnails: (input) =>
        videoGenerateThumbnails(input).pipe(Effect.provideContext(context)),
      video_status: (input) => videoStatus(input).pipe(Effect.provideContext(context)),
    });
  }),
);
