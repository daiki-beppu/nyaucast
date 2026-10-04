import { Effect, Schema } from "effect";
import { Tool } from "effect/ai";

import {
  ChannelConfigNotFound,
  ChannelSettings,
  InvalidChannelConfig,
} from "../../channel/channel-settings.ts";
import { ShortCandidateNotFound } from "../../db/explainer-shorts.ts";
import { VideoNotFound, requireLatestPlan } from "../../db/explainer-videos.ts";
import { InvalidDiagrams, reviewDiagram } from "../../diagrams/diagram.ts";
import { writeDiagramFile } from "../../diagrams/diagram-files.ts";
import { splitPhrases } from "../../narration/phrases.ts";
import { InvalidReadingMarkup, ParagraphTooLong } from "../../scripts/script.ts";
import { InvalidScriptFile, ScriptNotFound, readScript } from "../../scripts/script-files.ts";
import { Ordinal } from "../../shorts/short-candidate.ts";
import { resolveShortTarget } from "../../videos/cuts.ts";
import { ProduceGateNotApproved, requireProduceApproval } from "../../videos/produce-gate.ts";

class SceneNotFound extends Schema.TaggedError<SceneNotFound>()("SceneNotFound", {
  scene: Schema.Finite,
  videoId: Schema.String,
}) {}

export const ExplainerVideoWriteDiagramTool = Tool.make("video_write_diagram", {
  description:
    "Write the diagram of one scene of an explainer video: an XML-well-formed fragment of HTML and SVG that declares when each element moves by a position in the script, never by seconds, and carries no script. " +
    "A position is P (paragraph P of the scene, same as P.1) or P.K (the K-th phrase of paragraph P), numbered from 1. " +
    "The vocabulary is data-beat (the element appears at a position), data-enter (fade, slide or pop; needs data-beat), data-from (left, right, top or bottom; only with data-enter slide) and data-dim (the element dims at a position, after its data-beat). " +
    "Only one element moves at a position. Subtitles are drawn by the assembler, never by the diagram. " +
    "The diagram is checked against the saved script and every violation is listed at once; nothing is written when there is one. " +
    "With short, the diagram belongs to the dedicated short of that candidate: it is checked against the dedicated script and written to videos/<id>/shorts/<short>/scenes/. " +
    "Writing a scene again replaces its diagram. The diagram is the agent's input and is never deleted. " +
    "Requires the produce gate to be approved. " +
    "Fails with VideoNotFound for an unknown video, with ProduceGateNotApproved before the produce gate is approved, " +
    "with ScriptNotFound or InvalidScriptFile for the saved script, with InvalidReadingMarkup or ParagraphTooLong when the saved script no longer passes the checks of video_write_script, " +
    "with SceneNotFound when the script has no such scene, with ShortCandidateNotFound when short names a candidate that was never written or is withdrawn, and with InvalidDiagrams (videoId and violations, each with scene and rule) for the violations of the diagram. " +
    "Returns the key of the written file.",
  failure: Schema.Union([
    ChannelConfigNotFound,
    InvalidChannelConfig,
    VideoNotFound,
    ProduceGateNotApproved,
    ScriptNotFound,
    InvalidScriptFile,
    InvalidReadingMarkup,
    ParagraphTooLong,
    SceneNotFound,
    ShortCandidateNotFound,
    InvalidDiagrams,
  ]),
  parameters: Schema.Struct({
    html: Schema.String.annotate({ description: "The diagram of the scene." }),
    scene: Schema.Finite.check(Schema.isInt(), Schema.isGreaterThan(0)).annotate({
      description: "Scene number, numbered from 1.",
    }),
    short: Schema.optionalKey(
      Ordinal.annotate({
        description:
          "Candidate number of a dedicated short, to write its diagram instead of the long cut's.",
      }),
    ),
    videoId: Schema.String.annotate({ description: "Video ID returned by video_write_plan." }),
  }),
  success: Schema.Struct({
    key: Schema.String,
    scene: Schema.Finite,
    videoId: Schema.String,
  }),
}).annotate(Tool.Strict, true);

export const explainerVideoWriteDiagram = Effect.fn("video.writeDiagram")(function* ({
  html,
  scene,
  short,
  videoId,
}: {
  readonly html: string;
  readonly scene: number;
  readonly short?: number;
  readonly videoId: string;
}) {
  yield* (yield* ChannelSettings).explainer;
  yield* requireLatestPlan(videoId);
  yield* requireProduceApproval(videoId);
  const target = yield* resolveShortTarget(videoId, short);
  const paragraphs = (yield* readScript(target)).filter((paragraph) => paragraph.scene === scene);
  if (paragraphs.length === 0) {
    return yield* new SceneNotFound({ scene, videoId });
  }
  const shape = paragraphs.map((paragraph) => splitPhrases(paragraph.text).length);
  const { violations } = reviewDiagram(html, scene, shape);
  if (violations.length > 0) {
    return yield* new InvalidDiagrams({ videoId, violations });
  }
  const key = yield* writeDiagramFile(target, scene, html);
  return { key, scene, videoId };
});
