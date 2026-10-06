import { statSync } from "node:fs";
import { relative } from "node:path";

import { BaseSequencer, type TestSpecification } from "vite-plus/test/node";

interface SizedFile {
  readonly path: string;
  readonly size: number;
}

// 大きい順に、そのときいちばん軽い shard へ詰める（LPT）。重みはファイルの大きさで、チェックアウトだけで決まる。
// 所要時間の記録を重みにすると、shard の job ごとに読む記録が違い、分け方が食い違ってテストが漏れ得る。
export const partitionBySize = (files: readonly SizedFile[], count: number): string[][] => {
  const shards = Array.from({ length: count }, () => ({ load: 0, paths: [] as string[] }));
  const ordered = [...files].sort(
    (left, right) =>
      right.size - left.size || (left.path < right.path ? -1 : left.path > right.path ? 1 : 0),
  );
  for (const { path, size } of ordered) {
    const lightest = shards.reduce((min, shard) => (shard.load < min.load ? shard : min));
    lightest.paths.push(path);
    lightest.load += size;
  }
  return shards.map(({ paths }) => paths);
};

// Vitest の既定はパスのハッシュで分けるので、最も重い 2 ファイル（renderCut・mixAudioTrack）が同じ shard に入り、
// CPU を取り合って律速していた（#715）。分け方だけを差し替え、shard の中の実行順は既定のまま。
export class SizeShardSequencer extends BaseSequencer {
  override async shard(files: TestSpecification[]): Promise<TestSpecification[]> {
    const { config } = this.ctx;
    const { count, index } = config.shard ?? { count: 1, index: 1 };
    const keyOf = (spec: TestSpecification) =>
      `${spec.project.name}:${relative(config.root, spec.moduleId)}`;
    const mine = new Set(
      partitionBySize(
        files.map((spec) => ({ path: keyOf(spec), size: statSync(spec.moduleId).size })),
        count,
      )[index - 1],
    );
    return files.filter((spec) => mine.has(keyOf(spec)));
  }
}
