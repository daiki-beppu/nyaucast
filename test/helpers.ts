import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

import { NodeServices } from "@effect/platform-node";
import { Effect, Layer, Result, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { TestClock } from "effect/testing";

import { LocalStore } from "../src/db/local-store.ts";

export function withTemporaryDirectory<T>(prefix: string, execute: (directory: string) => T): T {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  try {
    return execute(directory);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

export async function withTemporaryDirectoryAsync<Value>(
  prefix: string,
  execute: (directory: string) => Promise<Value>,
): Promise<Value> {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  try {
    return await execute(directory);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

/** Effect 版: スコープが閉じたときに一時ディレクトリを消す。 */
export const temporaryDirectory = (prefix: string) =>
  Effect.acquireRelease(
    Effect.sync(() => mkdtempSync(join(tmpdir(), prefix))),
    (directory) => Effect.sync(() => rmSync(directory, { force: true, recursive: true })),
  );

export function localDatabasePath(channelRoot: string): string {
  return join(channelRoot, "data", "local.db");
}

/** local store を開く唯一の口 `LocalStore.layer(url)` へ渡す接続先。チャンネルルートの data/local.db。 */
export function localDatabaseUrl(channelRoot: string): string {
  return pathToFileURL(localDatabasePath(channelRoot)).href;
}

/** 一時ディレクトリの実ファイル libSQL（マイグレーション適用済み）と、FileSystem / Path を提供する。 */
export const channelLayer = (channelRoot: string) =>
  Layer.mergeAll(
    LocalStore.layer(localDatabaseUrl(channelRoot)).pipe(Layer.provide(NodeServices.layer)),
    NodeServices.layer,
  );

/** 一時ディレクトリを 1 つ作り、その中のチャンネルとして use を実行する（スコープ終了で後始末）。 */
export const withChannel = <A, E, R>(
  prefix: string,
  use: (channelRoot: string) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const channelRoot = yield* temporaryDirectory(prefix);
    return yield* use(channelRoot).pipe(Effect.provide(channelLayer(channelRoot)));
  });

/** TestClock を絶対時刻に合わせる。ゲート事実の時刻は Clock から取られるため、テストはここで時刻を決める。 */
export const setClock = (iso: string) => TestClock.setTime(Date.parse(iso));

export const insertCollection = (collection: { id: string; title: string }) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO collections (id, title) VALUES (${collection.id}, ${collection.title})`;
  });

export const selectAll = (table: "approvals" | "collections" | "rejections" | "thumbnails") =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql.unsafe<Record<string, unknown>>(`SELECT * FROM ${table}`);
  });

/** 契約テスト（プロセスを起動する側）が、DB を作ってマイグレーションを適用するための入口。 */
export function openLocalStoreOnce(channelRoot: string): Promise<void> {
  return Effect.runPromise(
    Effect.gen(function* () {
      yield* SqlClient.SqlClient;
    }).pipe(Effect.provide(channelLayer(channelRoot))),
  );
}

export function seedCollection(
  channelRoot: string,
  collection: { id: string; title: string },
): Promise<void> {
  return Effect.runPromise(
    insertCollection(collection).pipe(Effect.provide(channelLayer(channelRoot))),
  );
}

export function seedRejection(
  channelRoot: string,
  fact: { collectionId: string; gate: "produce" | "publish"; rejectedAt: string },
): Promise<void> {
  return Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO rejections (collection_id, gate, rejected_at) VALUES (${fact.collectionId}, ${fact.gate}, ${fact.rejectedAt})`;
    }).pipe(Effect.provide(channelLayer(channelRoot))),
  );
}

/** プロセスが書いた事実を、実装に依存せず読み出す（読み取り専用）。 */
export function readRows(
  databasePath: string,
  table: "approvals" | "collections" | "rejections" | "thumbnails",
): Record<string, unknown>[] {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return database.prepare(`SELECT * FROM ${table}`).all();
  } finally {
    database.close();
  }
}

type Decoder = Parameters<typeof Schema.decodeUnknownResult>[0];

/**
 * Schema が入力を受け入れるか。未知のキーは拒否する（`Tool.Strict` の tool を McpServer が検証するときと同じ
 * `onExcessProperty: "error"`）。strict の検証に使う。
 */
export function accepts(schema: Decoder, input: unknown): boolean {
  return Result.isSuccess(Schema.decodeUnknownResult(schema)(input, { onExcessProperty: "error" }));
}

/** McpServer が strict な tool の inputSchema として公開する JSON Schema の `additionalProperties`。 */
export function publishedAdditionalProperties(tool: { parametersSchema: Decoder }): unknown {
  return Schema.toJsonSchemaDocument(tool.parametersSchema, {
    onExcessProperty: "error",
  }).schema["additionalProperties"];
}
