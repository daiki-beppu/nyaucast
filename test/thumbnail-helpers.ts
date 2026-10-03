import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { NodeFileSystem, NodePath, NodeServices } from "@effect/platform-node";
import { Effect, Layer } from "effect";
import {
  HttpClient,
  HttpClientError,
  type HttpClientRequest,
  HttpClientResponse,
} from "effect/http";

import { StaticSecrets } from "../src/auth/secrets.ts";
import { ThumbnailFiles } from "../src/thumbnails/thumbnail-files.ts";
import { fakeCodex, type FakeCodex } from "./codex-helpers.ts";
import { withVideoChannel } from "./explainer-helpers.ts";

export const geminiKey = "GEMINI_KEY_SENTINEL";

interface GeminiRequestBody {
  readonly contents: ReadonlyArray<{
    readonly parts: ReadonlyArray<{
      readonly inlineData?: { readonly data: string; readonly mimeType: string };
      readonly text?: string;
    }>;
  }>;
  readonly generationConfig?: { readonly imageConfig?: { readonly aspectRatio?: string } };
}

interface GeminiCall {
  readonly body: GeminiRequestBody;
  readonly headers: Record<string, string | undefined>;
  /** 本文のすべての text の部分をつないだもの。 */
  readonly prompt: string;
  readonly method: string;
  readonly url: string;
  /** 本文の inline 画像（base64）。参照画像を付けた順。 */
  readonly inlineImages: readonly string[];
}

export type FakeReply =
  | { readonly image: Uint8Array; readonly mimeType?: string }
  | { readonly status: number }
  | { readonly body: unknown }
  | { readonly transportFailure: true };

function recordCall(request: HttpClientRequest.HttpClientRequest, url: URL): GeminiCall {
  const text =
    request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "";
  const body = JSON.parse(text) as GeminiRequestBody;
  const parts = body.contents.flatMap((content) => content.parts);
  return {
    body,
    headers: { ...request.headers },
    inlineImages: parts.flatMap((part) =>
      part.inlineData === undefined ? [] : [part.inlineData.data],
    ),
    method: request.method,
    prompt: parts.flatMap((part) => (part.text === undefined ? [] : [part.text])).join("\n"),
    url: url.toString(),
  };
}

const imageResponse = (reply: { image: Uint8Array; mimeType?: string }) => ({
  candidates: [
    {
      content: {
        parts: [
          {
            inlineData: {
              data: Buffer.from(reply.image).toString("base64"),
              mimeType: reply.mimeType ?? "image/png",
            },
          },
        ],
      },
    },
  ],
});

/**
 * 偽の Gemini（HttpClient の偽装）。呼ばれた順に記録し、用意した応答を順に返す。
 * 応答の形は Gemini の generateContent の REST（candidates[].content.parts[].inlineData）に合わせる。
 * 応答が尽きた後の呼び出しは、想定外の呼び出しとして defect にする。
 */
export function fakeGemini(replies: readonly FakeReply[]) {
  const pending = [...replies];
  const calls: GeminiCall[] = [];
  const http = HttpClient.make((request, url) =>
    Effect.gen(function* () {
      calls.push(recordCall(request, url));
      const reply = pending.shift();
      if (reply === undefined) {
        return yield* Effect.die("test response queue is empty");
      }
      if ("transportFailure" in reply) {
        return yield* new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({ request }),
        });
      }
      if ("status" in reply) {
        return HttpClientResponse.fromWeb(
          request,
          Response.json(
            { error: { code: reply.status, message: "failed" } },
            { status: reply.status },
          ),
        );
      }
      const body = "image" in reply ? imageResponse(reply) : reply.body;
      return HttpClientResponse.fromWeb(request, Response.json(body));
    }),
  );
  const resolved: string[] = [];
  const secrets = StaticSecrets.of({
    resolve: (name) =>
      Effect.sync(() => {
        resolved.push(name);
        return geminiKey;
      }),
  });
  return {
    calls,
    http: Layer.succeed(HttpClient.HttpClient, http),
    resolvedSecretNames: resolved,
    secrets: Layer.succeed(StaticSecrets, secrets),
  };
}

export type FakeGemini = ReturnType<typeof fakeGemini>;

/**
 * tool が使う外部の継ぎ目（偽の Gemini の HTTP と静的シークレット、偽の codex の子プロセス、実ファイルの成果物の置き場）。
 * 子プロセスは常に偽物で、本物の codex は起動しない。
 */
const thumbnailServices = (channelRoot: string, gemini: FakeGemini, codex: FakeCodex) =>
  Layer.mergeAll(
    ThumbnailFiles.layer(channelRoot).pipe(Layer.provide(NodeServices.layer)),
    gemini.http,
    gemini.secrets,
    codex.layer,
    NodeFileSystem.layer,
    NodePath.layer,
  );

/**
 * 一時チャンネル（実ファイルの libSQL）に、偽の Gemini・偽の codex・サムネイルの成果物の置き場を足して use を動かす。
 * codex を省略すると、応答を持たない偽物が入る（`exec` の呼び出しは想定外として defect になる）。
 */
export const withThumbnailChannel = <A, E, R>(
  prefix: string,
  config: string | undefined,
  gemini: FakeGemini,
  use: (channelRoot: string) => Effect.Effect<A, E, R>,
  codex: FakeCodex = fakeCodex(),
) =>
  withVideoChannel(prefix, config, (channelRoot) =>
    use(channelRoot).pipe(Effect.provide(thumbnailServices(channelRoot, gemini, codex))),
  );

/** チャンネルルートからの相対パスへバイト列を書く（参照画像などの前提データ用）。 */
export function writeChannelFile(channelRoot: string, relativePath: string, bytes: Uint8Array) {
  const path = join(channelRoot, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
}

export const channelFileExists = (channelRoot: string, relativePath: string) =>
  existsSync(join(channelRoot, relativePath));

export const readChannelFile = (channelRoot: string, relativePath: string) =>
  new Uint8Array(readFileSync(join(channelRoot, relativePath)));

export const bodyBase64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
