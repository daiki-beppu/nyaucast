import { Effect, Option, Schema } from "effect";
import { HttpBody } from "effect/http";

import type { FileReader } from "../videos/video-files.ts";
import { YouTubeClient, type YouTubeClientFailure } from "./client.ts";

// チャンクは 256KB の倍数（issue 決定 8）。最後のチャンクだけ端数。
const chunkBytes = 262_144;
const resumedStatus = 308;

// 失敗は、タグだけを持つ。開始の応答に Location が無い／完了の応答が video ID を持たない、いずれも事実のまま。
export class ResumableUploadFailed extends Schema.TaggedError<ResumableUploadFailed>()(
  "ResumableUploadFailed",
  {},
) {}

/**
 * 送信前のチャンクの読み取り自体が失敗した（ファイルを開いた後の I/O エラー）。サムネイルの読み取り
 * 失敗（post-adapter.ts の ThumbnailReadFailed）と同じ理由で、型付きの失敗として運ぶ必要がある。
 * Effect.promise は reject を defect にし、呼び出し側の Effect.result では捕まらず、試行が結果の
 * 無いまま実行全体を落としてしまう。
 */
export class ChunkReadFailed extends Schema.TaggedError<ChunkReadFailed>()("ChunkReadFailed", {}) {}

/**
 * チャンクの送信が中断し、中断からの再開の照会そのものも失敗（通信の中断・429/5xx・401 などの応答）
 * して完了可否を確定できない（issue 論点 2・B）場合、または照会からの復帰の応答が 2xx/308 以外で
 * 応答しつつ本文から video ID を確定できない（P6）場合に、原因（cause）を保持したまま返す。結果を
 * 書かないこと（B-1〜B-3・P6）と、認証の失敗なら同一アカウントの残りを試さないこと（B-4）は別の
 * 不変条件で、どちらも同じ 1 つの原因から導く（呼び出し側の責務）。直接完了（中断なし）の同じ不正
 * 応答は、この対象にせず permanent のまま区別する（P6）。
 */
export type UploadResumableOutcome =
  | { readonly cause: ResumableUploadFailed | YouTubeClientFailure; readonly kind: "indeterminate" }
  | { readonly kind: "completed"; readonly videoId: string };

export interface ResumableUploadInput {
  /** P1: 境界で解決済みのアクセストークン。exchange の送信直前の認証取得を避ける。 */
  readonly accessToken: string;
  readonly channel: string;
  readonly contentType: string;
  readonly file: FileReader;
  readonly resource: unknown;
  readonly startUrl: string;
}

const CompletedVideo = Schema.Struct({ id: Schema.String });

// "bytes=0-<last>" から次の開始位置。Range が無ければ何も受理されていない（開始を 0 から）。
const nextStartAfter = (range: string | undefined): number =>
  range === undefined ? 0 : Number(range.split("-")[1]) + 1;

const startSession = (input: ResumableUploadInput) =>
  Effect.gen(function* () {
    const client = yield* YouTubeClient;
    const response = yield* client.exchange({
      accessToken: input.accessToken,
      body: () => HttpBody.jsonUnsafe(input.resource),
      channel: input.channel,
      headers: {
        "x-upload-content-length": String(input.file.size),
        "x-upload-content-type": input.contentType,
      },
      method: "POST",
      url: input.startUrl,
    });
    const location = response.headers["location"];
    return location === undefined ? yield* new ResumableUploadFailed() : location;
  });

const readChunk = (file: FileReader, start: number) =>
  Effect.tryPromise({
    catch: () => new ChunkReadFailed(),
    try: () => file.read(start, Math.min(start + chunkBytes, file.size)),
  });

const putChunk = (input: ResumableUploadInput, session: string, bytes: Uint8Array, start: number) =>
  Effect.gen(function* () {
    const client = yield* YouTubeClient;
    return yield* client.exchange({
      accepted: [resumedStatus],
      accessToken: input.accessToken,
      body: () => HttpBody.uint8Array(bytes),
      channel: input.channel,
      headers: {
        "content-range": `bytes ${start}-${start + bytes.length - 1}/${input.file.size}`,
      },
      method: "PUT",
      url: session,
    });
  });

// 中断後の照会: 本文なしで Content-Range: bytes */<size> を送る。開始をやり直さない。
const queryProgress = (input: ResumableUploadInput, session: string) =>
  Effect.gen(function* () {
    const client = yield* YouTubeClient;
    return yield* client.exchange({
      accepted: [resumedStatus],
      accessToken: input.accessToken,
      channel: input.channel,
      headers: { "content-range": `bytes */${input.file.size}` },
      method: "PUT",
      url: session,
    });
  });

const decodeCompletedVideoId = (body: Option.Option<unknown>) =>
  Option.match(body, {
    onNone: () => Effect.fail(new ResumableUploadFailed()),
    onSome: (value) =>
      Schema.decodeUnknownEffect(CompletedVideo)(value).pipe(
        Effect.map((video) => video.id),
        Effect.mapError(() => new ResumableUploadFailed()),
      ),
  });

type ExchangeResponse = {
  readonly body: Option.Option<unknown>;
  readonly headers: Record<string, string | undefined>;
  readonly status: number;
};

/**
 * 308（続きがある）なら次のチャンクへ進む（開始をやり直さない）。そうでなければ、直接完了と
 * 照会からの復帰のどちらであるかに応じて違う onFinal に委ねる（P6: 不正応答の扱いがここだけ違う）。
 */
const continueFromResponse = (
  input: ResumableUploadInput,
  session: string,
  response: ExchangeResponse,
  onFinal: (
    response: ExchangeResponse,
  ) => Effect.Effect<UploadResumableOutcome, ResumableUploadFailed, YouTubeClient>,
): Effect.Effect<
  UploadResumableOutcome,
  ChunkReadFailed | ResumableUploadFailed | YouTubeClientFailure,
  YouTubeClient
> =>
  Effect.gen(function* () {
    if (response.status === resumedStatus) {
      return yield* sendChunkFrom(input, session, nextStartAfter(response.headers["range"]));
    }
    return yield* onFinal(response);
  });

type ContinueHandler = (
  input: ResumableUploadInput,
  session: string,
  response: ExchangeResponse,
) => Effect.Effect<
  UploadResumableOutcome,
  ChunkReadFailed | ResumableUploadFailed | YouTubeClientFailure,
  YouTubeClient
>;

/**
 * チャンクの PUT が直接完了したときの応答の処理（P6）。本文から video ID を確定できない不正応答は、
 * 中断していないので従来どおり ResumableUploadFailed のまま失敗として伝播する（permanent に
 * 分類される。P6-3）。
 */
const continueDirectly: ContinueHandler = (input, session, response) =>
  continueFromResponse(input, session, response, (response) =>
    Effect.gen(function* () {
      const videoId = yield* decodeCompletedVideoId(response.body);
      return { kind: "completed", videoId } as const;
    }),
  );

/**
 * 中断からの再開の照会の応答の処理（P6）。本文から video ID を確定できない場合はここでは完了可否が
 * 不明なままなので、permanent にせず indeterminate（原因付き）として返す（直接完了の同じ不正応答
 * とは区別する。P6-1 と P6-3 の違いはここだけ）。
 */
const continueFromQuery: ContinueHandler = (input, session, response) =>
  continueFromResponse(input, session, response, (response) =>
    Effect.gen(function* () {
      const decoded = yield* decodeCompletedVideoId(response.body).pipe(Effect.result);
      return decoded._tag === "Success"
        ? ({ kind: "completed", videoId: decoded.success } as const)
        : ({ cause: decoded.failure, kind: "indeterminate" } as const);
    }),
  );

const sendChunkFrom = (
  input: ResumableUploadInput,
  session: string,
  start: number,
): Effect.Effect<
  UploadResumableOutcome,
  ChunkReadFailed | ResumableUploadFailed | YouTubeClientFailure,
  YouTubeClient
> =>
  Effect.gen(function* () {
    const bytes = yield* readChunk(input.file, start);
    const putOutcome = yield* putChunk(input, session, bytes, start).pipe(Effect.result);
    if (putOutcome._tag === "Success") {
      return yield* continueDirectly(input, session, putOutcome.success);
    }
    // 送信の中断（HTTP の応答より前に通信が切れた）だけを、照会による再開の対象にする。他の失敗
    // （確定した HTTP 応答）はそのまま伝播する（A: 投稿経路はここで再試行しない）。
    if (putOutcome.failure._tag !== "YouTubeHttpBoundaryFailed") {
      return yield* Effect.fail(putOutcome.failure);
    }
    const queryOutcome = yield* queryProgress(input, session).pipe(Effect.result);
    if (queryOutcome._tag === "Success") {
      return yield* continueFromQuery(input, session, queryOutcome.success);
    }
    // 照会自体がどの理由で失敗しても（通信の中断だけでなく、429・5xx・401 などの応答も）、完了可否を
    // 確定できていない（B）。原因は捨てずに運ぶ（B-4: 呼び出し側が分類して停止の判断に使う）。
    return { cause: queryOutcome.failure, kind: "indeterminate" } as const;
  });

/**
 * resumable upload（issue 決定 8、論点 5・6）。開始のリクエストに X-Upload-Content-Length と
 * X-Upload-Content-Type を付け、resource を JSON の本文として送る。256KB の倍数のチャンクで送り、
 * 中断したら Content-Range（bytes 区間の末尾を「*」にした形）で照会して、開始をやり直さずに再開する。
 * 照会そのもの、または照会からの復帰で完了可否を確定できなければ "indeterminate"（原因付き）を返す。
 * 開始の失敗（Location が無い）はこの不確定の対象にしない（開始はまだ試行を進めておらず、やり直してよい）。
 */
export const uploadResumable = (
  input: ResumableUploadInput,
): Effect.Effect<
  UploadResumableOutcome,
  ChunkReadFailed | ResumableUploadFailed | YouTubeClientFailure,
  YouTubeClient
> =>
  Effect.gen(function* () {
    const session = yield* startSession(input);
    return yield* sendChunkFrom(input, session, 0);
  });
