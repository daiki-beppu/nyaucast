import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "@effect/vitest";

import {
  partitionByWeight,
  shardWeightsFile,
  WeightShardSequencer,
  weightOf,
} from "../vitest.shard.config.ts";
import { withTemporaryDirectoryAsync } from "./helpers.ts";

// 契約（#715・#742）:
//   partitionByWeight(files, count): string[][] — 重い順に、そのときいちばん軽い shard へ詰める。
//   CI の shard の job は、それぞれ自分の分だけを取り出す。どの job でも同じ分け方になり、
//   どのファイルもちょうど 1 つの shard に入らないと、どの job も pass したまま一部のテストが走らない。
//   weightOf(record, path): number — 記録にある所要時間（秒）。記録に無いファイルは軽いファイルとして扱う。
//   WeightShardSequencer は root の記録を読み、shard の番号に当たるファイルだけを返す。

const file = (path: string, weight: number) => ({ path, weight });

describe("partitionByWeight", () => {
  test("puts every file in exactly one shard", () => {
    const files = Array.from({ length: 23 }, (_, at) => file(`f${at}.test.ts`, (at * 7919) % 101));

    for (const count of [1, 2, 3, 5]) {
      const shards = partitionByWeight(files, count);

      expect(shards).toHaveLength(count);
      expect(shards.flat().sort()).toEqual(files.map(({ path }) => path).sort());
    }
  });

  test("separates the two heaviest files", () => {
    const shards = partitionByWeight(
      [file("light-a", 1), file("heavy-a", 50), file("light-b", 2), file("heavy-b", 40)],
      2,
    );

    expect(shards.find((shard) => shard.includes("heavy-a"))).not.toContain("heavy-b");
  });

  test("gives the same shards whatever order the files come in", () => {
    const files = [file("a", 3), file("b", 3), file("c", 5), file("d", 1), file("e", 3)];

    expect(partitionByWeight([...files].reverse(), 2)).toEqual(partitionByWeight(files, 2));
  });
});

describe("weightOf", () => {
  test("is the recorded seconds of a file", () => {
    expect(weightOf({ "src/a.test.ts": 44.2 }, "src/a.test.ts")).toBe(44.2);
  });

  test("weighs a file missing from the record as a light one", () => {
    const record = { "src/heavy.test.ts": 44.2, "src/light.test.ts": 0.1 };

    expect(weightOf(record, "src/new.test.ts")).toBeLessThan(1.5);
    expect(weightOf(record, "src/new.test.ts")).toBeGreaterThan(0);
  });
});

type Vitest = ConstructorParameters<typeof WeightShardSequencer>[0];
type TestSpecification = Parameters<WeightShardSequencer["shard"]>[0][number];

describe("WeightShardSequencer", () => {
  // root に記録を置き、shard の設定だけを持つ Vitest の代わりで、実際の分け方を確かめる
  const shardOf = (
    record: Record<string, number> | undefined,
    shard?: { count: number; index: number },
  ) =>
    withTemporaryDirectoryAsync("nyaucast-shard-sequencer-", async (root) => {
      if (record !== undefined) writeFileSync(join(root, shardWeightsFile), JSON.stringify(record));
      const ctx = { config: { root, shard } } as unknown as Vitest;
      const specs = ["src/heavy.test.ts", "src/a.test.ts", "src/b.test.ts", "test/c.test.ts"].map(
        (path) =>
          ({
            moduleId: join(root, path),
            project: { name: path.startsWith("src/") ? "unit" : "contract" },
          }) as unknown as TestSpecification,
      );
      const picked = await new WeightShardSequencer(ctx).shard(specs);
      return picked.map(({ moduleId }) => moduleId.slice(root.length + 1));
    });

  test("gives the heaviest recorded file a shard of its own", async () => {
    const record = {
      "src/a.test.ts": 1,
      "src/b.test.ts": 1,
      "src/heavy.test.ts": 9,
      "test/c.test.ts": 1,
    };

    expect(await shardOf(record, { count: 2, index: 1 })).toEqual(["src/heavy.test.ts"]);
    expect(await shardOf(record, { count: 2, index: 2 })).toEqual([
      "src/a.test.ts",
      "src/b.test.ts",
      "test/c.test.ts",
    ]);
  });

  test("still puts every file in exactly one shard without a record", async () => {
    const shards = await Promise.all(
      [1, 2].map((index) => shardOf(undefined, { count: 2, index })),
    );

    expect(shards.flat().sort()).toEqual([
      "src/a.test.ts",
      "src/b.test.ts",
      "src/heavy.test.ts",
      "test/c.test.ts",
    ]);
  });

  test("runs every file when there is no shard", async () => {
    expect(await shardOf(undefined)).toHaveLength(4);
  });
});
