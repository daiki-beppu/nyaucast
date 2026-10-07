import { join } from "node:path";

import { NodeServices } from "@effect/platform-node";
import { Effect, Layer } from "effect";

import { StaticSecrets } from "../src/auth/secrets.ts";
import { CloudflareEnvironment } from "../src/cloudflare/environment.ts";
import { InstagramAuth } from "../src/instagram/auth.ts";
import { environment, writeJsonFile } from "./helpers.ts";
import type { Routes } from "./sns-api.ts";

/**
 * Instagram への投稿アダプタ(issue #555)の統合テストが共有する、偽の InstagramAuth・R2 の
 * StaticSecrets の値・Graph API/R2 の URL の組み立て。`test/youtube-fake-client.ts`
 * (fakeYouTubeAuth)と同じ形。実連携はスタブ化し、この偽物で確認した範囲(呼ばれた順・受けた値)だけを
 * 直接証拠にする。
 */

const instagramAccessToken = "IG_ACCESS_TOKEN_SENTINEL";

/** どのチャンネルにも同じ固定トークンを返す偽の認証。authorize はこの経路では使わない。 */
export const instagramAuthLayer = Layer.succeed(
  InstagramAuth,
  InstagramAuth.of({
    authorize: () => Effect.die("authorize is not part of these fixtures"),
    getAccessToken: () => Effect.succeed(instagramAccessToken),
  }),
);

/** R2 の 4 値。アカウント ID と bucket 名は environment.json、アクセスキーの組は R2_*（ADR-0012 決定 9・issue #757）。 */
export const r2Config = {
  accessKeyId: "R2_ACCESS_KEY_ID_SENTINEL",
  accountId: "r2accountid0123456789",
  bucket: "nyaucast-media",
  secretAccessKey: "R2_SECRET_ACCESS_KEY_SENTINEL",
} as const;

const r2AccessKeyEnvironment = {
  R2_ACCESS_KEY_ID: r2Config.accessKeyId,
  R2_SECRET_ACCESS_KEY: r2Config.secretAccessKey,
};

/**
 * R2 の 4 値を解決できる Layer。configRoot に environment.json（アカウント ID と bucket 名）を書き、
 * アクセスキーの組は StaticSecrets が環境変数から解決する。`StaticSecrets.resolve` は呼ばれた時点の
 * ConfigProvider を読むので、環境変数は Layer の構築側ではなく、解決を呼ぶプログラム側へ届ける必要が
 * ある(src/auth/secrets.test.ts と同じ渡し方)。
 */
export const r2ConfigLayer = (configRoot: string) =>
  Layer.mergeAll(
    StaticSecrets.layer({ configRoot }),
    CloudflareEnvironment.layer({ configRoot }).pipe(Layer.provide(NodeServices.layer)),
    environment(r2AccessKeyEnvironment),
    Layer.effectDiscard(
      Effect.sync(() =>
        writeJsonFile(join(configRoot, "cloudflare", "environment.json"), {
          accountId: r2Config.accountId,
          bucket: r2Config.bucket,
        }),
      ),
    ),
  );

const r2Host = `${r2Config.accountId}.r2.cloudflarestorage.com`;

/** 1 回の試行で使う R2 のオブジェクトキー(issue #555 決定 D6: instagram/<channel>/<postId>.mp4)。 */
export const r2KeyFor = (channel: string, postId: number) => `instagram/${channel}/${postId}.mp4`;

export const r2ObjectUrl = (key: string) => `https://${r2Host}/${r2Config.bucket}/${key}`;

// Graph API は版を付けない(D9。src/instagram/auth.ts と同じ作り)。
const graphOrigin = "https://graph.instagram.com";
export const igUserId = "instagram-id";
export const mediaCreateUrl = (accountId: string = igUserId) => `${graphOrigin}/${accountId}/media`;
export const mediaPublishUrl = (accountId: string = igUserId) =>
  `${graphOrigin}/${accountId}/media_publish`;
export const containerStatusUrl = (containerId: string) => `${graphOrigin}/${containerId}`;

/**
 * コンテナの `status_code` の polling 用の route ハンドラ。呼ばれるたびに列の次の値を返し、
 * 列を使い切ったら die する(test/youtube-fake-client.ts の queue と同じ作法)。
 */
export const statusSequence = (statuses: readonly string[]): Routes[string] => {
  const pending = [...statuses];
  return () => {
    const next = pending.shift();
    return next === undefined
      ? Effect.die("test status_code queue is empty")
      : Response.json({ status_code: next });
  };
};
