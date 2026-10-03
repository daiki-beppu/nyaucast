import { Effect } from "effect";
import { Toolkit } from "effect/ai";
import type { SqlClient } from "effect/sql";

import type { ChannelSettings } from "./channel/channel-settings.ts";
import type { CollectionIds } from "./collections/collection-ids.ts";
import type { CollectionDirectories } from "./collections/directories.ts";
import { CollectionStatusTool, collectionStatus } from "./tools/collection.status.ts";
import { PlanCheckTitleTool, planCheckTitle } from "./tools/plan.checkTitle.ts";
import { ExplainerWritePlanTool, explainerWritePlan } from "./tools/explainer.writePlan.ts";
import { PlanInitTool, planInit } from "./tools/plan.init.ts";
import { VideoStatusTool, videoStatus } from "./tools/video.status.ts";
import type { VideoIds } from "./videos/video-ids.ts";

// registry は置かない。tool 一覧は、ここで import した tool を並べるだけ。
export const NyaucastToolkit = Toolkit.make(
  PlanInitTool,
  PlanCheckTitleTool,
  CollectionStatusTool,
  ExplainerWritePlanTool,
  VideoStatusTool,
);

// handler の Layer。service の Layer は組み立てず、必要な service を要求するだけにする（合成は entry point）。
export const NyaucastToolHandlers = NyaucastToolkit.toLayer(
  Effect.gen(function* () {
    const context = yield* Effect.context<
      ChannelSettings | CollectionDirectories | CollectionIds | SqlClient.SqlClient | VideoIds
    >();
    return NyaucastToolkit.of({
      collection_status: (input) => collectionStatus(input).pipe(Effect.provideContext(context)),
      explainer_write_plan: (input) =>
        explainerWritePlan(input).pipe(Effect.provideContext(context)),
      plan_check_title: (input) => planCheckTitle(input).pipe(Effect.provideContext(context)),
      plan_init: (input) => planInit(input).pipe(Effect.provideContext(context)),
      video_status: (input) => videoStatus(input).pipe(Effect.provideContext(context)),
    });
  }),
);
