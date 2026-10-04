import { Effect, Schema } from "effect";
import { Tool } from "effect/ai";

import { AccountNotDeclared, AccountsDeclarationInvalid } from "../auth/accounts.ts";
import { DeclaredAccounts } from "../auth/declared-accounts.ts";
import {
  ChannelConfigNotFound,
  ChannelSettings,
  InvalidChannelConfig,
  NotExplainerChannel,
} from "../channel/channel-settings.ts";
import { appendPostDraft, isUnchangedDraft, lastPostDraft } from "../db/explainer-post-drafts.ts";
import {
  ShortCandidateNotFound,
  requireActiveShort,
  shortFactLock,
} from "../db/explainer-shorts.ts";
import { VideoNotFound, requireLatestPlan } from "../db/explainer-videos.ts";
import { InvalidPostText, PostText, checkPostText } from "../posts/post-text.ts";
import { Ordinal } from "../shorts/short-candidate.ts";
import { ProduceGateNotApproved, requireProduceApproval } from "../videos/produce-gate.ts";

// 時差（Z または ±hh:mm）を必須にした ISO 8601。時差が無い時刻は、どの時刻か決まらないので受けない。
const ScheduledAt = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u),
  Schema.makeFilter((value: string) => !Number.isNaN(Date.parse(value)), {
    description: "a date-time",
  }),
);

export const VideoWritePostDraftTool = Tool.make("video_write_post_draft", {
  description:
    "Write a post draft of an explainer video before the publish gate: the post text and the scheduled time of one account. " +
    "The key is the short candidate (omit short for the long-form video) and the account declared for the platform (its id); the draft carries no cut. " +
    "A YouTube post is a title and a description (no tags); an Instagram or X post is a text. " +
    "The platform must have an account declared in config/channel/accounts.json. " +
    "The post text is checked: it must not be blank; the YouTube title is at most 100 characters and the description at most 5000 bytes of UTF-8; an Instagram text is at most 2200 characters; " +
    "an X text is at most 280 under X's weighted count (a Japanese character or an emoji counts 2) and must contain no URL, a bare domain such as example.com included. " +
    "scheduledAt is an ISO 8601 time with an offset (Z or ±hh:mm) and is stored in UTC; a time in the past is not refused here. " +
    "Drafts are append-only and the last draft of a key is the one that counts. Writing exactly the same post and time again records nothing. " +
    "A short's draft counts only while it is newer than the last version of the candidate; video_status returns the drafts that count. " +
    "Requires the produce gate to be approved. " +
    "Fails with VideoNotFound for an unknown video, with ProduceGateNotApproved before the produce gate is approved, " +
    "with ShortCandidateNotFound when short names a candidate that was never written or is withdrawn, " +
    "with AccountNotDeclared (channel and platform) when the channel declares no account for the platform, with AccountsDeclarationInvalid when the declaration file is broken, " +
    "and with InvalidPostText (platform, field and rule: empty, tooLong or containsUrl) when the post text breaks a check; nothing is written in these cases. " +
    "Returns the platform, the short number when there is one, and whether a draft was recorded now.",
  failure: Schema.Union([
    InvalidPostText,
    AccountNotDeclared,
    AccountsDeclarationInvalid,
    ShortCandidateNotFound,
    ProduceGateNotApproved,
    VideoNotFound,
    NotExplainerChannel,
    InvalidChannelConfig,
    ChannelConfigNotFound,
  ]),
  parameters: Schema.Struct({
    post: PostText.annotate({ description: "The post text, by platform." }),
    scheduledAt: ScheduledAt.annotate({
      description: "When to publish: ISO 8601 with an offset (Z or ±hh:mm).",
    }),
    short: Schema.optionalKey(
      Ordinal.annotate({
        description:
          "Candidate number of the short this draft is for. Omit it for the long-form video.",
      }),
    ),
    videoId: Schema.String.annotate({ description: "Video ID returned by explainer_write_plan." }),
  }),
  success: Schema.Struct({
    platform: Schema.Literals(["instagram", "x", "youtube"]),
    recorded: Schema.Boolean,
    short: Schema.optionalKey(Schema.Finite),
    videoId: Schema.String,
  }),
}).annotate(Tool.Strict, true);

interface Written {
  readonly post: PostText;
  readonly scheduledAt: string;
  readonly short?: number;
  readonly videoId: string;
}

const writePostDraft = Effect.fn("video.writePostDraft")(function* (written: Written) {
  const { post, short, videoId } = written;
  yield* (yield* ChannelSettings).requireExplainer;
  yield* requireLatestPlan(videoId);
  yield* requireProduceApproval(videoId);
  const candidates = short === undefined ? [] : [yield* requireActiveShort(videoId, short)];
  const account = yield* (yield* DeclaredAccounts).require(post.platform);
  yield* checkPostText(post);
  const scheduledAt = new Date(written.scheduledAt).toISOString();
  const result = { platform: post.platform, ...(short === undefined ? {} : { short }), videoId };
  const last = yield* lastPostDraft(videoId, short, post.platform, account.id);
  if (isUnchangedDraft(last, candidates, { post, scheduledAt })) {
    return { ...result, recorded: false };
  }
  yield* appendPostDraft({
    accountId: account.id,
    after: candidates[0]?.createdAt,
    post,
    scheduledAt,
    short,
    videoId,
  });
  return { ...result, recorded: true };
});

// 投稿案の時刻は直前の事実と候補の最後の版より後にするので、候補の事実を積む操作と同じ lock で直列にする。
export const videoWritePostDraft = (input: Written) =>
  shortFactLock.withPermits(1)(writePostDraft(input));
