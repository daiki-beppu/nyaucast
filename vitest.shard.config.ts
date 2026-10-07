import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import { BaseSequencer, type TestSpecification } from "vite-plus/test/node";

interface WeightedFile {
  readonly path: string;
  readonly weight: number;
}

/** テストファイルごとの所要時間（秒）の記録。キーは root からの相対パス。 */
export type ShardWeights = Readonly<Record<string, number>>;

/** 記録のファイル。`pnpm run shard-weights:update` で全件を走らせて作り直す。 */
export const shardWeightsFile = "vitest.shard-weights.json";

// 記録が無いときは、どのファイルも記録に無いものとして扱う（分け方はパスの順で決まり、漏れは起きない）。
const readShardWeights = (root: string): ShardWeights => {
  const file = join(root, shardWeightsFile);
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as ShardWeights) : {};
};

// 記録に無いファイル（記録の後に足したテスト）は、多くのファイルと同じく 1 秒前後で終わるものとして扱う。
const unrecordedWeight = 1;

/** 記録にある所要時間。記録に無いファイルは軽いファイルとして扱う。 */
export const weightOf = (weights: ShardWeights, path: string): number =>
  weights[path] ?? unrecordedWeight;

// 重い順に、そのときいちばん軽い shard へ詰める（LPT）。重みはリポジトリに記録した所要時間で、チェックアウトだけで決まる。
// 所要時間の cache を重みにすると、shard の job ごとに読む cache が違い、分け方が食い違ってテストが漏れ得る（#715）。
// 記録が古くなっても崩れるのは均衡だけで、どのファイルもちょうど 1 つの shard に入ることは変わらない（#742）。
export const partitionByWeight = (files: readonly WeightedFile[], count: number): string[][] => {
  const shards = Array.from({ length: count }, () => ({ load: 0, paths: [] as string[] }));
  const ordered = [...files].sort(
    (left, right) =>
      right.weight - left.weight || (left.path < right.path ? -1 : left.path > right.path ? 1 : 0),
  );
  for (const { path, weight } of ordered) {
    const lightest = shards.reduce((min, shard) => (shard.load < min.load ? shard : min));
    lightest.paths.push(path);
    lightest.load += weight;
  }
  return shards.map(({ paths }) => paths);
};

// Vitest の既定はパスのハッシュで分けるので、最も重い 2 ファイル（renderCut・mixAudioTrack）が同じ shard に入り、
// CPU を取り合って律速していた（#715）。分け方だけを差し替え、shard の中の実行順は既定のまま。
export class WeightShardSequencer extends BaseSequencer {
  override async shard(files: TestSpecification[]): Promise<TestSpecification[]> {
    const { config } = this.ctx;
    if (config.shard === undefined) return files;
    const { count, index } = config.shard;
    const weights = readShardWeights(config.root);
    const keyOf = (spec: TestSpecification) =>
      `${spec.project.name}:${relative(config.root, spec.moduleId)}`;
    const mine = new Set(
      partitionByWeight(
        files.map((spec) => ({
          path: keyOf(spec),
          weight: weightOf(weights, relative(config.root, spec.moduleId)),
        })),
        count,
      )[index - 1],
    );
    return files.filter((spec) => mine.has(keyOf(spec)));
  }
}
