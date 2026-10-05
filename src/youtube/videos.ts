import { Effect, Option, Schema } from "effect";

import { YouTubeClient, type YouTubeClientFailure } from "./client.ts";

const videosUrl = "https://youtube.googleapis.com/youtube/v3/videos";
// 削除は 404（既に無い）も成功として扱う（issue 決定「結果の無い試行を持つ投稿は…消さず」の対になる、
// 既に無いリモートへの削除を失敗にしない契約）。
const alreadyGoneStatus = 404;

/** videos.list の応答を decode できなかった（本文が無い・形が違う）。 */
export class YouTubeVideoStatusUnreadable extends Schema.TaggedError<YouTubeVideoStatusUnreadable>()(
  "YouTubeVideoStatusUnreadable",
  {},
) {}

const VideosListBody = Schema.Struct({
  items: Schema.Array(
    Schema.Struct({
      status: Schema.Struct({
        privacyStatus: Schema.String,
        uploadStatus: Schema.String,
      }),
    }),
  ),
});

/** videos.list が返す 1 本の動画の status（issue 決定「公開の確認」が見る 2 つの値）。 */
export interface YouTubeVideoStatus {
  readonly privacyStatus: string;
  readonly uploadStatus: string;
}

/**
 * videos.list（part=status）を 1 回だけ送る。投稿の経路（exchange）と同じく一時的な失敗を
 * 同じ実行の中で送り直さない（issue「#553 の後の前提」「videos.list と削除も投稿の経路と同じく
 * 送り直さない」）。応答の items[].status を decode して返す。decode できなければ
 * YouTubeVideoStatusUnreadable で失敗する。
 */
export const readVideoPublicationStatus = (
  channel: string,
  remoteId: string,
): Effect.Effect<
  ReadonlyArray<YouTubeVideoStatus>,
  YouTubeClientFailure | YouTubeVideoStatusUnreadable,
  YouTubeClient
> =>
  Effect.gen(function* () {
    const client = yield* YouTubeClient;
    const result = yield* client.exchange({
      channel,
      method: "GET",
      url: `${videosUrl}?part=status&id=${remoteId}`,
    });
    const decoded = yield* Schema.decodeUnknownEffect(VideosListBody)(
      Option.getOrUndefined(result.body),
    ).pipe(Effect.mapError(() => new YouTubeVideoStatusUnreadable()));
    return decoded.items.map((item) => item.status);
  });

/**
 * videos の DELETE を 1 回だけ送る（投稿の経路と同じく送り直さない）。204 と 404（既に無い）の
 * どちらも成功として扱う（issue 決定「SNS 側で予約済みのときは、リモートの private の動画を
 * 消してから積む」。既に消えていても取り消しは積める）。
 */
export const deleteVideo = (
  channel: string,
  remoteId: string,
): Effect.Effect<void, YouTubeClientFailure, YouTubeClient> =>
  Effect.gen(function* () {
    const client = yield* YouTubeClient;
    yield* client.exchange({
      accepted: [alreadyGoneStatus],
      channel,
      method: "DELETE",
      url: `${videosUrl}?id=${remoteId}`,
    });
  });
