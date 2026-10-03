import { Deferred, Effect, Option, Schema, type Scope } from "effect";

/** Chrome のダウンロード・起動・CDP の接続とコマンドの失敗。原因はログに出さず、失敗した段階だけを持つ。 */
export class ChromeUnavailable extends Schema.TaggedError<ChromeUnavailable>()(
  "ChromeUnavailable",
  { stage: Schema.Literals(["download", "launch", "connect", "command", "closed"]) },
) {}

// CDP のメッセージ。応答は id を持ち、イベントは method を持つ。flatten した session の宛先は sessionId。
const Message = Schema.Struct({
  error: Schema.optionalKey(Schema.Struct({ message: Schema.String })),
  id: Schema.optionalKey(Schema.Finite),
  method: Schema.optionalKey(Schema.String),
  result: Schema.optionalKey(Schema.Unknown),
  sessionId: Schema.optionalKey(Schema.String),
});
const decodeMessage = Schema.decodeUnknownOption(Schema.fromJsonString(Message));

export interface CdpConnection {
  /** コマンドを送り、結果を返す。ブラウザが error を返したら command の失敗。 */
  send(
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
  ): Effect.Effect<unknown, ChromeUnavailable>;
  /** イベントの待ちを先に登録する。外側の Effect が登録で、返った Effect がイベントの到着まで待つ。 */
  expect(method: string, sessionId: string): Effect.Effect<Effect.Effect<void, ChromeUnavailable>>;
}

type Pending = Deferred.Deferred<unknown, ChromeUnavailable>;

const closedFailure = new ChromeUnavailable({ stage: "closed" });

const openSocket = (url: string) =>
  Effect.callback<WebSocket, ChromeUnavailable>((resume) => {
    const socket = new WebSocket(url);
    socket.addEventListener("open", () => resume(Effect.succeed(socket)), { once: true });
    socket.addEventListener(
      "error",
      () => resume(Effect.fail(new ChromeUnavailable({ stage: "connect" }))),
      { once: true },
    );
  });

/** ブラウザの WebSocket へ CDP で直結する。スコープが終わると閉じる。 */
export const connectCdp = (
  url: string,
): Effect.Effect<CdpConnection, ChromeUnavailable, Scope.Scope> =>
  Effect.gen(function* () {
    const socket = yield* Effect.acquireRelease(openSocket(url), (opened) =>
      Effect.sync(() => opened.close()),
    );
    const pending = new Map<number, Pending>();
    const waiters = new Map<string, Deferred.Deferred<void, ChromeUnavailable>[]>();
    let nextId = 0;

    const failAll = () => {
      for (const deferred of pending.values())
        Deferred.doneUnsafe(deferred, Effect.fail(closedFailure));
      for (const list of waiters.values()) {
        for (const deferred of list) Deferred.doneUnsafe(deferred, Effect.fail(closedFailure));
      }
      pending.clear();
      waiters.clear();
    };

    const settle = (id: number, message: typeof Message.Type) => {
      const deferred = pending.get(id);
      pending.delete(id);
      if (deferred === undefined) return;
      Deferred.doneUnsafe(
        deferred,
        message.error === undefined
          ? Effect.succeed(message.result)
          : Effect.fail(new ChromeUnavailable({ stage: "command" })),
      );
    };

    const notify = (key: string) => {
      for (const deferred of waiters.get(key) ?? []) {
        Deferred.doneUnsafe(deferred, Effect.void);
      }
      waiters.delete(key);
    };

    socket.addEventListener("message", (event) => {
      const decoded = decodeMessage(String(event.data));
      if (Option.isNone(decoded)) return;
      const message = decoded.value;
      if (message.id !== undefined) settle(message.id, message);
      else if (message.method !== undefined) notify(`${message.sessionId ?? ""}:${message.method}`);
    });
    socket.addEventListener("close", failAll);
    socket.addEventListener("error", failAll);

    const send: CdpConnection["send"] = (method, params, sessionId) =>
      Effect.gen(function* () {
        if (socket.readyState !== WebSocket.OPEN) return yield* closedFailure;
        const id = (nextId += 1);
        const deferred = yield* Deferred.make<unknown, ChromeUnavailable>();
        pending.set(id, deferred);
        socket.send(
          JSON.stringify({
            id,
            method,
            params: params ?? {},
            ...(sessionId === undefined ? {} : { sessionId }),
          }),
        );
        return yield* Deferred.await(deferred);
      });

    const expect: CdpConnection["expect"] = (method, sessionId) =>
      Effect.gen(function* () {
        const deferred = yield* Deferred.make<void, ChromeUnavailable>();
        const key = `${sessionId}:${method}`;
        waiters.set(key, [...(waiters.get(key) ?? []), deferred]);
        return Deferred.await(deferred);
      });

    return { expect, send };
  });
