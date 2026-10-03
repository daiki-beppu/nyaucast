import { Effect } from "effect";
import { Toolkit } from "effect/ai";
import type { SqlClient } from "effect/sql";

import type { CollectionIds } from "./collections/collection-ids.ts";
import type { CollectionDirectories } from "./collections/directories.ts";
import { CollectionStatusTool, collectionStatus } from "./tools/collection.status.ts";
import { PlanCheckTitleTool, planCheckTitle } from "./tools/plan.checkTitle.ts";
import { PlanInitTool, planInit } from "./tools/plan.init.ts";

// registry は置かない。tool 一覧は、ここで import した tool を並べるだけ。
export const NyaucastToolkit = Toolkit.make(PlanInitTool, PlanCheckTitleTool, CollectionStatusTool);

// handler の Layer。service の Layer は組み立てず、必要な service を要求するだけにする（合成は entry point）。
export const NyaucastToolHandlers = NyaucastToolkit.toLayer(
  Effect.gen(function* () {
    const context = yield* Effect.context<
      CollectionDirectories | CollectionIds | SqlClient.SqlClient
    >();
    return NyaucastToolkit.of({
      collection_status: (input) => collectionStatus(input).pipe(Effect.provideContext(context)),
      plan_check_title: (input) => planCheckTitle(input).pipe(Effect.provideContext(context)),
      plan_init: (input) => planInit(input).pipe(Effect.provideContext(context)),
    });
  }),
);
