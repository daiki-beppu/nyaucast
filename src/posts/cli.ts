import { Console, Effect } from "effect";
import { Command } from "effect/cli";

import { ChannelSettings } from "../channel/channel-settings.ts";
import { type DuePostOutcome, runDuePosts } from "./due-posts.ts";

type DetailOf<K extends DuePostOutcome["kind"]> = (
  outcome: Extract<DuePostOutcome, { kind: K }>,
) => string;

const noDetail = () => "";

// kind ごとの付記（postId の後に付ける事実）。本体（kind・postId）は describeOutcome が組む。
const detailFormatters: { [K in DuePostOutcome["kind"]]: DetailOf<K> } = {
  account_stopped: noDetail,
  indeterminate: noDetail,
  no_adapter: (outcome) => ` (${outcome.platform})`,
  not_acquired: noDetail,
  not_ready: noDetail,
  permanent: (outcome) => ` (${outcome.tag})`,
  scheduled_in_past: noDetail,
  succeeded: (outcome) =>
    ` remoteId=${outcome.remoteId}` +
    (outcome.thumbnailSetFailed === true ? " thumbnailSetFailed=true" : ""),
  temporary: (outcome) => ` (${outcome.tag})`,
};

// 1 行 = 1 件の事実。次に何をすべきかは書かない（issue #553 の方針。定期実行のログから次の操作を判断しない）。
const describeOutcome = (outcome: DuePostOutcome): string => {
  const detailOf = detailFormatters[outcome.kind] as DetailOf<DuePostOutcome["kind"]>;
  return `${outcome.kind}: post ${outcome.postId}${detailOf(outcome)}`;
};

const run = Command.make("run", {}, () =>
  Effect.gen(function* () {
    const settings = yield* (yield* ChannelSettings).requireExplainer;
    const outcomes = yield* runDuePosts(settings.distribution.toleranceMinutes);
    yield* Effect.forEach(outcomes, (outcome) => Console.log(describeOutcome(outcome)), {
      discard: true,
    });
  }),
).pipe(
  Command.withDescription(
    "時刻が来た投稿を実行する（issue #553）。チャンネルの全動画を横断し、due の投稿だけを処理する。1 行 = 1 件の結果（事実のみ）。",
  ),
);

export const postCommand = Command.make("post").pipe(Command.withSubcommands([run]));
