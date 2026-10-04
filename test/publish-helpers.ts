import { basename } from "node:path";

import { NodeServices } from "@effect/platform-node";
import { Effect, Layer, Option, Queue, Terminal } from "effect";

import { CredentialStore } from "../src/auth/credential-store.ts";
import { appendCutExport, appendCutPreview } from "../src/db/explainer-cuts.ts";
import { StdinTerminal } from "../src/videos/stdin-terminal.ts";
import { scriptScenes } from "./composition-helpers.ts";
import { setClock } from "./helpers.ts";
import { instagramPost, writePostDraft, xPost, youtubePost } from "./post-draft-helpers.ts";
import { clipCut, dedicatedCut, shortCutExportKey, writeShort } from "./short-helpers.ts";
import { approveProduce, recordPlan, scriptInput } from "./narration-helpers.ts";
import { insertCandidate, insertSelection } from "./thumbnail-facts.ts";
import { callTool } from "./tool-helpers.ts";

// ---- 対話（stdin と Terminal）----

/** stdin が TTY かどうかを、境界で解決した値として差し込む。 */
export const stdinTerminal = (isTerminal: boolean) =>
  Layer.succeed(StdinTerminal, StdinTerminal.of({ isTerminal }));

/** ショートの候補ごとの選択肢。画面に並ぶ順（切り抜き / 専用 / どちらも出さない）。 */
type ShortChoice = "clip" | "dedicated" | "none";
const shortChoices: readonly ShortChoice[] = ["clip", "dedicated", "none"];

/**
 * 既定値のカーソルから choice まで動かして Enter を押すキー。
 * Select のカーソルは端で循環するので、下へ動かす回数だけで任意の選択肢に着く。
 */
export const pick = (choice: ShortChoice, defaultChoice: ShortChoice): readonly string[] => {
  const steps =
    (shortChoices.indexOf(choice) - shortChoices.indexOf(defaultChoice) + shortChoices.length) %
    shortChoices.length;
  return [...Array.from({ length: steps }, () => "down"), "enter"];
};

/** 最後の選択（承認する / やめずに終える）。先頭の「承認する」を Enter、「やめずに終える」はその 1 つ下。 */
export const approve: readonly string[] = ["enter"];
export const finishWithoutApproving: readonly string[] = ["down", "enter"];

const key = (name: string) => ({ ctrl: false, meta: false, name, shift: false });

/**
 * 運営者の代わりに、プロンプトごとのキー入力を台本どおりに流し込む Terminal。
 * プロンプトは台本の先頭から順に 1 つずつ答える。台本より多く求められたら defect にする。
 * NodeServices も Terminal を持つので、これは内側で先に渡す。
 */
export const scriptedOperator = (
  script: readonly (readonly string[])[],
  options: { readonly beforePrompt?: ((index: number) => Effect.Effect<void>) | undefined } = {},
) => {
  const remaining = [...script];
  let asked = 0;
  const layer = Layer.succeed(
    Terminal.Terminal,
    Terminal.make({
      columns: Effect.succeed(80),
      display: () => Effect.void,
      readInput: Effect.gen(function* () {
        const keys = remaining.shift();
        if (keys === undefined) {
          return yield* Effect.die("台本にない選択を求められた");
        }
        // 運営者が画面を見て考えている間に、別の誰か（agent）が事実を書く状況を作る。
        yield* options.beforePrompt?.(asked) ?? Effect.void;
        asked += 1;
        const queue = yield* Queue.unbounded<Terminal.UserInput, never>();
        yield* Queue.offerAll(
          queue,
          keys.map((name) => ({ input: Option.none(), key: key(name) })),
        );
        return queue;
      }),
      readLine: Effect.die("unused"),
      rows: Effect.succeed(24),
    }),
  );
  return { layer, unanswered: () => remaining.length };
};

// ---- 前提データ ----

const thumbnailSelectedAt = "2026-10-03T13:00:00.000Z";
export const publishTime = "2026-10-04T15:00:00.000Z";

const scriptAndShortsTime = "2026-10-03T13:30:00.000Z";
const exportTime = "2026-10-03T14:00:00.000Z";

/** 企画（正午）・サムネイルの選択・企画ゲートの承認・長尺の台本までそろえた動画 V1。 */
export const prepareVideo = Effect.gen(function* () {
  yield* recordPlan();
  const key = yield* insertCandidate({ number: 1, round: 1, videoId: "V1" });
  yield* insertSelection({ number: 1, round: 1, selectedAt: thumbnailSelectedAt, videoId: "V1" });
  yield* approveProduce();
  yield* setClock(scriptAndShortsTime);
  yield* callTool("video_write_script", scriptInput(scriptScenes));
  return key;
});

/** ショートの候補を書き、agent の推奨を記録する。 */
export const addShort = (number: number, recommended: ShortChoice) =>
  Effect.gen(function* () {
    yield* writeShort({ number });
    yield* recommendShort(number, recommended);
  });

export const recommendShort = (number: number, cut: ShortChoice) =>
  callTool("video_recommend_short_cut", { cut, number, videoId: "V1" });

/** 長尺の 3 つの SNS と、ショートの候補の投稿案。 */
const writeLongDrafts = Effect.gen(function* () {
  yield* writePostDraft({ post: youtubePost("長尺の題名", "長尺の説明") });
  yield* writePostDraft({ post: instagramPost("長尺のインスタ") });
  yield* writePostDraft({ post: xPost("長尺のエックス") });
});

export const writeShortDraft = (
  short: number,
  post: Parameters<typeof writePostDraft>[0]["post"],
  scheduledAt?: string,
) => writePostDraft({ post, short, ...(scheduledAt === undefined ? {} : { scheduledAt }) });

/** カットの書き出しとプレビュー（同じ composition の鍵）を事実として積む。ファイルは作らない。 */
export const exportCut = (cut: string) =>
  Effect.gen(function* () {
    const compositionHash = `hash-${cut}`;
    yield* appendCutExport({
      compositionHash,
      cut,
      key: shortCutExportKey(cut),
      renderHash: `render-${cut}`,
      videoId: "V1",
    });
    yield* appendCutPreview({ compositionHash, cut, videoId: "V1" });
  });

export const previewDirectoryOf = (cut: string) => `videos/V1/cuts/${cut}/previews/hash-${cut}`;

/** 長尺と、指定した候補の 2 カットを書き出す。 */
const exportCuts = (shorts: readonly number[]) =>
  Effect.gen(function* () {
    yield* setClock(exportTime);
    yield* exportCut("long");
    for (const number of shorts) {
      yield* exportCut(clipCut(number));
      yield* exportCut(dedicatedCut(number));
    }
  });

interface StandardShort {
  readonly draft?: Parameters<typeof writePostDraft>[0]["post"];
  readonly number: number;
  readonly recommended: ShortChoice;
}

/** 標準のショートの候補: 1（推奨は切り抜き、X の投稿案）と 2（推奨は専用、Instagram の投稿案）。 */
export const standardShorts: readonly StandardShort[] = [
  { draft: xPost("候補 1 のエックス"), number: 1, recommended: "clip" },
  { draft: instagramPost("候補 2 のインスタ"), number: 2, recommended: "dedicated" },
];

/**
 * 公開できる動画 V1: 長尺に 3 SNS の投稿案、指定したショートの候補（推奨と投稿案つき）、全カットの書き出しとプレビュー。
 * 終わったときの時計は公開の時刻。
 */
export const preparePublishableVideo = (shorts: readonly StandardShort[]) =>
  Effect.gen(function* () {
    yield* prepareVideo;
    for (const short of shorts) {
      yield* addShort(short.number, short.recommended);
    }
    yield* setClock("2026-10-03T13:40:00.000Z");
    yield* writeLongDrafts;
    for (const short of shorts) {
      if (short.draft !== undefined) {
        yield* writeShortDraft(short.number, short.draft);
      }
    }
    yield* exportCuts(shorts.map((short) => short.number));
    yield* setClock(publishTime);
  });

/** 標準の動画 V1 で公開すると作られる投稿（推奨どおり）。[カット, SNS, アカウントの ID]。 */
export const standardPosts: (readonly [string, string, string])[] = [
  ["long", "instagram", "instagram-id"],
  ["long", "x", "x-id"],
  ["long", "youtube", "youtube-id"],
  ["short-1-clip", "x", "x-id"],
  ["short-2-dedicated", "instagram", "instagram-id"],
];

// ---- 認証 ----

/** チャンネル名はチャンネルルートのディレクトリ名。 */
export const channelNameOf = (channelRoot: string) => basename(channelRoot);

const farFuture = Date.parse("2030-01-01T00:00:00.000Z");

/** 宣言した ID と同じトークンを保存する（既定の `<platform>-id`）。 */
export const storeToken = (
  channelRoot: string,
  platform: "instagram" | "x" | "youtube",
  options: { readonly accountId?: string; readonly expiresAt?: number } = {},
) =>
  CredentialStore.use((store) =>
    store.save(channelNameOf(channelRoot), platform, {
      accountId: options.accountId ?? `${platform}-id`,
      expiresAt: options.expiresAt ?? farFuture,
      token: {},
    }),
  );

export const storeAllTokens = (channelRoot: string) =>
  Effect.gen(function* () {
    for (const platform of ["youtube", "instagram", "x"] as const) {
      yield* storeToken(channelRoot, platform);
    }
  });

export const credentialStoreLayer = (credentialRoot: string) =>
  CredentialStore.layer({ credentialRoot }).pipe(Layer.provide(NodeServices.layer));

/** `nyaucast auth status` が 1 アカウントについて出す行と同じ形。 */
export const authStatusLine = (
  channelRoot: string,
  platform: "instagram" | "x" | "youtube",
  state: "expiring" | "refresh_failed" | "unauthenticated" | "valid",
) =>
  [channelNameOf(channelRoot), platform, `@nyaucast-${platform}`, `${platform}-id`, state].join(
    " ",
  );
