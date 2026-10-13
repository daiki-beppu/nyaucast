import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Sink, Stream } from "effect";
import { ChildProcessSpawner } from "effect/process";

import { Cf } from "./cf.ts";

describe("Cf.checkR2Availability", () => {
  it.effect.each([
    { exitCode: 0, stderr: "[10042] warning", failure: undefined },
    {
      exitCode: 1,
      stderr: "[10042] NotEntitled",
      failure: { _tag: "CloudflareR2CheckoutRequired", accountId: "selected" },
    },
    {
      exitCode: 1,
      stderr: "[10003] AccessDenied",
      failure: { _tag: "CfCommandFailed", operation: "r2" },
    },
    {
      exitCode: 1,
      stderr: "[100420] unknown",
      failure: { _tag: "CfCommandFailed", operation: "r2" },
    },
  ])("classifies exit=$exitCode stderr=$stderr", ({ exitCode, stderr, failure }) => {
    const spawner = ChildProcessSpawner.make(() =>
      Effect.succeed(
        ChildProcessSpawner.makeHandle({
          all: Stream.empty,
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(exitCode)),
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          pid: ChildProcessSpawner.ProcessId(1),
          stderr: Stream.make(new TextEncoder().encode(stderr)),
          stdin: Sink.drain,
          stdout: Stream.make(new TextEncoder().encode("[]")),
          unref: Effect.succeed(Effect.void),
        }),
      ),
    );
    const layer = Cf.layer({}).pipe(
      Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner)),
    );
    return Effect.gen(function* () {
      const outcome = yield* Effect.result((yield* Cf).checkR2Availability("selected"));
      assert.strictEqual(outcome._tag, failure === undefined ? "Success" : "Failure");
      assert.deepStrictEqual(
        outcome._tag === "Failure"
          ? Object.fromEntries(Object.entries(outcome.failure))
          : undefined,
        failure,
      );
    }).pipe(Effect.provide(layer));
  });
});
