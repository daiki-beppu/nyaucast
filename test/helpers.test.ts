import { assert, describe, it } from "@effect/vitest";
import { Effect, Exit, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { fakeSpawner } from "./helpers.ts";

const runCommand = Effect.fnUntraced(function* (command: string, args: ReadonlyArray<string>) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const handle = yield* spawner.spawn(ChildProcess.make(command, args));
  const stdout = yield* Stream.mkString(Stream.decodeText(handle.stdout));
  const all = yield* Stream.mkString(Stream.decodeText(handle.all));
  const exitCode = yield* handle.exitCode;
  return { all, exitCode, stdout };
}, Effect.scoped);

describe("fakeSpawner", () => {
  it.effect("returns the fixed result for different commands and records their arguments", () =>
    Effect.gen(function* () {
      const fake = fakeSpawner({ exitCode: 3, stdout: "fixed output\n" });

      const cf = yield* runCommand("cf", ["auth", "whoami"]).pipe(Effect.provide(fake.layer));
      const op = yield* runCommand("op", ["whoami"]).pipe(Effect.provide(fake.layer));

      assert.deepStrictEqual(cf, { all: "fixed output\n", exitCode: 3, stdout: "fixed output\n" });
      assert.deepStrictEqual(op, { all: "fixed output\n", exitCode: 3, stdout: "fixed output\n" });
      assert.deepStrictEqual(fake.calls, [
        { command: "cf", args: ["auth", "whoami"] },
        { command: "op", args: ["whoami"] },
      ]);
    }),
  );

  it.effect("returns each command and argument rule's result and records calls in order", () =>
    Effect.gen(function* () {
      const fake = fakeSpawner([
        { command: "op", args: ["whoami"], exitCode: 1, stdout: "op signed out\n" },
        { command: "cf", args: ["accounts", "list"], exitCode: 2, stdout: "account list\n" },
        { command: "cf", args: ["auth", "whoami"], exitCode: 0, stdout: "cf identity\n" },
      ]);

      const identity = yield* runCommand("cf", ["auth", "whoami"]).pipe(Effect.provide(fake.layer));
      const accounts = yield* runCommand("cf", ["accounts", "list"]).pipe(
        Effect.provide(fake.layer),
      );
      const op = yield* runCommand("op", ["whoami"]).pipe(Effect.provide(fake.layer));

      assert.deepStrictEqual(identity, {
        all: "cf identity\n",
        exitCode: 0,
        stdout: "cf identity\n",
      });
      assert.deepStrictEqual(accounts, {
        all: "account list\n",
        exitCode: 2,
        stdout: "account list\n",
      });
      assert.deepStrictEqual(op, {
        all: "op signed out\n",
        exitCode: 1,
        stdout: "op signed out\n",
      });
      assert.deepStrictEqual(fake.calls, [
        { command: "cf", args: ["auth", "whoami"] },
        { command: "cf", args: ["accounts", "list"] },
        { command: "op", args: ["whoami"] },
      ]);
    }),
  );

  it.effect("returns the first matching rule on every matching call", () =>
    Effect.gen(function* () {
      const fake = fakeSpawner([
        { command: "op", args: ["whoami"], exitCode: 0, stdout: "first\n" },
        { command: "op", args: ["whoami"], exitCode: 9, stdout: "second\n" },
      ]);

      const first = yield* runCommand("op", ["whoami"]).pipe(Effect.provide(fake.layer));
      const repeated = yield* runCommand("op", ["whoami"]).pipe(Effect.provide(fake.layer));

      assert.deepStrictEqual(first, { all: "first\n", exitCode: 0, stdout: "first\n" });
      assert.deepStrictEqual(repeated, { all: "first\n", exitCode: 0, stdout: "first\n" });
    }),
  );

  it.effect("distinguishes one argument containing a space from two separate arguments", () =>
    Effect.gen(function* () {
      const fake = fakeSpawner([
        { command: "cf", args: ["a b"], exitCode: 4, stdout: "one argument" },
        { command: "cf", args: ["a", "b"], exitCode: 5, stdout: "two arguments" },
      ]);

      const single = yield* runCommand("cf", ["a b"]).pipe(Effect.provide(fake.layer));
      const separate = yield* runCommand("cf", ["a", "b"]).pipe(Effect.provide(fake.layer));

      assert.deepStrictEqual(single, { all: "one argument", exitCode: 4, stdout: "one argument" });
      assert.deepStrictEqual(separate, {
        all: "two arguments",
        exitCode: 5,
        stdout: "two arguments",
      });
    }),
  );

  it.effect("matches a rule with no arguments and returns its empty output", () =>
    Effect.gen(function* () {
      const fake = fakeSpawner([{ command: "op", args: [], exitCode: 0, stdout: "" }]);

      const result = yield* runCommand("op", []).pipe(Effect.provide(fake.layer));

      assert.deepStrictEqual(result, { all: "", exitCode: 0, stdout: "" });
      assert.deepStrictEqual(fake.calls, [{ command: "op", args: [] }]);
    }),
  );

  it.effect.each([
    { name: "an unregistered command", command: "op", args: ["auth", "whoami"] },
    { name: "a different argument value", command: "cf", args: ["auth", "login"] },
    { name: "a different argument order", command: "cf", args: ["whoami", "auth"] },
    { name: "a missing argument", command: "cf", args: ["auth"] },
    { name: "an extra argument", command: "cf", args: ["auth", "whoami", "extra"] },
  ])("fails to spawn $name and records the attempted call", ({ command, args }) =>
    Effect.gen(function* () {
      const fake = fakeSpawner([
        { command: "cf", args: ["auth", "whoami"], exitCode: 0, stdout: "registered" },
      ]);

      const result = yield* Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        return yield* Effect.exit(spawner.spawn(ChildProcess.make(command, args)));
      }).pipe(Effect.scoped, Effect.provide(fake.layer));

      assert.isTrue(Exit.isFailure(result));
      assert.deepStrictEqual(fake.calls, [{ command, args }]);
    }),
  );

  it.effect("fails to spawn when the rule list is empty and records the attempted call", () =>
    Effect.gen(function* () {
      const fake = fakeSpawner([]);

      const result = yield* Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        return yield* Effect.exit(spawner.spawn(ChildProcess.make("cf", [])));
      }).pipe(Effect.scoped, Effect.provide(fake.layer));

      assert.isTrue(Exit.isFailure(result));
      assert.deepStrictEqual(fake.calls, [{ command: "cf", args: [] }]);
    }),
  );
});
