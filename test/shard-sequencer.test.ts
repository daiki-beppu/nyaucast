import { describe, expect, test } from "@effect/vitest";

import { partitionBySize } from "../vitest.shard.config.ts";

// 契約（#715）:
//   partitionBySize(files, count): string[][] — 大きい順に、そのときいちばん軽い shard へ詰める。
//   CI の shard の job は、それぞれ自分の分だけを取り出す。どの job でも同じ分け方になり、
//   どのファイルもちょうど 1 つの shard に入らないと、どの job も pass したまま一部のテストが走らない。

const file = (path: string, size: number) => ({ path, size });

describe("partitionBySize", () => {
  test("puts every file in exactly one shard", () => {
    const files = Array.from({ length: 23 }, (_, at) => file(`f${at}.test.ts`, (at * 7919) % 101));

    for (const count of [1, 2, 3, 5]) {
      const shards = partitionBySize(files, count);

      expect(shards).toHaveLength(count);
      expect(shards.flat().sort()).toEqual(files.map(({ path }) => path).sort());
    }
  });

  test("separates the two largest files", () => {
    const shards = partitionBySize(
      [file("small-a", 1), file("large-a", 50), file("small-b", 2), file("large-b", 40)],
      2,
    );

    expect(shards.find((shard) => shard.includes("large-a"))).not.toContain("large-b");
  });

  test("gives the same shards whatever order the files come in", () => {
    const files = [file("a", 3), file("b", 3), file("c", 5), file("d", 1), file("e", 3)];

    expect(partitionBySize([...files].reverse(), 2)).toEqual(partitionBySize(files, 2));
  });
});
