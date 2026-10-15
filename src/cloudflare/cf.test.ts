import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Redacted, Sink, Stream } from "effect";
import { ChildProcessSpawner } from "effect/process";

import { Cf, CfCommandFailed } from "./cf.ts";

describe("Cf.authenticate", () => {
  it.effect.each([0, 1, 130])("waits for exit %s and releases the child", (exitCode) => {
    const released = { count: 0 };
    const spawner = ChildProcessSpawner.make(() =>
      Effect.acquireRelease(
        Effect.succeed(
          ChildProcessSpawner.makeHandle({
            all: Stream.empty,
            exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(exitCode)),
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
            isRunning: Effect.succeed(false),
            kill: () => Effect.void,
            pid: ChildProcessSpawner.ProcessId(1),
            stderr: Stream.empty,
            stdin: Sink.drain,
            stdout: Stream.empty,
            unref: Effect.succeed(Effect.void),
          }),
        ),
        () =>
          Effect.sync(() => {
            released.count += 1;
          }),
      ),
    );
    const layer = Cf.layer({}).pipe(
      Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner)),
    );
    return Effect.gen(function* () {
      const outcome = yield* Effect.result((yield* Cf).authenticate);
      assert.strictEqual(outcome._tag, exitCode === 0 ? "Success" : "Failure");
      if (outcome._tag === "Failure") {
        assert.instanceOf(outcome.failure, CfCommandFailed);
        assert.strictEqual(outcome.failure.operation, "authenticate");
      }
      assert.strictEqual(released.count, 1);
    }).pipe(Effect.provide(layer));
  });
});

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

// `cf accounts tokens list` / `create` の 1 回の呼び出しを模す spawner。args と env を記録し、
// 決まった stdout と終了コードを返す。
const recordingSpawner = (response: { exitCode: number; stdout: string }) => {
  const calls: Array<{ args: ReadonlyArray<string>; env: Record<string, string | undefined> }> = [];
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.sync(() => {
      if (command._tag === "StandardCommand") {
        calls.push({ args: command.args, env: command.options.env ?? {} });
      }
      const stdout = Stream.make(new TextEncoder().encode(response.stdout));
      return ChildProcessSpawner.makeHandle({
        all: stdout,
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(response.exitCode)),
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        pid: ChildProcessSpawner.ProcessId(1),
        stderr: Stream.empty,
        stdin: Sink.drain,
        stdout,
        unref: Effect.succeed(Effect.void),
      });
    }),
  );
  const layer = Cf.layer({}).pipe(
    Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner)),
  );
  return { calls, layer };
};

describe("Cf.listTokens", () => {
  it.effect("reads the id and name of every token in the JSON array for the given account", () => {
    // 実物の `cf accounts tokens list` は、API の result（トークンの配列）をそのまま JSON で出す。
    const fake = recordingSpawner({
      exitCode: 0,
      stdout: `${JSON.stringify([
        { id: "id-1", name: "nyaucast-media-write", status: "active", policies: [] },
        { id: "id-2", name: "other", status: "disabled" },
      ])}\n`,
    });
    return Effect.gen(function* () {
      const tokens = yield* (yield* Cf).listTokens("selected");
      assert.deepStrictEqual(tokens, [
        { id: "id-1", name: "nyaucast-media-write" },
        { id: "id-2", name: "other" },
      ]);
      assert.lengthOf(fake.calls, 1);
      assert.deepStrictEqual(fake.calls[0]!.args.slice(1, 4), ["accounts", "tokens", "list"]);
      assert.strictEqual(fake.calls[0]!.env["CLOUDFLARE_ACCOUNT_ID"], "selected");
    }).pipe(Effect.provide(fake.layer));
  });

  // 非 0 の終了は、CLI の契約テスト（test/cloudflare-cli.test.ts）が同じ失敗を観測する。
  it.effect("fails with only the operation on output that is not a token array", () => {
    const fake = recordingSpawner({ exitCode: 0, stdout: '{"tokens":[]}' });
    return Effect.gen(function* () {
      const outcome = yield* Effect.result((yield* Cf).listTokens("selected"));
      assert.strictEqual(outcome._tag, "Failure");
      if (outcome._tag === "Failure") {
        assert.deepStrictEqual(Object.fromEntries(Object.entries(outcome.failure)), {
          _tag: "CfCommandFailed",
          operation: "token-list",
        });
      }
    }).pipe(Effect.provide(fake.layer));
  });
});

describe("Cf.createToken", () => {
  const policies = [
    {
      effect: "allow" as const,
      permissionGroupIds: ["group"],
      resources: { "com.cloudflare.edge.r2.bucket.selected_default_nyaucast-media": "*" },
    },
  ];

  it.effect("returns the id and the redacted value of the created token", () => {
    const fake = recordingSpawner({
      exitCode: 0,
      stdout: `${JSON.stringify({ id: "TOKEN_ID", name: "n", status: "active", value: "TOKEN_VALUE" })}\n`,
    });
    return Effect.gen(function* () {
      const token = yield* (yield* Cf).createToken({
        accountId: "selected",
        name: "nyaucast-media-write",
        policies,
      });
      assert.strictEqual(token.id, "TOKEN_ID");
      assert.isTrue(Redacted.isRedacted(token.value));
      assert.strictEqual(Redacted.value(token.value), "TOKEN_VALUE");
      assert.notInclude(String(token.value), "TOKEN_VALUE");
    }).pipe(Effect.provide(fake.layer));
  });
});
