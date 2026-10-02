// PROTOTYPE (#475): エージェントが v3 の API を書いたときに検出できるかの囮。
import { Context, Effect, Either } from "effect";

export class Old extends Context.Tag("Old")<Old, { n: number }>() {}
export const a = Effect.succeed(1).pipe(Effect.catchAll(() => Effect.succeed(2)));
export const b = Effect.either(Effect.fail("x"));
export const c = Either.right(1);
export const d = Effect.zipRight(Effect.void, Effect.succeed(1));
