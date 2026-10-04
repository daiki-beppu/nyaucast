import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { nyaucastCli } from "../src/cli.ts";
import { knownCliTree } from "./codec-support.ts";
import { runProgram, unusedAuthLayer, unusedPostLayer, unusedVideoLayer } from "./helpers.ts";

const runRoot = (arguments_: string[]) =>
  runProgram(
    nyaucastCli({
      auth: unusedAuthLayer,
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
        // video / auth / post の Layer は組まれない（組まれると notUsed の die になり、この失敗にならない）
        assert.strictEqual((outcome as { failure: { _tag: string } }).failure._tag, "ShowHelp");
        assert.include(errors.join("\n"), 'Unknown subcommand "collection"');
        assert.notMatch(stdout, /^\s+collection\s/mu);
      }),
  );
});
