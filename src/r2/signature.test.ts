import { createHash } from "node:crypto";

import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";

import { presignUrl, signHeaders } from "./signature.ts";

// 契約（issue #555 の計画 C2・D1・D2・D6、SCN-C2-P1・N1・P2・N2）:
//   presignUrl と signHeaders は、AWS SigV4 の仕様どおりに決定的な署名付き URL／ヘッダーを組み立てる
//   （node:crypto だけに依存し、HttpClient も Clock も触らない）。presignUrl は GET の
//   query 署名（UNSIGNED-PAYLOAD）、signHeaders は PUT/DELETE のヘッダー署名（実ペイロードのハッシュ）
//   を担う（D2）。どちらも、オブジェクトキー（D6: instagram/<channel>/<postId>.mp4 の形。
//   チャンネル名には空白を含み得る）の符号化が、canonical request と実際に送る URL/ヘッダーの両方で
//   同じ関数を通ることで一致する（SCN-C2-P1）。
//
// 期待値は、AWS の SigV4 の仕様（canonical request → string to sign → signing key の HMAC 連鎖 →
// signature）に基づいて本テストが独立に計算した値（/tmp のワンオフスクリプトで検証済み）であり、
// 実装のコピーではない。

const fixedNow = new Date("2026-10-06T00:00:00.000Z");
const accessKeyId = "R2_ACCESS_KEY_ID_SENTINEL";
const secretAccessKey = "R2_SECRET_ACCESS_KEY_SENTINEL";
const host = "abcdef0123456789abcdef0123456789.r2.cloudflarestorage.com";
const credentials = { accessKeyId, secretAccessKey };
// presignUrl は上限を外れた期限を defect にするため Effect を返す。期待値は同期に組めるので、
// この helper でその場で実行する(範囲外は runSync が defect を投げ、assert.throws が受ける)。
const presign = (options: Parameters<typeof presignUrl>[0]) => Effect.runSync(presignUrl(options));
const region = "auto";
const service = "s3";

describe("presignUrl: SCN-C2-P1 - a channel name with a space encodes consistently", () => {
  it("keeps path separators literal and encodes the space as %20, matching a hand-computed SigV4 signature", () => {
    const url = presign({
      credentials,
      expiresSeconds: 21600,
      host,
      method: "GET",
      now: fixedNow,
      path: "/nyaucast-media/instagram/my channel/42.mp4",
      region,
      service,
    });

    assert.strictEqual(
      url,
      "https://abcdef0123456789abcdef0123456789.r2.cloudflarestorage.com" +
        "/nyaucast-media/instagram/my%20channel/42.mp4" +
        "?X-Amz-Algorithm=AWS4-HMAC-SHA256" +
        "&X-Amz-Credential=R2_ACCESS_KEY_ID_SENTINEL%2F20261006%2Fauto%2Fs3%2Faws4_request" +
        "&X-Amz-Date=20261006T000000Z" +
        "&X-Amz-Expires=21600" +
        "&X-Amz-SignedHeaders=host" +
        "&X-Amz-Signature=7baa62daa44e82064e02fbe6a158c10fbc7aac4b04fab798e858d113886fa9e4",
    );
  });
});

describe(
  "presignUrl: SCN-C2-N1 - the encoding family (path separators, an embedded slash in a query " +
    "value, a space, query delimiters, a trailing slash in the key)",
  () => {
    it(
      "percent-encodes an embedded slash inside a query value (X-Amz-Credential) as %2F while " +
        "path separators stay literal, and keeps query parameters in ascending name order",
      () => {
        const url = presign({
          credentials,
          expiresSeconds: 604800,
          host,
          method: "GET",
          now: fixedNow,
          path: "/nyaucast-media/instagram/chan&nel=x/42.mp4/",
          region,
          service,
        });

        assert.strictEqual(
          url,
          "https://abcdef0123456789abcdef0123456789.r2.cloudflarestorage.com" +
            "/nyaucast-media/instagram/chan%26nel%3Dx/42.mp4/" +
            "?X-Amz-Algorithm=AWS4-HMAC-SHA256" +
            "&X-Amz-Credential=R2_ACCESS_KEY_ID_SENTINEL%2F20261006%2Fauto%2Fs3%2Faws4_request" +
            "&X-Amz-Date=20261006T000000Z" +
            "&X-Amz-Expires=604800" +
            "&X-Amz-SignedHeaders=host" +
            "&X-Amz-Signature=aa68030a3cc2cb11fd5f884084daa86386833223e880678e7c16219c11e230dc",
        );
      },
    );

    // 昇順に並ぶのは canonical query（署名の対象になるパラメータ）で、X-Amz-Signature は署名の
    // 結果なので対象に入らず、最後に付く（SigV4 の仕様。上の 2 件の URL 全体の期待値と同じ形）。
    it("puts the signed query parameters in ascending name order and appends X-Amz-Signature last", () => {
      const url = presign({
        credentials,
        expiresSeconds: 3600,
        host,
        method: "GET",
        now: fixedNow,
        path: "/nyaucast-media/instagram/chan/1.mp4",
        region,
        service,
      });
      const query = new URL(url).search.slice(1);
      const names = query.split("&").map((pair) => pair.split("=")[0]);
      assert.strictEqual(names.at(-1), "X-Amz-Signature");
      const signedNames = names.slice(0, -1);
      assert.deepStrictEqual(
        signedNames,
        signedNames.toSorted((left, right) => (String(left) < String(right) ? -1 : 1)),
      );
    });
  },
);

describe("presignUrl: SCN-C2-P2/N2 - X-Amz-Expires stays within the 7-day bound R2/S3 presigning allows", () => {
  it("accepts 1 second and 604800 seconds (7 days), the inclusive bounds", () => {
    for (const expiresSeconds of [1, 604800]) {
      const url = presign({
        credentials,
        expiresSeconds,
        host,
        method: "GET",
        now: fixedNow,
        path: "/nyaucast-media/instagram/chan/1.mp4",
        region,
        service,
      });
      assert.include(url, `X-Amz-Expires=${expiresSeconds}`);
    }
  });

  it("refuses to build a URL for an expiry beyond 604800 seconds (7 days)", () => {
    assert.throws(() =>
      presign({
        credentials,
        expiresSeconds: 604801,
        host,
        method: "GET",
        now: fixedNow,
        path: "/nyaucast-media/instagram/chan/1.mp4",
        region,
        service,
      }),
    );
  });

  it("refuses a non-positive expiry", () => {
    assert.throws(() =>
      presign({
        credentials,
        expiresSeconds: 0,
        host,
        method: "GET",
        now: fixedNow,
        path: "/nyaucast-media/instagram/chan/1.mp4",
        region,
        service,
      }),
    );
  });
});

describe("presignUrl: determinism", () => {
  it("is deterministic for the same inputs, and changes when the signing time changes", () => {
    const build = (now: Date) =>
      presign({
        credentials,
        expiresSeconds: 21600,
        host,
        method: "GET",
        now,
        path: "/nyaucast-media/instagram/chan/1.mp4",
        region,
        service,
      });

    assert.strictEqual(build(fixedNow), build(new Date(fixedNow.getTime())));
    assert.notStrictEqual(build(fixedNow), build(new Date(fixedNow.getTime() + 1000)));
  });
});

describe("signHeaders: PUT/DELETE use header signing (D2), with the real payload hash", () => {
  const path = "/nyaucast-media/instagram/my channel/42.mp4";

  it("matches a hand-computed SigV4 Authorization header for a PUT with a known payload hash", () => {
    const payloadSha256 = createHash("sha256").update("hello world").digest("hex");

    const headers = signHeaders({
      credentials,
      host,
      method: "PUT",
      now: fixedNow,
      path,
      payloadSha256,
      region,
      service,
    });

    assert.strictEqual(headers["x-amz-content-sha256"], payloadSha256);
    assert.strictEqual(headers["x-amz-date"], "20261006T000000Z");
    assert.strictEqual(
      headers["authorization"],
      "AWS4-HMAC-SHA256 " +
        "Credential=R2_ACCESS_KEY_ID_SENTINEL/20261006/auto/s3/aws4_request, " +
        "SignedHeaders=host;x-amz-content-sha256;x-amz-date, " +
        "Signature=b5550b2f6db9d1ae5195f00371b594ced3b90a2db15589732e9a7a15e8bb86a1",
    );
  });

  it("matches a hand-computed SigV4 Authorization header for a DELETE (empty payload hash)", () => {
    const emptySha256 = createHash("sha256").update("").digest("hex");

    const headers = signHeaders({
      credentials,
      host,
      method: "DELETE",
      now: fixedNow,
      path,
      payloadSha256: emptySha256,
      region,
      service,
    });

    assert.strictEqual(headers["x-amz-content-sha256"], emptySha256);
    assert.strictEqual(
      headers["authorization"],
      "AWS4-HMAC-SHA256 " +
        "Credential=R2_ACCESS_KEY_ID_SENTINEL/20261006/auto/s3/aws4_request, " +
        "SignedHeaders=host;x-amz-content-sha256;x-amz-date, " +
        "Signature=34d2903e6c756f182aef6691d6c86e381af17051f8e8516bebad7c64f2613e53",
    );
  });

  it("changes the signature when the payload hash changes, with every other input held fixed (the PUT body is actually covered by the signature)", () => {
    const base = {
      credentials,
      host,
      method: "PUT" as const,
      now: fixedNow,
      path,
      region,
      service,
    };
    const a = signHeaders({
      ...base,
      payloadSha256: createHash("sha256").update("a").digest("hex"),
    });
    const b = signHeaders({
      ...base,
      payloadSha256: createHash("sha256").update("b").digest("hex"),
    });
    assert.notStrictEqual(a["authorization"], b["authorization"]);
  });
});
