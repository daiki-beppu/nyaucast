import { createHash } from "node:crypto";

import { Effect, Option, Schema } from "effect";
import { Tool } from "effect/ai";

import {
  ChannelConfigNotFound,
  ChannelSettings,
  InvalidChannelConfig,
  type Theme,
} from "../../channel/channel-settings.ts";
import { compositionFileKey, shortVersionMeta } from "../../compositions/composition.ts";
import { ShortCandidateNotFound, type ShortCandidate } from "../../db/explainer-shorts.ts";
import { VideoNotFound, requireLatestPlan } from "../../db/explainer-videos.ts";
import {
  InvalidDiagrams,
  beatAttribute,
  dimAttribute,
  enterAttribute,
  fromAttribute,
  isMotionElement,
  missingDiagram,
  motionPosition,
  reviewDiagram,
  type SceneShape,
  type Violation,
} from "../../diagrams/diagram.ts";
import { readDiagramBytes } from "../../diagrams/diagram-files.ts";
import { markupHtml, type ElementNode, type MarkupNode } from "../../diagrams/markup.ts";
import {
  InvalidTimingTable,
  TimingTableNotFound,
  decodeTimingTableBytes,
  readTimingTableBytes,
  type TimingTable,
} from "../../narration/timing-table.ts";
import type { ScriptTarget } from "../../scripts/script-files.ts";
import {
  InvalidShortRange,
  ShortTooLong,
  clipSpan,
  rangeKey,
  requireShortLength,
  type ShortRef,
} from "../../shorts/short-candidate.ts";
import {
  CutField,
  resolveCut,
  sourceTarget,
  type CutRequest,
  type CutTarget,
} from "../../videos/cuts.ts";
import { ProduceGateNotApproved, requireProduceApproval } from "../../videos/produce-gate.ts";
import { VideoFiles } from "../../videos/video-files.ts";

class ThemeNotDeclared extends Schema.TaggedError<ThemeNotDeclared>()("ThemeNotDeclared", {}) {}

class FontNotFound extends Schema.TaggedError<FontNotFound>()("FontNotFound", {
  path: Schema.String,
}) {}

class FontUnsupported extends Schema.TaggedError<FontUnsupported>()("FontUnsupported", {
  path: Schema.String,
}) {}

const hashMetaPattern = /<meta name="nyaucast-composition-hash" content="([0-9a-f]{64})">/u;

export const ExplainerVideoAssembleCompositionTool = Tool.make("video_assemble_composition", {
  description:
    "Assemble the composition of a cut of an explainer video (the long cut by default): one self-contained HTML file that implements window.__hf (width, height, fps, duration, seek and segments; see docs/reference/composition-contract.md). " +
    "The positions of the diagrams (docs/reference/diagram-contract.md) are turned into seconds with the timing table written by video_synthesize_narration, " +
    "the subtitles (one per phrase, in the notation, at the bottom), the theme of the channel (colors, sizes and font files, embedded as base64) and the frame are added by the tool, and the scenes are the segments. " +
    "Every diagram is checked again, across scenes, and every violation is listed at once; nothing is written when there is one. " +
    "The composition is keyed by a hash of the diagrams, the timing table, the theme with its font files and the layout: when the existing composition has the same hash it is returned as it is, and with force it is built again. " +
    "The cut long is 1920x1080. A clip short (short-<n>-clip) is 1080x1920: the long diagrams of the scenes the candidate's paragraph range touches sit in a 16:9 frame in the middle, scaled down, with the hook (escaped text, never read aloud) in the top band and the subtitles of the range in the bottom band; all times are the long timing table shifted by the start of the range, and its hash includes the range and the hook. " +
    "A dedicated short (short-<n>-dedicated) is 1080x1920 with the diagrams of shorts/<n>/scenes/ over the whole frame and the subtitles at the bottom, made from the timing table of its own narration. " +
    "A short is at most 60 seconds long (the range of a clip, the narration of a dedicated short). The composition of a cut is written to compositions/<cut>.html. " +
    "No browser is used and no row is added to the local store. " +
    "Requires the produce gate to be approved. " +
    "Fails with VideoNotFound for an unknown video, with ProduceGateNotApproved before the produce gate is approved, with ThemeNotDeclared when the channel declares no theme, with ShortCandidateNotFound when the cut names a candidate that was never written or is withdrawn, with InvalidShortRange when the range of a clip is not in the timing table any more, with ShortTooLong when a short is over 60 seconds, " +
    "with TimingTableNotFound or InvalidTimingTable for the timing table, with InvalidDiagrams (videoId and violations, each with scene and rule; a scene without a diagram is a violation) for the diagrams, " +
    "and with FontNotFound or FontUnsupported (path) for a font file of the theme. " +
    "Returns whether the composition was assembled now, its hash and its key.",
  failure: Schema.Union([
    ChannelConfigNotFound,
    InvalidChannelConfig,
    VideoNotFound,
    ProduceGateNotApproved,
    ThemeNotDeclared,
    ShortCandidateNotFound,
    InvalidShortRange,
    ShortTooLong,
    TimingTableNotFound,
    InvalidTimingTable,
    InvalidDiagrams,
    FontNotFound,
    FontUnsupported,
  ]),
  parameters: Schema.Struct({
    cut: CutField,
    force: Schema.optionalKey(Schema.Boolean).annotate({
      description: "Assemble again even when the existing composition has the same hash.",
    }),
    videoId: Schema.String.annotate({ description: "Video ID returned by video_write_plan." }),
  }),
  success: Schema.Struct({
    assembled: Schema.Boolean,
    hash: Schema.String,
    key: Schema.String,
    videoId: Schema.String,
  }),
}).annotate(Tool.Strict, true);

// ---- レイアウト（長尺）: 値はすべて鮮度の鍵に入る ----

const fps = 30;
const motionSeconds = 0.5;
const dimmedOpacity = 0.3;
const slideDistance = 80;
const popScale = 0.8;
// 境界は 1/1024 秒の格子に丸める。2 進で正確に表せるので、start + duration === 次の start が厳密に成り立つ。
const grid = 1024;

const onGrid = (seconds: number) => Math.round(seconds * grid) / grid;

// 字幕の帯は、字幕の 3 行分と下の余白。図解の領域はこの上に収める（字幕と重ならない）。
const captionBand =
  "calc(var(--nc-size-caption-font-size) * 3 + var(--nc-size-caption-margin) * 2)";

// ---- レイアウト: 長尺は 1920x1080、専用ショートは 1080x1920 の全面、切り抜きは 1080x1920 の中央に長尺の舞台を縮小して置く ----

const longWidth = 1920;
const longHeight = 1080;
const shortWidth = 1080;
const shortHeight = 1920;
const clipScale = shortWidth / longWidth;
const clipFrameHeight = longHeight * clipScale;
const clipFrameTop = (shortHeight - clipFrameHeight) / 2;

const pageRule = (width: number, height: number) =>
  `html, body { margin: 0; width: ${width}px; height: ${height}px; overflow: hidden; background: var(--nc-color-background); color: var(--nc-color-text); font-family: var(--nc-font-body); }`;
const stageRule = (width: number, height: number) =>
  `#nc-stage { position: absolute; left: 0; top: 0; width: ${width}px; height: ${height}px; }`;
const sceneRule = `.nc-scene { position: absolute; left: var(--nc-size-stage-padding); right: var(--nc-size-stage-padding); top: var(--nc-size-stage-padding); bottom: calc(var(--nc-size-stage-padding) + ${captionBand}); }`;
const motionRule = "[data-nc-motion] { transform-box: fill-box; transform-origin: center; }";
const captionRules = (width: number) =>
  `#nc-caption { position: absolute; left: 50%; bottom: var(--nc-size-caption-margin); transform: translateX(-50%); max-width: calc(${width}px - var(--nc-size-caption-margin) * 2); padding: 0.2em 0.6em; text-align: center; font-family: var(--nc-font-caption); font-size: var(--nc-size-caption-font-size); color: var(--nc-color-caption-text); background: var(--nc-color-caption-background); }
#nc-caption:empty { display: none; }`;
const hookRule = `#nc-hook { position: absolute; left: 0; right: 0; top: 0; height: ${clipFrameTop}px; display: flex; align-items: center; justify-content: center; box-sizing: border-box; padding: 0 var(--nc-size-stage-padding); text-align: center; font-family: var(--nc-font-caption); font-size: calc(var(--nc-size-caption-font-size) * 1.6); color: var(--nc-color-text); }`;
const frameRule = `#nc-frame { position: absolute; left: 0; top: ${clipFrameTop}px; width: ${shortWidth}px; height: ${clipFrameHeight}px; overflow: hidden; }`;
const scaledStageRule = `#nc-stage { position: absolute; left: 0; top: 0; width: ${longWidth}px; height: ${longHeight}px; transform: scale(${clipScale}); transform-origin: 0 0; }`;

const cssOf = (rules: readonly string[]) => `\n${rules.join("\n")}\n`;

interface Layout {
  readonly css: string;
  readonly height: number;
  /** 舞台の前後に置く要素。切り抜きは、フックの帯と、舞台を縮小して置く枠。 */
  readonly page: (stage: readonly string[], hook: string | undefined) => string[];
  readonly width: number;
}

const stageOnly = (stage: readonly string[]) => ['<div id="nc-stage">', ...stage, "</div>"];

const escapeText = (text: string) =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const fullLayout = (width: number, height: number): Layout => ({
  css: cssOf([
    pageRule(width, height),
    stageRule(width, height),
    sceneRule,
    motionRule,
    captionRules(width),
  ]),
  height,
  page: stageOnly,
  width,
});

const longLayout = fullLayout(longWidth, longHeight);
const dedicatedLayout = fullLayout(shortWidth, shortHeight);
const clipLayout: Layout = {
  css: cssOf([
    pageRule(shortWidth, shortHeight),
    hookRule,
    frameRule,
    scaledStageRule,
    sceneRule,
    motionRule,
    captionRules(shortWidth),
  ]),
  height: shortHeight,
  page: (stage, hook) => [
    `<div id="nc-hook">${escapeText(hook ?? "")}</div>`,
    '<div id="nc-frame">',
    ...stageOnly(stage),
    "</div>",
  ],
  width: shortWidth,
};

// seek を実装するタイムラインの runtime。composition にインラインで埋め込む（src/lib/ には置かない）。
// 触る DOM は querySelectorAll / getElementById / getAttribute / style.setProperty / textContent だけ。
// seek は毎回、すべての状態を t だけから設定し直す（差分では更新しない）。時計・乱数・タイマーは使わない。
const runtimeSource = `(function () {
  var data = JSON.parse(document.getElementById("nc-data").textContent);
  var sceneElements = document.querySelectorAll(".nc-scene");
  var motionElements = document.querySelectorAll("[data-nc-motion]");
  var captionElement = document.getElementById("nc-caption");
  var directions = { left: [-1, 0], right: [1, 0], top: [0, -1], bottom: [0, 1] };

  function clamp(value) {
    return value < 0 ? 0 : value > 1 ? 1 : value;
  }
  function progress(t, timed) {
    if (timed === null) {
      return 0;
    }
    if (t < timed.start) {
      return 0;
    }
    return timed.length > 0 ? clamp((t - timed.start) / timed.length) : 1;
  }
  function appearance(motion, t) {
    return motion.beat === null ? 1 : progress(t, motion.beat);
  }
  function opacityOf(motion, t) {
    return appearance(motion, t) * (1 - progress(t, motion.dim) * (1 - data.dimmed));
  }
  function transformOf(motion, t) {
    var p = appearance(motion, t);
    if (p >= 1) {
      return "none";
    }
    if (motion.enter === "slide") {
      var d = directions[motion.from];
      return "translate(" + d[0] * (1 - p) * data.slide + "px, " + d[1] * (1 - p) * data.slide + "px)";
    }
    return motion.enter === "pop" ? "scale(" + (data.popScale + (1 - data.popScale) * p) + ")" : "none";
  }
  function captionAt(t) {
    for (var i = 0; i < data.captions.length; i++) {
      if (t >= data.captions[i].start && t < data.captions[i].end) {
        return data.captions[i].text;
      }
    }
    return "";
  }
  function seek(t) {
    for (var i = 0; i < sceneElements.length; i++) {
      var inScene = t >= data.scenes[i].start && t < data.scenes[i].end;
      sceneElements[i].style.setProperty("visibility", inScene ? "visible" : "hidden");
    }
    for (var j = 0; j < motionElements.length; j++) {
      var motion = data.motions[Number(motionElements[j].getAttribute("data-nc-motion"))];
      motionElements[j].style.setProperty("opacity", String(opacityOf(motion, t)));
      motionElements[j].style.setProperty("transform", transformOf(motion, t));
    }
    captionElement.textContent = captionAt(t);
  }
  window.__hf = {
    width: data.width,
    height: data.height,
    fps: data.fps,
    duration: data.duration,
    seek: seek,
    segments: data.segments
  };
})();`;

// ---- テーマ ----

const fontTypes: Record<string, { readonly format: string; readonly mime: string }> = {
  otf: { format: "opentype", mime: "font/otf" },
  ttf: { format: "truetype", mime: "font/ttf" },
  woff: { format: "woff", mime: "font/woff" },
  woff2: { format: "woff2", mime: "font/woff2" },
};

const fontTypeOf = (path: string) => fontTypes[(path.split(".").at(-1) ?? "").toLowerCase()];

const kebab = (name: string) => name.replaceAll(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`);

interface EmbeddedFont {
  readonly bytes: Uint8Array;
  readonly path: string;
}

const fontFaceCss = ({ bytes, path }: EmbeddedFont, family: string) => {
  const type = fontTypeOf(path);
  const data = Buffer.from(bytes).toString("base64");
  return `@font-face { font-family: "${family}"; src: url(data:${type?.mime ?? ""};base64,${data}) format("${type?.format ?? ""}"); }`;
};

const variables = (prefix: string, values: Record<string, string | number>, unit: string) =>
  Object.entries(values).map(([name, value]) => `--nc-${prefix}-${kebab(name)}: ${value}${unit};`);

/** @font-face と CSS 変数。同じパスのフォントは 1 回だけ埋め込む。 */
const themeCss = (theme: Theme, fonts: readonly EmbeddedFont[]) => {
  const families = new Map(fonts.map((font, index) => [font.path, `nc-font-${index}`]));
  return [
    ...fonts.map((font) => fontFaceCss(font, families.get(font.path) ?? "")),
    ":root {",
    ...variables("color", theme.colors, ""),
    ...variables("size", theme.sizes, "px"),
    `--nc-font-body: "${families.get(theme.fonts.body) ?? ""}";`,
    `--nc-font-caption: "${families.get(theme.fonts.caption) ?? ""}";`,
    "}",
  ].join("\n");
};

// ---- 台本上の位置を秒に直す ----

type TimingParagraph = TimingTable["paragraphs"][number];

interface SceneInput {
  /** シーンの最後の段落の終わり（次のシーンの境界）。 */
  readonly end: number;
  readonly paragraphs: readonly TimingParagraph[];
  readonly scene: number;
  readonly shape: SceneShape;
}

/** タイミング表の中で段落を持つシーン（昇順）。カットのシーンはこれで決まる。 */
const sceneInputs = (table: TimingTable): SceneInput[] =>
  [...new Set(table.paragraphs.map((paragraph) => paragraph.scene))]
    .toSorted((a, b) => a - b)
    .map((scene) => {
      const paragraphs = table.paragraphs
        .filter((paragraph) => paragraph.scene === scene)
        .toSorted((a, b) => a.paragraph - b.paragraph);
      return {
        end: Math.max(...paragraphs.map((paragraph) => paragraph.endSeconds)),
        paragraphs,
        scene,
        shape: paragraphs.map((paragraph) => paragraph.phrases.length),
      };
    });

const startOf = (input: SceneInput, position: { paragraph: number; phrase: number } | undefined) =>
  position === undefined
    ? null
    : (input.paragraphs[position.paragraph - 1]?.phrases[position.phrase - 1]?.startSeconds ??
      null);

interface MotionSpec {
  readonly beatAt: number | null;
  readonly dimAt: number | null;
  readonly enter: string;
  readonly from: string | null;
}

const specOf = (input: SceneInput, element: ElementNode): MotionSpec => {
  const valueOf = (name: string) =>
    element.attributes.find((attribute) => attribute.name.toLowerCase() === name)?.value;
  const enter = valueOf(enterAttribute) ?? "fade";
  return {
    beatAt: startOf(input, motionPosition(element, beatAttribute, input.shape)),
    dimAt: startOf(input, motionPosition(element, dimAttribute, input.shape)),
    enter,
    from: enter === "slide" ? (valueOf(fromAttribute) ?? null) : null,
  };
};

interface Timed {
  readonly length: number;
  readonly start: number;
}

interface Motion {
  readonly beat: Timed | null;
  readonly dim: Timed | null;
  readonly enter: string;
  readonly from: string | null;
}

/** 動きの長さは motionSeconds まで。同じ図解の次の動きが始まるときには終わっている（同時に動くのは 1 か所だけ）。 */
const motionsOf = (specs: readonly MotionSpec[]): Motion[] => {
  const times = specs
    .flatMap((spec) => [spec.beatAt, spec.dimAt])
    .filter((at): at is number => at !== null)
    .toSorted((a, b) => a - b);
  const timed = (at: number | null): Timed | null => {
    if (at === null) return null;
    const next = times[times.indexOf(at) + 1];
    return {
      length: next === undefined ? motionSeconds : Math.min(motionSeconds, next - at),
      start: at,
    };
  };
  return specs.map((spec) => ({
    beat: timed(spec.beatAt),
    dim: timed(spec.dimAt),
    enter: spec.enter,
    from: spec.from,
  }));
};

interface Numbering {
  next: number;
}

const motionAttribute = (number: number) => ({ name: "data-nc-motion", value: String(number) });

// 動く要素に、composition 全体で重複しない番号を文書の順に付ける。親を先に、子を後に数える。
const numberNodes = (
  nodes: readonly MarkupNode[],
  input: SceneInput,
  numbering: Numbering,
  specs: MotionSpec[],
): MarkupNode[] =>
  nodes.map((node) => {
    if (node.kind !== "element") return node;
    const own = isMotionElement(node) ? [motionAttribute(numbering.next++)] : [];
    if (own.length > 0) specs.push(specOf(input, node));
    return {
      ...node,
      attributes: [...node.attributes, ...own],
      children: numberNodes(node.children, input, numbering, specs),
    };
  });

// ---- 図解の検査 ----

interface DiagramSource {
  readonly html: string | undefined;
  readonly input: SceneInput;
}

interface Reviewed {
  readonly ids: ReadonlySet<string>;
  readonly scenes: readonly { readonly input: SceneInput; readonly nodes: readonly MarkupNode[] }[];
  readonly violations: readonly Violation[];
}

/** 全シーンを検査する。図解が無いシーンも、違反のあるシーンも、止めずに全件を集める。シーンをまたいだ id の重複も調べる。 */
const reviewAll = (sources: readonly DiagramSource[]): Reviewed =>
  sources.reduce<Reviewed>(
    (reviewed, { html, input }) => {
      if (html === undefined) {
        return { ...reviewed, violations: [...reviewed.violations, missingDiagram(input.scene)] };
      }
      const review = reviewDiagram(html, input.scene, input.shape, reviewed.ids);
      return {
        ids: new Set([...reviewed.ids, ...review.ids]),
        scenes: [...reviewed.scenes, { input, nodes: review.nodes }],
        violations: [...reviewed.violations, ...review.violations],
      };
    },
    { ids: new Set(), scenes: [], violations: [] },
  );

// ---- composition の組み立て ----

const jsonForScript = (value: unknown) => JSON.stringify(value).replaceAll("<", "\\u003c");

const segmentsOf = (inputs: readonly SceneInput[], duration: number) => {
  const starts = [0, ...inputs.slice(0, -1).map((input) => onGrid(input.end))];
  return starts.map((start, index) => ({
    duration: (starts[index + 1] ?? duration) - start,
    start,
    static: false,
  }));
};

// ---- カットの計画: レイアウト・時間・字幕・シーン・鍵に足すもの ----

interface CutPlan {
  readonly captions: readonly TimingParagraph[];
  readonly duration: number;
  /** 鮮度の鍵に足す、タイミング表と図解のほかに出力を決めるもの（切り抜きの範囲とフック）。 */
  readonly extras: unknown;
  readonly hook: string | undefined;
  readonly layout: Layout;
  readonly scenes: readonly SceneInput[];
}

// 長尺と専用ショート: タイミング表のすべてをそのまま使う。
const wholePlan = (layout: Layout, table: TimingTable): CutPlan => ({
  captions: table.paragraphs,
  duration: table.durationSeconds,
  extras: undefined,
  hook: undefined,
  layout,
  scenes: sceneInputs(table),
});

const shiftedBy = (paragraphs: readonly TimingParagraph[], offset: number): TimingParagraph[] =>
  paragraphs.map((paragraph) => ({
    ...paragraph,
    endSeconds: paragraph.endSeconds - offset,
    phrases: paragraph.phrases.map((phrase) => ({
      ...phrase,
      endSeconds: phrase.endSeconds - offset,
      startSeconds: phrase.startSeconds - offset,
    })),
    startSeconds: paragraph.startSeconds - offset,
  }));

// 切り抜き: 範囲の区間の開始を 0 にずらし、範囲の段落を持つシーンだけを置く。字幕は範囲の段落の句だけ。
const clipPlan = (ref: ShortRef, version: ShortCandidate, table: TimingTable) =>
  Effect.gen(function* () {
    const span = yield* clipSpan(ref, table, version.range);
    const touched = new Set(span.paragraphs.map((paragraph) => paragraph.scene));
    const shifted = { ...table, paragraphs: shiftedBy(table.paragraphs, span.startSeconds) };
    return {
      captions: shiftedBy(span.paragraphs, span.startSeconds),
      duration: span.endSeconds - span.startSeconds,
      extras: { hook: version.hook, range: rangeKey(version.range) },
      hook: version.hook,
      layout: clipLayout,
      scenes: sceneInputs(shifted).filter((input) => touched.has(input.scene)),
    } satisfies CutPlan;
  });

const planCut = (videoId: string, target: CutTarget, table: TimingTable) =>
  Effect.gen(function* () {
    if (target.kind === "long") {
      return wholePlan(longLayout, table);
    }
    const ref = { cut: target.cut, number: target.number, videoId };
    if (target.kind === "clip") {
      return yield* clipPlan(ref, target.version, table);
    }
    yield* requireShortLength(ref, table.durationSeconds);
    return wholePlan(dedicatedLayout, table);
  });

interface CompositionParts {
  readonly fonts: readonly EmbeddedFont[];
  readonly hash: string;
  /** ショートなら、組み立てに使った候補の版（作成時刻）。 */
  readonly shortVersion: string | undefined;
  readonly plan: CutPlan;
  readonly reviewed: Reviewed;
  readonly theme: Theme;
}

const buildHtml = ({ fonts, hash, plan, reviewed, shortVersion, theme }: CompositionParts) => {
  const numbering: Numbering = { next: 0 };
  const specs: MotionSpec[][] = [];
  const scenes = reviewed.scenes.map(({ input, nodes }) => {
    const sceneSpecs: MotionSpec[] = [];
    const numbered = numberNodes(nodes, input, numbering, sceneSpecs);
    specs.push(sceneSpecs);
    return { html: markupHtml(numbered), input };
  });
  const duration = onGrid(plan.duration);
  const segments = segmentsOf(
    scenes.map(({ input }) => input),
    duration,
  );
  const data = {
    captions: plan.captions.flatMap((paragraph) =>
      paragraph.phrases.map((phrase) => ({
        end: phrase.endSeconds,
        start: phrase.startSeconds,
        text: phrase.text,
      })),
    ),
    dimmed: dimmedOpacity,
    duration,
    fps,
    height: plan.layout.height,
    motions: specs.flatMap(motionsOf),
    popScale,
    scenes: segments.map((segment) => ({
      end: segment.start + segment.duration,
      start: segment.start,
    })),
    segments,
    slide: slideDistance,
    width: plan.layout.width,
  };
  return [
    "<!doctype html>",
    '<html lang="ja">',
    "<head>",
    '<meta charset="utf-8">',
    `<meta name="nyaucast-composition-hash" content="${hash}">`,
    ...(shortVersion === undefined ? [] : [shortVersionMeta(shortVersion)]),
    `<style>${themeCss(theme, fonts)}${plan.layout.css}</style>`,
    "</head>",
    "<body>",
    ...plan.layout.page(
      scenes.map(
        ({ html, input }) =>
          `<section class="nc-scene" data-nc-scene="${input.scene}">${html}</section>`,
      ),
      plan.hook,
    ),
    '<div id="nc-caption"></div>',
    `<script type="application/json" id="nc-data">${jsonForScript(data)}</script>`,
    `<script>${runtimeSource}</script>`,
    "</body>",
    "</html>",
    "",
  ].join("\n");
};

// ---- 鮮度の鍵 ----

const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");

/**
 * 図解群・タイミング表・テーマ（フォントのバイト列を含む）・レイアウトのハッシュ。
 * 切り抜きは、範囲とフックも含める。ショートは候補の版も含める（版が変われば組み立て直し、meta の版を新しくする）。
 * 長尺は何も足さないので、長尺の鍵は変わらない。
 */
const freshnessKey = (
  plan: CutPlan,
  theme: Theme,
  fonts: readonly EmbeddedFont[],
  timingBytes: Uint8Array,
  diagrams: readonly (string | undefined)[],
  shortVersion: string | undefined,
) =>
  sha256(
    JSON.stringify([
      [
        plan.layout.width,
        plan.layout.height,
        fps,
        motionSeconds,
        dimmedOpacity,
        slideDistance,
        popScale,
        plan.layout.css,
        runtimeSource,
      ],
      [theme, fonts.map((font) => [font.path, sha256(font.bytes)])],
      sha256(timingBytes),
      diagrams,
      ...(plan.extras === undefined ? [] : [plan.extras]),
      ...(shortVersion === undefined ? [] : [shortVersion]),
    ]),
  );

// ---- tool ----

const requireTheme = Effect.gen(function* () {
  const { theme } = yield* (yield* ChannelSettings).explainer;
  if (theme === undefined) {
    return yield* new ThemeNotDeclared();
  }
  return theme;
});

const readFont = (path: string) =>
  Effect.gen(function* () {
    if (fontTypeOf(path) === undefined) {
      return yield* new FontUnsupported({ path });
    }
    const bytes = yield* (yield* VideoFiles).read(path);
    if (Option.isNone(bytes)) {
      return yield* new FontNotFound({ path });
    }
    return { bytes: bytes.value, path } satisfies EmbeddedFont;
  });

// 同じパスは 1 回だけ読む（body と caption が同じフォントでもよい）。
const readFonts = (theme: Theme) =>
  Effect.forEach([...new Set([theme.fonts.body, theme.fonts.caption])], readFont);

const readDiagramSources = (source: ScriptTarget, inputs: readonly SceneInput[]) =>
  Effect.forEach(inputs, (input) =>
    Effect.gen(function* () {
      const bytes = yield* readDiagramBytes(source, input.scene);
      return { bytes: Option.getOrUndefined(bytes), input };
    }),
  );

// 図解を読み、全シーンを検査する。違反があれば InvalidDiagrams で何も書かない。
const reviewSources = (videoId: string, source: ScriptTarget, inputs: readonly SceneInput[]) =>
  Effect.gen(function* () {
    const sources = yield* readDiagramSources(source, inputs);
    const decoder = new TextDecoder();
    const diagrams = sources.map(({ bytes }) =>
      bytes === undefined ? undefined : decoder.decode(bytes),
    );
    const reviewed = reviewAll(
      sources.map(({ input }, index) => ({ html: diagrams[index], input })),
    );
    if (reviewed.violations.length > 0) {
      return yield* new InvalidDiagrams({ videoId, violations: reviewed.violations });
    }
    return { diagrams, reviewed };
  });

const existingHash = (key: string) =>
  Effect.gen(function* () {
    const bytes = yield* (yield* VideoFiles).read(key);
    return Option.flatMap(bytes, (value) =>
      Option.fromNullishOr(hashMetaPattern.exec(new TextDecoder().decode(value))?.[1]),
    );
  });

export const explainerVideoAssembleComposition = Effect.fn("video.assembleComposition")(function* ({
  cut,
  force,
  videoId,
}: CutRequest) {
  const theme = yield* requireTheme;
  yield* requireLatestPlan(videoId);
  yield* requireProduceApproval(videoId);
  const target = yield* resolveCut(videoId, cut);
  const source = sourceTarget(videoId, target);
  const timingBytes = yield* readTimingTableBytes(source);
  const plan = yield* planCut(videoId, target, yield* decodeTimingTableBytes(videoId, timingBytes));
  // 段落が 1 つも無いタイミング表からは、時間を覆う segment を作れない。
  if (plan.scenes.length === 0) {
    return yield* new InvalidTimingTable({ videoId });
  }
  const { diagrams, reviewed } = yield* reviewSources(videoId, source, plan.scenes);
  const fonts = yield* readFonts(theme);
  const shortVersion = target.kind === "long" ? undefined : target.version.createdAt;
  const hash = freshnessKey(plan, theme, fonts, timingBytes, diagrams, shortVersion);
  const key = compositionFileKey(videoId, target.cut);
  if (force !== true && Option.contains(yield* existingHash(key), hash)) {
    return { assembled: false, hash, key, videoId };
  }
  const html = buildHtml({ fonts, hash, plan, reviewed, shortVersion, theme });
  yield* (yield* VideoFiles).write(key, new TextEncoder().encode(html));
  return { assembled: true, hash, key, videoId };
});
