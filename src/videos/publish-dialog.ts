import { Console, Effect } from "effect";
import { Prompt } from "effect/cli";

import { ChannelSettings } from "../channel/channel-settings.ts";
import { shortCutNames } from "../db/explainer-cuts.ts";
import type { PostDraft } from "../db/explainer-post-drafts.ts";
import {
  type AccountView,
  type PromptedShort,
  type PublishPreparation,
  type ShortChoice,
  StdinNotTerminal,
  approvePublish,
  preparePublish,
} from "./publish-gate.ts";
import { StdinTerminal } from "./stdin-terminal.ts";

const draftLine = (draft: PostDraft) => {
  const text =
    draft.post.platform === "youtube"
      ? `${draft.post.title} / ${draft.post.description}`
      : draft.post.text;
  const target = draft.short === undefined ? "long" : `short-${draft.short}`;
  return `  ${target} ${draft.platform} ${draft.accountId} ${draft.scheduledAt} ${text}`;
};

const cutLine = (cut: PublishPreparation["cuts"][number]) =>
  `  ${cut.cut} 書き出し: ${cut.exportKey ?? "なし"} / プレビュー: ${cut.previewDirectory ?? "なし"}`;

// auth status と同じ並び（チャンネル・SNS・handle・不変の ID・認証の状態）。
const accountLine = (view: AccountView) =>
  "account" in view
    ? `  ${[view.account.channel, view.platform, view.account.handle, view.account.id, view.state].join(" ")}`
    : `  ${view.platform} 宣言なし`;

// 表示するのは事実だけ。ファイルは開かない。
const showPreparation = (shown: PublishPreparation) =>
  Effect.forEach(
    [
      `公開ゲート: video ${shown.videoId}`,
      "カット:",
      ...shown.cuts.map(cutLine),
      `サムネイル: ${shown.thumbnailKey ?? "未選択"}`,
      "投稿案:",
      ...shown.drafts.map(draftLine),
      "アカウント:",
      ...shown.accounts.map(accountLine),
    ],
    (line) => Console.log(line),
    { discard: true },
  );

// 選択肢は 切り抜き / 専用 / どちらも出さない の順。推奨が既定値。
const chooseShort = (short: PromptedShort) => {
  const [clip, dedicated] = shortCutNames(short.number);
  const choices: ReadonlyArray<{ readonly title: string; readonly value: ShortChoice }> = [
    { title: `切り抜き (${clip})`, value: "clip" },
    { title: `専用 (${dedicated})`, value: "dedicated" },
    { title: "どちらも出さない", value: "none" },
  ];
  return Prompt.run(
    Prompt.Select({
      choices: choices.map((choice) => ({
        ...choice,
        selected: choice.value === short.recommended,
      })),
      message: `ショート ${short.number}（${short.hook}）`,
    }),
  );
};

const confirmApproval = Prompt.run(
  Prompt.Select({
    choices: [
      { title: "承認する", value: true },
      { title: "やめずに終える", value: false },
    ],
    message: "公開ゲートを承認しますか",
  }),
);

/**
 * 解説動画の `video publish`。TTY のときだけ動き、事実を見せ、ショートの候補ごとの選択と承認を問う。
 * やめずに終えたときは何も書かない。
 */
export const publishExplainerVideo = (videoId: string) =>
  Effect.gen(function* () {
    if (!(yield* StdinTerminal).isTerminal) {
      return yield* new StdinNotTerminal({ videoId });
    }
    yield* (yield* ChannelSettings).requireExplainer;
    const shown = yield* preparePublish(videoId);
    yield* showPreparation(shown);
    const choices = new Map<number, ShortChoice>();
    for (const short of shown.prompted) {
      choices.set(short.number, yield* chooseShort(short));
    }
    if (!(yield* confirmApproval)) {
      return yield* Console.log(
        `承認せずに終えました: video ${videoId} / gate=publish（記録は追加していません）`,
      );
    }
    const approved = yield* approvePublish(videoId, choices, shown);
    yield* Console.log(
      `承認を記録しました: video ${approved.videoId} / gate=publish / 投稿 ${approved.posts} 件`,
    );
  });
