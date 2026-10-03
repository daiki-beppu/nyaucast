import { existsSync } from "node:fs";
import { basename, dirname } from "node:path";

import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { failureFacts } from "../../test/helpers.ts";
import { fakeCodex, type CodexExecReply, type FakeCodex } from "../../test/codex-helpers.ts";
import { solidPng } from "../../test/thumbnail-images.ts";
import { CodexImageGenerator } from "./codex.ts";

// この adapter は動画・解説動画・チャンネル設定を知らない。偽の codex（子プロセスの起動の偽装）だけで動かす。
const png = solidPng(16, 9);
const prompt = "Create original artwork only.\nThumbnail text: 猫\nBackground: 夜の窓辺";

const withGenerator = <A, E>(
  codex: FakeCodex,
  use: (generator: CodexImageGenerator["Service"]) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    return yield* use(yield* CodexImageGenerator);
  }).pipe(
    Effect.provide(
      CodexImageGenerator.layer.pipe(
        Layer.provide(Layer.mergeAll(codex.layer, NodeFileSystem.layer, NodePath.layer)),
      ),
    ),
  );

const generate = (codex: FakeCodex, referenceImage?: { bytes: Uint8Array; mimeType: string }) =>
  withGenerator(codex, (generator) =>
    generator.generate({ prompt, ...(referenceImage === undefined ? {} : { referenceImage }) }),
  );

const oneReply = (reply: CodexExecReply) => fakeCodex({ replies: [reply] });

describe("CodexImageGenerator.requireLogin", () => {
  it.effect("succeeds without starting `codex exec` when `codex login status` exits with 0", () =>
    Effect.gen(function* () {
      const codex = fakeCodex({ login: "logged-in" });

      yield* withGenerator(codex, (generator) => generator.requireLogin);

      assert.deepStrictEqual(
        codex.calls.map((call) => [call.command, ...call.args]),
        [["codex", "login", "status"]],
      );
    }),
  );

  it.effect(
    "fails with CodexNotLoggedIn when `codex login status` exits with a non-zero code",
    () =>
      Effect.gen(function* () {
        const codex = fakeCodex({ login: "logged-out" });

        const failure = yield* Effect.flip(
          withGenerator(codex, (generator) => generator.requireLogin),
        );

        assert.strictEqual(failure._tag, "CodexNotLoggedIn");
        assert.strictEqual(codex.execCalls.length, 0);
      }),
  );

  it.effect("fails with CodexUnavailable, not CodexNotLoggedIn, when codex cannot be started", () =>
    Effect.gen(function* () {
      const codex = fakeCodex({ login: "unavailable" });

      const failure = yield* Effect.flip(
        withGenerator(codex, (generator) => generator.requireLogin),
      );

      assert.strictEqual(failure._tag, "CodexUnavailable");
    }),
  );
});

describe("CodexImageGenerator.generate", () => {
  it.effect(
    "starts codex once with fixed arguments in a work directory, the prompt as the last single argument",
    () =>
      Effect.gen(function* () {
        const codex = oneReply({ image: png });

        yield* generate(codex);

        assert.strictEqual(codex.calls.length, 1);
        const [call] = codex.execCalls;
        assert.isDefined(call);
        assert.strictEqual(call.command, "codex");
        assert.isDefined(call.workDir);
        assert.deepStrictEqual(call.args.slice(0, 7), [
          "exec",
          "--skip-git-repo-check",
          "--ephemeral",
          "--sandbox",
          "workspace-write",
          "--cd",
          call.workDir,
        ]);
        // 参照画像がないので、--image は付かない。残りは指示文の 1 つの引数だけ。
        assert.strictEqual(call.args.length, 8);
        assert.include(call.args[7] ?? "", prompt);
      }),
  );

  it.effect("returns the bytes codex wrote as a PNG", () =>
    Effect.gen(function* () {
      const codex = oneReply({ image: png });

      const generated = yield* generate(codex);

      assert.deepStrictEqual(new Uint8Array(generated.bytes), png);
      assert.strictEqual(generated.mimeType, "image/png");
    }),
  );

  it.effect("passes the reference image as a file in the work directory with --image", () =>
    Effect.gen(function* () {
      const codex = oneReply({ image: png });
      const reference = solidPng(8, 8, [255, 0, 0]);

      yield* generate(codex, { bytes: reference, mimeType: "image/png" });

      const [call] = codex.execCalls;
      assert.isDefined(call);
      assert.isDefined(call.imagePaths);
      assert.strictEqual(call.imagePaths.length, 1);
      const [imagePath] = call.imagePaths;
      assert.isDefined(imagePath);
      assert.strictEqual(dirname(imagePath), call.workDir);
      assert.strictEqual(basename(imagePath), "reference.png");
      assert.deepStrictEqual(call.imageBytes, [reference]);
      // `--image` は複数の値を取るので、`--` で区切ってからプロンプトを渡す。
      assert.strictEqual(call.args.length, 11);
      assert.deepStrictEqual(call.args.slice(7, 10), ["--image", imagePath, "--"]);
      assert.include(call.args[10] ?? "", prompt);
      assert.include(call.prompt ?? "", prompt);
    }),
  );

  it.effect(
    "reads the prompt as another --image value, and exits with 1, when no `--` separates them",
    () =>
      Effect.gen(function* () {
        const codex = oneReply({ image: png });
        const withoutSeparator = [
          "exec",
          "--cd",
          "/nonexistent",
          "--image",
          "/nonexistent/ref.png",
          prompt,
        ];

        const exitCode = yield* Effect.scoped(
          Effect.gen(function* () {
            const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
            const handle = yield* spawner.spawn(ChildProcess.make("codex", withoutSeparator));
            return yield* handle.exitCode;
          }),
        ).pipe(Effect.provide(codex.layer));

        assert.strictEqual(exitCode, 1);
        assert.isUndefined(codex.execCalls[0]?.prompt);
        assert.deepStrictEqual(codex.execCalls[0]?.imagePaths, ["/nonexistent/ref.png", prompt]);
      }),
  );

  it.effect("gives each call its own work directory", () =>
    Effect.gen(function* () {
      const codex = fakeCodex({ replies: [{ image: png }, { image: png }] });

      yield* generate(codex);
      yield* generate(codex);

      const [first, second] = codex.execCalls;
      assert.isDefined(first?.workDir);
      assert.isDefined(second?.workDir);
      assert.notStrictEqual(first.workDir, second.workDir);
    }),
  );

  it.effect("removes the work directory after a success", () =>
    Effect.gen(function* () {
      const codex = oneReply({ image: png });

      yield* generate(codex);

      const workDir = codex.execCalls[0]?.workDir ?? "";
      assert.notStrictEqual(workDir, "");
      assert.isFalse(existsSync(workDir));
    }),
  );

  it.effect(
    "fails with CodexExecFailed carrying the exit code when codex exits with non-zero",
    () =>
      Effect.gen(function* () {
        const codex = oneReply({ exitCode: 3 });

        const failure = yield* Effect.flip(generate(codex));

        assert.strictEqual(failure._tag, "CodexExecFailed");
        assert.deepStrictEqual(failureFacts(failure)["exitCode"], 3);
        assert.isFalse(existsSync(codex.execCalls[0]?.workDir ?? ""));
      }),
  );

  it.effect(
    "decides by the exit code: a file that exists does not make a non-zero exit succeed",
    () =>
      Effect.gen(function* () {
        const codex = oneReply({ exitCode: 1, image: png });

        const failure = yield* Effect.flip(generate(codex));

        assert.strictEqual(failure._tag, "CodexExecFailed");
      }),
  );

  it.effect("fails with CodexImageMissing when codex exits with 0 but wrote no file", () =>
    Effect.gen(function* () {
      const codex = oneReply({});

      const failure = yield* Effect.flip(generate(codex));

      assert.strictEqual(failure._tag, "CodexImageMissing");
      assert.isFalse(existsSync(codex.execCalls[0]?.workDir ?? ""));
    }),
  );

  it.effect(
    "fails with CodexImageMissing, not a defect, when the output cannot be read as a file",
    () =>
      Effect.gen(function* () {
        const codex = oneReply({ outputAsDirectory: true });

        const failure = yield* Effect.flip(generate(codex));

        assert.strictEqual(failure._tag, "CodexImageMissing");
        assert.isFalse(existsSync(codex.execCalls[0]?.workDir ?? ""));
      }),
  );

  it.effect(
    "does not read codex's output to decide: a success message without a file still fails",
    () =>
      Effect.gen(function* () {
        const codex = oneReply({ stdout: "Done. Image saved to thumbnail.png (success)" });

        const failure = yield* Effect.flip(generate(codex));

        assert.strictEqual(failure._tag, "CodexImageMissing");
      }),
  );

  it.effect(
    "does not read codex's output to decide: a failure message with a file still succeeds",
    () =>
      Effect.gen(function* () {
        const codex = oneReply({ image: png, stdout: "error: could not generate the image" });

        const generated = yield* generate(codex);

        assert.deepStrictEqual(new Uint8Array(generated.bytes), png);
      }),
  );

  it.effect("fails with CodexUnavailable when the process cannot be started", () =>
    Effect.gen(function* () {
      const codex = oneReply({ spawnFailure: true });

      const failure = yield* Effect.flip(generate(codex));

      assert.strictEqual(failure._tag, "CodexUnavailable");
    }),
  );

  it.effect("does not retry a failed run", () =>
    Effect.gen(function* () {
      const codex = fakeCodex({ replies: [{ exitCode: 1 }, { image: png }] });

      yield* Effect.flip(generate(codex));

      assert.strictEqual(codex.execCalls.length, 1);
    }),
  );
});
