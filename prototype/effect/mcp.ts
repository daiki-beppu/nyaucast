// PROTOTYPE (#475): registry を置かない（ADR-0001 決定 1）は Toolkit.make の引数の並びで保てる。
import { Effect, Layer } from "effect";
import { McpServer, Toolkit } from "effect/ai";

import { Collections } from "./Collections.ts";
import { LocalStore } from "./LocalStore.ts";
import { CollectionStatus, collectionStatus } from "./tools/collection.status.ts";
import { PlanInit, planInit } from "./tools/plan.init.ts";

const tools = Toolkit.make(PlanInit, CollectionStatus);

const handlers = tools.toLayer(
  Effect.gen(function* () {
    const context = yield* Effect.context<Collections | import("effect").FileSystem.FileSystem | import("effect").Path.Path>();
    return tools.of({
      "plan.init": (input) => planInit(input).pipe(Effect.provideContext(context), Effect.orDie),
      "collection.status": (input) => collectionStatus(input).pipe(Effect.provideContext(context)),
    });
  }),
);

export const McpLive = (channelRoot: string) =>
  McpServer.toolkit(tools).pipe(
    Layer.provide(handlers),
    Layer.provide(Collections.layer),
    Layer.provide(LocalStore.layer(channelRoot)),
  );
