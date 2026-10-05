import { Clock, Console, Effect } from "effect";
import { Argument, Command } from "effect/cli";

import { ChannelSettings } from "../channel/channel-settings.ts";
import { HttpUrl } from "../db/explainer-videos.ts";
import { cancelPost, type CancelPostOutcome } from "./cancel-post.ts";
import { type DuePostOutcome, runDuePosts } from "./due-posts.ts";
import type { ClassifiedPost } from "./post-classification.ts";
import { describePostTarget, readPostTarget } from "./post-target.ts";
import { type PublicationCheckOutcome, runPublicationChecks } from "./publication-check.ts";
import { recordPostPublished, type RecordPublicationOutcome } from "./record-publication.ts";
import { runPostNow } from "./run-post-now.ts";

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

// 公開の確認の 1 行(issue 決定「公開の確認」)。次に何をすべきかは書かない(ADR-0009 決定 14)。
const describePublicationCheckOutcome = (outcome: PublicationCheckOutcome): string =>
  `${outcome.kind}: post ${outcome.postId}`;

// 取り消しの 1 行。結果の無い試行を持つ投稿だけ、リモートに残っているかもしれないことを付記する(AC2)。
const describeCancelOutcome = (outcome: CancelPostOutcome): string =>
  `${outcome.kind}: post ${outcome.postId}` +
  (outcome.kind === "canceled" && outcome.remoteMayRemain === true
    ? " (remote may still remain)"
    : "");

// 公開済みの記録の 1 行。
const describeRecordPublicationOutcome = (outcome: RecordPublicationOutcome): string =>
  `${outcome.kind}: post ${outcome.postId}`;

const currentIsoTime = Effect.map(Clock.currentTimeMillis, (ms) => new Date(ms).toISOString());

const postIdArgument = Argument.Int("post-id");

// 3 つの CLI（取り消し・今すぐ実行・公開済みの記録）が共有する準備段。動かす前に投稿先の
// アカウントとカットを表示する(issue 決定)。
const withPostTarget = (postId: number) =>
  Effect.gen(function* () {
    const settings = yield* (yield* ChannelSettings).requireExplainer;
    const target = yield* readPostTarget(postId, settings.distribution.toleranceMinutes);
    yield* Console.log(describePostTarget(target));
    return target;
  });

// 3 つの CLI が共有する本体: 表示 → 操作 → 結果を 1 行。各 CLI は操作と出力の組み立てだけが違う。
const runPostAction = <A, E, R>(
  postId: number,
  action: (target: ClassifiedPost) => Effect.Effect<A, E, R>,
  describe: (outcome: A) => string,
) =>
  Effect.gen(function* () {
    const target = yield* withPostTarget(postId);
    const outcome = yield* action(target);
    yield* Console.log(describe(outcome));
  });

const run = Command.make("run", {}, () =>
  Effect.gen(function* () {
    const settings = yield* (yield* ChannelSettings).requireExplainer;
    const toleranceMinutes = settings.distribution.toleranceMinutes;
    // 公開の確認を先に、その後 due の投稿を実行する(issue 決定「公開の確認」。同じ実行で新しく
    // 作った予約をその実行の中で照会しない)。
    const publicationOutcomes = yield* runPublicationChecks(toleranceMinutes);
    yield* Effect.forEach(
      publicationOutcomes,
      (outcome) => Console.log(describePublicationCheckOutcome(outcome)),
      { discard: true },
    );
    const outcomes = yield* runDuePosts(toleranceMinutes);
    yield* Effect.forEach(outcomes, (outcome) => Console.log(describeOutcome(outcome)), {
      discard: true,
    });
  }),
).pipe(
  Command.withDescription(
    "時刻が来た投稿を実行する（issue #553）。同じ実行の中で、予定時刻を過ぎた予約済みの YouTube の投稿の公開を確かめた後、due の投稿を処理する。チャンネルの全動画を横断する。1 行 = 1 件の結果（事実のみ）。",
  ),
);

const cancel = Command.make("cancel", { postId: postIdArgument }, ({ postId }) =>
  runPostAction(
    postId,
    (target) => Effect.flatMap(currentIsoTime, (recordedAt) => cancelPost(target, recordedAt)),
    describeCancelOutcome,
  ),
).pipe(
  Command.withDescription(
    "投稿を取り消す（人間だけが叩く。issue #554）。動かす前に投稿先のアカウントとカットを表示する。SNS 側で予約済みの YouTube の投稿は、リモートの private の動画を消してから取り消しを積む。結果の無い試行を持つ投稿は削除を呼ばず、残っているかもしれないことを表示する。",
  ),
);

const runNow = Command.make("run-now", { postId: postIdArgument }, ({ postId }) =>
  runPostAction(postId, runPostNow, describeOutcome),
).pipe(
  Command.withDescription(
    "確認待ちか失敗の投稿を、許容時間を無視して実行する（人間だけが叩く。issue #554）。動かす前に投稿先のアカウントとカットを表示する。鮮度の検査は外さない。",
  ),
);

const markPublished = Command.make(
  "mark-published",
  { postId: postIdArgument, url: Argument.String("url").pipe(Argument.withSchema(HttpUrl)) },
  ({ postId, url }) =>
    runPostAction(
      postId,
      (target) =>
        Effect.flatMap(currentIsoTime, (recordedAt) =>
          recordPostPublished(target, url, recordedAt),
        ),
      describeRecordPublicationOutcome,
    ),
).pipe(
  Command.withDescription(
    "結果の無い試行や公開の確認が取れない投稿を、リモートの URL とともに公開済みとして記録する（人間だけが叩く。issue #554）。動かす前に投稿先のアカウントとカットを表示する。",
  ),
);

export const postCommand = Command.make("post").pipe(
  Command.withSubcommands([run, cancel, runNow, markPublished]),
);
