import { rmSync } from "node:fs";
import { join } from "node:path";

import { assert, describe, it } from "@effect/vitest";
import { Effect, Exit } from "effect";
import { Command } from "effect/cli";
import { SqlClient } from "effect/sql";
import { TestConsole } from "effect/testing";

import { appendCutExport, appendCutPreview } from "../db/explainer-cuts.ts";
import { appendPostDraft } from "../db/explainer-post-drafts.ts";
import { videoCommand } from "./cli.ts";
import { explainerConfig } from "../../test/explainer-helpers.ts";
import {
  failureFacts,
  selectAll,
  setClock,
  temporaryDirectory,
  writeJsonFile,
} from "../../test/helpers.ts";
import { recordPlan } from "../../test/narration-helpers.ts";
import {
  declareAccounts,
  defaultScheduledAt,
  instagramPost,
  writePostDraft,
  xPost,
  youtubePost,
} from "../../test/post-draft-helpers.ts";
import {
  addShort,
  approve,
  authStatusLine,
  channelNameOf,
  credentialStoreLayer,
  exportCut,
  finishWithoutApproving,
  pick,
  prepareVideo,
  preparePublishableVideo,
  previewDirectoryOf,
  publishTime,
  recommendShort,
  scriptedOperator,
  standardPosts,
  standardShorts,
  stdinTerminal,
  storeAllTokens,
  storeToken,
  writeShortDraft,
} from "../../test/publish-helpers.ts";
import { clipCut, dedicatedCut, shortCutExportKey, writeShort } from "../../test/short-helpers.ts";
import { insertCandidate, insertSelection } from "../../test/thumbnail-facts.ts";
import { callTool, withToolChannel } from "../../test/tool-helpers.ts";

// 契約（この issue の計画 C1〜C12）:
//   解説動画のチャンネルの `nyaucast video publish <id>` は、stdin が TTY のときだけ動き、
//   カット・投稿案・投稿先のアカウントを見せ、ショートの候補ごとに切り抜き / 専用 / どちらも出さないを選ばせ、
//   最後に承認する / やめずに終えるを選ばせる。承認すると、公開ゲートの承認と投稿を 1 つのトランザクションで書く。
//   拒否の条件に当たれば何も書かない。やめずに終えても何も書かない。
//   プロンプトの順序と既定値は、選択肢が画面に並ぶ順（切り抜き / 専用 / どちらも出さない、承認する / やめずに終える）で決まる。
//   CLI は effect/cli を in-process で実行する。DB・設定・トークンの置き場は一時チャンネルの本物。

interface PublishChannel {
  readonly channelRoot: string;
  readonly credentialRoot: string;
}

// 3 つの SNS を宣言し、すべてにトークンを保存した一時チャンネルで use を動かす。
const inChannel = <A, E, R>(
  prefix: string,
  use: (channel: PublishChannel) => Effect.Effect<A, E, R>,
) =>
  withToolChannel(prefix, { config: explainerConfig }, (channelRoot) =>
    Effect.gen(function* () {
      const credentialRoot = yield* temporaryDirectory(`${prefix}credentials-`);
      const credentials = credentialStoreLayer(credentialRoot);
      declareAccounts(channelRoot);
      yield* storeAllTokens(channelRoot).pipe(Effect.provide(credentials));
      return yield* use({ channelRoot, credentialRoot }).pipe(Effect.provide(credentials));
    }),
  );

interface RunOptions {
  readonly beforePrompt?: ((index: number) => Effect.Effect<void>) | undefined;
  readonly script?: readonly (readonly string[])[];
  readonly terminal?: boolean;
  readonly videoId?: string;
}

// 台本どおりに答える Terminal で CLI を動かす。失敗（想定した型付きの失敗）は outcome に、defect は呼び出し側へ届く。
const operate = <A, E, R>(
  program: Effect.Effect<A, E, R>,
  options: RunOptions,
  operator: ReturnType<typeof scriptedOperator>,
) =>
  program.pipe(
    Effect.provide(operator.layer),
    Effect.provide(stdinTerminal(options.terminal ?? true)),
    Effect.provide(TestConsole.layer),
  );

const publishArguments = (options: RunOptions) => ["publish", options.videoId ?? "V1"];

const runPublish = (options: RunOptions) => {
  const operator = scriptedOperator(options.script ?? [], { beforePrompt: options.beforePrompt });
  return operate(
    Effect.gen(function* () {
      // TestConsole は同じテストの中の実行をまたいで行を溜めるので、この実行が出した行だけを取る。
      const logsBefore = (yield* TestConsole.logLines).length;
      const outcome = yield* Effect.result(
        Command.runWith(videoCommand, { version: "test" })(publishArguments(options)),
      );
      const logs = (yield* TestConsole.logLines).slice(logsBefore).map(String);
      return { logs, outcome, unanswered: operator.unanswered() };
    }),
    options,
    operator,
  );
};

// defect（SQL の失敗など）も含めた終了。トランザクションの途中で書き込みが失敗したときの観測に使う。
const exitOfPublish = (options: RunOptions) => {
  const operator = scriptedOperator(options.script ?? []);
  return operate(
    Effect.exit(Command.runWith(videoCommand, { version: "test" })(publishArguments(options))),
    options,
    operator,
  );
};

const runOtherCommand = (args: string[]) =>
  Effect.gen(function* () {
    const outcome = yield* Effect.result(Command.runWith(videoCommand, { version: "test" })(args));
    return outcome;
  }).pipe(
    Effect.provide(scriptedOperator([]).layer),
    Effect.provide(stdinTerminal(true)),
    Effect.provide(TestConsole.layer),
  );

const failureOf = (outcome: { _tag: string; failure?: unknown }) => {
  assert.strictEqual(outcome._tag, "Failure");
  return outcome.failure as { _tag: string };
};

const publishApprovalTimes = selectAll("explainer_approvals").pipe(
  Effect.map((rows) =>
    rows.filter((row) => row["gate"] === "publish").map((row) => String(row["approved_at"])),
  ),
);

const rejectionRows = selectAll("explainer_rejections");

const postRows = selectAll("explainer_posts");

// 作られた投稿を [カット, SNS, アカウントの ID] で、カット・SNS の順に並べる。
const createdPosts = postRows.pipe(
  Effect.map((rows) =>
    rows
      .map(
        (row) => [String(row["cut"]), String(row["platform"]), String(row["account_id"])] as const,
      )
      .toSorted((a, b) => a.join("|").localeCompare(b.join("|"))),
  ),
);

const videoStatus = callTool("video_status", { videoId: "V1" });

const nothingWritten = Effect.gen(function* () {
  assert.deepStrictEqual(yield* publishApprovalTimes, []);
  assert.deepStrictEqual(yield* postRows, []);
  assert.deepStrictEqual(yield* rejectionRows, []);
});

const everyScriptedChoice = [["enter"], ["enter"], approve] as const;

describe("nyaucast video publish <id> on an explainer channel: approving", () => {
  it.effect(
    "writes one publish approval and the posts of the recommended cuts, which copy the drafts",
    () =>
      inChannel("nyaucast-publish-approve-", () =>
        Effect.gen(function* () {
          yield* preparePublishableVideo(standardShorts);

          const { outcome, unanswered } = yield* runPublish({ script: everyScriptedChoice });

          assert.strictEqual(outcome._tag, "Success");
          assert.strictEqual(unanswered, 0);
          assert.deepStrictEqual(yield* publishApprovalTimes, [publishTime]);
          assert.deepStrictEqual(yield* createdPosts, standardPosts);
          const rows = yield* postRows;
          const textOf = new Map(
            rows.map((row) => [
              `${String(row["cut"])}|${String(row["platform"])}`,
              String(row["title"] ?? row["body"]),
            ]),
          );
          assert.deepStrictEqual(Object.fromEntries(textOf), {
            "long|instagram": "長尺のインスタ",
            "long|x": "長尺のエックス",
            "long|youtube": "長尺の題名",
            "short-1-clip|x": "候補 1 のエックス",
            "short-2-dedicated|instagram": "候補 2 のインスタ",
          });
          assert.deepStrictEqual(
            rows.filter((row) => row["platform"] === "youtube").map((row) => row["description"]),
            ["長尺の説明"],
          );
          for (const row of rows) {
            assert.strictEqual(row["video_id"], "V1");
            assert.strictEqual(row["scheduled_at"], defaultScheduledAt);
          }
          const status = yield* videoStatus;
          assert.isUndefined(status.awaitingApproval);
          assert.isFalse(status.abandoned);
        }),
      ),
  );

  it.effect("makes a post for the cut that the operator picks instead of the recommendation", () =>
    inChannel("nyaucast-publish-pick-", () =>
      Effect.gen(function* () {
        yield* preparePublishableVideo(standardShorts);

        const { outcome } = yield* runPublish({
          script: [pick("dedicated", "clip"), pick("clip", "dedicated"), approve],
        });

        assert.strictEqual(outcome._tag, "Success");
        assert.deepStrictEqual(
          (yield* createdPosts).map(([cut]) => cut),
          ["long", "long", "long", "short-1-dedicated", "short-2-clip"],
        );
      }),
    ),
  );

  it.effect("makes no post for a candidate the operator picks neither cut for", () =>
    inChannel("nyaucast-publish-none-", () =>
      Effect.gen(function* () {
        yield* preparePublishableVideo(standardShorts);

        const { outcome } = yield* runPublish({
          script: [pick("none", "clip"), ["enter"], approve],
        });

        assert.strictEqual(outcome._tag, "Success");
        assert.deepStrictEqual(yield* createdPosts, [
          ["long", "instagram", "instagram-id"],
          ["long", "x", "x-id"],
          ["long", "youtube", "youtube-id"],
          ["short-2-dedicated", "instagram", "instagram-id"],
        ]);
        assert.strictEqual((yield* publishApprovalTimes).length, 1);
      }),
    ),
  );

  it.effect(
    "makes no post for a candidate without a recommendation when the operator keeps the default",
    () =>
      inChannel("nyaucast-publish-no-recommendation-", () =>
        Effect.gen(function* () {
          yield* preparePublishableVideo([
            { draft: xPost("候補 1 のエックス"), number: 1, recommended: "clip" },
          ]);
          yield* writeShort({ number: 2 });
          yield* writeShortDraft(2, xPost("候補 2 のエックス"));
          yield* setClock("2026-10-04T14:00:00.000Z");
          yield* exportCut(clipCut(2));
          yield* exportCut(dedicatedCut(2));
          yield* setClock(publishTime);

          const { outcome } = yield* runPublish({ script: [["enter"], ["enter"], approve] });

          assert.strictEqual(outcome._tag, "Success");
          assert.deepStrictEqual(
            (yield* createdPosts).filter(([cut]) => cut.startsWith("short-2-")),
            [],
          );
          assert.strictEqual(
            (yield* createdPosts).filter(([cut]) => cut.startsWith("short-1-")).length,
            1,
          );
        }),
      ),
  );

  it.effect("uses the last recommendation of a candidate as the default", () =>
    inChannel("nyaucast-publish-last-recommendation-", () =>
      Effect.gen(function* () {
        yield* preparePublishableVideo(standardShorts);
        yield* recommendShort(1, "dedicated");

        const { outcome } = yield* runPublish({ script: everyScriptedChoice });

        assert.strictEqual(outcome._tag, "Success");
        assert.deepStrictEqual(
          (yield* createdPosts).filter(([cut]) => cut.startsWith("short-1-")),
          [["short-1-dedicated", "x", "x-id"]],
        );
      }),
    ),
  );

  it.effect("writes nothing when the operator finishes without approving", () =>
    inChannel("nyaucast-publish-finish-", () =>
      Effect.gen(function* () {
        yield* preparePublishableVideo(standardShorts);

        const { outcome, unanswered } = yield* runPublish({
          script: [["enter"], ["enter"], finishWithoutApproving],
        });

        assert.strictEqual(outcome._tag, "Success");
        assert.strictEqual(unanswered, 0);
        yield* nothingWritten;
        const status = yield* videoStatus;
        assert.strictEqual(status.awaitingApproval, "publish");
        assert.isFalse(status.abandoned);
      }),
    ),
  );
});

describe("nyaucast video publish <id> on an explainer channel: the video that was abandoned", () => {
  it.effect("resumes with a publish approval newer than the NO-GO", () =>
    inChannel("nyaucast-publish-resume-", () =>
      Effect.gen(function* () {
        yield* preparePublishableVideo(standardShorts);
        yield* setClock("2026-10-04T14:30:00.000Z");
        const abandoned = yield* runOtherCommand(["abandon", "V1"]);
        assert.strictEqual(abandoned._tag, "Success");
        assert.isTrue((yield* videoStatus).abandoned);
        yield* setClock(publishTime);

        const { outcome } = yield* runPublish({ script: everyScriptedChoice });

        assert.strictEqual(outcome._tag, "Success");
        const rejectedAt = (yield* rejectionRows).map((row) => String(row["rejected_at"]));
        const approvedAt = yield* publishApprovalTimes;
        assert.strictEqual(rejectedAt.length, 1);
        assert.strictEqual(approvedAt.length, 1);
        assert.isTrue(approvedAt[0]! > rejectedAt[0]!);
        const status = yield* videoStatus;
        assert.isFalse(status.abandoned);
        assert.isUndefined(status.awaitingApproval);
        assert.strictEqual((yield* createdPosts).length, standardPosts.length);
      }),
    ),
  );
});

describe("nyaucast video publish <id> on an explainer channel: freshness of the approval", () => {
  it.effect(
    "is newer than the last export of an adopted cut, even when the clock is behind it",
    () =>
      inChannel("nyaucast-publish-fresh-export-", () =>
        Effect.gen(function* () {
          yield* preparePublishableVideo(standardShorts);
          const exportedAt = "2026-10-04T16:00:00.000Z";
          yield* setClock(exportedAt);
          yield* exportCut(clipCut(1));
          yield* setClock(publishTime);

          const { outcome } = yield* runPublish({ script: everyScriptedChoice });

          assert.strictEqual(outcome._tag, "Success");
          const approvedAt = yield* publishApprovalTimes;
          assert.strictEqual(approvedAt.length, 1);
          assert.isTrue(approvedAt[0]! > exportedAt);
        }),
      ),
  );

  it.effect("is newer than the last thumbnail selection, even when the clock is behind it", () =>
    inChannel("nyaucast-publish-fresh-selection-", () =>
      Effect.gen(function* () {
        yield* preparePublishableVideo(standardShorts);
        const selectedAt = "2026-10-04T17:00:00.000Z";
        yield* insertSelection({ number: 1, round: 1, selectedAt, videoId: "V1" });

        const { outcome } = yield* runPublish({ script: everyScriptedChoice });

        assert.strictEqual(outcome._tag, "Success");
        const approvedAt = yield* publishApprovalTimes;
        assert.strictEqual(approvedAt.length, 1);
        assert.isTrue(approvedAt[0]! > selectedAt);
      }),
    ),
  );
});

describe("nyaucast video publish <id> on an explainer channel: what it shows", () => {
  it.effect(
    "shows the cuts with their previews, the last selected thumbnail, the drafts and the accounts",
    () =>
      inChannel("nyaucast-publish-display-", ({ channelRoot }) =>
        Effect.gen(function* () {
          yield* preparePublishableVideo(standardShorts);
          yield* insertCandidate({ number: 2, round: 1, videoId: "V1" });
          yield* insertSelection({
            number: 2,
            round: 1,
            selectedAt: "2026-10-03T13:10:00.000Z",
            videoId: "V1",
          });

          const { logs, outcome } = yield* runPublish({ script: everyScriptedChoice });

          assert.strictEqual(outcome._tag, "Success");
          const shown = (fragment: string) => logs.filter((line) => line.includes(fragment));
          for (const cut of ["long", clipCut(1), dedicatedCut(1), clipCut(2), dedicatedCut(2)]) {
            assert.isAbove(shown(shortCutExportKey(cut)).length, 0, `the export of ${cut}`);
            assert.isAbove(shown(previewDirectoryOf(cut)).length, 0, `the previews of ${cut}`);
          }
          assert.isAbove(shown("videos/V1/thumbnails/1-2.jpg").length, 0);
          assert.deepStrictEqual(shown("videos/V1/thumbnails/1-1.jpg"), []);
          for (const fragment of [
            "長尺の題名",
            "長尺の説明",
            "長尺のインスタ",
            "長尺のエックス",
            "候補 1 のエックス",
            "候補 2 のインスタ",
            defaultScheduledAt,
          ]) {
            assert.isAbove(shown(fragment).length, 0, `the draft ${fragment}`);
          }
          for (const platform of ["youtube", "instagram", "x"] as const) {
            assert.isAbove(
              shown(authStatusLine(channelRoot, platform, "valid")).length,
              0,
              `the account of ${platform}`,
            );
          }
        }),
      ),
  );

  it.effect("shows an expiring token as expiring and still approves", () =>
    inChannel("nyaucast-publish-expiring-", ({ channelRoot }) =>
      Effect.gen(function* () {
        yield* preparePublishableVideo(standardShorts);
        yield* storeToken(channelRoot, "x", { expiresAt: Date.parse(publishTime) + 60_000 });

        const { logs, outcome } = yield* runPublish({ script: everyScriptedChoice });

        assert.strictEqual(outcome._tag, "Success");
        assert.isAbove(
          logs.filter((line) => line.includes(authStatusLine(channelRoot, "x", "expiring"))).length,
          0,
        );
        assert.strictEqual((yield* createdPosts).length, standardPosts.length);
      }),
    ),
  );
});

describe("nyaucast video publish <id> on an explainer channel: refusals", () => {
  it.effect("fails without asking anything and writes nothing when stdin is not a terminal", () =>
    inChannel("nyaucast-publish-no-tty-", () =>
      Effect.gen(function* () {
        yield* preparePublishableVideo(standardShorts);

        const refused = yield* runPublish({ script: everyScriptedChoice, terminal: false });

        assert.strictEqual(refused.outcome._tag, "Failure");
        assert.strictEqual(refused.unanswered, everyScriptedChoice.length);
        yield* nothingWritten;

        const accepted = yield* runPublish({ script: everyScriptedChoice });

        assert.strictEqual(accepted.outcome._tag, "Success");
        assert.strictEqual((yield* publishApprovalTimes).length, 1);
      }),
    ),
  );

  it.effect("fails with ProduceGateNotApproved and writes nothing before the produce gate", () =>
    inChannel("nyaucast-publish-early-", () =>
      Effect.gen(function* () {
        yield* recordPlan();

        const { outcome } = yield* runPublish({ script: [approve] });

        const failure = failureOf(outcome);
        assert.strictEqual(failure._tag, "ProduceGateNotApproved");
        assert.strictEqual(failureFacts(failure)["videoId"], "V1");
        yield* nothingWritten;
      }),
    ),
  );

  it.effect("fails with VideoNotFound for an unknown video and writes nothing", () =>
    inChannel("nyaucast-publish-unknown-", () =>
      Effect.gen(function* () {
        const { outcome } = yield* runPublish({ script: [approve], videoId: "nope" });

        assert.strictEqual(failureOf(outcome)._tag, "VideoNotFound");
        yield* nothingWritten;
      }),
    ),
  );

  // 拒否の条件ごとに、条件を作った状態で何も書かれないことと、条件を直した状態では承認できることを対にして確かめる。
  // 直した後に承認できるので、拒否の理由がその条件であって、別の前提の欠けではないと分かる。
  const breakers = {
    "invalid text": () =>
      appendPostDraft({
        accountId: "x-id",
        post: { platform: "x", text: "詳しくは https://example.com へ" },
        scheduledAt: defaultScheduledAt,
        videoId: "V1",
      }),
    "mismatched token": ({ channelRoot }: PublishChannel) =>
      storeToken(channelRoot, "instagram", { accountId: "someone-else" }),
    "past schedule": () =>
      writePostDraft({ post: xPost("長尺のエックス"), scheduledAt: "2026-10-04T14:00:00.000Z" }),
    undeclared: ({ channelRoot }: PublishChannel) =>
      Effect.sync(() => declareAccounts(channelRoot, ["youtube", "x"])),
    unauthenticated: ({ channelRoot, credentialRoot }: PublishChannel) =>
      Effect.sync(() =>
        rmSync(join(credentialRoot, channelNameOf(channelRoot), "instagram.json"), { force: true }),
      ),
  };

  const repairs = {
    "invalid text": () =>
      appendPostDraft({
        accountId: "x-id",
        post: { platform: "x", text: "長尺のエックス" },
        scheduledAt: defaultScheduledAt,
        videoId: "V1",
      }),
    "mismatched token": ({ channelRoot }: PublishChannel) => storeToken(channelRoot, "instagram"),
    "past schedule": () =>
      writePostDraft({ post: xPost("長尺のエックス"), scheduledAt: defaultScheduledAt }),
    undeclared: ({ channelRoot }: PublishChannel) =>
      Effect.sync(() => declareAccounts(channelRoot)),
    unauthenticated: ({ channelRoot }: PublishChannel) => storeToken(channelRoot, "instagram"),
  };

  it.effect.each([
    "undeclared",
    "unauthenticated",
    "mismatched token",
    "past schedule",
    "invalid text",
  ] as const)("writes nothing for %s, and approves once it is put right", (refusal) =>
    inChannel("nyaucast-publish-refusal-", (channel) =>
      Effect.gen(function* () {
        yield* preparePublishableVideo(standardShorts);
        yield* breakers[refusal](channel);

        const refused = yield* runPublish({ script: everyScriptedChoice });

        const failure = failureOf(refused.outcome);
        if (refusal === "invalid text") {
          assert.strictEqual(failure._tag, "InvalidPostText");
        }
        yield* nothingWritten;

        yield* repairs[refusal](channel);
        const accepted = yield* runPublish({ script: everyScriptedChoice });

        assert.strictEqual(accepted.outcome._tag, "Success");
        assert.strictEqual((yield* publishApprovalTimes).length, 1);
        assert.strictEqual((yield* createdPosts).length, standardPosts.length);
      }),
    ),
  );

  it.effect(
    "writes nothing when an adopted cut has no draft, and approves when the operator adopts neither cut",
    () =>
      inChannel("nyaucast-publish-no-draft-", () =>
        Effect.gen(function* () {
          yield* preparePublishableVideo([...standardShorts, { number: 3, recommended: "clip" }]);

          const refused = yield* runPublish({ script: [["enter"], ["enter"], ["enter"], approve] });

          assert.strictEqual(refused.outcome._tag, "Failure");
          yield* nothingWritten;

          const accepted = yield* runPublish({
            script: [["enter"], ["enter"], pick("none", "clip"), approve],
          });

          assert.strictEqual(accepted.outcome._tag, "Success");
          assert.deepStrictEqual(yield* createdPosts, standardPosts);
        }),
      ),
  );

  it.effect("allows an account that has no draft at all", () =>
    inChannel("nyaucast-publish-account-without-draft-", () =>
      Effect.gen(function* () {
        yield* prepareVideo;
        yield* setClock("2026-10-03T13:40:00.000Z");
        yield* writePostDraft({ post: xPost("長尺のエックス") });
        yield* setClock("2026-10-03T14:00:00.000Z");
        yield* exportCut("long");
        yield* setClock(publishTime);

        const { outcome } = yield* runPublish({ script: [approve] });

        assert.strictEqual(outcome._tag, "Success");
        assert.deepStrictEqual(yield* createdPosts, [["long", "x", "x-id"]]);
      }),
    ),
  );

  it.effect(
    "writes nothing when a draft is rewritten after it was shown, and shows the new one next",
    () =>
      inChannel("nyaucast-publish-changed-", () =>
        Effect.gen(function* () {
          yield* preparePublishableVideo(standardShorts);
          const rewrite = writePostDraft({
            post: youtubePost("書き直した題名", "書き直した説明"),
            scheduledAt: defaultScheduledAt,
          });
          const context = yield* Effect.context<Effect.Services<typeof rewrite>>();

          const stale = yield* runPublish({
            beforePrompt: (index) =>
              index === everyScriptedChoice.length - 1
                ? rewrite.pipe(Effect.provideContext(context), Effect.orDie, Effect.asVoid)
                : Effect.void,
            script: everyScriptedChoice,
          });

          assert.strictEqual(stale.outcome._tag, "Failure");
          yield* nothingWritten;

          const fresh = yield* runPublish({ script: everyScriptedChoice });

          assert.strictEqual(fresh.outcome._tag, "Success");
          assert.isAbove(fresh.logs.filter((line) => line.includes("書き直した題名")).length, 0);
          const rows = yield* postRows;
          assert.deepStrictEqual(
            rows.filter((row) => row["platform"] === "youtube").map((row) => row["title"]),
            ["書き直した題名"],
          );
        }),
      ),
  );
});

// 最後の問いに答える直前（画面を見せた後）に、effect を 1 回だけ実行する。
const afterShown = <R>(effect: Effect.Effect<unknown, unknown, R>) =>
  Effect.gen(function* () {
    const context = yield* Effect.context<R>();
    return (index: number) =>
      index === everyScriptedChoice.length - 1
        ? effect.pipe(Effect.provideContext(context), Effect.orDie, Effect.asVoid)
        : Effect.void;
  });

describe("nyaucast video publish <id> on an explainer channel: refusals about what is not made", () => {
  const neitherClip = [pick("none", "clip"), ["enter"], approve] as const;

  it.effect("fails when the account of a post to make is not the declared account", () =>
    inChannel("nyaucast-publish-draft-account-", ({ channelRoot }) =>
      Effect.gen(function* () {
        yield* preparePublishableVideo(standardShorts);
        writeJsonFile(
          join(channelRoot, "config", "channel", "accounts.json"),
          Object.fromEntries(
            ["youtube", "instagram", "x"].map((platform) => [
              platform,
              {
                handle: `@nyaucast-${platform}`,
                id: platform === "x" ? "x-other-id" : `${platform}-id`,
              },
            ]),
          ),
        );
        yield* storeToken(channelRoot, "x", { accountId: "x-other-id" });

        const refused = yield* runPublish({ script: everyScriptedChoice });

        assert.isTrue(refused.outcome._tag === "Failure");
        yield* nothingWritten;

        declareAccounts(channelRoot);
        yield* storeToken(channelRoot, "x");
        const accepted = yield* runPublish({ script: everyScriptedChoice });

        assert.strictEqual(accepted.outcome._tag, "Success");
        assert.strictEqual((yield* createdPosts).length, standardPosts.length);
      }),
    ),
  );

  it.effect(
    "fails for a past schedule of a draft whose candidate the operator does not adopt",
    () =>
      inChannel("nyaucast-publish-none-past-", () =>
        Effect.gen(function* () {
          yield* preparePublishableVideo(standardShorts);
          yield* writeShortDraft(1, xPost("候補 1 のエックス"), "2026-10-04T14:00:00.000Z");

          const refused = yield* runPublish({ script: neitherClip });

          assert.strictEqual(failureOf(refused.outcome)._tag, "ScheduledInPast");
          yield* nothingWritten;

          yield* writeShortDraft(1, xPost("候補 1 のエックス"), defaultScheduledAt);
          const accepted = yield* runPublish({ script: neitherClip });

          assert.strictEqual(accepted.outcome._tag, "Success");
        }),
      ),
  );

  it.effect(
    "fails for an invalid text of a draft whose candidate the operator does not adopt",
    () =>
      inChannel("nyaucast-publish-none-text-", () =>
        Effect.gen(function* () {
          yield* preparePublishableVideo(standardShorts);
          yield* appendPostDraft({
            accountId: "x-id",
            post: { platform: "x", text: "詳しくは https://example.com へ" },
            scheduledAt: defaultScheduledAt,
            short: 1,
            videoId: "V1",
          });

          const refused = yield* runPublish({ script: neitherClip });

          assert.strictEqual(failureOf(refused.outcome)._tag, "InvalidPostText");
          yield* nothingWritten;

          yield* appendPostDraft({
            accountId: "x-id",
            post: { platform: "x", text: "候補 1 のエックス" },
            scheduledAt: defaultScheduledAt,
            short: 1,
            videoId: "V1",
          });
          const accepted = yield* runPublish({ script: neitherClip });

          assert.strictEqual(accepted.outcome._tag, "Success");
        }),
      ),
  );

  it.effect("fails with NoPostToCreate when the operator adopts no cut that has a draft", () =>
    inChannel("nyaucast-publish-no-post-", () =>
      Effect.gen(function* () {
        yield* prepareVideo;
        yield* addShort(1, "none");
        yield* setClock("2026-10-03T13:40:00.000Z");
        yield* writeShortDraft(1, xPost("候補 1 のエックス"));
        yield* setClock("2026-10-03T14:00:00.000Z");
        yield* exportCut("long");
        yield* setClock(publishTime);

        const { outcome } = yield* runPublish({ script: [["enter"], approve] });

        assert.strictEqual(failureOf(outcome)._tag, "NoPostToCreate");
        yield* nothingWritten;
      }),
    ),
  );

  it.effect("fails when the draft of a cut that has a live post became invalid", () =>
    inChannel("nyaucast-publish-invalid-draft-of-live-", () =>
      Effect.gen(function* () {
        yield* preparePublishableVideo(standardShorts);
        yield* runPublish({ script: everyScriptedChoice });
        const approvalsBefore = yield* publishApprovalTimes;
        const postsBefore = yield* createdPosts;
        yield* setClock("2026-10-04T16:00:00.000Z");
        yield* writeShort({ hook: "別の台本", number: 1 });
        yield* addShort(3, "clip");
        yield* writeShortDraft(3, xPost("候補 3 のエックス"));
        yield* exportCut(clipCut(3));
        yield* exportCut(dedicatedCut(3));
        yield* setClock("2026-10-04T16:30:00.000Z");

        const { outcome } = yield* runPublish({ script: [["enter"], approve] });

        const failure = failureOf(outcome);
        assert.strictEqual(failure._tag, "AdoptedCutHasNoDraft");
        assert.strictEqual(failureFacts(failure)["cut"], "short-1-clip");
        assert.deepStrictEqual(yield* publishApprovalTimes, approvalsBefore);
        assert.deepStrictEqual(yield* createdPosts, postsBefore);
      }),
    ),
  );

  it.effect("points a new draft of a candidate that has a live post at the cut of that post", () =>
    inChannel("nyaucast-publish-live-candidate-", () =>
      Effect.gen(function* () {
        yield* preparePublishableVideo(standardShorts);
        yield* runPublish({ script: everyScriptedChoice });
        yield* setClock("2026-10-04T16:00:00.000Z");
        yield* writeShortDraft(1, instagramPost("候補 1 のインスタ"));
        yield* setClock("2026-10-04T16:30:00.000Z");

        const second = yield* runPublish({ script: [approve] });

        assert.strictEqual(second.outcome._tag, "Success");
        assert.strictEqual(second.unanswered, 0);
        assert.deepStrictEqual(
          (yield* createdPosts).filter(
            ([cut, platform]) => cut === "short-1-clip" && platform === "instagram",
          ),
          [["short-1-clip", "instagram", "instagram-id"]],
        );
        assert.strictEqual((yield* postRows).length, standardPosts.length + 1);
      }),
    ),
  );

  it.effect(
    "still approves the second time when a draft that has a live post is now in the past",
    () =>
      inChannel("nyaucast-publish-live-past-", () =>
        Effect.gen(function* () {
          yield* preparePublishableVideo(standardShorts);
          yield* runPublish({ script: everyScriptedChoice });
          yield* setClock("2026-10-06T00:00:00.000Z");
          yield* addShort(3, "clip");
          yield* writeShortDraft(3, xPost("候補 3 のエックス"), "2026-10-07T00:00:00.000Z");
          yield* exportCut(clipCut(3));
          yield* exportCut(dedicatedCut(3));

          const { outcome } = yield* runPublish({ script: [["enter"], approve] });

          assert.strictEqual(outcome._tag, "Success");
          assert.strictEqual((yield* postRows).length, standardPosts.length + 1);
        }),
      ),
  );

  const changes = {
    "an export of the long cut": () =>
      appendCutExport({
        compositionHash: "hash-long",
        cut: "long",
        key: shortCutExportKey("long"),
        renderHash: "render-long-again",
        videoId: "V1",
      }),
    "a preview of the long cut": () =>
      appendCutPreview({ compositionHash: "hash-long-again", cut: "long", videoId: "V1" }),
    "the selected thumbnail": () =>
      insertSelection({
        number: 2,
        round: 1,
        selectedAt: "2026-10-04T17:30:00.000Z",
        videoId: "V1",
      }),
  };

  it.effect.each([
    "an export of the long cut",
    "a preview of the long cut",
    "the selected thumbnail",
  ] as const)("writes nothing when %s changes after it was shown", (change) =>
    inChannel("nyaucast-publish-facts-changed-", () =>
      Effect.gen(function* () {
        yield* preparePublishableVideo(standardShorts);
        yield* insertCandidate({ number: 2, round: 1, videoId: "V1" });
        const beforePrompt = yield* afterShown(changes[change]());

        const stale = yield* runPublish({ beforePrompt, script: everyScriptedChoice });

        assert.strictEqual(failureOf(stale.outcome)._tag, "PublishFactsChanged");
        yield* nothingWritten;

        const fresh = yield* runPublish({ script: everyScriptedChoice });

        assert.strictEqual(fresh.outcome._tag, "Success");
      }),
    ),
  );
});

describe("nyaucast video publish <id> on an explainer channel: a canceled post (C12/C14)", () => {
  // 契約（この issue #554 の計画 C12・C14、「公開ゲートの後に直すとき…取り消し → 投稿案の書き直し →
  // video publish の再実行で直す」ADR-0009 決定 10）: 取り消し済みの投稿は readLivePosts に現れない
  // ので、その投稿案は「生きている投稿を持たない投稿案」として再び pending になり、2 回目の
  // video publish で新しい投稿が作られる(古い行は残る。append-only)。
  it.effect(
    "lets the long-form YouTube draft be published again after its post is canceled, without any new prompts",
    () =>
      inChannel("nyaucast-publish-canceled-", () =>
        Effect.gen(function* () {
          yield* preparePublishableVideo(standardShorts);
          yield* runPublish({ script: everyScriptedChoice });
          const beforeRows = yield* postRows;
          const longYoutubePostId = beforeRows.find(
            (row) => row["cut"] === "long" && row["platform"] === "youtube",
          )?.["id"];
          assert.isDefined(longYoutubePostId);
          const sql = yield* SqlClient.SqlClient;
          yield* sql`INSERT INTO explainer_post_cancellations (post_id, recorded_at) VALUES (${longYoutubePostId}, '2026-10-04T16:00:00.000Z')`;
          yield* setClock("2026-10-04T16:30:00.000Z");

          const second = yield* runPublish({ script: [approve] });

          assert.strictEqual(second.outcome._tag, "Success");
          assert.strictEqual(second.unanswered, 0);
          assert.strictEqual((yield* postRows).length, standardPosts.length + 1);
          assert.deepStrictEqual(
            (yield* createdPosts).filter(
              ([cut, platform]) => cut === "long" && platform === "youtube",
            ),
            [
              ["long", "youtube", "youtube-id"],
              ["long", "youtube", "youtube-id"],
            ],
          );
        }),
      ),
  );
});

describe("nyaucast video publish <id> on an explainer channel: one transaction", () => {
  it.effect.each(["explainer_posts", "explainer_approvals"] as const)(
    "leaves neither the approval nor the posts when a write to %s fails",
    (table) =>
      inChannel("nyaucast-publish-atomic-", () =>
        Effect.gen(function* () {
          yield* preparePublishableVideo(standardShorts);
          const sql = yield* SqlClient.SqlClient;
          const guard = table === "explainer_approvals" ? "WHEN NEW.gate = 'publish' " : "";
          yield* sql.unsafe(
            `CREATE TRIGGER fail_${table} BEFORE INSERT ON ${table} ${guard}BEGIN SELECT RAISE(ABORT, 'forced failure'); END`,
          );

          const exit = yield* exitOfPublish({ script: everyScriptedChoice });

          assert.isTrue(Exit.isFailure(exit));
          yield* nothingWritten;

          yield* sql.unsafe(`DROP TRIGGER fail_${table}`);
          const retried = yield* runPublish({ script: everyScriptedChoice });

          assert.strictEqual(retried.outcome._tag, "Success");
          assert.strictEqual((yield* publishApprovalTimes).length, 1);
          assert.strictEqual((yield* createdPosts).length, standardPosts.length);
        }),
      ),
  );
});

describe("nyaucast video publish <id> on an explainer channel: the second time", () => {
  it.effect(
    "shows only the drafts without a live post, asks only about candidates without one, and writes a new approval",
    () =>
      inChannel("nyaucast-publish-second-", () =>
        Effect.gen(function* () {
          yield* preparePublishableVideo(standardShorts);
          const first = yield* runPublish({ script: everyScriptedChoice });
          assert.strictEqual(first.outcome._tag, "Success");
          const firstApprovedAt = (yield* publishApprovalTimes)[0]!;

          yield* setClock("2026-10-04T16:00:00.000Z");
          yield* addShort(3, "clip");
          yield* setClock("2026-10-04T16:10:00.000Z");
          yield* writeShortDraft(3, xPost("候補 3 のエックス"));
          yield* setClock("2026-10-04T16:20:00.000Z");
          yield* exportCut(clipCut(3));
          yield* exportCut(dedicatedCut(3));
          yield* setClock("2026-10-04T16:30:00.000Z");

          const second = yield* runPublish({ script: [["enter"], approve] });

          assert.strictEqual(second.outcome._tag, "Success");
          assert.strictEqual(second.unanswered, 0);
          const approvals = yield* publishApprovalTimes;
          assert.strictEqual(approvals.length, 2);
          assert.isTrue(approvals[1]! > firstApprovedAt);
          assert.deepStrictEqual(
            (yield* createdPosts).filter(([cut]) => cut === "short-3-clip"),
            [["short-3-clip", "x", "x-id"]],
          );
          assert.strictEqual((yield* postRows).length, standardPosts.length + 1);
          for (const text of [
            "長尺の題名",
            "長尺のインスタ",
            "長尺のエックス",
            "候補 1 のエックス",
            "候補 2 のインスタ",
          ]) {
            assert.deepStrictEqual(
              second.logs.filter((line) => line.includes(text)),
              [],
              `the draft ${text} already has a live post`,
            );
          }
          assert.isAbove(
            second.logs.filter((line) => line.includes("候補 3 のエックス")).length,
            0,
          );
        }),
      ),
  );

  it.effect("is newer than the last export of a cut that already has live posts", () =>
    inChannel("nyaucast-publish-second-fresh-", () =>
      Effect.gen(function* () {
        yield* preparePublishableVideo(standardShorts);
        yield* runPublish({ script: everyScriptedChoice });
        const exportedAt = "2026-10-04T17:00:00.000Z";
        yield* setClock(exportedAt);
        yield* exportCut("long");
        yield* setClock("2026-10-04T16:00:00.000Z");
        yield* writeShortDraft(1, xPost("候補 1 の別のエックス"), "2026-10-06T00:00:00.000Z");
        yield* setClock("2026-10-04T16:30:00.000Z");
        yield* addShort(3, "clip");
        yield* writeShortDraft(3, xPost("候補 3 のエックス"));
        yield* exportCut(clipCut(3));
        yield* exportCut(dedicatedCut(3));

        const second = yield* runPublish({ script: [["enter"], approve] });

        assert.strictEqual(second.outcome._tag, "Success");
        const approvals = yield* publishApprovalTimes;
        assert.isTrue(approvals[1]! > exportedAt);
      }),
    ),
  );

  it.effect("writes nothing when every draft already has a live post", () =>
    inChannel("nyaucast-publish-nothing-left-", () =>
      Effect.gen(function* () {
        yield* preparePublishableVideo(standardShorts);
        yield* runPublish({ script: everyScriptedChoice });
        const approvedBefore = yield* publishApprovalTimes;
        const postsBefore = yield* createdPosts;
        yield* setClock("2026-10-04T16:30:00.000Z");

        const { outcome } = yield* runPublish({ script: [approve] });

        assert.strictEqual(outcome._tag, "Failure");
        assert.deepStrictEqual(yield* publishApprovalTimes, approvedBefore);
        assert.deepStrictEqual(yield* createdPosts, postsBefore);
      }),
    ),
  );
});
