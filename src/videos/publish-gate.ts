import { Clock, Effect, Option, Result, Schema } from "effect";

import { type Platform, platforms } from "../auth/account-key.ts";
import { type Account, type AccountNotDeclared } from "../auth/accounts.ts";
import { CredentialStore, type StoredCredential } from "../auth/credential-store.ts";
import { DeclaredAccounts } from "../auth/declared-accounts.ts";
import { type AuthState, deriveAuthState } from "../auth/status.ts";
import { ChannelSettings } from "../channel/channel-settings.ts";
import { type CutFacts, longCut, readCutFacts, shortCutNames } from "../db/explainer-cuts.ts";
import { type PostDraft, readPostDrafts } from "../db/explainer-post-drafts.ts";
import { type LivePost, appendPosts, isPostOf, readLivePosts } from "../db/explainer-posts.ts";
import {
  type ShortCandidate,
  type ShortRecommendation,
  readShortFacts,
  readShortRecommendations,
} from "../db/explainer-shorts.ts";
import { latestSelectionAt, readThumbnailFacts } from "../db/explainer-thumbnails.ts";
import { requireLatestPlan } from "../db/explainer-videos.ts";
import { appendExplainerApproval } from "../db/gates.ts";
import { inTransaction } from "../db/transaction.ts";
import { checkPostText } from "../posts/post-text.ts";
import { requireProduceApproval } from "./produce-gate.ts";

// 失敗は、タグと事実だけを持つ。次に取る行動は持たない。
export class StdinNotTerminal extends Schema.TaggedError<StdinNotTerminal>()("StdinNotTerminal", {
  videoId: Schema.String,
}) {}
class PublishFactsChanged extends Schema.TaggedError<PublishFactsChanged>()("PublishFactsChanged", {
  videoId: Schema.String,
}) {}
class NoPostToCreate extends Schema.TaggedError<NoPostToCreate>()("NoPostToCreate", {
  videoId: Schema.String,
}) {}
class AccountNotAuthenticated extends Schema.TaggedError<AccountNotAuthenticated>()(
  "AccountNotAuthenticated",
  { channel: Schema.String, platform: Schema.String },
) {}
class AccountIdMismatch extends Schema.TaggedError<AccountIdMismatch>()("AccountIdMismatch", {
  channel: Schema.String,
  declaredId: Schema.String,
  platform: Schema.String,
  tokenId: Schema.String,
}) {}
class ScheduledInPast extends Schema.TaggedError<ScheduledInPast>()("ScheduledInPast", {
  accountId: Schema.String,
  platform: Schema.String,
  scheduledAt: Schema.String,
  short: Schema.optionalKey(Schema.Finite),
}) {}
class DraftAccountNotDeclared extends Schema.TaggedError<DraftAccountNotDeclared>()(
  "DraftAccountNotDeclared",
  { declaredId: Schema.String, draftAccountId: Schema.String, platform: Schema.String },
) {}
class AdoptedCutHasNoDraft extends Schema.TaggedError<AdoptedCutHasNoDraft>()(
  "AdoptedCutHasNoDraft",
  { cut: Schema.String },
) {}

/** ショートの候補ごとの選択。切り抜き・専用・どちらも出さない。 */
export type ShortChoice = ShortRecommendation;

export interface CutView {
  readonly cut: string;
  readonly exportKey?: string;
  readonly previewDirectory?: string;
}

/** 宣言が無い SNS は notDeclared を、宣言がある SNS は宣言したアカウントと保存されたトークンを持つ。 */
export type AccountView = {
  readonly platform: Platform;
  readonly state: AuthState;
} & (
  | { readonly notDeclared: AccountNotDeclared }
  | { readonly account: Account; readonly credential?: StoredCredential }
);

/** 選択を問う候補（生きている投稿が 1 件も無い、取り下げていない候補）と、その既定値（agent の最後の推奨）。 */
export interface PromptedShort {
  readonly hook: string;
  readonly number: number;
  readonly recommended: ShortChoice;
}

export interface PublishPreparation {
  readonly accounts: ReadonlyArray<AccountView>;
  readonly cuts: ReadonlyArray<CutView>;
  /** 生きている投稿を持たない投稿案。 */
  readonly drafts: ReadonlyArray<PostDraft>;
  readonly prompted: ReadonlyArray<PromptedShort>;
  /** 表示した内容。承認を書く直前に読み直して比べる。 */
  readonly snapshot: string;
  readonly thumbnailKey?: string;
  readonly videoId: string;
}

/** 選択を問った候補の番号 → 選択。 */
export type ShortChoices = ReadonlyMap<number, ShortChoice>;

const cutOf = (number: number, choice: ShortChoice): string | undefined => {
  const [clip, dedicated] = shortCutNames(number);
  return choice === "clip" ? clip : choice === "dedicated" ? dedicated : undefined;
};

interface PublishState {
  readonly cutFacts: ReadonlyArray<typeof CutFacts.Type>;
  /** 現在有効な投稿案の全体（生きている投稿を持つものを含む）。 */
  readonly drafts: ReadonlyArray<PostDraft>;
  readonly live: ReadonlyArray<LivePost>;
  readonly pending: ReadonlyArray<PostDraft>;
  readonly recommendations: ReadonlyArray<{
    readonly cut: ShortRecommendation;
    readonly number: number;
  }>;
  readonly shorts: ReadonlyArray<ShortCandidate>;
  readonly thumbnailKey: string | undefined;
}

const readState = (videoId: string) =>
  Effect.gen(function* () {
    yield* (yield* ChannelSettings).requireExplainer;
    yield* requireLatestPlan(videoId);
    yield* requireProduceApproval(videoId);
    const shorts = yield* readShortFacts(videoId);
    const drafts = yield* readPostDrafts(videoId, shorts);
    const live = yield* readLivePosts(videoId);
    const thumbnails = yield* readThumbnailFacts(videoId);
    return {
      cutFacts: yield* readCutFacts(videoId),
      drafts,
      live,
      pending: drafts.filter((draft) => !live.some((post) => isPostOf(post, draft))),
      recommendations: yield* readShortRecommendations(videoId),
      shorts,
      thumbnailKey: thumbnails.selection?.key,
    } satisfies PublishState;
  });

const livePostsOfShort = (state: PublishState, number: number) =>
  state.live.filter((post) => post.short === number);

/** 選択を問う候補: 生きている投稿が 1 件も無い候補。ある候補は、その投稿のカットに固定する。 */
const promptedShorts = (state: PublishState): ReadonlyArray<PromptedShort> =>
  state.shorts
    .filter((short) => livePostsOfShort(state, short.number).length === 0)
    .map((short) => ({
      hook: short.hook,
      number: short.number,
      recommended:
        state.recommendations.find((recommendation) => recommendation.number === short.number)
          ?.cut ?? "none",
    }));

const snapshotOf = (state: PublishState) =>
  JSON.stringify({
    pending: state.pending.map((draft) => [
      draft.short ?? null,
      draft.platform,
      draft.accountId,
      draft.createdAt,
    ]),
    prompted: promptedShorts(state).map((short) => short.number),
    cuts: state.cutFacts.map((fact) => [
      fact.cut,
      fact.lastExport?.createdAt ?? null,
      fact.lastPreview?.createdAt ?? null,
    ]),
    thumbnail: state.thumbnailKey ?? null,
  });

const cutViews = (videoId: string, state: PublishState): ReadonlyArray<CutView> =>
  [longCut, ...state.shorts.flatMap((short) => shortCutNames(short.number))].map((cut) => {
    const facts = state.cutFacts.find((fact) => fact.cut === cut);
    return {
      cut,
      ...(facts?.lastExport === undefined ? {} : { exportKey: facts.lastExport.key }),
      ...(facts?.lastPreview === undefined
        ? {}
        : {
            previewDirectory: `videos/${videoId}/cuts/${cut}/previews/${facts.lastPreview.compositionHash}`,
          }),
    };
  });

const readAccountView = (platform: Platform, now: number) =>
  Effect.gen(function* () {
    const found = yield* (yield* DeclaredAccounts).require(platform).pipe(Effect.result);
    if (Result.isFailure(found)) {
      // 宣言が無いのは拒否の条件であって、表示を止める失敗ではない。それ以外の失敗は通す。
      const undeclared: AccountView =
        found.failure._tag === "AccountNotDeclared"
          ? { notDeclared: found.failure, platform, state: "unauthenticated" }
          : yield* found.failure;
      return undeclared;
    }
    const account = found.success;
    const credential = Option.getOrUndefined(
      yield* (yield* CredentialStore).read(account.channel, platform),
    );
    const view: AccountView = {
      account,
      ...(credential === undefined ? {} : { credential }),
      platform,
      state: deriveAuthState(credential, account.id, now),
    };
    return view;
  });

const accountViews = (platformsToShow: ReadonlyArray<Platform>) =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    return yield* Effect.forEach(platformsToShow, (platform) => readAccountView(platform, now));
  });

const platformsOf = (drafts: ReadonlyArray<PostDraft>) =>
  platforms.filter((platform) => drafts.some((draft) => draft.platform === platform));

/** 公開ゲートの対話に見せる事実を読む。何も書かない。 */
export const preparePublish = (videoId: string) =>
  Effect.gen(function* () {
    const state = yield* readState(videoId);
    return {
      accounts: yield* accountViews(platformsOf(state.pending)),
      cuts: cutViews(videoId, state),
      drafts: state.pending,
      prompted: promptedShorts(state),
      snapshot: snapshotOf(state),
      ...(state.thumbnailKey === undefined ? {} : { thumbnailKey: state.thumbnailKey }),
      videoId,
    } satisfies PublishPreparation;
  });

interface PlannedPost {
  readonly cut: string;
  readonly draft: PostDraft;
}

/** ショートの候補ごとのカット。生きている投稿が指すカット、無ければ選んだカット（どちらも出さないなら undefined）。 */
const resolveShortCuts = (state: PublishState, choices: ShortChoices) =>
  Effect.forEach(state.shorts, (short) => {
    const livePost = livePostsOfShort(state, short.number).at(-1);
    if (livePost !== undefined) {
      return Effect.succeed([short.number, livePost.cut] as const);
    }
    const choice = choices.get(short.number);
    return choice === undefined
      ? Effect.die(`no choice was made for the short ${short.number}`)
      : Effect.succeed([short.number, cutOf(short.number, choice)] as const);
  }).pipe(Effect.map((entries) => new Map(entries)));

type ShortCuts = ReadonlyMap<number, string | undefined>;

/** 作る投稿。長尺の投稿案は長尺のカット、ショートの投稿案はその候補のカットを指す。 */
const planPosts = (state: PublishState, shortCuts: ShortCuts): ReadonlyArray<PlannedPost> =>
  state.pending.flatMap((draft) => {
    const cut = draft.short === undefined ? longCut : shortCuts.get(draft.short);
    return cut === undefined ? [] : [{ cut, draft }];
  });

/** 採用したカット: 長尺と、候補ごとのカット。 */
const adoptedCuts = (shortCuts: ShortCuts) => [
  longCut,
  ...[...shortCuts.values()].flatMap((cut) => (cut === undefined ? [] : [cut])),
];

// 拒否の検査。決定 10 に並んだ順 (a) アカウント (b) 予定時刻 (c) 採用したカットの投稿案 (d) 形式 で、最初に当たった 1 件で止める。
const requireAuthenticated = (view: AccountView) =>
  Effect.gen(function* () {
    if ("notDeclared" in view) {
      return yield* view.notDeclared;
    }
    const { account, credential } = view;
    if (credential === undefined) {
      return yield* new AccountNotAuthenticated({
        channel: account.channel,
        platform: view.platform,
      });
    }
    if (credential.accountId !== account.id) {
      return yield* new AccountIdMismatch({
        channel: account.channel,
        declaredId: account.id,
        platform: view.platform,
        tokenId: credential.accountId,
      });
    }
  });

/** 作る投稿のアカウントは、その SNS の現在の宣言のアカウントでなければならない。 */
const requireDeclaredAccount = (view: AccountView, planned: ReadonlyArray<PlannedPost>) =>
  Effect.gen(function* () {
    if ("notDeclared" in view) {
      return yield* view.notDeclared;
    }
    const stray = planned.find(
      ({ draft }) => draft.platform === view.platform && draft.accountId !== view.account.id,
    );
    if (stray !== undefined) {
      return yield* new DraftAccountNotDeclared({
        declaredId: view.account.id,
        draftAccountId: stray.draft.accountId,
        platform: view.platform,
      });
    }
  });

const requireAccounts = (planned: ReadonlyArray<PlannedPost>) =>
  accountViews(platformsOf(planned.map(({ draft }) => draft))).pipe(
    Effect.flatMap((views) =>
      Effect.forEach(
        views,
        (view) =>
          requireDeclaredAccount(view, planned).pipe(
            Effect.andThen(() => requireAuthenticated(view)),
          ),
        { discard: true },
      ),
    ),
  );

/** 表示した投稿案（生きている投稿を持たないもの）の予定時刻を検査する。作る・作らないを問わない。 */
const requireNotPast = (pending: ReadonlyArray<PostDraft>, now: number) => {
  const nowIso = new Date(now).toISOString();
  const past = pending.find((draft) => draft.scheduledAt < nowIso);
  return past === undefined
    ? Effect.void
    : Effect.fail(
        new ScheduledInPast({
          accountId: past.accountId,
          platform: past.platform,
          scheduledAt: past.scheduledAt,
          ...(past.short === undefined ? {} : { short: past.short }),
        }),
      );
};

const requireDraftsOfAdoptedCuts = (state: PublishState, shortCuts: ShortCuts) => {
  const hasDraft = (cut: string) =>
    state.drafts.some(
      (draft) => (draft.short === undefined ? longCut : shortCuts.get(draft.short)) === cut,
    );
  const missing = adoptedCuts(shortCuts).find((cut) => !hasDraft(cut));
  return missing === undefined
    ? Effect.void
    : Effect.fail(new AdoptedCutHasNoDraft({ cut: missing }));
};

const requireWritable = (
  state: PublishState,
  planned: ReadonlyArray<PlannedPost>,
  shortCuts: ShortCuts,
) =>
  Effect.gen(function* () {
    yield* requireAccounts(planned);
    yield* requireNotPast(state.pending, yield* Clock.currentTimeMillis);
    yield* requireDraftsOfAdoptedCuts(state, shortCuts);
    yield* Effect.forEach(state.pending, (draft) => checkPostText(draft.post), { discard: true });
  });

const selectionTimes = (videoId: string) =>
  latestSelectionAt(videoId).pipe(Effect.map(Option.toArray));

const lastExportTimes = (state: PublishState, cuts: ReadonlyArray<string>) =>
  cuts.flatMap((cut) => {
    const createdAt = state.cutFacts.find((fact) => fact.cut === cut)?.lastExport?.createdAt;
    return createdAt === undefined ? [] : [createdAt];
  });

/**
 * 公開ゲートの承認と投稿を、1 つのトランザクションで書く。
 * 表示した内容が変わっていたら書かない。承認は、作る投稿のカットの最後の書き出しと最後のサムネイルの選択のどれよりも後に積む。
 */
export const approvePublish = (videoId: string, choices: ShortChoices, shown: PublishPreparation) =>
  inTransaction(
    Effect.gen(function* () {
      const state = yield* readState(videoId);
      if (snapshotOf(state) !== shown.snapshot) {
        return yield* new PublishFactsChanged({ videoId });
      }
      const shortCuts = yield* resolveShortCuts(state, choices);
      const planned = planPosts(state, shortCuts);
      if (planned.length === 0) {
        return yield* new NoPostToCreate({ videoId });
      }
      yield* requireWritable(state, planned, shortCuts);
      const approvedAt = yield* appendExplainerApproval(videoId, "publish", [
        ...lastExportTimes(state, adoptedCuts(shortCuts)),
        ...(yield* selectionTimes(videoId)),
      ]);
      yield* appendPosts(videoId, new Date(approvedAt).toISOString(), planned);
      return { posts: planned.length, videoId };
    }),
  );
