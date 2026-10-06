import { Effect, Layer } from "effect";
import { HttpClientError, HttpClientRequest } from "effect/http";

import type { AdapterFailure } from "../src/auth/adapter.ts";
import { XAuth } from "../src/x/auth.ts";
import { XClient } from "../src/x/client.ts";
import { clientLayerOnFakes } from "./helpers.ts";

/**
 * `src/x/client.ts`・`src/x/media-upload.ts`・`src/x/post-adapter.ts`・`due-posts.test.ts` の
 * X 向け統合テストが共有する、偽の `XAuth` と `XClient` の Layer。X の HTTP そのものは
 * `test/sns-api.ts` の `fakeHttp`（URL ごとに答える）を使う（YouTube の queue 式は X には写さない。
 * X の経路は中断からの再開を持たず、1 回の試行の中で initialize → append → finalize → STATUS →
 * tweets が順に呼ばれるだけなので、呼び出し順は route ごとの記録（fakeHttp の `requests`）で確かめる）。
 */

export const xAccessToken = "X_ACCESS_TOKEN_SENTINEL";

/**
 * 既定は、どのチャンネルにも同じ固定トークンを返す偽の認証。差し替えるのはトークンの解決だけで
 * （`XAuth` は `authorize` と `getAccessToken` の 2 つしか持たず、期限の手前で先回りして更新するので
 * 更新のメソッドが無い）、認可フローはこの fixture の対象外。
 */
export const fakeXAuth = (
  getAccessToken: (channel: string) => Effect.Effect<string, AdapterFailure> = () =>
    Effect.succeed(xAccessToken),
) =>
  XAuth.of({
    authorize: () => Effect.die("authorize is not part of these fixtures"),
    getAccessToken,
  });

export const xClientLayer = clientLayerOnFakes(XClient.layer, XAuth, fakeXAuth);

/**
 * X へ到達しないはずの経路（YouTube の投稿、取り消し、公開の確認、公開済みの記録）を検査するテストが
 * `post` の木へ渡す `XClient`。`post` の木全体が XClient を要求する（#556 の platform 非依存化）ので
 * 組めることは必要だが、実際に呼ばれたら platform の振り分けが崩れているので defect にする。
 * 組んだ時点では落とさず、メソッドが呼ばれたときだけ落とす（fakeXAuth の authorize と同じ作法）。
 */
export const unusedXClientLayer = Layer.succeed(
  XClient,
  XClient.of({
    resolveAccessToken: () => Effect.die("XClient.resolveAccessToken must not be called"),
    send: () => Effect.die("XClient.send must not be called"),
  }),
);

/**
 * 通信が応答より前に切れた（中断）ことを再現する。`src/x/auth.test.ts` の `transportFailure` と
 * 同じ作法（`fakeHttp` の handler は生の `HttpClientRequest` を受け取らないため、同じ method/url で
 * 新しく作る。`TransportError` は `request` の値そのものではなく型だけを見る）。
 */
export const xNetworkError = (method: "GET" | "POST" | "PUT", url: string) =>
  Effect.fail(
    new HttpClientError.HttpClientError({
      reason: new HttpClientError.TransportError({
        cause: new Error("simulated connection drop"),
        request: HttpClientRequest.make(method)(url),
      }),
    }),
  );
