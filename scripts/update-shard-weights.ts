// CI の shard の重み（vitest.shard-weights.json）を作り直す（#742）。
// `pnpm run shard-weights:update` が全件を JSON で書き出した後に、その所要時間で記録をまるごと置き換える。
// 一部だけを走らせた結果を読むと記録が欠けるので、Vitest の cache ではなく、全件の実行の出力だけを読む。
import { readFileSync, writeFileSync } from "node:fs";
import { relative } from "node:path";

import { shardWeightsFile } from "../vitest.shard.config.ts";

const [reportFile] = process.argv.slice(2);
if (reportFile === undefined) {
  throw new Error("usage: node scripts/update-shard-weights.ts <vitest json report>");
}

const { testResults } = JSON.parse(readFileSync(reportFile, "utf8")) as {
  readonly testResults: readonly {
    readonly endTime: number;
    readonly name: string;
    readonly startTime: number;
  }[];
};
const weights = Object.fromEntries(
  testResults
    .map(
      ({ endTime, name, startTime }) =>
        [relative(process.cwd(), name), Math.round((endTime - startTime) / 100) / 10] as const,
    )
    .sort(([left], [right]) => (left < right ? -1 : 1)),
);
writeFileSync(shardWeightsFile, `${JSON.stringify(weights, null, 2)}\n`);
