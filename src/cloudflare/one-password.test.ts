import { NodeServices } from "@effect/platform-node";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Redacted } from "effect";

import { fakeSpawner, temporaryDirectory, writeJsonFile } from "../../test/helpers.ts";
import { OnePasswordR2 } from "./one-password.ts";

describe("OnePasswordR2", () => {
  it.effect.each([
    { response: "{}", operation: "list" },
    {
      response:
        '[{"id":"a","title":"nyaucast R2","vault":{"id":"vault"}},{"id":"b","title":"nyaucast R2","vault":{"id":"vault"}}]',
      operation: "list",
    },
    { response: "[]", operation: "create" },
    {
      response: '{"id":"wrong-item","title":"nyaucast R2","vault":{"id":"vault"},"fields":[]}',
      operation: "get",
    },
  ] as const)(
    "stops on invalid or ambiguous item responses ($operation)",
    ({ response, operation }) =>
      Effect.gen(function* () {
        const configRoot = yield* temporaryDirectory("nyaucast-op-item-invalid-");
        const spawner = fakeSpawner([
          {
            command: "op",
            args: ["item", "create", "-", "--dry-run", "--format", "json"],
            exitCode: 0,
            stdout: '{"vault":{"id":"vault"}}',
          },
          {
            command: "op",
            args: ["item", "list", "--vault", "vault", "--format", "json"],
            exitCode: 0,
            stdout:
              operation === "get"
                ? '[{"id":"existing","title":"nyaucast R2","vault":{"id":"vault"}}]'
                : operation === "list"
                  ? response
                  : "[]",
          },
          {
            command: "op",
            args: ["item", "get", "existing", "--vault", "vault", "--reveal", "--format", "json"],
            exitCode: 0,
            stdout: response,
          },
          {
            command: "op",
            args: ["item", "create", "-", "--format", "json"],
            exitCode: 0,
            stdout: response,
          },
        ]);
        const result = yield* OnePasswordR2.use((service) =>
          service.save({
            accessKeyId: "TEST_ID",
            secretAccessKey: Redacted.make("TEST_SECRET"),
          }),
        ).pipe(
          Effect.provide(
            OnePasswordR2.layer({ configRoot }).pipe(
              Layer.provide(Layer.merge(NodeServices.layer, spawner.layer)),
            ),
          ),
          Effect.result,
        );
        assert.strictEqual(result._tag, "Failure");
        if (result._tag === "Failure") {
          assert.deepStrictEqual(result.failure.toJSON(), {
            _tag: "OnePasswordCommandFailed",
            operation,
          });
        }
        assert.lengthOf(spawner.calls, operation === "list" ? 2 : 3);
        assert.isFalse(existsSync(join(configRoot, "secrets.json")));
      }),
  );
  it.effect.each([0, 1])("checks whoami only when requested (exit %s)", (exitCode) =>
    Effect.gen(function* () {
      const configRoot = yield* temporaryDirectory("nyaucast-op-available-");
      const spawner = fakeSpawner({ exitCode, stdout: "" });
      yield* Effect.gen(function* () {
        const service = yield* OnePasswordR2;
        assert.deepStrictEqual(spawner.calls, []);
        assert.strictEqual(yield* service.available, exitCode === 0);
        assert.deepStrictEqual(
          spawner.calls.map((call) => call.args),
          [["whoami"]],
        );
      }).pipe(
        Effect.provide(
          OnePasswordR2.layer({ configRoot }).pipe(
            Layer.provide(Layer.merge(NodeServices.layer, spawner.layer)),
          ),
        ),
      );
    }),
  );

  it.effect.each(["R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"])(
    "detects an existing %s reference without invoking op",
    (name) =>
      Effect.gen(function* () {
        const configRoot = yield* temporaryDirectory("nyaucast-op-reference-");
        const spawner = fakeSpawner({ exitCode: 0, stdout: "" });
        writeJsonFile(`${configRoot}/secrets.json`, { [name]: "op://vault/item/field" });
        const hasReferences = yield* OnePasswordR2.use((service) => service.hasReferences).pipe(
          Effect.provide(
            OnePasswordR2.layer({ configRoot }).pipe(
              Layer.provide(Layer.merge(NodeServices.layer, spawner.layer)),
            ),
          ),
        );
        assert.isTrue(hasReferences);
        assert.deepStrictEqual(spawner.calls, []);
      }),
  );

  it.effect.each(["not json", '{"vault": null}', '{"vault":{"id":"bad/id"}}'])(
    "rejects an invalid preview without forwarding diagnostics (%s)",
    (stdout) =>
      Effect.gen(function* () {
        const configRoot = yield* temporaryDirectory("nyaucast-op-invalid-");
        const spawner = fakeSpawner({ exitCode: 0, stdout });
        const result = yield* OnePasswordR2.use((service) =>
          service.save({
            accessKeyId: "TEST_ID",
            secretAccessKey: Redacted.make("TEST_SECRET"),
          }),
        ).pipe(
          Effect.provide(
            OnePasswordR2.layer({ configRoot }).pipe(
              Layer.provide(Layer.merge(NodeServices.layer, spawner.layer)),
            ),
          ),
          Effect.result,
        );
        assert.strictEqual(result._tag, "Failure");
        if (result._tag === "Failure") {
          assert.deepStrictEqual(result.failure.toJSON(), {
            _tag: "OnePasswordCommandFailed",
            operation: "preview",
          });
        }
        assert.lengthOf(spawner.calls, 1);
      }),
  );
});
