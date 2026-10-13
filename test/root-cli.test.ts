import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Exit, Layer } from "effect";

import { cliTeardown, nyaucastCli } from "../src/cli.ts";
import { CloudflareProvisioningFailed } from "../src/cloudflare/alchemy.ts";
import { decideProvisioning } from "../src/cloudflare/provision.ts";
import { knownCliTree } from "./codec-support.ts";
import {
  runProgram,
  unusedAuthLayer,
  unusedCloudflareLayer,
  unusedPostLayer,
  unusedVideoLayer,
} from "./helpers.ts";

const runRoot = (arguments_: string[]) =>
  runProgram(
    nyaucastCli({
      auth: unusedAuthLayer,
      cloudflare: unusedCloudflareLayer,
      mcpServer: Layer.empty,
      post: unusedPostLayer,
      video: unusedVideoLayer,
    })(arguments_),
  ).pipe(Effect.provide(NodeServices.layer));

describe("nyaucast root command", () => {
  it("has video produce / publish / abandon, post run, and no collection command", () => {
    const tree = knownCliTree();
    for (const gate of ["produce", "publish", "abandon"]) {
      assert.isTrue(tree.has(`nyaucast video ${gate}`), gate);
    }
    // 時刻が来た投稿を実行する CLI（#553）。MCP には開かず、定期実行からもそのまま叩ける形にする。
    assert.isTrue(tree.has("nyaucast post run"));
    // 投稿単位の人間だけが叩く 3 つの CLI（この issue #554、ADR-0009 決定 9・14）。
    assert.isTrue(tree.has("nyaucast post cancel"));
    assert.isTrue(tree.has("nyaucast post run-now"));
    assert.isTrue(tree.has("nyaucast post mark-published"));
    assert.isFalse(tree.has("nyaucast collection"));
    for (const path of tree.keys()) {
      assert.notMatch(path, /^nyaucast collection/u);
    }
  });

  it.effect.each([
    { arguments_: ["produce", "01JCOLLECTION00000000000000"] },
    { arguments_: ["publish", "01JCOLLECTION00000000000000"] },
    { arguments_: ["reject", "produce", "01JCOLLECTION00000000000000"] },
  ])(
    "`collection $arguments_` fails as an unknown command before any layer is built",
    ({ arguments_ }) =>
      Effect.gen(function* () {
        const { errors, outcome, stdout } = yield* runRoot(["collection", ...arguments_]);

        assert.strictEqual(outcome._tag, "Failure");
        // video / auth / post / cloudflare の Layer は組まれない（組まれると notUsed の die になり、この失敗にならない）
        assert.strictEqual((outcome as { failure: { _tag: string } }).failure._tag, "ShowHelp");
        assert.include(errors.join("\n"), 'Unknown subcommand "collection"');
        assert.notMatch(stdout, /^\s+collection\s/mu);
      }),
  );
});

describe("CLI teardown", () => {
  it.effect("exits with 2 for the confirmation-required failure", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        decideProvisioning([{ action: "create", kind: "bucket", resource: "Media" }], false),
      );
      const codes: number[] = [];
      cliTeardown(exit, (code: number) => {
        codes.push(code);
      });
      assert.deepStrictEqual(codes, [2]);
    }),
  );

  it.each([
    { name: "provisioning failure", error: new CloudflareProvisioningFailed({ phase: "plan" }) },
    {
      name: "error mentioning the confirmation tag",
      error: new Error("CloudflareConfirmationRequired"),
    },
  ])("keeps exit code 1 for $name", ({ error }) => {
    const codes: number[] = [];
    cliTeardown(Exit.fail(error), (code: number) => {
      codes.push(code);
    });
    assert.deepStrictEqual(codes, [1]);
  });

  it("keeps exit code 0 on success", () => {
    const codes: number[] = [];
    cliTeardown(Exit.succeed(undefined), (code: number) => {
      codes.push(code);
    });
    assert.deepStrictEqual(codes, [0]);
  });

  it("keeps the runtime interruption exit code", () => {
    const codes: number[] = [];
    cliTeardown(Exit.interrupt(123), (code: number) => {
      codes.push(code);
    });
    assert.deepStrictEqual(codes, [130]);
  });
});
