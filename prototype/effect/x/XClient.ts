// PROTOTYPE (#475): X への動画投稿クライアント（docs/research/x-video-posting.md の手順）。
// - access token が切れていれば refresh し、ローテーションした refresh token を直ちに書き戻す（直列化する）
// - チャンク分割で upload し、STATUS を check_after_secs に従って polling する
// - made_with_ai: true を付けて投稿する
import { Clock, Context, Duration, Effect, Layer, Ref, Schedule, Schema, Semaphore } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

export const Tokens = Schema.Struct({
  accessToken: Schema.String,
  refreshToken: Schema.String,
  expiresAt: Schema.Number, // epoch ms
});
export type Tokens = typeof Tokens.Type;

// 読み書きの口（#464 の credentials/<channel>/x.json）。試作では差し替え可能な service にするだけ。
export class TokenStore extends Context.Service<
  TokenStore,
  { load: Effect.Effect<Tokens>; save(tokens: Tokens): Effect.Effect<void> }
>()("nyaucast/x/TokenStore") {
  static memory(initial: Tokens) {
    return Layer.effect(
      TokenStore,
      Effect.map(Ref.make(initial), (ref) =>
        TokenStore.of({ load: Ref.get(ref), save: (t) => Ref.set(ref, t) }),
      ),
    );
  }
}

export class XError extends Schema.TaggedError<XError>()("XError", {
  step: Schema.String,
  cause: Schema.Defect(),
}) {}

const TokenResponse = Schema.Struct({
  access_token: Schema.String,
  refresh_token: Schema.String,
  expires_in: Schema.Number,
});
const MediaInit = Schema.Struct({ data: Schema.Struct({ id: Schema.String }) });
const ProcessingInfo = Schema.Struct({
  state: Schema.Literals(["pending", "in_progress", "succeeded", "failed"]),
  check_after_secs: Schema.optionalKey(Schema.Number),
});
const MediaStatus = Schema.Struct({
  data: Schema.Struct({ id: Schema.String, processing_info: Schema.optionalKey(ProcessingInfo) }),
});
const Created = Schema.Struct({ data: Schema.Struct({ id: Schema.String }) });

const CHUNK = 5 * 1024 * 1024;

export class XClient extends Context.Service<XClient>()("nyaucast/x/XClient", {
  make: Effect.gen(function* () {
    const http = (yield* HttpClient.HttpClient).pipe(
      HttpClient.mapRequest(HttpClientRequest.prependUrl("https://api.x.com")),
      HttpClient.filterStatusOk,
    );
    const store = yield* TokenStore;
    const lock = yield* Semaphore.make(1);

    // 期限の 60 秒前から refresh する。二重使用で refresh token が失効するので lock で直列化する。
    const accessToken = lock.withPermits(1)(
      Effect.gen(function* () {
        const tokens = yield* store.load;
        const now = yield* Clock.currentTimeMillis;
        if (now < tokens.expiresAt - 60_000) return tokens.accessToken;
        const fresh = yield* HttpClientRequest.post("/2/oauth2/token").pipe(
          HttpClientRequest.bodyUrlParams({
            grant_type: "refresh_token",
            refresh_token: tokens.refreshToken,
          }),
          http.execute,
          Effect.flatMap(HttpClientResponse.schemaBodyJson(TokenResponse)),
          Effect.mapError((cause) => new XError({ step: "refresh", cause })),
        );
        yield* store.save({
          accessToken: fresh.access_token,
          refreshToken: fresh.refresh_token,
          expiresAt: now + fresh.expires_in * 1000,
        });
        return fresh.access_token;
      }),
    );

    const authed = <A, I>(step: string, request: HttpClientRequest.HttpClientRequest, schema: Schema.Codec<A, I>) =>
      Effect.gen(function* () {
        const token = yield* accessToken;
        return yield* http.execute(HttpClientRequest.bearerToken(request, token)).pipe(
          Effect.flatMap(HttpClientResponse.schemaBodyJson(schema)),
          Effect.mapError((cause) => (cause instanceof XError ? cause : new XError({ step, cause }))),
        );
      });

    const waitProcessed = Effect.fn("XClient.waitProcessed")(function* (mediaId: string) {
      const status = authed(
        "status",
        HttpClientRequest.get("/2/media/upload").pipe(
          HttpClientRequest.setUrlParams({ command: "STATUS", media_id: mediaId }),
        ),
        MediaStatus,
      );
      // check_after_secs だけ待って再確認。succeeded / failed で止める。上限 30 回。
      const pending = (s: typeof MediaStatus.Type) =>
        s.data.processing_info?.state === "pending" || s.data.processing_info?.state === "in_progress";
      const last = yield* status.pipe(
        Effect.tap((s) =>
          pending(s) ? Effect.sleep(Duration.seconds(s.data.processing_info?.check_after_secs ?? 1)) : Effect.void,
        ),
        Effect.repeat({ schedule: Schedule.recurs(30), while: pending }),
      );
      if (last.data.processing_info?.state !== "succeeded") {
        return yield* new XError({ step: "status", cause: last.data.processing_info });
      }
    });

    const uploadVideo = Effect.fn("XClient.uploadVideo")(function* (video: Uint8Array<ArrayBuffer>) {
      const init = yield* authed(
        "initialize",
        HttpClientRequest.post("/2/media/upload/initialize").pipe(
          HttpClientRequest.bodyJsonUnsafe({
            media_type: "video/mp4",
            total_bytes: video.byteLength,
            media_category: "tweet_video",
          }),
        ),
        MediaInit,
      );
      const id = init.data.id;
      for (let index = 0; index * CHUNK < video.byteLength; index++) {
        const form = new FormData();
        form.append("segment_index", String(index));
        form.append("media", new Blob([video.subarray(index * CHUNK, (index + 1) * CHUNK)]));
        yield* authed(
          "append",
          HttpClientRequest.post(`/2/media/upload/${id}/append`).pipe(HttpClientRequest.bodyFormData(form)),
          Schema.Any,
        );
      }
      yield* authed("finalize", HttpClientRequest.post(`/2/media/upload/${id}/finalize`), MediaStatus);
      yield* waitProcessed(id);
      return id;
    });

    const post = Effect.fn("XClient.post")(function* (text: string, video: Uint8Array<ArrayBuffer>) {
      const mediaId = yield* uploadVideo(video);
      const created = yield* authed(
        "post",
        HttpClientRequest.post("/2/tweets").pipe(
          HttpClientRequest.bodyJsonUnsafe({ text, media: { media_ids: [mediaId] }, made_with_ai: true }),
        ),
        Created,
      );
      return created.data.id;
    });

    return { post };
  }),
}) {
  static readonly layer = Layer.effect(this, this.make);
}
