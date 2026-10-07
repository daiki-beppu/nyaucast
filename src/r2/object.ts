import { createHash } from "node:crypto";

import { Clock, Effect, Option, Ref, Schema, Stream } from "effect";
import { HttpBody, HttpClient, HttpClientRequest } from "effect/http";

import { StaticSecrets, type StaticSecretsFailure } from "../auth/secrets.ts";
import {
  CloudflareEnvironment,
  type CloudflareEnvironmentInvalid,
  CloudflareEnvironmentNotCreated,
} from "../cloudflare/environment.ts";
import { type FileReader, readUploadChunk, uploadChunkBytes } from "../videos/video-files.ts";
import { encodePath, type R2Method, presignUrl, signHeaders } from "./signature.ts";

/**
 * R2 のオブジェクトの 1 操作ずつ（置く・消す・受け渡し用の署名付き URL を組む）。公開するのは
 * ドメイン上の操作だけで、署名の計算（signature.ts）は外へ出さない。推測できないキーでの一時公開や
 * 公開 ACL の操作は持たない（issue #555 決定 4 行目。この差分は署名付き URL の経路までとする）。
 */

// アクセスキーの組の名前は ADR-0012 決定 9 が固定した（issue #757）。静的なシークレットの仕組み
// （StaticSecrets）だけが解決する。アカウント ID と bucket 名は Cloudflare 環境の写し（environment.json）から読む。
const accessKeyIdName = "R2_ACCESS_KEY_ID";
const secretAccessKeyName = "R2_SECRET_ACCESS_KEY";

// R2 は region を持たないので、S3 互換の署名では "auto" を使う。
const region = "auto";
const service = "s3";
const videoContentType = "video/mp4";

const emptyPayloadSha256 = createHash("sha256").update("").digest("hex");

// 失敗は、タグと HTTP status だけを持つ。署名付き URL・オブジェクトキー・アクセスキーは持たない。
class R2HttpFailure extends Schema.TaggedError<R2HttpFailure>()("R2HttpFailure", {
  status: Schema.Finite,
}) {}
class R2BoundaryFailed extends Schema.TaggedError<R2BoundaryFailed>()("R2BoundaryFailed", {}) {}
/**
 * 送る本文の読み取り自体が失敗した（ファイルを開いた後の I/O エラー）。`Effect.promise` の reject は
 * defect になり、呼び出し側の `Effect.result` で捕まらないため、ここで型付きの失敗へ変換する。
 *
 * ハッシュを計算する読み（`hashPayload`）と、本文のストリームを送る読み（`payloadStream`）の
 * どちらで起きてもこの型で届く。後者は HTTP client がリクエストの失敗として包み、原因の型を失う
 * （`HttpBody.stream` の失敗型は unknown）ため、`putObject` が読み取りの失敗を記録しておき、
 * 分類（post-outcome.ts）の前に client 側の失敗（`R2BoundaryFailed`）と区別する。
 */
class R2PayloadReadFailed extends Schema.TaggedError<R2PayloadReadFailed>()(
  "R2PayloadReadFailed",
  {},
) {}

export type R2ObjectFailure = R2BoundaryFailed | R2HttpFailure | R2PayloadReadFailed;

/** R2 へ繋ぐために解決済みの 4 値。下位層は設定ソースを問い合わせず、この解決済みの値だけを使う。 */
export interface R2Config {
  readonly accessKeyId: string;
  readonly accountId: string;
  readonly bucket: string;
  readonly secretAccessKey: string;
}

export type R2ConfigFailure =
  | CloudflareEnvironmentInvalid
  | CloudflareEnvironmentNotCreated
  | StaticSecretsFailure;

/**
 * R2 の 4 値を解決する境界（ADR-0012 決定 9・issue #757）。アカウント ID と bucket 名は environment.json
 * から、アクセスキーの組は `StaticSecrets`（環境変数 → `secrets.json` の参照 → environment.json の
 * 秘密のブロック）から読む。environment.json が無ければ、Cloudflare 環境が未作成として失敗する。
 */
export const resolveR2Config: Effect.Effect<
  R2Config,
  R2ConfigFailure,
  CloudflareEnvironment | StaticSecrets
> = Effect.gen(function* () {
  const environment = yield* (yield* CloudflareEnvironment).read;
  if (Option.isNone(environment)) {
    return yield* new CloudflareEnvironmentNotCreated();
  }
  const secrets = yield* StaticSecrets;
  return {
    accessKeyId: yield* secrets.resolve(accessKeyIdName),
    accountId: environment.value.accountId,
    bucket: environment.value.bucket,
    secretAccessKey: yield* secrets.resolve(secretAccessKeyName),
  };
});

/** host・パス・region・service を組む唯一の場所。presign と header 署名が同じ値を共有する。 */
const signingBase = (config: R2Config, method: R2Method, key: string, now: Date) => ({
  credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
  host: `${config.accountId}.r2.cloudflarestorage.com`,
  method,
  now,
  path: `/${config.bucket}/${key}`,
  region,
  service,
});

type SigningBase = ReturnType<typeof signingBase>;

const chunkStarts = (size: number) => {
  const starts: number[] = [];
  for (let start = 0; start < size; start += uploadChunkBytes) {
    starts.push(start);
  }
  return starts;
};

const readChunk = (video: FileReader, start: number) =>
  readUploadChunk(video, start, () => new R2PayloadReadFailed());

/**
 * 本文の sha256。ヘッダー署名は実ペイロードのハッシュを含むので、送る前に 1 度計算する必要がある。
 * 全体をメモリに載せないため、チャンクを順に読んで hash を進める。
 */
const hashPayload = (video: FileReader) =>
  Effect.gen(function* () {
    const hash = createHash("sha256");
    for (const start of chunkStarts(video.size)) {
      hash.update(yield* readChunk(video, start));
    }
    return hash.digest("hex");
  });

/**
 * 送る本文のストリーム。送信中の読み取りの失敗は HTTP client がリクエストの失敗として包むので、
 * 型付きの失敗が起きた事実だけを `readFailed` へ残してから、失敗をそのまま伝える（握りつぶさない）。
 * 読み取りの失敗を client の包み方から復元する方式は採らない（包み方は client の実装ごとに違う）。
 */
const payloadStream = (video: FileReader, readFailed: Ref.Ref<boolean>) =>
  Stream.fromIterable(chunkStarts(video.size)).pipe(
    Stream.mapEffect((start) =>
      readChunk(video, start).pipe(Effect.tapError(() => Ref.set(readFailed, true))),
    ),
  );

const sendSigned = (
  base: SigningBase,
  payloadSha256: string,
  body: HttpBody.HttpBody,
): Effect.Effect<void, R2BoundaryFailed | R2HttpFailure, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    const request = HttpClientRequest.make(base.method)(
      `https://${base.host}${encodePath(base.path)}`,
      { headers: signHeaders({ ...base, payloadSha256 }) },
    ).pipe(HttpClientRequest.setBody(body));
    const response = yield* http
      .execute(request)
      .pipe(Effect.mapError(() => new R2BoundaryFailed()));
    if (response.status < 200 || response.status >= 300) {
      return yield* new R2HttpFailure({ status: response.status });
    }
  });

/** 動画 1 本を、呼び出し側が決めたキーへ置く（ヘッダー署名。本文は内容長付きのストリーム）。 */
export const putObject = (
  config: R2Config,
  key: string,
  video: FileReader,
): Effect.Effect<void, R2ObjectFailure, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const payloadSha256 = yield* hashPayload(video);
    const now = new Date(yield* Clock.currentTimeMillis);
    const readFailed = yield* Ref.make(false);
    yield* sendSigned(
      signingBase(config, "PUT", key, now),
      payloadSha256,
      HttpBody.stream(payloadStream(video, readFailed), videoContentType, video.size),
    ).pipe(
      // client が返した失敗のうち、原因が本文の読み取りだったものを型付きの失敗へ戻す。分類の前に
      // 行うので、同じ原因がハッシュの計算で起きた場合と同じ分類・同じタグになる。非 2xx
      // （R2HttpFailure）と、読み取りが絡まない通信の失敗はそのまま伝える。
      Effect.catchTag("R2BoundaryFailed", (boundaryFailed) =>
        Effect.gen(function* () {
          if (yield* Ref.get(readFailed)) {
            return yield* new R2PayloadReadFailed();
          }
          return yield* boundaryFailed;
        }),
      ),
    );
  });

/** オブジェクト 1 つを消す（呼び出し側が渡したキーだけを対象にする）。 */
export const deleteObject = (
  config: R2Config,
  key: string,
): Effect.Effect<void, R2ObjectFailure, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const now = new Date(yield* Clock.currentTimeMillis);
    yield* sendSigned(signingBase(config, "DELETE", key, now), emptyPayloadSha256, HttpBody.empty);
  });

/** 受け渡し用の署名付き GET URL。期限の上限（7 日）は signature.ts が拒否する。 */
export const presignGetUrl = (
  config: R2Config,
  key: string,
  expiresSeconds: number,
  now: Date,
): Effect.Effect<string> => presignUrl({ ...signingBase(config, "GET", key, now), expiresSeconds });
