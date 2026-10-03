import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { NodeHttpClient, NodeRuntime, NodeServices, NodeStdio } from "@effect/platform-node";
import { Effect, Layer, Logger, Stdio } from "effect";
import { McpProtocol, McpServer } from "effect/ai";

import { ChannelAccounts } from "./auth/accounts.ts";
import { CredentialStore } from "./auth/credential-store.ts";
import { StaticSecrets } from "./auth/secrets.ts";
import { ChannelSettings } from "./channel/channel-settings.ts";
import { CollectionIds } from "./collections/collection-ids.ts";
import { CollectionDirectories } from "./collections/directories.ts";
import { LocalStore } from "./db/local-store.ts";
import { nyaucastCli, version } from "./cli.ts";
import { InstagramAuth } from "./instagram/auth.ts";
import { NyaucastToolHandlers, NyaucastToolkit } from "./mcp.ts";
import { ThumbnailFiles } from "./thumbnails/thumbnail-files.ts";
import { VideoFiles } from "./videos/video-files.ts";
import { VideoIds } from "./videos/video-ids.ts";
import { XAuth } from "./x/auth.ts";
import { YouTubeAuth } from "./youtube/auth.ts";

const channelRoot = process.cwd();
const localStore = LocalStore.layer(pathToFileURL(`${channelRoot}/data/local.db`).href);
// ホームディレクトリは、ここで 1 回だけ解決して各 Layer に渡す。
const configRoot = join(homedir(), ".config", "nyaucast");
const thumbnailFiles = ThumbnailFiles.layer(channelRoot);

// MCP は stdout が JSON-RPC 専用。tool の handler と DB が整ってから stdio の server を起動する
// （起動後すぐの tools/list が空にならないよう、tool の登録は server が読み始める前に終える）。
const mcpHandlers = NyaucastToolHandlers.pipe(
  Layer.provide(CollectionDirectories.layer(channelRoot)),
  Layer.provide(CollectionIds.layer),
  Layer.provide(ChannelSettings.layer(channelRoot)),
  Layer.provide(VideoIds.layer),
  Layer.provide(thumbnailFiles),
  Layer.provide(VideoFiles.layer(channelRoot)),
  Layer.provide(StaticSecrets.layer({ configRoot })),
  Layer.provide(NodeHttpClient.layerUndici),
  Layer.provide(localStore),
);

const mcpServer = McpServer.toolkit(NyaucastToolkit).pipe(
  Layer.provide(
    McpServer.layerStdio({
      name: "nyaucast",
      protocols: [McpProtocol.v2025_06_18],
      version,
    }).pipe(Layer.provideMerge(mcpHandlers)),
  ),
  Layer.provide(NodeStdio.layer),
);

const credentialStore = CredentialStore.layer({ credentialRoot: join(configRoot, "credentials") });
const authDependencies = Layer.mergeAll(
  credentialStore,
  StaticSecrets.layer({ configRoot }),
  NodeHttpClient.layerUndici,
);
const authServices = Layer.mergeAll(
  ChannelAccounts.layer({ configRoot }),
  credentialStore,
  Layer.mergeAll(
    YouTubeAuth.layerProduction,
    InstagramAuth.layerProduction,
    XAuth.layerProduction,
  ).pipe(Layer.provide(authDependencies)),
);

const video = Layer.mergeAll(localStore, ChannelSettings.layer(channelRoot), thumbnailFiles);

Stdio.Stdio.use(({ args }) =>
  Effect.flatMap(args, nyaucastCli({ auth: authServices, localStore, mcpServer, video })),
).pipe(
  Effect.provide(NodeServices.layer),
  Effect.provideService(Logger.LogToStderr, true),
  NodeRuntime.runMain({ disableErrorReporting: true }),
);
