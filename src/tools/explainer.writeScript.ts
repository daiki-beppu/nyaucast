import { Effect, Schema } from "effect";
import { Tool } from "effect/ai";

import {
  ChannelConfigNotFound,
  ChannelSettings,
  InvalidChannelConfig,
  NotExplainerChannel,
} from "../channel/channel-settings.ts";
import { VideoNotFound, requireLatestPlan } from "../db/explainer-videos.ts";
import {
  InvalidReadingMarkup,
  ParagraphTooLong,
  Scenes,
  maxParagraphReadingCharacters,
  parseScript,
} from "../scripts/script.ts";
import { writeScriptFile } from "../scripts/script-files.ts";
import { ProduceGateNotApproved, requireProduceApproval } from "../videos/produce-gate.ts";

export const ExplainerWriteScriptTool = Tool.make("explainer_write_script", {
  description:
    "Write the script of an explainer video as JSON: scenes, each with paragraphs, each paragraph with its text. " +
    "A text may carry reading marks {notation|reading} (half-width braces and bar): the notation is shown in subtitles and the reading is what the voice speaks. " +
    `The script is validated before anything is written, and a paragraph whose reading is over ${maxParagraphReadingCharacters} characters is rejected. ` +
    "Writing again replaces the script of that video. The script is the agent's input and is never deleted. " +
    "Requires the produce gate to be approved. " +
    "Fails with VideoNotFound for an unknown video, with ProduceGateNotApproved before the produce gate is approved, " +
    "with InvalidReadingMarkup (scene and paragraph, numbered from 1) for a mark that is not closed, nested, has two readings or an empty part, " +
    "and with ParagraphTooLong (scene and paragraph, numbered from 1) for a paragraph over the limit; nothing is written in these cases. " +
    "Returns the key of the written file and the number of scenes and paragraphs.",
  failure: Schema.Union([
    ChannelConfigNotFound,
    InvalidChannelConfig,
    NotExplainerChannel,
    VideoNotFound,
    ProduceGateNotApproved,
    InvalidReadingMarkup,
    ParagraphTooLong,
  ]),
  parameters: Schema.Struct({
    scenes: Scenes.annotate({ description: "Scenes in order, each with its paragraphs in order." }),
    videoId: Schema.String.annotate({ description: "Video ID returned by explainer_write_plan." }),
  }),
  success: Schema.Struct({
    key: Schema.String,
    paragraphs: Schema.Finite,
    scenes: Schema.Finite,
    videoId: Schema.String,
  }),
}).annotate(Tool.Strict, true);

export const explainerWriteScript = Effect.fn("explainer.writeScript")(function* ({
  scenes,
  videoId,
}: {
  readonly scenes: typeof Scenes.Type;
  readonly videoId: string;
}) {
  yield* (yield* ChannelSettings).requireExplainer;
  yield* requireLatestPlan(videoId);
  yield* requireProduceApproval(videoId);
  const paragraphs = yield* parseScript(scenes);
  const key = yield* writeScriptFile(videoId, scenes);
  return { key, paragraphs: paragraphs.length, scenes: scenes.length, videoId };
});
