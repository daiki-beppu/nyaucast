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
import {
  CollectionVideoCheckTitleTool,
  collectionVideoCheckTitle,
} from "./tools/collection/video.checkTitle.ts";
import {
  CollectionVideoStatusTool,
  collectionVideoStatus,
} from "./tools/collection/video.status.ts";
import {
  CollectionVideoWritePlanTool,
  collectionVideoWritePlan,
} from "./tools/collection/video.writePlan.ts";
import {
  ExplainerVideoAssembleCompositionTool,
  explainerVideoAssembleComposition,
} from "./tools/explainer/video.assembleComposition.ts";
import {
  ExplainerVideoExcludeThumbnailTool,
  explainerVideoExcludeThumbnail,
} from "./tools/explainer/video.excludeThumbnail.ts";
import {
  ExplainerVideoFetchTopicCandidatesTool,
  explainerVideoFetchTopicCandidates,
} from "./tools/explainer/video.fetchTopicCandidates.ts";
import {
  ExplainerVideoGenerateThumbnailsTool,
  explainerVideoGenerateThumbnails,
} from "./tools/explainer/video.generateThumbnails.ts";
import {
  ExplainerVideoMixAudioTrackTool,
  explainerVideoMixAudioTrack,
} from "./tools/explainer/video.mixAudioTrack.ts";
import {
  ExplainerVideoPreviewCutTool,
  explainerVideoPreviewCut,
} from "./tools/explainer/video.previewCut.ts";
import {
  ExplainerVideoRenderCutTool,
  explainerVideoRenderCut,
} from "./tools/explainer/video.renderCut.ts";
import { ExplainerVideoStatusTool, explainerVideoStatus } from "./tools/explainer/video.status.ts";
import {
  ExplainerVideoSynthesizeNarrationTool,
  explainerVideoSynthesizeNarration,
} from "./tools/explainer/video.synthesizeNarration.ts";
import {
  ExplainerVideoWithdrawShortTool,
  explainerVideoWithdrawShort,
} from "./tools/explainer/video.withdrawShort.ts";
import {
  ExplainerVideoWriteDiagramTool,
  explainerVideoWriteDiagram,
} from "./tools/explainer/video.writeDiagram.ts";
import {
  ExplainerVideoWritePlanTool,
  explainerVideoWritePlan,
} from "./tools/explainer/video.writePlan.ts";
import {
  ExplainerVideoWritePostDraftTool,
  explainerVideoWritePostDraft,
} from "./tools/explainer/video.writePostDraft.ts";
import {
  ExplainerVideoWriteScriptTool,
  explainerVideoWriteScript,
} from "./tools/explainer/video.writeScript.ts";
import {
  ExplainerVideoWriteShortTool,
  explainerVideoWriteShort,
} from "./tools/explainer/video.writeShort.ts";
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

// registry は置かない。tool 一覧は、チャンネルの種類ごとに、ここで import した tool を並べるだけ（どちらを公開するかは entry point が決める）。
export const ExplainerToolkit = Toolkit.make(
  ExplainerVideoFetchTopicCandidatesTool,
  ExplainerVideoWritePlanTool,
  ExplainerVideoWriteScriptTool,
  ExplainerVideoWriteShortTool,
  ExplainerVideoWithdrawShortTool,
  ExplainerVideoWriteDiagramTool,
  ExplainerVideoSynthesizeNarrationTool,
  ExplainerVideoAssembleCompositionTool,
  ExplainerVideoMixAudioTrackTool,
  ExplainerVideoRenderCutTool,
  ExplainerVideoPreviewCutTool,
  ExplainerVideoStatusTool,
  ExplainerVideoWritePostDraftTool,
  ExplainerVideoGenerateThumbnailsTool,
  ExplainerVideoExcludeThumbnailTool,
);

export const CollectionToolkit = Toolkit.make(
  CollectionVideoWritePlanTool,
  CollectionVideoCheckTitleTool,
  CollectionVideoStatusTool,
);

// handler が要求する service は、Layer を組むときに取った context で満たす。
// service の Layer は組み立てず、必要な service を要求するだけにする（合成は entry point）。
type ToolServices =
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
  | VideoIds;

const provideServices = Effect.map(
  Effect.context<ToolServices>(),
  (context) =>
    <Input, Success, Failure>(
      handler: (input: Input) => Effect.Effect<Success, Failure, ToolServices>,
    ) =>
    (input: Input) =>
      handler(input).pipe(Effect.provideContext(context)),
);

export const ExplainerToolHandlers = ExplainerToolkit.toLayer(
  Effect.map(provideServices, (provide) =>
    ExplainerToolkit.of({
      video_assemble_composition: provide(explainerVideoAssembleComposition),
      video_exclude_thumbnail: provide(explainerVideoExcludeThumbnail),
      video_fetch_topic_candidates: provide(explainerVideoFetchTopicCandidates),
      video_generate_thumbnails: provide(explainerVideoGenerateThumbnails),
      video_mix_audio_track: provide(explainerVideoMixAudioTrack),
      video_preview_cut: provide(explainerVideoPreviewCut),
      video_render_cut: provide(explainerVideoRenderCut),
      video_status: provide(explainerVideoStatus),
      video_synthesize_narration: provide(explainerVideoSynthesizeNarration),
      video_withdraw_short: provide(explainerVideoWithdrawShort),
      video_write_diagram: provide(explainerVideoWriteDiagram),
      video_write_plan: provide(explainerVideoWritePlan),
      video_write_post_draft: provide(explainerVideoWritePostDraft),
      video_write_script: provide(explainerVideoWriteScript),
      video_write_short: provide(explainerVideoWriteShort),
    }),
  ),
);

export const CollectionToolHandlers = CollectionToolkit.toLayer(
  Effect.map(provideServices, (provide) =>
    CollectionToolkit.of({
      video_check_title: provide(collectionVideoCheckTitle),
      video_status: provide(collectionVideoStatus),
      video_write_plan: provide(collectionVideoWritePlan),
    }),
  ),
);
