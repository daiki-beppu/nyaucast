import { Effect, Schema } from "effect";
import { HttpBody } from "effect/http";

import { ChunkReadFailed, type FileReader } from "../videos/video-files.ts";
import { XClient, type XClientFailure } from "./client.ts";

const mediaUploadUrl = "https://api.x.com/2/media/upload";
const mediaCategory = "tweet_video";
const mediaType = "video/mp4";

/**
 * `append` の 1 チャンクの大きさ。X の上限は 5MB（#556 の決定 2）で、MB（10 進の 5_000_000）と
 * MiB（2 進の 5_242_880）のどちらで解釈しても下回る値にする。
 */
export const appendChunkBytes = 4 * 1024 * 1024;

/**
 * 処理待ちの上限。超えたら投稿を 1 回も送らずに切り上げる。チャンネル設定の許容時間の既定（60 分）
 * の中で次回実行が同じ投稿を再び試せるように、その一部に収める。
 */
const processingWaitBudgetMillis = 10 * 60_000;

/**
 * 処理待ちの再照会の間隔の下限。X は `pending`/`in_progress` の応答に `check_after_secs` を付けるが、
 * 付かない応答でも間隔なしで照会し続けないようにする。
 */
const minimumPollSeconds = 1;

/** 処理が終わらないまま待機の上限に達した（一時的。投稿はまだ 1 回も送っていない）。 */
export class XMediaProcessingUnfinished extends Schema.TaggedError<XMediaProcessingUnfinished>()(
  "XMediaProcessingUnfinished",
  {},
) {}

/** `finalize` または `STATUS` が処理の失敗を報告した（恒久的。投稿は送らない。#556 の AC）。 */
export class XMediaProcessingFailed extends Schema.TaggedError<XMediaProcessingFailed>()(
  "XMediaProcessingFailed",
  {},
) {}

// `media_id` は append/finalize/STATUS の URL のパス片と query に入るため、digits だけを受ける。
const MediaId = Schema.String.check(Schema.isPattern(/^[0-9]{1,19}$/u));

const ProcessingInfo = Schema.Struct({
  check_after_secs: Schema.optionalKey(Schema.Finite),
  state: Schema.Literals(["failed", "in_progress", "pending", "succeeded"]),
});
type ProcessingInfo = typeof ProcessingInfo.Type;

const InitializedMedia = Schema.Struct({ data: Schema.Struct({ id: MediaId }) });

// `finalize` と `STATUS` は、処理の進み具合を同じ形で返す（処理が要らなければ processing_info 自体が無い）。
const MediaProcessing = Schema.Struct({
  data: Schema.Struct({ processing_info: Schema.optionalKey(ProcessingInfo) }),
});

interface XMediaUploadInput {
  readonly accessToken: string;
  readonly file: FileReader;
}

interface AppendChunk {
  readonly end: number;
  readonly segmentIndex: number;
  readonly start: number;
}

/** 反復の前に、送る区間と `segment_index` をまとめて決める（反復は送信だけを行う）。 */
const appendChunks = (size: number): ReadonlyArray<AppendChunk> =>
  Array.from({ length: Math.ceil(size / appendChunkBytes) }, (_, segmentIndex) => {
    const start = segmentIndex * appendChunkBytes;
    return { end: Math.min(start + appendChunkBytes, size), segmentIndex, start };
  });

const initialize = (input: XMediaUploadInput) =>
  Effect.gen(function* () {
    const client = yield* XClient;
    const initialized = yield* client.send({
      accessToken: input.accessToken,
      body: () =>
        HttpBody.jsonUnsafe({
          media_category: mediaCategory,
          media_type: mediaType,
          total_bytes: input.file.size,
        }),
      method: "POST",
      schema: InitializedMedia,
      url: `${mediaUploadUrl}/initialize`,
    });
    return initialized.data.id;
  });

const appendChunk = (input: XMediaUploadInput, mediaId: string, chunk: AppendChunk) =>
  Effect.gen(function* () {
    const bytes = yield* Effect.tryPromise({
      catch: () => new ChunkReadFailed(),
      try: () => input.file.read(chunk.start, chunk.end),
    });
    const client = yield* XClient;
    // X は `application/json` と `multipart/form-data` の両方を同じ schema で受ける。本文は読まない。
    yield* client.send({
      accessToken: input.accessToken,
      body: () =>
        HttpBody.jsonUnsafe({
          media: Buffer.from(bytes).toString("base64"),
          segment_index: chunk.segmentIndex,
        }),
      method: "POST",
      schema: Schema.Unknown,
      url: `${mediaUploadUrl}/${mediaId}/append`,
    });
  });

/**
 * `finalize` と `STATUS` は、処理の進み具合を同じ形（MediaProcessing）で返す。送る先と method だけが
 * 違うので、応答の読み方は 1 か所に置く（解釈も classifyMediaProcessing 1 か所で行う）。
 */
const requestProcessing = (input: XMediaUploadInput, method: "GET" | "POST", url: string) =>
  Effect.gen(function* () {
    const client = yield* XClient;
    const response = yield* client.send({
      accessToken: input.accessToken,
      method,
      schema: MediaProcessing,
      url,
    });
    return response.data.processing_info;
  });

const finalize = (input: XMediaUploadInput, mediaId: string) =>
  requestProcessing(input, "POST", `${mediaUploadUrl}/${mediaId}/finalize`);

const requestStatus = (input: XMediaUploadInput, mediaId: string) =>
  requestProcessing(input, "GET", `${mediaUploadUrl}?command=STATUS&media_id=${mediaId}`);

type ProcessingDecision =
  | { readonly delayMillis: number; readonly kind: "wait" }
  | { readonly kind: "done" }
  | { readonly kind: "failed" };

// X が示した check_after_secs を使う。付かない応答でも間隔なしで照会し続けないよう下限で抑える。
const pollDelayMillis = (processing: ProcessingInfo): number =>
  Math.max(processing.check_after_secs ?? minimumPollSeconds, minimumPollSeconds) * 1_000;

/** `finalize` と `STATUS` の `processing_info.state` を同じ規則で読む唯一の判定。 */
const classifyMediaProcessing = (processing: ProcessingInfo): ProcessingDecision => {
  if (processing.state === "succeeded") return { kind: "done" };
  if (processing.state === "failed") return { kind: "failed" };
  return { delayMillis: pollDelayMillis(processing), kind: "wait" };
};

/**
 * 処理中だから照会しているので、`STATUS` の応答に `processing_info` が無いのは X が自身の契約を
 * 破った応答である。`finalize` の欠落（処理不要で完了）と同じ意味に読むと、未処理のメディアで
 * `POST /2/tweets` へ進んでしまうため、完了とは読まない。処理中のまま待ち続け、待機の上限で一時的な
 * 失敗にする（投稿は 1 回も送らない。#556 の決定 2「`STATUS` が `succeeded` まで待つ」）。
 */
const polledProcessing = (processing: ProcessingInfo | undefined): ProcessingInfo =>
  processing ?? { state: "in_progress" };

/**
 * 同じ `media_id` の処理が `succeeded` になるまで待つ。`pending`/`in_progress` のあいだは X が示した
 * `check_after_secs` だけ待って `STATUS` を 1 回送り、残りの待機予算を減らして繰り返す。予算が尽きたら
 * 一時的な失敗にして、この実行では投稿を送らない（次回実行が許容時間の中で再び試す。ADR-0009 決定 9）。
 */
const awaitProcessed = (
  input: XMediaUploadInput,
  mediaId: string,
  processing: ProcessingInfo,
  remainingMillis: number,
): Effect.Effect<
  void,
  XClientFailure | XMediaProcessingFailed | XMediaProcessingUnfinished,
  XClient
> =>
  Effect.gen(function* () {
    const decision = classifyMediaProcessing(processing);
    if (decision.kind === "done") return;
    if (decision.kind === "failed") return yield* new XMediaProcessingFailed();
    if (remainingMillis < decision.delayMillis) {
      return yield* new XMediaProcessingUnfinished();
    }
    yield* Effect.sleep(decision.delayMillis);
    return yield* awaitProcessed(
      input,
      mediaId,
      polledProcessing(yield* requestStatus(input, mediaId)),
      remainingMillis - decision.delayMillis,
    );
  });

/**
 * 1 回の試行の中で X v2 のメディアアップロードを通し、`media_id` を返す（#556 の決定 2）。
 * `initialize` → `append`（5MB 以下のチャンクを `segment_index` 昇順に 1 回ずつ）→ `finalize` →
 * （処理が要るなら）`STATUS` が `succeeded` になるまで待つ。`media_id` は 24 時間で失効するので
 * 戻り値だけで運び、local store には保存しない（呼び出しごとに `initialize` からやり直す）。
 */
export const uploadXMedia = (
  input: XMediaUploadInput,
): Effect.Effect<
  string,
  ChunkReadFailed | XClientFailure | XMediaProcessingFailed | XMediaProcessingUnfinished,
  XClient
> =>
  Effect.gen(function* () {
    const mediaId = yield* initialize(input);
    yield* Effect.forEach(
      appendChunks(input.file.size),
      (chunk) => appendChunk(input, mediaId, chunk),
      { discard: true },
    );
    const finalized = yield* finalize(input, mediaId);
    // `finalize` が processing_info を返さないのは、処理が要らずに完了したことを表す（X は処理不要の
    // メディアに付けない）。この読み方は finalize の応答に限る（polledProcessing の注記）。
    if (finalized !== undefined) {
      yield* awaitProcessed(input, mediaId, finalized, processingWaitBudgetMillis);
    }
    return mediaId;
  });
