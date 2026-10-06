import { createHash, createHmac } from "node:crypto";

import { Effect } from "effect";

/**
 * AWS SigV4 の署名の計算（Cloudflare R2 は S3 互換の API を同じ署名で受ける）。HttpClient も Clock も
 * 触らず、時刻は呼び出し側が渡すので、同じ入力からは必ず同じ署名になる。GET の受け渡し用の URL は
 * query 署名（`UNSIGNED-PAYLOAD`）、PUT / DELETE はヘッダー署名（実ペイロードのハッシュ）を使う。
 */

const algorithm = "AWS4-HMAC-SHA256";
const terminator = "aws4_request";
const unsignedPayload = "UNSIGNED-PAYLOAD";
const signedHeadersForPresign = "host";
const signedHeadersForHeaderSigning = "host;x-amz-content-sha256;x-amz-date";

/** 署名付き URL の期限の上限（SigV4 の presign が許す 7 日。issue #555 決定 3 行目の「最長 7 日」）。 */
const maximumExpiresSeconds = 604_800;

interface R2Credentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

export type R2Method = "DELETE" | "GET" | "PUT";

interface SigningBase {
  readonly credentials: R2Credentials;
  readonly host: string;
  readonly method: R2Method;
  /** 署名の時刻。呼び出し側が Clock から解決して渡す。 */
  readonly now: Date;
  /** 符号化前のパス（`/<bucket>/<key>`）。符号化はこのモジュールが 1 か所で行う。 */
  readonly path: string;
  readonly region: string;
  readonly service: string;
}

const unreserved = /[A-Za-z0-9\-._~]/u;

/**
 * SigV4 の percent-encoding。区切りとしての `/` を残すかどうかだけが、パスと query 値で違う
 * （値の中の `/` は `%2F`、空白は `%20`。`+` にはしない）。
 */
const uriEncode = (value: string, keepSlash: boolean): string => {
  let encoded = "";
  for (const byte of new TextEncoder().encode(value)) {
    const character = String.fromCharCode(byte);
    encoded =
      unreserved.test(character) || (keepSlash && character === "/")
        ? `${encoded}${character}`
        : `${encoded}%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return encoded;
};

/**
 * オブジェクトのパスの符号化。canonical request と、実際に送る URL の両方がこの 1 か所を通ることで、
 * 署名の対象と宛先が必ず一致する（チャンネル名に空白が入っても食い違わない）。
 */
export const encodePath = (path: string): string => uriEncode(path, true);

const hashHex = (value: string) => createHash("sha256").update(value).digest("hex");

const hmac = (key: Buffer | string, value: string) =>
  createHmac("sha256", key).update(value).digest();

const amzDateOf = (now: Date) => now.toISOString().replace(/[-:]|\.\d{3}/gu, "");

const scopeOf = (base: SigningBase, date: string) =>
  `${date}/${base.region}/${base.service}/${terminator}`;

const credentialOf = (base: SigningBase, date: string) =>
  `${base.credentials.accessKeyId}/${scopeOf(base, date)}`;

const signingKey = (base: SigningBase, date: string) =>
  [base.region, base.service, terminator].reduce(
    (key, part) => hmac(key, part),
    hmac(`AWS4${base.credentials.secretAccessKey}`, date),
  );

const signatureOf = (base: SigningBase, canonicalRequest: string, amzDate: string) => {
  const date = amzDate.slice(0, 8);
  const stringToSign = [algorithm, amzDate, scopeOf(base, date), hashHex(canonicalRequest)].join(
    "\n",
  );
  return createHmac("sha256", signingKey(base, date)).update(stringToSign).digest("hex");
};

// query のパラメータは名前の昇順で、名前も値も区切りを含めずに符号化する。
const canonicalQuery = (parameters: Readonly<Record<string, string>>) =>
  Object.entries(parameters)
    .sort(([left], [right]) => (left < right ? -1 : 1))
    .map(([name, value]) => `${uriEncode(name, false)}=${uriEncode(value, false)}`)
    .join("&");

const isExpiresWithinBound = (expiresSeconds: number) =>
  Number.isInteger(expiresSeconds) &&
  expiresSeconds >= 1 &&
  expiresSeconds <= maximumExpiresSeconds;

interface PresignOptions extends SigningBase {
  readonly expiresSeconds: number;
}

const buildPresignedUrl = (options: PresignOptions): string => {
  const amzDate = amzDateOf(options.now);
  const query = canonicalQuery({
    "X-Amz-Algorithm": algorithm,
    "X-Amz-Credential": credentialOf(options, amzDate.slice(0, 8)),
    "X-Amz-Date": amzDate,
    "X-Amz-Expires": String(options.expiresSeconds),
    "X-Amz-SignedHeaders": signedHeadersForPresign,
  });
  const path = encodePath(options.path);
  const canonicalRequest = [
    options.method,
    path,
    query,
    `host:${options.host}\n`,
    signedHeadersForPresign,
    unsignedPayload,
  ].join("\n");
  const signature = signatureOf(options, canonicalRequest, amzDate);
  return `https://${options.host}${path}?${query}&X-Amz-Signature=${signature}`;
};

/**
 * 受け渡し用の署名付き URL（query 署名）。本文は無いので `UNSIGNED-PAYLOAD` で署名する。
 * 期限は呼び出し側の定数で決まるので、上限（7 日）を外れるのは呼び出し側の誤りとして defect にする
 * （範囲外の期限を持つ URL は組まない）。
 */
export const presignUrl = (options: PresignOptions): Effect.Effect<string> =>
  isExpiresWithinBound(options.expiresSeconds)
    ? Effect.sync(() => buildPresignedUrl(options))
    : Effect.die(
        `a presigned URL's expiry must be an integer between 1 and ${maximumExpiresSeconds} seconds`,
      );

interface SignHeadersOptions extends SigningBase {
  /** 実際に送る本文の sha256（16 進）。本文を署名の対象に含めるため、呼び出し側が先に計算する。 */
  readonly payloadSha256: string;
}

/** PUT / DELETE のヘッダー署名。`x-amz-content-sha256` に実ペイロードのハッシュを入れる。 */
export const signHeaders = (options: SignHeadersOptions): Record<string, string> => {
  const amzDate = amzDateOf(options.now);
  const canonicalRequest = [
    options.method,
    encodePath(options.path),
    "",
    `host:${options.host}\nx-amz-content-sha256:${options.payloadSha256}\nx-amz-date:${amzDate}\n`,
    signedHeadersForHeaderSigning,
    options.payloadSha256,
  ].join("\n");
  const signature = signatureOf(options, canonicalRequest, amzDate);
  return {
    authorization:
      `${algorithm} Credential=${credentialOf(options, amzDate.slice(0, 8))}, ` +
      `SignedHeaders=${signedHeadersForHeaderSigning}, Signature=${signature}`,
    "x-amz-content-sha256": options.payloadSha256,
    "x-amz-date": amzDate,
  };
};
