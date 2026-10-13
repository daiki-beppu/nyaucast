import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { ChildProcessSpawner } from "effect/process";

import { runCommand } from "../src/lib/command-output.ts";

// issue #696 ARCH-001/AI-001 の修正（`Cf` が子プロセス環境を1つ組む）は、`src/cloudflare/cf.ts` の
// テストが偽の spawner（`fakeCf`）を使うため、`options.env` をそのまま子プロセスへ渡すか・ホストの
// 環境へ重ねるかの違いを検出できない（偽物は Node の extendEnv 解決を一切再現しない）。この契約の
// 所有者である `runCommand` 自身を、実際の子プロセスで直接検証する。

/** 子プロセスの `process.env` を JSON にして標準出力へ書くだけの node スクリプト。 */
const printEnvArgs = ["-e", "process.stdout.write(JSON.stringify(process.env))"];

/** ホストの `process.env` に sentinel を一時的に置く。scope の終了で必ず元に戻す。 */
const withHostEnvSentinel = (key: string, value: string) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const previous = process.env[key];
      process.env[key] = value;
      return previous;
    }),
    (previous) =>
      Effect.sync(() => {
        if (previous === undefined) delete process.env[key];
        else process.env[key] = previous;
      }),
  );

/** `runCommand` が実際に起こした子プロセスの環境を、終了コードの検査込みで取り出す。 */
const childEnvOf = (options?: { env?: Record<string, string> }) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const { exitCode, stdout } = yield* runCommand(
      spawner,
      process.execPath,
      printEnvArgs,
      options,
    );
    assert.strictEqual(exitCode, 0, stdout);
    return JSON.parse(stdout) as Record<string, string | undefined>;
  });

describe("runCommand output", () => {
  it.effect.each([0, 1])("collects stdout and stderr separately with exit code %s", (exitCode) =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const output = yield* runCommand(spawner, process.execPath, [
        "-e",
        `process.stdout.write("result\\n"); process.stderr.write("[10042] R2 is not enabled\\n"); process.exitCode = ${exitCode};`,
      ]);

      const expected = {
        exitCode: ChildProcessSpawner.ExitCode(exitCode),
        stdout: "result\n",
        stderr: "[10042] R2 is not enabled\n",
      };
      assert.deepStrictEqual(output, expected);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("runCommand (command-output.ts) の子プロセス環境の受け渡し", () => {
  it.effect(
    "env を渡すときはそれが子プロセスの環境の全体になり、ホスト自身の環境変数は重ならない",
    () =>
      Effect.gen(function* () {
        const sentinelKey = "NYAUCAST_COMMAND_OUTPUT_HOST_ONLY_SENTINEL";
        yield* withHostEnvSentinel(sentinelKey, "HOST_ONLY_VALUE");

        const childEnv = yield* childEnvOf({ env: { GIVEN_ONLY_KEY: "given-value" } });

        assert.strictEqual(childEnv["GIVEN_ONLY_KEY"], "given-value");
        // extendEnv が復活すると、ホストにしかないこの変数まで子プロセスへ漏れる。
        assert.isFalse(
          Object.hasOwn(childEnv, sentinelKey),
          "ホストにしかない変数が env 指定時の子プロセスへ漏れている（extendEnv の復活を示す）",
        );
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("env を渡さないときは、子プロセスはホストの環境をそのまま継承する", () =>
    Effect.gen(function* () {
      const sentinelKey = "NYAUCAST_COMMAND_OUTPUT_INHERIT_SENTINEL";
      yield* withHostEnvSentinel(sentinelKey, "INHERITED_VALUE");

      const childEnv = yield* childEnvOf();

      assert.strictEqual(childEnv[sentinelKey], "INHERITED_VALUE");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

describe("runCommand stdin", () => {
  it.live(
    "transfers the complete input, closes stdin, and drains stdout while the child is writing",
    () =>
      Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const input = JSON.stringify({
          R2_ACCESS_KEY_ID: "TEST_ID",
          R2_SECRET_ACCESS_KEY: "x".repeat(256 * 1024),
        });
        const prefix = "o".repeat(256 * 1024);
        // 子が stdin を読む前に pipe 容量以上を書き、送信と収集の直列化を検出する。
        const script = `
        process.stdout.write('o'.repeat(256 * 1024), () => {
          let input = '';
          process.stdin.setEncoding('utf8');
          process.stdin.on('data', chunk => { input += chunk; });
          process.stdin.on('end', () => process.stdout.write(input));
          process.stdin.resume();
        });
      `;
        const options: NonNullable<Parameters<typeof runCommand>[3]> & { stdin: string } = {
          stdin: input,
        };
        const result = yield* runCommand(spawner, process.execPath, ["-e", script], options).pipe(
          Effect.timeout("5 seconds"),
        );
        assert.strictEqual(result.exitCode, 0);
        assert.strictEqual(result.stdout, prefix + input);
      }).pipe(Effect.provide(NodeServices.layer)),
  );
});
