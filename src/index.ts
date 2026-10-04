import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { NodeHttpClient, NodeRuntime, NodeServices, NodeStdio } from "@effect/platform-node";
import { Effect, Layer, Logger, Stdio } from "effect";
import { McpProtocol, McpServer, type Tool, type Toolkit } from "effect/ai";

import { ChannelAccounts } from "./auth/accounts.ts";
import { DeclaredAccounts } from "./auth/declared-accounts.ts";
import { CredentialStore } from "./auth/credential-store.ts";
import { StaticSecrets } from "./auth/secrets.ts";
import { BgmPool } from "./channel/bgm-pool.ts";
import { ChannelSettings } from "./channel/channel-settings.ts";
import { CollectionIds } from "./collections/collection-ids.ts";
import { CollectionDirectories } from "./collections/directories.ts";
import { LocalStore } from "./db/local-store.ts";
import { nyaucastCli, version } from "./cli.ts";
import { Chrome, chromeCacheDirectory } from "./lib/chrome.ts";
import { InstagramAuth } from "./instagram/auth.ts";
import {
  CollectionToolHandlers,
  CollectionToolkit,
  ExplainerToolHandlers,
  ExplainerToolkit,
  nyaucastInstructions,
} from "./mcp.ts";
import { ThumbnailFiles } from "./thumbnails/thumbnail-files.ts";
import { StdinTerminal } from "./videos/stdin-terminal.ts";
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
const withMcpServices = <A, E, R>(handlers: Layer.Layer<A, E, R>) =>
  handlers.pipe(
    Layer.provide(BgmPool.layer(channelRoot)),
    Layer.provide(CollectionDirectories.layer(channelRoot)),
    Layer.provide(CollectionIds.layer),
    Layer.provide(DeclaredAccounts.layer(channelRoot)),
    Layer.provide(ChannelSettings.layer(channelRoot)),
    Layer.provide(VideoIds.layer),
    Layer.provide(thumbnailFiles),
    Layer.provide(Chrome.layer({ cacheDirectory: chromeCacheDirectory(homedir()) })),
    Layer.provide(VideoFiles.layer(channelRoot)),
    Layer.provide(StaticSecrets.layer({ configRoot })),
    Layer.provide(NodeHttpClient.layerUndici),
    Layer.provide(localStore),
  );

const mcpServerOf = <Tools extends Record<string, Tool.Any>, E, R>(
  toolkit: Toolkit.Toolkit<Tools>,
  handlers: Layer.Layer<Tool.HandlersFor<Tools>, E, R>,
) =>
  McpServer.toolkit(toolkit).pipe(
    Layer.provide(
      McpServer.layerStdio({
        instructions: nyaucastInstructions,
        name: "nyaucast",
        protocols: [McpProtocol.v2025_06_18],
        version,
      }).pipe(Layer.provideMerge(withMcpServices(handlers))),
    ),
    Layer.provide(NodeStdio.layer),
  );

const explainerMcpServer = mcpServerOf(ExplainerToolkit, ExplainerToolHandlers);
const collectionMcpServer = mcpServerOf(CollectionToolkit, CollectionToolHandlers);

// 公開する tool は、起動したチャンネルの種類で決まる。種類は起動時にここで 1 回だけ読む。
// 設定の無いチャンネルでは種類を決められないので、tools/list を答える前に起動が失敗する。
const mcpServer = Layer.unwrap(
  Effect.gen(function* () {
    const kind = yield* (yield* ChannelSettings).kind;
    return kind === "explainer" ? explainerMcpServer : collectionMcpServer;
  }).pipe(Effect.provide(ChannelSettings.layer(channelRoot))),
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

// stdin が TTY かどうかは、ここで 1 回だけ解決する。
const stdinTerminal = Layer.succeed(
  StdinTerminal,
  StdinTerminal.of({ isTerminal: process.stdin.isTTY === true }),
);
const video = Layer.mergeAll(
  localStore,
  ChannelSettings.layer(channelRoot),
  credentialStore,
  DeclaredAccounts.layer(channelRoot),
  stdinTerminal,
  thumbnailFiles,
);

Stdio.Stdio.use(({ args }) =>
  Effect.flatMap(args, nyaucastCli({ auth: authServices, mcpServer, video })),
).pipe(
  Effect.provide(NodeServices.layer),
  Effect.provideService(Logger.LogToStderr, true),
  NodeRuntime.runMain({ disableErrorReporting: true }),
);
