import { Effect, type FileSystem, type Path } from "effect";
import { Toolkit } from "effect/ai";
import type { HttpClient } from "effect/http";
import type { ChildProcessSpawner } from "effect/process";
import type { SqlClient } from "effect/sql";

import type { DeclaredAccounts } from "./auth/declared-accounts.ts";
import type { StaticSecrets } from "./auth/secrets.ts";

import type { BgmPool } from "./channel/bgm-pool.ts";
import type { ChannelSettings } from "./channel/channel-settings.ts";
import type { CollectionIds } from "./collections/collection-ids.ts";
import type { CollectionDirectories } from "./collections/directories.ts";
import type { Chrome } from "./lib/chrome.ts";
import type { ThumbnailFiles } from "./thumbnails/thumbnail-files.ts";
import { CollectionStatusTool, collectionStatus } from "./tools/collection.status.ts";
import { PlanCheckTitleTool, planCheckTitle } from "./tools/plan.checkTitle.ts";
import {
  ExplainerAssembleCompositionTool,
  explainerAssembleComposition,
} from "./tools/explainer.assembleComposition.ts";
import {
  ExplainerFetchTopicCandidatesTool,
  explainerFetchTopicCandidates,
} from "./tools/explainer.fetchTopicCandidates.ts";
import {
  ExplainerMixAudioTrackTool,
  explainerMixAudioTrack,
} from "./tools/explainer.mixAudioTrack.ts";
import { ExplainerPreviewCutTool, explainerPreviewCut } from "./tools/explainer.previewCut.ts";
import { ExplainerRenderCutTool, explainerRenderCut } from "./tools/explainer.renderCut.ts";
import {
  ExplainerSynthesizeNarrationTool,
  explainerSynthesizeNarration,
} from "./tools/explainer.synthesizeNarration.ts";
import {
  ExplainerWriteDiagramTool,
  explainerWriteDiagram,
} from "./tools/explainer.writeDiagram.ts";
import {
  ExplainerWithdrawShortTool,
  explainerWithdrawShort,
} from "./tools/explainer.withdrawShort.ts";
import { ExplainerWritePlanTool, explainerWritePlan } from "./tools/explainer.writePlan.ts";
import { ExplainerWriteScriptTool, explainerWriteScript } from "./tools/explainer.writeScript.ts";
import { ExplainerWriteShortTool, explainerWriteShort } from "./tools/explainer.writeShort.ts";
import { PlanInitTool, planInit } from "./tools/plan.init.ts";
import {
  VideoExcludeThumbnailTool,
  videoExcludeThumbnail,
} from "./tools/video.excludeThumbnail.ts";
import {
  VideoGenerateThumbnailsTool,
  videoGenerateThumbnails,
} from "./tools/video.generateThumbnails.ts";
import { VideoStatusTool, videoStatus } from "./tools/video.status.ts";
import { VideoWritePostDraftTool, videoWritePostDraft } from "./tools/video.writePostDraft.ts";
import type { VideoFiles } from "./videos/video-files.ts";
import type { VideoIds } from "./videos/video-ids.ts";

/**
 * MCP の initialize で client に返す道案内。512 文字以内に、codec の名前とどの区間で読むかだけを書く。
 * 手順そのものは codec の領分で、ここには書かない（ADR-0010 決定 6）。
 */
export const nyaucastInstructions =
  "Before planning or producing an explainer video, read the knowledge codec explainer-lifecycle " +
  "(skills/explainer-lifecycle/SKILL.md in the nyaucast package, linked from .agents/skills). " +
  "Read it for the plan section (topic, plan, thumbnails, before the plan gate) and the produce " +
  "section (script, shorts, diagram, narration, render, preview).";

// registry は置かない。tool 一覧は、ここで import した tool を並べるだけ。
export const NyaucastToolkit = Toolkit.make(
  PlanInitTool,
  PlanCheckTitleTool,
  CollectionStatusTool,
  ExplainerFetchTopicCandidatesTool,
  ExplainerWritePlanTool,
  ExplainerWriteScriptTool,
  ExplainerWriteShortTool,
  ExplainerWithdrawShortTool,
  ExplainerWriteDiagramTool,
  ExplainerSynthesizeNarrationTool,
  ExplainerAssembleCompositionTool,
  ExplainerMixAudioTrackTool,
  ExplainerRenderCutTool,
  ExplainerPreviewCutTool,
  VideoStatusTool,
  VideoWritePostDraftTool,
  VideoGenerateThumbnailsTool,
  VideoExcludeThumbnailTool,
);

// handler の Layer。service の Layer は組み立てず、必要な service を要求するだけにする（合成は entry point）。
export const NyaucastToolHandlers = NyaucastToolkit.toLayer(
  Effect.gen(function* () {
    const context = yield* Effect.context<
      | BgmPool
      | ChannelSettings
      | Chrome
      | ChildProcessSpawner.ChildProcessSpawner
      | CollectionDirectories
      | CollectionIds
      | DeclaredAccounts
      | FileSystem.FileSystem
      | HttpClient.HttpClient
      | Path.Path
      | SqlClient.SqlClient
      | StaticSecrets
      | ThumbnailFiles
      | VideoFiles
      | VideoIds
    >();
    return NyaucastToolkit.of({
      collection_status: (input) => collectionStatus(input).pipe(Effect.provideContext(context)),
      explainer_assemble_composition: (input) =>
        explainerAssembleComposition(input).pipe(Effect.provideContext(context)),
      explainer_fetch_topic_candidates: (input) =>
        explainerFetchTopicCandidates(input).pipe(Effect.provideContext(context)),
      explainer_mix_audio_track: (input) =>
        explainerMixAudioTrack(input).pipe(Effect.provideContext(context)),
      explainer_preview_cut: (input) =>
        explainerPreviewCut(input).pipe(Effect.provideContext(context)),
      explainer_render_cut: (input) =>
        explainerRenderCut(input).pipe(Effect.provideContext(context)),
      explainer_synthesize_narration: (input) =>
        explainerSynthesizeNarration(input).pipe(Effect.provideContext(context)),
      explainer_withdraw_short: (input) =>
        explainerWithdrawShort(input).pipe(Effect.provideContext(context)),
      explainer_write_diagram: (input) =>
        explainerWriteDiagram(input).pipe(Effect.provideContext(context)),
      explainer_write_plan: (input) =>
        explainerWritePlan(input).pipe(Effect.provideContext(context)),
      explainer_write_script: (input) =>
        explainerWriteScript(input).pipe(Effect.provideContext(context)),
      explainer_write_short: (input) =>
        explainerWriteShort(input).pipe(Effect.provideContext(context)),
      plan_check_title: (input) => planCheckTitle(input).pipe(Effect.provideContext(context)),
      plan_init: (input) => planInit(input).pipe(Effect.provideContext(context)),
      video_exclude_thumbnail: (input) =>
        videoExcludeThumbnail(input).pipe(Effect.provideContext(context)),
      video_generate_thumbnails: (input) =>
        videoGenerateThumbnails(input).pipe(Effect.provideContext(context)),
      video_status: (input) => videoStatus(input).pipe(Effect.provideContext(context)),
      video_write_post_draft: (input) =>
        videoWritePostDraft(input).pipe(Effect.provideContext(context)),
    });
  }),
);
