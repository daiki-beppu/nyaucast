import { homedir } from "node:os";

import { NodeServices } from "@effect/platform-node";
import { Effect, type FileSystem, Layer, type Path, Semaphore, Stream } from "effect";
import type { Toolkit } from "effect/ai";
import { AiError, Tool } from "effect/ai";

import { CredentialStore } from "../src/auth/credential-store.ts";
import { DeclaredAccounts } from "../src/auth/declared-accounts.ts";
import { BgmPool } from "../src/channel/bgm-pool.ts";
import { CollectionIds } from "../src/collections/collection-ids.ts";
import { CloudflareEnvironment } from "../src/cloudflare/environment.ts";
import { CollectionDirectories } from "../src/collections/directories.ts";
import { Chrome, chromeCacheDirectory } from "../src/lib/chrome.ts";
import {
  CollectionToolHandlers,
  CollectionToolkit,
  ExplainerToolHandlers,
  ExplainerToolkit,
} from "../src/mcp.ts";
import { ThumbnailFiles } from "../src/thumbnails/thumbnail-files.ts";
import { VideoFiles } from "../src/videos/video-files.ts";
import { RenderLock } from "../src/videos/render-lock.ts";
import type { VideoIds } from "../src/videos/video-ids.ts";
import { fakeCodex, type FakeCodex } from "./codex-helpers.ts";
import { withVideoChannel } from "./explainer-helpers.ts";
import { temporaryDirectory } from "./helpers.ts";
import { fakeGemini, type FakeGemini } from "./thumbnail-helpers.ts";

/**
 * MCP の入口と同じ配線（種類ごとの `*ToolHandlers`）を通して、tool を名前で呼ぶ口を作る。
 * 入力は MCP が `handle` を呼ぶときと同じ decode options（strict な tool は未知のキーを拒否）で、tool の Schema にかけられる。
 * handler の Layer は呼び出しごとに組む。呼び出し側が与えた Clock などの service が handler に届く。
 */
const toolCaller = <Tools extends Record<string, Tool.Any>, HandlerServices>(
  toolkit: Toolkit.Toolkit<Tools>,
  handlers: Layer.Layer<Tool.HandlersFor<Tools>, never, HandlerServices>,
) => {
  const call = <Name extends keyof Tools & string>(
    name: Name,
    params: Tool.ParametersEncoded<Tools[Name]>,
  ) =>
    Effect.gen(function* () {
      const withHandlers = yield* toolkit;
      const strict = Tool.getStrictMode(toolkit.tools[name] as Tool.Any) === true;
      const results = yield* withHandlers.handle(name, params, undefined, {
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
    }).pipe(Effect.provide(handlers));

  /**
   * 入力が tool の Schema で拒否されたときの理由の種別を返す（宣言した失敗や成功なら defect）。
   * 未知のキーの拒否は、tool の `Tool.Strict` の注記に連動する decode options で決まる。拒否されれば handler は動かない。
   */
  const rejection = <Name extends keyof Tools & string>(
    name: Name,
    params: Tool.ParametersEncoded<Tools[Name]>,
  ) =>
    Effect.flip(call(name, params)).pipe(
      Effect.flatMap((failure) =>
        AiError.isAiError(failure)
          ? Effect.succeed(failure.reason._tag)
          : Effect.die(`tool ${name} failed without an AI error: ${String(failure)}`),
      ),
    );

  return { call, rejection };
};

const explainerCaller = toolCaller(ExplainerToolkit, ExplainerToolHandlers);
const collectionCaller = toolCaller(CollectionToolkit, CollectionToolHandlers);

/** 解説動画の MCP サーバーが公開する tool を名前で呼ぶ。 */
export const callTool = explainerCaller.call;
export const rejectionReason = explainerCaller.rejection;

/** BGM 動画（collection）の MCP サーバーが公開する tool を名前で呼ぶ。 */
export const callCollectionTool = collectionCaller.call;
export const collectionRejectionReason = collectionCaller.rejection;

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
 * `ExplainerToolHandlers` と `CollectionToolHandlers` が要求する service をすべてテスト用に揃えて use を動かす。
 * 一時ディレクトリの実ファイルの libSQL、実ファイルの成果物の置き場、偽の HttpClient と静的シークレット、偽の子プロセス。
 * Cloudflare 環境は、チャンネルルートを設定の置き場として読む本物（既定では environment.json が無く、未作成）。
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
    (channelRoot) =>
      Effect.gen(function* () {
        const gemini = options.gemini ?? fakeGemini([]);
        const codex = options.codex ?? fakeCodex();
        // トークンの置き場はチャンネルルートの外（本番と同じで、公開ゲートの承認と混じらない）。
        const credentialRoot = yield* temporaryDirectory(`${prefix}credentials-`);
        return yield* use(channelRoot).pipe(
          Effect.provide(
            Layer.mergeAll(
              BgmPool.layer(channelRoot),
              CloudflareEnvironment.layer({ configRoot: channelRoot }).pipe(
                Layer.provide(NodeServices.layer),
              ),
              CollectionDirectories.layer(channelRoot),
              CredentialStore.layer({ credentialRoot }).pipe(Layer.provide(NodeServices.layer)),
              DeclaredAccounts.layer(channelRoot),
              options.collectionIds ?? CollectionIds.layer,
              ThumbnailFiles.layer(channelRoot),
              (options.videoFiles ?? VideoFiles.layer)(channelRoot),
              // 描画のロックはチャンネルごと。同じチャンネルの中は本番と同じく直列で、別のチャンネルのテストとは並走できる。
              Layer.succeed(RenderLock, Semaphore.makeUnsafe(1)),
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
      }),
    options.videoIds,
  );
