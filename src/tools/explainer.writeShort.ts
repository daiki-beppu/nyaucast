import { Effect, Option, Schema } from "effect";
import { Tool } from "effect/ai";

import {
  ChannelConfigNotFound,
  ChannelSettings,
  InvalidChannelConfig,
  NotExplainerChannel,
} from "../channel/channel-settings.ts";
import {
  appendShortVersion,
  isWithdrawn,
  lastShortVersion,
  shortFactLock,
  type ShortVersion,
} from "../db/explainer-shorts.ts";
import { VideoNotFound, requireLatestPlan } from "../db/explainer-videos.ts";
import {
  InvalidReadingMarkup,
  ParagraphTooLong,
  Scenes,
  maxParagraphReadingCharacters,
  parseScript,
} from "../scripts/script.ts";
import {
  InvalidScriptFile,
  ScriptNotFound,
  readScript,
  scriptFileKey,
  scriptFileMatches,
  scriptSha256,
  writeScriptFile,
} from "../scripts/script-files.ts";
import {
  InvalidShortRange,
  Ordinal,
  ParagraphRange,
  maxShortSeconds,
  paragraphsInRange,
  sameRange,
} from "../shorts/short-candidate.ts";
import { ProduceGateNotApproved, requireProduceApproval } from "../videos/produce-gate.ts";

export const ExplainerWriteShortTool = Tool.make("explainer_write_short", {
  description:
    "Write a short candidate of an explainer video: the paragraph range of the long script to clip, the hook (shown on screen, never read aloud) and the dedicated short's own script. " +
    "The range is given by positions {scene, paragraph}, numbered from 1, both ends included, and may cross scenes. " +
    "The dedicated script is validated like the long script (reading marks, paragraph length) and written to videos/<id>/shorts/<number>/script.json, " +
    "and one version of the candidate (number, range, hook, script key, time) is recorded. " +
    "Writing a candidate again with a change records one more version and the last version is the candidate; writing exactly the same content again records nothing. " +
    "A short is at most " +
    `${maxShortSeconds} seconds; the length is checked when the cut is assembled and mixed, once its seconds are known. ` +
    `A paragraph of the dedicated script is limited to ${maxParagraphReadingCharacters} reading characters. ` +
    "Requires the produce gate to be approved. " +
    "Fails with VideoNotFound for an unknown video, with ProduceGateNotApproved before the produce gate is approved, " +
    "with ScriptNotFound or InvalidScriptFile for the saved long script, with InvalidReadingMarkup or ParagraphTooLong for a script that breaks the checks, " +
    "and with InvalidShortRange (videoId and number) when the range is reversed or names a paragraph the long script does not have; nothing is written in these cases. " +
    "Returns the key of the dedicated script, the number and whether a version was recorded now.",
  failure: Schema.Union([
    ChannelConfigNotFound,
    InvalidChannelConfig,
    NotExplainerChannel,
    VideoNotFound,
    ProduceGateNotApproved,
    ScriptNotFound,
    InvalidScriptFile,
    InvalidReadingMarkup,
    ParagraphTooLong,
    InvalidShortRange,
  ]),
  parameters: Schema.Struct({
    hook: Schema.NonEmptyString.annotate({
      description: "Text shown at the top of the clip short. It is not read aloud.",
    }),
    number: Ordinal.annotate({
      description: "Candidate number of the video, numbered from 1.",
    }),
    range: ParagraphRange.annotate({
      description: "Paragraphs of the long script to clip, both ends included.",
    }),
    scenes: Scenes.annotate({
      description: "The dedicated short's own script: scenes in order, each with its paragraphs.",
    }),
    videoId: Schema.String.annotate({ description: "Video ID returned by explainer_write_plan." }),
  }),
  success: Schema.Struct({
    key: Schema.String,
    number: Schema.Finite,
    recorded: Schema.Boolean,
    videoId: Schema.String,
  }),
}).annotate(Tool.Strict, true);

interface Written {
  readonly hook: string;
  readonly number: number;
  readonly range: ParagraphRange;
  readonly scenes: typeof Scenes.Type;
  readonly videoId: string;
}

const sameVersion = (written: Written, last: ShortVersion) =>
  last.hook === written.hook &&
  sameRange(last.range, written.range) &&
  last.scriptSha256 === scriptSha256(written.scenes);

// 最後の版が範囲・フック・台本の内容のすべてで入力と同じで、台本のファイルも同じバイト列で、取り下げられていないとき、書き直しは何も変えない。
const isUnchanged = (written: Written, last: Option.Option<ShortVersion>) =>
  Effect.gen(function* () {
    if (Option.isNone(last) || !sameVersion(written, last.value)) return false;
    const target = { short: written.number, videoId: written.videoId };
    return (
      (yield* scriptFileMatches(target, written.scenes)) &&
      !(yield* isWithdrawn(written.videoId, last.value))
    );
  });

const writeShort = Effect.fn("explainer.writeShort")(function* (written: Written) {
  const { number, videoId } = written;
  yield* (yield* ChannelSettings).requireExplainer;
  yield* requireLatestPlan(videoId);
  yield* requireProduceApproval(videoId);
  const longScript = yield* readScript({ videoId });
  yield* parseScript(written.scenes);
  if (paragraphsInRange(longScript, written.range) === undefined) {
    return yield* new InvalidShortRange({ number, videoId });
  }
  const last = yield* lastShortVersion(videoId, number);
  const target = { short: number, videoId };
  if (yield* isUnchanged(written, last)) {
    return { key: scriptFileKey(target), number, recorded: false, videoId };
  }
  const key = yield* writeScriptFile(target, written.scenes);
  yield* appendShortVersion({
    hook: written.hook,
    number,
    range: written.range,
    scriptKey: key,
    scriptSha256: scriptSha256(written.scenes),
    videoId,
  });
  return { key, number, recorded: true, videoId };
});

export const explainerWriteShort = (input: Written) =>
  shortFactLock.withPermits(1)(writeShort(input));
