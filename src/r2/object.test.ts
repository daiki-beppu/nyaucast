import { createHash } from "node:crypto";

import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { HttpClient } from "effect/http";

import { environment, fakeSpawner } from "../../test/helpers.ts";
import {
  bodyReadingHttpClient,
  readerFailingOnCall,
  succeedingReader,
} from "../../test/r2-fake.ts";
import { fakeHttp } from "../../test/sns-api.ts";
import { StaticSecrets } from "../auth/secrets.ts";
import { uploadChunkBytes } from "../videos/video-files.ts";
import {
  deleteObject,
  presignGetUrl,
  putObject,
  resolveR2Config,
  type R2Config,
} from "./object.ts";

// 契約（issue #555 の計画 C3・C4・D1・D6、SCN-C3-P1・N1）:
//   resolveR2Config は、R2 の account ID・bucket・アクセスキー ID・シークレットアクセスキーの 4 つを
//   `StaticSecrets` で固定の 4 つの名前（NYAUCAST_R2_ACCOUNT_ID・NYAUCAST_R2_BUCKET・
//   NYAUCAST_R2_ACCESS_KEY_ID・NYAUCAST_R2_SECRET_ACCESS_KEY）から解決する境界。1 つでも欠ければ、
//   その名前を持つ SecretNotConfigured で失敗する。
//   putObject/deleteObject は、呼び出し側が渡した key だけを対象にする（SigV4 自体の正しさは
//   src/r2/signature.test.ts が確認済みなので、ここでは host・path・method と、ヘッダー署名が
//   実際に使われていること、2 つの異なるキーの削除が互いに干渉しないことを確認する）。

const r2Names = {
  accessKeyId: "NYAUCAST_R2_ACCESS_KEY_ID",
  accountId: "NYAUCAST_R2_ACCOUNT_ID",
  bucket: "NYAUCAST_R2_BUCKET",
  secretAccessKey: "NYAUCAST_R2_SECRET_ACCESS_KEY",
} as const;

const validR2Env = {
  NYAUCAST_R2_ACCESS_KEY_ID: "ACCESS_KEY_ID_SENTINEL",
  NYAUCAST_R2_ACCOUNT_ID: "accountid0123456789",
  NYAUCAST_R2_BUCKET: "nyaucast-media",
  NYAUCAST_R2_SECRET_ACCESS_KEY: "SECRET_ACCESS_KEY_SENTINEL",
};

// StaticSecrets は configRoot/secrets.json を読むが、環境変数が先に読まれるのでこのテストでは
// 存在しないパスで構わない(StaticSecrets.resolve は環境変数で解決し、ファイルへ進まない)。
// `op` の偽物は、環境変数の経路だけを通ることを保証するために「呼ばれたら 1 で終わる」ものを渡す。
const staticSecretsLayer = StaticSecrets.layer({
  configRoot: "/nonexistent-nyaucast-config-root",
}).pipe(
  Layer.provide(fakeSpawner({ exitCode: 1, stdout: "" }).layer),
  Layer.provide(NodeServices.layer),
);

const resolveWith = (env: Record<string, string>) =>
  Effect.result(resolveR2Config).pipe(
    Effect.provide(Layer.mergeAll(staticSecretsLayer, environment(env))),
  );

describe("resolveR2Config: C4 - the 4 values are resolved from StaticSecrets by fixed names", () => {
  it.effect("resolves all 4 values from the environment", () =>
    Effect.gen(function* () {
      const result = yield* resolveWith(validR2Env);
      assert.strictEqual(result._tag, "Success");
      assert.deepStrictEqual(result._tag === "Success" ? result.success : undefined, {
        accessKeyId: "ACCESS_KEY_ID_SENTINEL",
        accountId: "accountid0123456789",
        bucket: "nyaucast-media",
        secretAccessKey: "SECRET_ACCESS_KEY_SENTINEL",
      });
    }),
  );

  it.effect.each(Object.entries(r2Names))(
    "fails with SecretNotConfigured naming %s when that one name is missing",
    ([, missingName]) =>
      Effect.gen(function* () {
        const env = { ...validR2Env };
        delete (env as Record<string, string>)[missingName];

        const result = yield* resolveWith(env);

        assert.strictEqual(result._tag, "Failure");
        const failure = result._tag === "Failure" ? result.failure : undefined;
        assert.strictEqual((failure as { _tag?: string } | undefined)?._tag, "SecretNotConfigured");
        assert.strictEqual((failure as { name?: string } | undefined)?.name, missingName);
      }),
  );
});

const fixedConfig: R2Config = {
  accessKeyId: "ACCESS_KEY_ID_SENTINEL",
  accountId: "accountid0123456789",
  bucket: "nyaucast-media",
  secretAccessKey: "SECRET_ACCESS_KEY_SENTINEL",
};
const r2Host = `${fixedConfig.accountId}.r2.cloudflarestorage.com`;
const keyA = "instagram/chan/1.mp4";
const keyB = "instagram/chan/2.mp4";

// R2 がヘッダー署名の PUT を受理する条件は、送られた本文の SHA-256 が x-amz-content-sha256 と
// 一致すること。putObject は本文を 2 度読む（ハッシュの計算とストリームの送信）ので、チャンクの
// 列挙や 2 つの読みの食い違いが起きると本文とハッシュが一致しなくなる。1 チャンクに収まらない
// 大きさ（uploadChunkBytes + 端数）で、受け取った本文全体とそのハッシュの一致を確認する。
describe("putObject: the body it sends and the payload hash it signs agree, across chunk boundaries", () => {
  it.effect("sends every chunk of a multi-chunk payload and signs that exact body's SHA-256", () =>
    Effect.gen(function* () {
      // 位置ごとに違う値にして、チャンクの欠落・重複・順序の入れ替わりを検出できるようにする。
      const bytes = Uint8Array.from(
        { length: uploadChunkBytes + 1234 },
        (_, index) => (index * 31 + 7) % 256,
      );
      const expectedSha256 = createHash("sha256").update(bytes).digest("hex");
      const fixture = fakeHttp({
        [`PUT https://${r2Host}/${fixedConfig.bucket}/${keyA}`]: (request) => {
          assert.strictEqual(request.bodyBytes?.length, bytes.length);
          assert.deepStrictEqual(request.bodyBytes, bytes);
          assert.strictEqual(request.headers["x-amz-content-sha256"], expectedSha256);
          return new Response(null, { status: 200 });
        },
      });

      yield* putObject(fixedConfig, keyA, succeedingReader(bytes)).pipe(
        Effect.provide(fixture.layer),
      );

      assert.strictEqual(fixture.requests.length, 1);
    }),
  );
});

// putObject は本文を 2 度読む（ハッシュの計算とストリームの送信）。2 度目の読みの失敗は HTTP client が
// リクエストの失敗として包み、原因の型を失う（HttpBody.stream の失敗型は unknown）。それでも、同じ原因
// （書き出しのファイルのチャンクが読めない）はどちらの読みで起きても同じ失敗のタグで届く必要がある。
// タグはこの先の分類（src/posts/post-outcome.ts）と `post run` の 1 行がそのまま使う契約である。
// そのタグがどの分類になるかは src/posts/post-outcome.test.ts が同じ偽物で観測する。

const failureTagOf = <A, E>(
  program: Effect.Effect<A, E, HttpClient.HttpClient>,
  layer: Layer.Layer<HttpClient.HttpClient>,
) =>
  Effect.gen(function* () {
    const result = yield* Effect.result(program).pipe(Effect.provide(layer));
    assert.strictEqual(result._tag, "Failure");
    return (result as { failure: { _tag?: string } }).failure._tag;
  });

describe("putObject: a chunk read failure carries the same failure tag wherever the read happens", () => {
  it.effect.each([
    ["the hash pass", 1],
    ["the body stream send", 2],
  ] as const)("fails with R2PayloadReadFailed when the read fails during %s", ([, failingCall]) =>
    Effect.gen(function* () {
      const tag = yield* failureTagOf(
        putObject(
          fixedConfig,
          keyA,
          readerFailingOnCall(Uint8Array.from([1, 2, 3, 4]), failingCall),
        ),
        bodyReadingHttpClient(false),
      );

      assert.strictEqual(tag, "R2PayloadReadFailed");
    }),
  );

  // 識別力のある反例: 読みが 1 度も失敗しなければ、client 側の失敗は一時的な R2BoundaryFailed のまま。
  it.effect(
    "fails with R2BoundaryFailed when every read succeeds and the client itself fails",
    () =>
      Effect.gen(function* () {
        const tag = yield* failureTagOf(
          putObject(fixedConfig, keyA, succeedingReader(Uint8Array.from([1, 2, 3, 4]))),
          bodyReadingHttpClient(true),
        );

        assert.strictEqual(tag, "R2BoundaryFailed");
      }),
  );
});

describe("putObject: sends a header-signed PUT with the given key and bytes", () => {
  it.effect(
    "PUTs to the bucket/key path on the account's R2 host, with the real payload and a SigV4 authorization header",
    () =>
      Effect.gen(function* () {
        const bytes = Uint8Array.from([1, 2, 3, 4]);
        const fixture = fakeHttp({
          [`PUT https://${r2Host}/${fixedConfig.bucket}/${keyA}`]: (request) => {
            assert.deepStrictEqual(request.bodyBytes, bytes);
            assert.isDefined(request.headers["x-amz-content-sha256"]);
            assert.match(request.headers["authorization"] ?? "", /^AWS4-HMAC-SHA256 /u);
            return new Response(null, { status: 200 });
          },
        });

        yield* putObject(fixedConfig, keyA, succeedingReader(bytes)).pipe(
          Effect.provide(fixture.layer),
        );
      }),
  );
});

describe(
  "deleteObject: SCN-C3-P1/N1 - deleting one object's key does not touch another object's key, " +
    "even when both share the same bucket and channel namespace",
  () => {
    it.effect("sends DELETE only for the given key's path, not the other key", () =>
      Effect.gen(function* () {
        const fixture = fakeHttp({
          [`DELETE https://${r2Host}/${fixedConfig.bucket}/${keyA}`]: () =>
            new Response(null, { status: 204 }),
        });

        yield* deleteObject(fixedConfig, keyA).pipe(Effect.provide(fixture.layer));

        assert.strictEqual(fixture.requests.length, 1);
        assert.strictEqual(
          fixture.requests[0]?.key,
          `DELETE https://${r2Host}/${fixedConfig.bucket}/${keyA}`,
        );
        // keyB 宛のリクエストは 1 件も発生していない(fakeHttp は routes に無いキーで die するので、
        // keyB への誤配信があればこのテスト自体が死んで検出できる)。
        assert.notInclude(
          fixture.requests.map((request) => request.key),
          `DELETE https://${r2Host}/${fixedConfig.bucket}/${keyB}`,
        );
      }),
    );

    it.effect(
      "deleting object A's key after writing both A and B leaves B's own delete independent (two posts' attempts do not collide)",
      () =>
        Effect.gen(function* () {
          const deletedKeys: string[] = [];
          const fixture = fakeHttp({
            [`DELETE https://${r2Host}/${fixedConfig.bucket}/${keyA}`]: () => {
              deletedKeys.push(keyA);
              return new Response(null, { status: 204 });
            },
            [`DELETE https://${r2Host}/${fixedConfig.bucket}/${keyB}`]: () => {
              deletedKeys.push(keyB);
              return new Response(null, { status: 204 });
            },
          });

          yield* deleteObject(fixedConfig, keyA).pipe(Effect.provide(fixture.layer));
          yield* deleteObject(fixedConfig, keyB).pipe(Effect.provide(fixture.layer));

          assert.deepStrictEqual(deletedKeys, [keyA, keyB]);
        }),
    );
  },
);

describe("presignGetUrl: composes the account's R2 host and the bucket/key path", () => {
  it("builds a URL on the account's R2 host, with the bucket/key path and the given expiry", () => {
    const now = new Date("2026-10-06T00:00:00.000Z");
    const url = Effect.runSync(presignGetUrl(fixedConfig, keyA, 21600, now));
    const parsed = new URL(url);

    assert.strictEqual(parsed.host, r2Host);
    assert.strictEqual(parsed.pathname, `/${fixedConfig.bucket}/${keyA}`);
    assert.strictEqual(parsed.searchParams.get("X-Amz-Expires"), "21600");
    assert.isTrue(parsed.searchParams.get("X-Amz-Credential")?.startsWith(fixedConfig.accessKeyId));
  });
});
