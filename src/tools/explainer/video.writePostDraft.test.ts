import { join } from "node:path";

import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";

import { scriptScenes } from "../../../test/composition-helpers.ts";
import { explainerConfig, planInput } from "../../../test/explainer-helpers.ts";
import {
  accepts,
  failureFacts,
  publishedAdditionalProperties,
  setClock,
  writeJsonFile,
} from "../../../test/helpers.ts";
import { approveProduce, recordPlan, scriptInput } from "../../../test/narration-helpers.ts";
import {
  declareAccounts,
  defaultScheduledAt,
  instagramPost,
  postDraftRows,
  writePostDraft,
  xPost,
  youtubePost,
} from "../../../test/post-draft-helpers.ts";
import { withdrawShort, writeShort } from "../../../test/short-helpers.ts";
import { callTool, rejectionReason, withToolChannel } from "../../../test/tool-helpers.ts";
import { ExplainerVideoWritePostDraftTool } from "./video.writePostDraft.ts";

// 契約（この issue の計画 C1〜C3）:
//   tool 名 video_write_post_draft、パラメータ { videoId, short?, scheduledAt, post }。
//   キーは「ショートの候補（short を省略すれば長尺）× SNS」。post は YouTube がタイトルと説明、Instagram と X が本文。
//   成功値 { videoId, short?, platform, recorded }。recorded は行を積んだときだけ true。
//   宣言していない SNS・形式の誤り・取り下げた候補・企画ゲート未承認では何も書かない。
//   投稿案は append-only。同じキーの最後の投稿案が有効で、候補の最後の版より新しいものだけが video_status に出る。

const first = "2026-10-04T01:00:00.000Z";
const second = "2026-10-04T02:00:00.000Z";
const third = "2026-10-04T03:00:00.000Z";

interface ChannelOptions {
  /** 宣言する SNS。省略は 3 つすべて。 */
  readonly accounts?: readonly ("instagram" | "x" | "youtube")[];
  /** 企画ゲートを承認しない。 */
  readonly unapproved?: boolean;
}

// 企画・承認・長尺の台本・アカウントの宣言を用意した動画 V1 で use を動かす。
const inChannel = <A, E, R>(
  prefix: string,
  options: ChannelOptions,
  use: (channelRoot: string) => Effect.Effect<A, E, R>,
) =>
  withToolChannel(prefix, { config: explainerConfig }, (channelRoot) =>
    Effect.gen(function* () {
      declareAccounts(channelRoot, options.accounts);
      yield* recordPlan();
      if (options.unapproved !== true) {
        yield* approveProduce();
        yield* callTool("video_write_script", scriptInput(scriptScenes));
      }
      return yield* use(channelRoot);
    }),
  );

const statusDrafts = callTool("video_status", { videoId: "V1" }).pipe(
  Effect.map((status) => status.postDrafts),
);

describe("video.writePostDraft: parameters", () => {
  const schema = ExplainerVideoWritePostDraftTool.parametersSchema;
  const valid = { post: xPost(), scheduledAt: "2026-10-05T09:00:00+09:00", videoId: "V1" };

  it("is named with its wire name", () => {
    assert.strictEqual(ExplainerVideoWritePostDraftTool.name, "video_write_post_draft");
  });

  it("accepts a long-form draft and a short draft for each platform, and rejects every other key", () => {
    assert.isTrue(accepts(schema, valid));
    assert.isTrue(accepts(schema, { ...valid, short: 2 }));
    assert.isTrue(accepts(schema, { ...valid, post: youtubePost() }));
    assert.isTrue(accepts(schema, { ...valid, post: instagramPost() }));
    assert.isFalse(accepts(schema, { ...valid, force: true }));
    assert.isFalse(accepts(schema, { ...valid, cut: "long" }));
    assert.isFalse(accepts(schema, { ...valid, post: { ...xPost(), hashtags: [] } }));
    for (const key of ["videoId", "scheduledAt", "post"] as const) {
      const without = Object.fromEntries(Object.entries(valid).filter(([name]) => name !== key));
      assert.isFalse(accepts(schema, without), `without ${key}`);
    }
    assert.strictEqual(publishedAdditionalProperties(ExplainerVideoWritePostDraftTool), false);
  });

  it("does not give a YouTube post tags", () => {
    assert.isFalse(accepts(schema, { ...valid, post: { ...youtubePost(), tags: ["猫"] } }));
  });

  it("does not accept a platform other than YouTube, Instagram and X", () => {
    assert.isFalse(accepts(schema, { ...valid, post: { platform: "tiktok", text: "t" } }));
  });

  it.each([0, -1, 1.5])(
    "does not accept the short number %j (a positive integer from 1)",
    (short) => {
      assert.isFalse(accepts(schema, { ...valid, short }));
    },
  );

  it.each([
    ["a time without an offset", "2026-10-05T09:00:00"],
    ["a date only", "2026-10-05"],
    ["free text", "tomorrow morning"],
    ["an empty string", ""],
  ])("does not accept %s as the scheduled time", (_name, scheduledAt) => {
    assert.isFalse(accepts(schema, { ...valid, scheduledAt }));
  });

  it.each(["2026-10-05T00:00:00Z", "2026-10-05T09:00:00+09:00", "2026-10-05T00:00:00.000Z"])(
    "accepts the ISO 8601 time with an offset %s",
    (scheduledAt) => {
      assert.isTrue(accepts(schema, { ...valid, scheduledAt }));
    },
  );

  it("accepts the result and rejects action fields in it", () => {
    const result = { platform: "x", recorded: true, videoId: "V1" };

    assert.isTrue(accepts(ExplainerVideoWritePostDraftTool.successSchema, result));
    assert.isTrue(accepts(ExplainerVideoWritePostDraftTool.successSchema, { ...result, short: 1 }));
    assert.isFalse(
      accepts(ExplainerVideoWritePostDraftTool.successSchema, { ...result, next: "approve" }),
    );
    assert.isFalse(
      accepts(ExplainerVideoWritePostDraftTool.successSchema, { ...result, recorded: "yes" }),
    );
  });

  it("describes the failure tags without telling the agent what to do next", () => {
    const { description } = ExplainerVideoWritePostDraftTool;

    for (const tag of [
      "AccountNotDeclared",
      "InvalidPostText",
      "ProduceGateNotApproved",
      "ShortCandidateNotFound",
      "VideoNotFound",
    ]) {
      assert.include(description, tag);
    }
    assert.notMatch(description, /\b(next|then run|you should|please)\b/iu);
  });

  it.effect("rejects an unknown key as invalid parameters, before anything is written", () =>
    inChannel("nyaucast-post-draft-unknown-key-", {}, () =>
      Effect.gen(function* () {
        const request = {
          cut: "long",
          post: xPost(),
          scheduledAt: defaultScheduledAt,
          videoId: "V1",
        };

        assert.strictEqual(
          yield* rejectionReason("video_write_post_draft", request),
          "ToolParameterValidationError",
        );
        assert.deepStrictEqual(yield* postDraftRows, []);
      }),
    ),
  );
});

describe("video.writePostDraft: writing a draft", () => {
  it.effect("records one draft for the long-form video, keyed without a short number", () =>
    inChannel("nyaucast-post-draft-long-", {}, () =>
      Effect.gen(function* () {
        yield* setClock(first);

        const result = yield* writePostDraft({ post: xPost("長尺の告知") });

        assert.deepStrictEqual(result, { platform: "x", recorded: true, videoId: "V1" });
        assert.deepStrictEqual(
          (yield* postDraftRows).map((row) => [
            row["video_id"],
            row["short_number"],
            row["platform"],
            row["scheduled_at"],
            row["created_at"],
          ]),
          [["V1", null, "x", defaultScheduledAt, first]],
        );
      }),
    ),
  );

  it.effect("records a draft for a short candidate under its number and returns the number", () =>
    inChannel("nyaucast-post-draft-short-", {}, () =>
      Effect.gen(function* () {
        yield* setClock(first);
        yield* writeShort({ number: 1 });
        yield* setClock(second);

        const result = yield* writePostDraft({ post: xPost("ショートの告知"), short: 1 });

        assert.deepStrictEqual(result, { platform: "x", recorded: true, short: 1, videoId: "V1" });
        const rows = yield* postDraftRows;
        assert.strictEqual(rows[0]?.["short_number"], 1);
      }),
    ),
  );

  it.effect("stores the scheduled time in UTC, whatever offset it was given in", () =>
    inChannel("nyaucast-post-draft-offset-", {}, () =>
      Effect.gen(function* () {
        yield* setClock(first);

        yield* writePostDraft({ post: xPost(), scheduledAt: "2026-10-05T09:00:00+09:00" });

        assert.strictEqual((yield* postDraftRows)[0]?.["scheduled_at"], "2026-10-05T00:00:00.000Z");
        assert.deepStrictEqual(
          (yield* statusDrafts).map((draft) => draft.scheduledAt),
          ["2026-10-05T00:00:00.000Z"],
        );
      }),
    ),
  );

  it.effect(
    "accepts a scheduled time in the past (the publish gate decides on it, not this tool)",
    () =>
      inChannel("nyaucast-post-draft-past-", {}, () =>
        Effect.gen(function* () {
          yield* setClock(first);

          const result = yield* writePostDraft({
            post: xPost(),
            scheduledAt: "2020-01-01T00:00:00Z",
          });

          assert.isTrue(result.recorded);
        }),
      ),
  );

  it.effect("keeps each platform and each candidate as its own key", () =>
    inChannel("nyaucast-post-draft-keys-", {}, () =>
      Effect.gen(function* () {
        yield* setClock(first);
        yield* writeShort({ number: 1 });
        yield* writeShort({ number: 2 });
        yield* setClock(second);

        yield* writePostDraft({ post: xPost("2 の x"), short: 2 });
        yield* writePostDraft({ post: xPost("長尺の x") });
        yield* writePostDraft({ post: youtubePost("1 の題名", "1 の説明"), short: 1 });
        yield* writePostDraft({ post: instagramPost("長尺の instagram") });
        yield* writePostDraft({ post: youtubePost("長尺の題名") });
        yield* writePostDraft({ post: xPost("1 の x"), short: 1 });

        assert.strictEqual((yield* postDraftRows).length, 6);
        assert.deepStrictEqual(
          (yield* statusDrafts).map((draft) => [draft.short, draft.platform]),
          [
            [undefined, "youtube"],
            [undefined, "instagram"],
            [undefined, "x"],
            [1, "youtube"],
            [1, "x"],
            [2, "x"],
          ],
        );
      }),
    ),
  );

  it.effect("stores the YouTube post as a title and a description", () =>
    inChannel("nyaucast-post-draft-youtube-", {}, () =>
      Effect.gen(function* () {
        yield* setClock(first);

        yield* writePostDraft({ post: youtubePost("題名", "説明の本文") });

        assert.deepStrictEqual(yield* statusDrafts, [
          {
            accountId: "youtube-id",
            createdAt: first,
            platform: "youtube",
            post: { description: "説明の本文", platform: "youtube", title: "題名" },
            scheduledAt: defaultScheduledAt,
          },
        ]);
      }),
    ),
  );
});

describe("video.writePostDraft: writing a draft again", () => {
  it.effect("adds one draft per change, and the last draft of the key is the one returned", () =>
    inChannel("nyaucast-post-draft-again-", {}, () =>
      Effect.gen(function* () {
        yield* setClock(first);
        yield* writePostDraft({ post: xPost("最初の案") });
        yield* setClock(second);

        const again = yield* writePostDraft({ post: xPost("書き直した案") });

        assert.isTrue(again.recorded);
        assert.strictEqual((yield* postDraftRows).length, 2);
        assert.deepStrictEqual(yield* statusDrafts, [
          {
            accountId: "x-id",
            createdAt: second,
            platform: "x",
            post: { platform: "x", text: "書き直した案" },
            scheduledAt: defaultScheduledAt,
          },
        ]);
      }),
    ),
  );

  it.effect(
    "keys a draft by the declared account, so another account's same draft is a new fact",
    () =>
      inChannel("nyaucast-post-draft-account-change-", {}, (channelRoot) =>
        Effect.gen(function* () {
          const declareX = (id: string) =>
            writeJsonFile(join(channelRoot, "config", "channel", "accounts.json"), {
              x: { handle: "@nyaucast-x", id },
            });
          yield* setClock(first);
          declareX("x-account-a");
          yield* writePostDraft({ post: xPost("同じ案") });
          yield* setClock(second);
          declareX("x-account-b");

          const other = yield* writePostDraft({ post: xPost("同じ案") });
          const again = yield* writePostDraft({ post: xPost("同じ案") });

          assert.isTrue(other.recorded);
          assert.isFalse(again.recorded);
          assert.strictEqual((yield* postDraftRows).length, 2);
          assert.deepStrictEqual(
            (yield* statusDrafts).map((draft) => draft.accountId),
            ["x-account-a", "x-account-b"],
          );
        }),
      ),
  );

  it.effect("records a draft when only the scheduled time changed", () =>
    inChannel("nyaucast-post-draft-reschedule-", {}, () =>
      Effect.gen(function* () {
        yield* setClock(first);
        yield* writePostDraft({ post: xPost() });
        yield* setClock(second);

        const again = yield* writePostDraft({ post: xPost(), scheduledAt: "2026-10-06T00:00:00Z" });

        assert.isTrue(again.recorded);
        assert.strictEqual((yield* postDraftRows).length, 2);
        assert.strictEqual((yield* statusDrafts)[0]?.scheduledAt, "2026-10-06T00:00:00.000Z");
      }),
    ),
  );

  it.effect("records nothing when exactly the same content is written again", () =>
    inChannel("nyaucast-post-draft-idempotent-", {}, () =>
      Effect.gen(function* () {
        yield* setClock(first);
        yield* writePostDraft({ post: youtubePost("題名", "説明") });
        yield* setClock(second);

        const again = yield* writePostDraft({ post: youtubePost("題名", "説明") });

        assert.deepStrictEqual(again, { platform: "youtube", recorded: false, videoId: "V1" });
        assert.strictEqual((yield* postDraftRows).length, 1);
        assert.strictEqual((yield* statusDrafts)[0]?.createdAt, first);
      }),
    ),
  );

  it.effect("records the same content again once the earlier draft is no longer valid", () =>
    inChannel("nyaucast-post-draft-rewrite-after-stale-", {}, () =>
      Effect.gen(function* () {
        yield* setClock(first);
        yield* writeShort({ number: 1 });
        yield* setClock(second);
        yield* writePostDraft({ post: xPost("同じ案"), short: 1 });
        yield* setClock(third);
        yield* writeShort({ hook: "改訂", number: 1 });
        assert.deepStrictEqual(yield* statusDrafts, []);

        const again = yield* writePostDraft({ post: xPost("同じ案"), short: 1 });

        assert.isTrue(again.recorded);
        assert.strictEqual((yield* postDraftRows).length, 2);
        assert.strictEqual((yield* statusDrafts).length, 1);
      }),
    ),
  );
});

describe("video.writePostDraft: validity against the candidate's last version", () => {
  it.effect("drops the drafts of a candidate from the read model once its version is renewed", () =>
    inChannel("nyaucast-post-draft-stale-", {}, () =>
      Effect.gen(function* () {
        yield* setClock(first);
        yield* writeShort({ number: 1 });
        yield* setClock(second);
        yield* writePostDraft({ post: xPost("初稿"), short: 1 });
        yield* writePostDraft({ post: youtubePost("初稿の題名"), short: 1 });
        assert.strictEqual((yield* statusDrafts).length, 2);

        yield* setClock(third);
        yield* writeShort({ hook: "改訂", number: 1 });

        assert.deepStrictEqual(yield* statusDrafts, []);
        // append-only: 古い投稿案の行は消えない。読み口が返さないだけ。
        assert.strictEqual((yield* postDraftRows).length, 2);
      }),
    ),
  );

  it.effect("returns a draft written after the renewal, even when the clock has not moved", () =>
    inChannel("nyaucast-post-draft-after-renewal-", {}, () =>
      Effect.gen(function* () {
        yield* setClock(first);
        yield* writeShort({ number: 1 });
        yield* setClock(second);
        yield* writePostDraft({ post: xPost("旧"), short: 1 });
        yield* setClock(third);
        yield* writeShort({ hook: "改訂", number: 1 });

        yield* writePostDraft({ post: xPost("新"), short: 1 });

        assert.deepStrictEqual(
          (yield* statusDrafts).map((draft) => [draft.post, draft.createdAt]),
          [[{ platform: "x", text: "新" }, "2026-10-04T03:00:00.001Z"]],
        );
      }),
    ),
  );

  it.effect(
    "drops the drafts of a renewed candidate even when the clock stands still or goes back",
    () =>
      inChannel("nyaucast-post-draft-renew-frozen-clock-", {}, () =>
        Effect.gen(function* () {
          yield* setClock(second);
          yield* writeShort({ number: 1 });
          yield* writePostDraft({ post: xPost("旧 1"), short: 1 });
          yield* writePostDraft({ post: xPost("旧 2"), short: 1 });

          yield* writeShort({ hook: "改訂", number: 1 });
          assert.deepStrictEqual(yield* statusDrafts, []);

          yield* writePostDraft({ post: xPost("新"), short: 1 });
          yield* setClock(first);
          yield* writeShort({ hook: "再改訂", number: 1 });

          assert.deepStrictEqual(yield* statusDrafts, []);
        }),
      ),
  );

  it.effect("keeps the drafts of the other candidates and of the long-form video", () =>
    inChannel("nyaucast-post-draft-others-", {}, () =>
      Effect.gen(function* () {
        yield* setClock(first);
        yield* writeShort({ number: 1 });
        yield* writeShort({ number: 2 });
        yield* setClock(second);
        yield* writePostDraft({ post: xPost("長尺") });
        yield* writePostDraft({ post: xPost("1"), short: 1 });
        yield* writePostDraft({ post: xPost("2"), short: 2 });

        yield* setClock(third);
        yield* writeShort({ hook: "改訂", number: 1 });

        assert.deepStrictEqual(
          (yield* statusDrafts).map((draft) => [draft.short, draft.post]),
          [
            [undefined, { platform: "x", text: "長尺" }],
            [2, { platform: "x", text: "2" }],
          ],
        );
      }),
    ),
  );

  it.effect("leaves out the drafts of a withdrawn candidate", () =>
    inChannel("nyaucast-post-draft-withdrawn-", {}, () =>
      Effect.gen(function* () {
        yield* setClock(first);
        yield* writeShort({ number: 1 });
        yield* writeShort({ number: 2 });
        yield* setClock(second);
        yield* writePostDraft({ post: xPost("1"), short: 1 });
        yield* writePostDraft({ post: xPost("2"), short: 2 });

        yield* withdrawShort(1);

        assert.deepStrictEqual(
          (yield* statusDrafts).map((draft) => draft.short),
          [2],
        );
      }),
    ),
  );

  it.effect("does not carry the drafts of another video", () =>
    inChannel("nyaucast-post-draft-other-video-", {}, () =>
      Effect.gen(function* () {
        yield* setClock(first);
        const other = yield* callTool("video_write_plan", planInput({ title: "Another" }));
        yield* writePostDraft({ post: xPost("V1 の案") });

        const status = yield* callTool("video_status", { videoId: other.videoId });

        assert.deepStrictEqual(status.postDrafts, []);
      }),
    ),
  );
});

describe("video.writePostDraft: refusing a draft", () => {
  it.effect("refuses an X post with a bare domain, and writes nothing", () =>
    inChannel("nyaucast-post-draft-x-domain-", {}, () =>
      Effect.gen(function* () {
        yield* setClock(first);

        const failure = yield* Effect.flip(
          writePostDraft({ post: xPost("詳しくは example.com を見て") }),
        );

        assert.strictEqual(failure._tag, "InvalidPostText");
        assert.deepStrictEqual(failureFacts(failure)["rule"], "containsUrl");
        assert.deepStrictEqual(yield* postDraftRows, []);
      }),
    ),
  );

  it.effect("refuses 141 Japanese characters for X, and accepts 140", () =>
    inChannel("nyaucast-post-draft-x-length-", {}, () =>
      Effect.gen(function* () {
        yield* setClock(first);

        const failure = yield* Effect.flip(writePostDraft({ post: xPost("あ".repeat(141)) }));
        assert.strictEqual(failure._tag, "InvalidPostText");
        assert.deepStrictEqual(failureFacts(failure)["rule"], "tooLong");
        assert.deepStrictEqual(yield* postDraftRows, []);

        const accepted = yield* writePostDraft({ post: xPost("あ".repeat(140)) });
        assert.isTrue(accepted.recorded);
      }),
    ),
  );

  it.effect("refuses a 101 character YouTube title, and accepts 100", () =>
    inChannel("nyaucast-post-draft-youtube-title-", {}, () =>
      Effect.gen(function* () {
        yield* setClock(first);

        const failure = yield* Effect.flip(writePostDraft({ post: youtubePost("a".repeat(101)) }));
        assert.strictEqual(failure._tag, "InvalidPostText");
        assert.deepStrictEqual(failureFacts(failure)["field"], "title");
        assert.deepStrictEqual(failureFacts(failure)["rule"], "tooLong");
        assert.deepStrictEqual(yield* postDraftRows, []);

        const accepted = yield* writePostDraft({ post: youtubePost("a".repeat(100)) });
        assert.isTrue(accepted.recorded);
      }),
    ),
  );

  it.effect("refuses an empty post", () =>
    inChannel("nyaucast-post-draft-empty-", {}, () =>
      Effect.gen(function* () {
        const failure = yield* Effect.flip(writePostDraft({ post: instagramPost("  ") }));

        assert.strictEqual(failure._tag, "InvalidPostText");
        assert.deepStrictEqual(failureFacts(failure)["rule"], "empty");
        assert.deepStrictEqual(yield* postDraftRows, []);
      }),
    ),
  );

  it.effect("accepts a bare domain for Instagram and YouTube", () =>
    inChannel("nyaucast-post-draft-domain-other-", {}, () =>
      Effect.gen(function* () {
        yield* setClock(first);

        assert.isTrue((yield* writePostDraft({ post: instagramPost("example.com") })).recorded);
        assert.isTrue(
          (yield* writePostDraft({ post: youtubePost("題名", "https://example.com/a") })).recorded,
        );
      }),
    ),
  );

  it.effect("refuses a draft for an account the channel has not declared", () =>
    inChannel("nyaucast-post-draft-undeclared-", { accounts: ["youtube"] }, () =>
      Effect.gen(function* () {
        yield* setClock(first);

        const failure = yield* Effect.flip(writePostDraft({ post: xPost() }));

        assert.strictEqual(failure._tag, "AccountNotDeclared");
        assert.strictEqual(failureFacts(failure)["platform"], "x");
        assert.deepStrictEqual(yield* postDraftRows, []);
        assert.isTrue((yield* writePostDraft({ post: youtubePost() })).recorded);
      }),
    ),
  );

  it.effect("refuses every draft when the channel declares no accounts at all", () =>
    inChannel("nyaucast-post-draft-no-accounts-", { accounts: [] }, () =>
      Effect.gen(function* () {
        const failure = yield* Effect.flip(writePostDraft({ post: youtubePost() }));

        assert.strictEqual(failure._tag, "AccountNotDeclared");
        assert.deepStrictEqual(yield* postDraftRows, []);
      }),
    ),
  );

  it.effect("fails with AccountsDeclarationInvalid when the declaration file is broken", () =>
    withToolChannel(
      "nyaucast-post-draft-broken-accounts-",
      { config: explainerConfig },
      (channelRoot) =>
        Effect.gen(function* () {
          yield* recordPlan();
          yield* approveProduce();
          writeJsonFile(`${channelRoot}/config/channel/accounts.json`, { x: { handle: "" } });

          const failure = yield* Effect.flip(writePostDraft({ post: xPost() }));

          assert.strictEqual(failure._tag, "AccountsDeclarationInvalid");
          assert.deepStrictEqual(yield* postDraftRows, []);
        }),
    ),
  );

  it.effect("reads the declaration at every call, so a declaration added later is honoured", () =>
    inChannel("nyaucast-post-draft-declared-later-", { accounts: ["youtube"] }, (channelRoot) =>
      Effect.gen(function* () {
        yield* setClock(first);
        const failure = yield* Effect.flip(writePostDraft({ post: xPost() }));
        assert.strictEqual(failure._tag, "AccountNotDeclared");

        declareAccounts(channelRoot, ["youtube", "x"]);

        assert.isTrue((yield* writePostDraft({ post: xPost() })).recorded);
      }),
    ),
  );

  it.effect("fails with ProduceGateNotApproved before the produce gate is approved", () =>
    inChannel("nyaucast-post-draft-unapproved-", { unapproved: true }, () =>
      Effect.gen(function* () {
        const failure = yield* Effect.flip(writePostDraft({ post: xPost() }));

        assert.strictEqual(failure._tag, "ProduceGateNotApproved");
        assert.deepStrictEqual(yield* postDraftRows, []);
      }),
    ),
  );

  it.effect("fails with VideoNotFound for an unknown video", () =>
    inChannel("nyaucast-post-draft-no-video-", {}, () =>
      Effect.gen(function* () {
        const failure = yield* Effect.flip(writePostDraft({ post: xPost(), videoId: "missing" }));

        assert.strictEqual(failure._tag, "VideoNotFound");
        assert.deepStrictEqual(yield* postDraftRows, []);
      }),
    ),
  );

  it.effect("fails with ShortCandidateNotFound for a candidate that was never written", () =>
    inChannel("nyaucast-post-draft-no-candidate-", {}, () =>
      Effect.gen(function* () {
        const failure = yield* Effect.flip(writePostDraft({ post: xPost(), short: 3 }));

        assert.strictEqual(failure._tag, "ShortCandidateNotFound");
        assert.deepStrictEqual(yield* postDraftRows, []);
      }),
    ),
  );

  it.effect("fails with ShortCandidateNotFound for a withdrawn candidate", () =>
    inChannel("nyaucast-post-draft-withdrawn-target-", {}, () =>
      Effect.gen(function* () {
        yield* setClock(first);
        yield* writeShort({ number: 1 });
        yield* withdrawShort(1);

        const failure = yield* Effect.flip(writePostDraft({ post: xPost(), short: 1 }));

        assert.strictEqual(failure._tag, "ShortCandidateNotFound");
        assert.deepStrictEqual(yield* postDraftRows, []);
      }),
    ),
  );
});

describe("video.writePostDraft: channel kind", () => {
  it.effect("fails with ChannelConfigNotFound when the channel has no video config", () =>
    withToolChannel("nyaucast-post-draft-noconfig-", {}, () =>
      Effect.gen(function* () {
        const failure = yield* Effect.flip(writePostDraft({ post: xPost() }));

        assert.strictEqual(failure._tag, "ChannelConfigNotFound");
      }),
    ),
  );

  it.effect("fails with InvalidChannelConfig when the video config is broken", () =>
    withToolChannel("nyaucast-post-draft-invalid-", { config: "{ not json" }, () =>
      Effect.gen(function* () {
        const failure = yield* Effect.flip(writePostDraft({ post: xPost() }));

        assert.strictEqual(failure._tag, "InvalidChannelConfig");
      }),
    ),
  );
});
