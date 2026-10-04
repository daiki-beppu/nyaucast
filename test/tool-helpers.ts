import { homedir } from "node:os";

import { NodeServices } from "@effect/platform-node";
import { Effect, type FileSystem, Layer, type Path, Stream } from "effect";
import type { Toolkit } from "effect/ai";
import { AiError, Tool } from "effect/ai";

import { DeclaredAccounts } from "../src/auth/declared-accounts.ts";
import { BgmPool } from "../src/channel/bgm-pool.ts";
import { CollectionIds } from "../src/collections/collection-ids.ts";
import { CollectionDirectories } from "../src/collections/directories.ts";
import { Chrome, chromeCacheDirectory } from "../src/lib/chrome.ts";
import { NyaucastToolHandlers, NyaucastToolkit } from "../src/mcp.ts";
import { ThumbnailFiles } from "../src/thumbnails/thumbnail-files.ts";
import { VideoFiles } from "../src/videos/video-files.ts";
import type { VideoIds } from "../src/videos/video-ids.ts";
import { fakeCodex, type FakeCodex } from "./codex-helpers.ts";
import { withVideoChannel } from "./explainer-helpers.ts";
import { fakeGemini, type FakeGemini } from "./thumbnail-helpers.ts";

type Tools = Toolkit.Tools<typeof NyaucastToolkit>;

/**
 * MCP の入口と同じ配線（`NyaucastToolHandlers`）を通して、tool を名前で呼ぶ。
 * 入力は MCP が `handle` を呼ぶときと同じ decode options（strict な tool は未知のキーを拒否）で、tool の Schema にかけられる。
 * handler の Layer は呼び出しごとに組む。呼び出し側が与えた Clock などの service が handler に届く。
 */
export const callTool = <Name extends keyof Tools>(
  name: Name,
  params: Tool.ParametersEncoded<Tools[Name]>,
) =>
  Effect.gen(function* () {
    const toolkit = yield* NyaucastToolkit;
    const strict = Tool.getStrictMode(NyaucastToolkit.tools[name]) === true;
    const results = yield* toolkit.handle(name, params, undefined, {
      errors: "all",
      onExcessProperty: strict ? "error" : "ignore",
    });
    const last = yield* Stream.runLast(results);
    if (last._tag === "None") {
      return yield* Effect.die(`tool ${name} returned no result`);
    }
    // 宣言した失敗は failureMode "error" で error チャネルに流れるので、ここに届く結果は成功値。
    if (last.value.isFailure) {
      return yield* Effect.die(`tool ${name} returned a failure result in the success channel`);
    }
    return last.value.result as Tool.Success<Tools[Name]>;
  }).pipe(Effect.provide(NyaucastToolHandlers));

/**
 * 入力が tool の Schema で拒否されたときの理由の種別を返す（宣言した失敗や成功なら defect）。
 * 未知のキーの拒否は、tool の `Tool.Strict` の注記に連動する decode options で決まる。拒否されれば handler は動かない。
 */
export const rejectionReason = <Name extends keyof Tools>(
  name: Name,
  params: Tool.ParametersEncoded<Tools[Name]>,
) =>
  Effect.flip(callTool(name, params)).pipe(
    Effect.flatMap((failure) =>
      AiError.isAiError(failure)
        ? Effect.succeed(failure.reason._tag)
        : Effect.die(`tool ${name} failed without an AI error: ${String(failure)}`),
    ),
  );

export interface ToolChannelOptions {
  /** チャンネルの設定ファイル（config/channel/video.json）の内容。省略は書かない。 */
  readonly config?: string;
  /** 新しい collection の ID。省略は本物の ID 生成。 */
  readonly collectionIds?: Layer.Layer<CollectionIds>;
  /** 新しい動画の ID。省略は V1, V2, ... の連番。 */
  readonly videoIds?: Layer.Layer<VideoIds>;
  /** 偽の Gemini。省略は応答を持たない偽物（呼ばれたら defect）。 */
  readonly gemini?: FakeGemini;
  /** 偽の codex。省略は応答を持たない偽物（`exec` は defect）。 */
  readonly codex?: FakeCodex;
  /** 動画のファイルの置き場。省略は実ファイルの `VideoFiles.layer`。実物を包んで、処理の途中で状態を変えるテストに使う。 */
  readonly videoFiles?:
    | ((channelRoot: string) => Layer.Layer<VideoFiles, never, FileSystem.FileSystem | Path.Path>)
    | undefined;
}

/**
 * `NyaucastToolHandlers` が要求する service をすべてテスト用に揃えて use を動かす。
 * 一時ディレクトリの実ファイルの libSQL、実ファイルの成果物の置き場、偽の HttpClient と静的シークレット、偽の子プロセス。
 * 外部への実通信と本物の子プロセスは起きない。
 */
export const withToolChannel = <A, E, R>(
  prefix: string,
  options: ToolChannelOptions,
  use: (channelRoot: string) => Effect.Effect<A, E, R>,
) =>
  withVideoChannel(
    prefix,
    options.config,
    (channelRoot) => {
      const gemini = options.gemini ?? fakeGemini([]);
      const codex = options.codex ?? fakeCodex();
      return use(channelRoot).pipe(
        Effect.provide(
          Layer.mergeAll(
            BgmPool.layer(channelRoot),
            CollectionDirectories.layer(channelRoot),
            DeclaredAccounts.layer(channelRoot),
            options.collectionIds ?? CollectionIds.layer,
            ThumbnailFiles.layer(channelRoot),
            (options.videoFiles ?? VideoFiles.layer)(channelRoot),
            gemini.http,
            gemini.secrets,
            codex.layer,
            // 本物の Chrome。偽の子プロセス（codex）とは別の spawner で動く。
            Chrome.layer({ cacheDirectory: chromeCacheDirectory(homedir()) }).pipe(
              Layer.provide(NodeServices.layer),
            ),
          ),
        ),
      );
    },
    options.videoIds,
  );
