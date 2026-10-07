import { Console, Effect } from "effect";
import { Command } from "effect/cli";

import { type CloudflareStatus, cloudflareStatus } from "./status.ts";

const nextCommand = "nyaucast cloudflare";

// 1 行 = 1 つの事実（key=value）。秘密の値は出さない（issue #692 決定 4 行目）。
const describeStatus = (status: CloudflareStatus): ReadonlyArray<string> => {
  if (status.kind === "absent") {
    return [`state=absent`, `next=${nextCommand}`];
  }
  const accessKeyFacts =
    status.accessKey.kind === "one_password"
      ? [`accessKey=one_password`, `accessKeyReference=${status.accessKey.reference}`]
      : [`accessKey=${status.accessKey.kind}`];
  return [
    `state=created`,
    `account=${status.accountId}`,
    `bucket=${status.bucket}`,
    ...accessKeyFacts,
  ];
};

const status = Command.make("status", {}, () =>
  cloudflareStatus.pipe(
    Effect.flatMap((status) =>
      // Effect.forEach は (line, index) で呼ぶため、index を渡さないよう明示的に包む。
      Effect.forEach(describeStatus(status), (line) => Console.log(line), { discard: true }),
    ),
  ),
);

// plan と apply（資源の作成・変更）は後続の ticket（issue #692 決定 1 行目）。この ticket は見るだけ。
export const cloudflareCommand = Command.make("cloudflare").pipe(
  Command.withSubcommands([status]),
  Command.withDescription("Cloudflare 環境（R2 バケットなど）の作成状況を見る。"),
);
