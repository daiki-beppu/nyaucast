import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { nyaucastCli } from "../src/cli.ts";
import { knownCliTree } from "./codec-support.ts";
import { runProgram, unusedAuthLayer, unusedVideoLayer } from "./helpers.ts";

const runRoot = (arguments_: string[]) =>
  runProgram(
    nyaucastCli({
      auth: unusedAuthLayer,
      mcpServer: Layer.empty,
      video: unusedVideoLayer,
    })(arguments_),
  ).pipe(Effect.provide(NodeServices.layer));

describe("nyaucast root command", () => {
  it("has video produce / publish / abandon and no collection command", () => {
    const tree = knownCliTree();
    for (const gate of ["produce", "publish", "abandon"]) {
      assert.isTrue(tree.has(`nyaucast video ${gate}`), gate);
    }
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
        // video / auth の Layer は組まれない（組まれると notUsed の die になり、この失敗にならない）
        assert.strictEqual((outcome as { failure: { _tag: string } }).failure._tag, "ShowHelp");
        assert.include(errors.join("\n"), 'Unknown subcommand "collection"');
        assert.notMatch(stdout, /^\s+collection\s/mu);
      }),
  );
});
