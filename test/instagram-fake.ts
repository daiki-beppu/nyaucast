import { Effect, Layer } from "effect";

import { InstagramAuth } from "../src/instagram/auth.ts";
import { StaticSecrets } from "../src/auth/secrets.ts";
import { environment } from "./helpers.ts";
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

/** R2 の 4 値(issue #555 決定 5 行目。StaticSecrets が解決する固定の 4 つの名前)。 */
export const r2Secrets = {
  accessKeyId: "R2_ACCESS_KEY_ID_SENTINEL",
  accountId: "r2accountid0123456789",
  bucket: "nyaucast-media",
  secretAccessKey: "R2_SECRET_ACCESS_KEY_SENTINEL",
} as const;

const r2Environment = {
  NYAUCAST_R2_ACCESS_KEY_ID: r2Secrets.accessKeyId,
  NYAUCAST_R2_ACCOUNT_ID: r2Secrets.accountId,
  NYAUCAST_R2_BUCKET: r2Secrets.bucket,
  NYAUCAST_R2_SECRET_ACCESS_KEY: r2Secrets.secretAccessKey,
};

/**
 * StaticSecrets が環境変数から R2 の 4 値を解決できる Layer(configRoot は使われない)。
 * `StaticSecrets.resolve` は呼ばれた時点の ConfigProvider を読むので、環境変数は Layer の構築側では
 * なく、解決を呼ぶプログラム側へ届ける必要がある(src/auth/secrets.test.ts と同じ渡し方)。
 */
export const r2SecretsLayer = (configRoot: string) =>
  Layer.mergeAll(StaticSecrets.layer({ configRoot }), environment(r2Environment));

const r2Host = `${r2Secrets.accountId}.r2.cloudflarestorage.com`;

/** 1 回の試行で使う R2 のオブジェクトキー(issue #555 決定 D6: instagram/<channel>/<postId>.mp4)。 */
export const r2KeyFor = (channel: string, postId: number) => `instagram/${channel}/${postId}.mp4`;

export const r2ObjectUrl = (key: string) => `https://${r2Host}/${r2Secrets.bucket}/${key}`;

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
