import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";

import {
  accepts,
  publishedAdditionalProperties,
  insertCollection,
  selectAll,
  setClock,
} from "../../../test/helpers.ts";
import {
  callCollectionTool,
  collectionRejectionReason,
  withToolChannel,
} from "../../../test/tool-helpers.ts";
import { CollectionIds } from "../../collections/collection-ids.ts";
import { recordApproval, recordRejection } from "../../db/gates.ts";
import { CollectionVideoWritePlanTool } from "./video.writePlan.ts";

const existingId = "01JEXISTING00000000000000";
const newId = "01JNEWCOLLECTION000000000000";

const fixedCollectionId = (id: string) =>
  Layer.succeed(CollectionIds, CollectionIds.of({ next: Effect.succeed(id) }));

const collectionRows = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql`SELECT id, title FROM collections ORDER BY id`;
});

const withExisting = (channelRoot: string, files: readonly string[] = ["keep.json"]) => {
  mkdirSync(join(channelRoot, "collections", existingId), { recursive: true });
  for (const file of files) {
    writeFileSync(join(channelRoot, "collections", existingId, file), "{}");
  }
};

describe("video.writePlan", () => {
  it("is named with its wire name", () => {
    assert.strictEqual(CollectionVideoWritePlanTool.name, "video_write_plan");
  });

  it("accepts only title and the optional force flag, and rejects every other key", () => {
    assert.isTrue(accepts(CollectionVideoWritePlanTool.parametersSchema, { title: "Night Drive" }));
    assert.isTrue(
      accepts(CollectionVideoWritePlanTool.parametersSchema, { force: true, title: "Night Drive" }),
    );
    assert.isFalse(
      accepts(CollectionVideoWritePlanTool.parametersSchema, {
        collectionId: "caller-owned",
        title: "Night Drive",
      }),
    );
    assert.isFalse(
      accepts(CollectionVideoWritePlanTool.parametersSchema, {
        channelDir: "/channels/deepfocus365",
        title: "Night Drive",
      }),
    );
    assert.strictEqual(publishedAdditionalProperties(CollectionVideoWritePlanTool), false);
  });

  it("applies the shared UTF-16 title limit to the parameters", () => {
    assert.isTrue(
      accepts(CollectionVideoWritePlanTool.parametersSchema, { title: "😀".repeat(50) }),
    );
    assert.isFalse(
      accepts(CollectionVideoWritePlanTool.parametersSchema, { title: `${"😀".repeat(50)}a` }),
    );
  });

  it("returns only the collection ID, whether it was created, and the directory", () => {
    const result = { collectionId: newId, created: true, dir: `collections/${newId}` };

    assert.isTrue(accepts(CollectionVideoWritePlanTool.successSchema, result));
    assert.isFalse(
      accepts(CollectionVideoWritePlanTool.successSchema, { ...result, next: "produce" }),
    );
  });

  it.effect("creates a record and flat directory with its generated collection ID", () =>
    withToolChannel(
      "nyaucast-plan-init-new-",
      { collectionIds: fixedCollectionId(newId) },
      (channelRoot) =>
        Effect.gen(function* () {
          const result = yield* callCollectionTool("video_write_plan", { title: "Morning Focus" });

          assert.deepStrictEqual(result, {
            collectionId: newId,
            created: true,
            dir: `collections/${newId}`,
          });
          assert.deepStrictEqual(yield* collectionRows, [{ id: newId, title: "Morning Focus" }]);
          assert.isTrue(existsSync(join(channelRoot, "collections", newId)));
        }),
    ),
  );

  it.effect("returns the existing collection when the title is repeated without force", () =>
    withToolChannel(
      "nyaucast-plan-init-repeat-",
      { collectionIds: fixedCollectionId(newId) },
      (channelRoot) =>
        Effect.gen(function* () {
          yield* insertCollection({ id: existingId, title: "Night Drive" });
          withExisting(channelRoot, ["notes.json"]);

          assert.deepStrictEqual(
            yield* callCollectionTool("video_write_plan", { title: "Night Drive" }),
            {
              collectionId: existingId,
              created: false,
              dir: `collections/${existingId}`,
            },
          );
          assert.deepStrictEqual(readdirSync(join(channelRoot, "collections", existingId)), [
            "notes.json",
          ]);
          assert.deepStrictEqual(yield* collectionRows, [{ id: existingId, title: "Night Drive" }]);
        }),
    ),
  );

  it.effect("force recreates an empty collection while preserving its ID", () =>
    withToolChannel(
      "nyaucast-plan-init-force-",
      { collectionIds: fixedCollectionId(newId) },
      (channelRoot) =>
        Effect.gen(function* () {
          yield* insertCollection({ id: existingId, title: "Night Drive" });
          withExisting(channelRoot, ["stale.json"]);

          assert.deepStrictEqual(
            yield* callCollectionTool("video_write_plan", { force: true, title: "Night Drive" }),
            {
              collectionId: existingId,
              created: true,
              dir: `collections/${existingId}`,
            },
          );
          assert.deepStrictEqual(readdirSync(join(channelRoot, "collections", existingId)), []);
          assert.deepStrictEqual(yield* collectionRows, [{ id: existingId, title: "Night Drive" }]);
        }),
    ),
  );

  it.effect.each(["artifact", "approval", "rejection"] as const)(
    "force fails before changing a collection that has a downstream %s",
    (kind) =>
      withToolChannel(
        "nyaucast-plan-init-downstream-",
        { collectionIds: fixedCollectionId(newId) },
        (channelRoot) =>
          Effect.gen(function* () {
            yield* insertCollection({ id: existingId, title: "Night Drive" });
            withExisting(channelRoot);
            yield* setClock("2026-09-02T00:00:00.000Z");
            if (kind === "approval") {
              yield* recordApproval({ collectionId: existingId, gate: "produce" });
            } else if (kind === "rejection") {
              yield* recordRejection({ collectionId: existingId, gate: "produce" });
            } else {
              const sql = yield* SqlClient.SqlClient;
              yield* sql`INSERT INTO thumbnails (collection_id, path, created_at) VALUES (${existingId}, 'collections/x/thumbnail.png', '2026-09-02T00:00:00.000Z')`;
            }

            const failure = yield* Effect.flip(
              callCollectionTool("video_write_plan", { force: true, title: "Night Drive" }),
            );

            assert.strictEqual(failure._tag, "CollectionHasDownstreamRecords");
            assert.deepStrictEqual(yield* collectionRows, [
              { id: existingId, title: "Night Drive" },
            ]);
            assert.deepStrictEqual(readdirSync(join(channelRoot, "collections", existingId)), [
              "keep.json",
            ]);
            assert.strictEqual(
              (yield* selectAll("approvals")).length + (yield* selectAll("rejections")).length,
              kind === "artifact" ? 0 : 1,
            );
          }),
      ),
  );

  it.effect("does not overwrite a record when the generated ID collides with an existing row", () =>
    withToolChannel(
      "nyaucast-plan-init-id-row-",
      { collectionIds: fixedCollectionId(existingId) },
      (channelRoot) =>
        Effect.gen(function* () {
          yield* insertCollection({ id: existingId, title: "Existing" });
          withExisting(channelRoot);

          const exit = yield* Effect.exit(
            callCollectionTool("video_write_plan", { title: "Morning Focus" }),
          );

          if (exit._tag === "Success") {
            assert.notStrictEqual(exit.value.collectionId, existingId);
          }
          const rows = yield* collectionRows;
          assert.deepStrictEqual(
            rows.find((row) => row["id"] === existingId),
            { id: existingId, title: "Existing" },
          );
          assert.deepStrictEqual(readdirSync(join(channelRoot, "collections", existingId)), [
            "keep.json",
          ]);
        }),
    ),
  );

  it.effect(
    "does not overwrite a directory when the generated ID collides with an existing directory",
    () =>
      withToolChannel(
        "nyaucast-plan-init-id-dir-",
        { collectionIds: fixedCollectionId(existingId) },
        (channelRoot) =>
          Effect.gen(function* () {
            withExisting(channelRoot);

            const exit = yield* Effect.exit(
              callCollectionTool("video_write_plan", { title: "Morning Focus" }),
            );

            assert.strictEqual(exit._tag, "Failure");
            assert.deepStrictEqual(readdirSync(join(channelRoot, "collections", existingId)), [
              "keep.json",
            ]);
            assert.deepStrictEqual(yield* collectionRows, []);
          }),
      ),
  );
});

describe("video.writePlan: unknown keys", () => {
  it.effect("rejects an unknown key as invalid parameters and creates nothing", () =>
    withToolChannel(
      "nyaucast-plan-init-unknown-",
      { collectionIds: fixedCollectionId(newId) },
      (channelRoot) =>
        Effect.gen(function* () {
          const input = { channelDir: "/channels/deepfocus365", title: "Morning Focus" };

          assert.strictEqual(
            yield* collectionRejectionReason("video_write_plan", input),
            "ToolParameterValidationError",
          );
          assert.deepStrictEqual(yield* collectionRows, []);
          assert.isFalse(existsSync(join(channelRoot, "collections", newId)));
        }),
    ),
  );
});
