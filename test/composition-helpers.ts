import { createContext, runInContext } from "node:vm";

import { assert } from "@effect/vitest";

import { explainerConfigWithVoice, timingKey, voiceDeclaration } from "./narration-helpers.ts";
import { readChannelFile, writeChannelFile } from "./thumbnail-helpers.ts";

/** チャンネルの video.json に書く「テーマ」。テストに関係する項目だけを上書きする。 */
export const themeDeclaration = (
  overrides: {
    readonly colors?: Record<string, unknown>;
    readonly fonts?: Record<string, unknown>;
    readonly sizes?: Record<string, unknown>;
  } = {},
) => ({
  colors: {
    accent: "#ffb400",
    background: "#101820",
    captionBackground: "#000000cc",
    captionText: "#ffffff",
    muted: "#8899aa",
    text: "#f5f5f5",
    ...overrides.colors,
  },
  fonts: {
    body: "assets/fonts/body.woff2",
    caption: "assets/fonts/caption.woff2",
    ...overrides.fonts,
  },
  sizes: { captionFontSize: 44, captionMargin: 48, stagePadding: 64, ...overrides.sizes },
});

/** 解説動画のチャンネルの設定（ボイスとテーマ付き）。theme が undefined なら「テーマ」を書かない。 */
export const explainerConfigWithTheme = (theme?: Record<string, unknown>) =>
  JSON.stringify({
    ...(JSON.parse(explainerConfigWithVoice(voiceDeclaration())) as Record<string, unknown>),
    ...(theme === undefined ? {} : { theme }),
  });

/** 中身に意味のないフォントのバイト列。seed が違えば別のバイト列になる。 */
export const fontBytes = (seed: number) =>
  Uint8Array.from([0x77, 0x4f, 0x46, 0x32, seed, 255, 0, 7]);

export const diagramKey = (scene: number, videoId = "V1") =>
  `videos/${videoId}/diagrams/${scene}.html`;
export const compositionKey = "videos/V1/compositions/long.html";
export const compositionHashMeta = (hash: string) =>
  `<meta name="nyaucast-composition-hash" content="${hash}">`;

// シーン 1 は段落 2 つ（1 句・3 句）、シーン 2 は段落 2 つ（1 句・2 句。2 句目の前の句が短い）。
const sceneOneParagraphOne = "猫は鳴く。";
const sceneOneParagraphTwo = "猫はとても静かに眠る、窓の外では雨が降る、それでも気にしない。";
const sceneTwoParagraphOne = "{API|エーピーアイ}の二つ目の場面です。";
const sceneTwoParagraphTwo = "はじまりです、これはとても長い二つ目の句であって切れ目なく続きます。";
export const scriptScenes = [
  [sceneOneParagraphOne, sceneOneParagraphTwo],
  [sceneTwoParagraphOne, sceneTwoParagraphTwo],
] as const;

// シーン 1 の図解: 段落 1 の頭で現れ、2 段落目の 2 句目で沈み、3 句目でスライドして現れる（動く要素は 2 つ）。
export const sceneOneDiagram =
  '<div><h1>見出し</h1><svg viewBox="0 0 10 10"><rect id="r1" data-beat="1" data-dim="2.2"/>' +
  '<g data-beat="2.3" data-enter="slide" data-from="left"><circle r="3"/></g></svg></div>';
// シーン 2 の図解: 1 段落目の頭（1）、2 段落目の頭（2 = 2.1）、2 段落目の 2 句目。2 句目の前の句は 0.5 秒より短い。
export const sceneTwoDiagram =
  '<div><p data-beat="1">一つ目</p><p data-beat="2">二つ目</p><p data-beat="2.2">三つ目</p></div>';

interface TimingTable {
  readonly durationSeconds: number;
  readonly paragraphs: readonly {
    readonly endSeconds: number;
    readonly paragraph: number;
    readonly phrases: readonly { endSeconds: number; startSeconds: number; text: string }[];
    readonly scene: number;
    readonly startSeconds: number;
  }[];
}

/** video_synthesize_narration が書いたタイミング表を、そのまま読む（期待値の出所）。 */
export const readTimingFile = (channelRoot: string) =>
  JSON.parse(new TextDecoder().decode(readChannelFile(channelRoot, timingKey))) as TimingTable;

/** 値があることを確かめて取り出す（無ければテストが失敗する）。 */
export const defined = <T>(value: T | undefined): T => {
  assert.isDefined(value);
  return value as T;
};

/** タイミング表の段落（台本の通し番号、0 始まり）の開始時刻。 */
export const paragraphStart = (timing: TimingTable, paragraph: number) =>
  defined(timing.paragraphs[paragraph]).startSeconds;

/** タイミング表の段落（通し番号）の、句（0 始まり）の開始時刻。 */
export const phraseStart = (timing: TimingTable, paragraph: number, phrase: number) =>
  defined(defined(timing.paragraphs[paragraph]).phrases[phrase]).startSeconds;

export const bodyFontPath = "assets/fonts/body.woff2";
export const captionFontPath = "assets/fonts/caption.woff2";

/** テーマが指す 2 つのフォントのファイルをチャンネルリポに置く。 */
export const writeThemeFonts = (channelRoot: string) => {
  writeChannelFile(channelRoot, bodyFontPath, fontBytes(1));
  writeChannelFile(channelRoot, captionFontPath, fontBytes(2));
};

// ---- 偽の DOM と node:vm による composition の実行（Chrome は使わない） ----

export interface Segment {
  readonly duration: number;
  readonly start: number;
  readonly static: boolean;
}

export interface Hf {
  readonly duration: number;
  readonly fps: number;
  readonly height: number;
  readonly seek: (t: number) => void;
  readonly segments: readonly Segment[];
  readonly width: number;
}

interface FakeElement {
  readonly attributes: Map<string, string>;
  readonly getAttribute: (name: string) => string | null;
  readonly style: { readonly setProperty: (name: string, value: string) => void };
  readonly styles: Map<string, string>;
  readonly tag: string;
  textContent: string;
}

const unescapeAttribute = (value: string) =>
  value
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");

const makeElement = (tag: string, attributes: Map<string, string>, text: string): FakeElement => {
  const styles = new Map<string, string>();
  return {
    attributes,
    getAttribute: (name) => attributes.get(name) ?? null,
    style: { setProperty: (name, value) => void styles.set(name, String(value)) },
    styles,
    tag,
    textContent: text,
  };
};

const attributePattern = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'))?/gu;
const parseAttributes = (source: string) =>
  new Map(
    [...source.matchAll(attributePattern)].map(
      ([, name = "", double, single]) =>
        [name, unescapeAttribute(double ?? single ?? "")] as [string, string],
    ),
  );

const javascriptTypes = new Set(["", "text/javascript", "module"]);

interface ParsedHtml {
  readonly elements: FakeElement[];
  readonly programs: string[];
}

// 開きタグだけを順に拾う最小の読み取り。script は実行するコードと、textContent で読むデータに分ける。
const parseHtml = (html: string): ParsedHtml => {
  const programs: string[] = [];
  const elements: FakeElement[] = [];
  const withoutScripts = html.replace(
    /<script\b([^>]*)>([\s\S]*?)<\/script>/gu,
    (_, attributeSource: string, body: string) => {
      const attributes = parseAttributes(attributeSource);
      if (javascriptTypes.has(attributes.get("type") ?? "")) programs.push(body);
      elements.push(makeElement("script", attributes, body));
      return "";
    },
  );
  const markup = withoutScripts
    .replace(/<style\b[\s\S]*?<\/style>/gu, "")
    .replace(/<!--[\s\S]*?-->/gu, "");
  for (const [, tag = "", attributeSource = ""] of markup.matchAll(
    /<([a-zA-Z][\w:-]*)((?:\s+[^\s=/>]+(?:\s*=\s*(?:"[^"]*"|'[^']*'))?)*)\s*\/?>/gu,
  )) {
    elements.push(makeElement(tag.toLowerCase(), parseAttributes(attributeSource), ""));
  }
  return { elements, programs };
};

// tag#id.class[attr][attr="value"] の形だけを受ける。composition の runtime はこれ以外の selector を使わない契約。
const compound = /^([a-z][\w-]*)?(?:#([\w-]+))?((?:\.[\w-]+)*)((?:\[[\w:-]+(?:="[^"]*")?\])*)$/u;

const parseSelector = (selector: string) => {
  const parts = compound.exec(selector);
  if (parts === null) {
    throw new Error(`selector outside the fake DOM: ${selector}`);
  }
  const [, tag, id, classes = "", attributes = ""] = parts;
  return {
    attributes: [...attributes.matchAll(/\[([\w:-]+)(?:="([^"]*)")?\]/gu)],
    classes: classes.split(".").filter(Boolean),
    id,
    tag,
  };
};

const hasAttribute = (element: FakeElement, [, name = "", value]: RegExpMatchArray) =>
  element.attributes.has(name) && (value === undefined || element.attributes.get(name) === value);

const matches = (selector: string, element: FakeElement) => {
  const { attributes, classes, id, tag } = parseSelector(selector);
  const classNames = (element.attributes.get("class") ?? "").split(/\s+/u);
  return [
    tag === undefined || element.tag === tag,
    id === undefined || element.attributes.get("id") === id,
    classes.every((name) => classNames.includes(name)),
    attributes.every((match) => hasAttribute(element, match)),
  ].every(Boolean);
};

export interface CompositionPage {
  readonly caption: () => string;
  readonly hf: Hf;
  /** 動く要素（data-nc-motion）の opacity。seek していない・設定されていなければ undefined。 */
  readonly motionOpacity: (index: number) => string | undefined;
  readonly motionCount: () => number;
  readonly motionStyle: (index: number, name: string) => string | undefined;
  readonly seek: (t: number) => void;
  /** すべての要素の style と textContent を 1 つの文字列にしたもの。同じ状態なら同じ文字列。 */
  readonly snapshot: () => string;
  /** wall-clock・乱数・タイマー・ネットワークの呼び出しの記録。 */
  readonly traps: readonly string[];
  readonly sceneVisibility: () => (string | undefined)[];
  /** selector に最初に合う要素に、seek が設定した style（無ければ空）。 */
  readonly styleOf: (selector: string) => Record<string, string>;
}

/**
 * composition の HTML 1 枚を新しい文脈で実行する。
 * DOM は document.querySelectorAll / getElementById と、要素の getAttribute / style.setProperty / textContent だけ。
 * Date・performance・Math.random・タイマー・fetch は呼ばれたら記録する（seek が純関数であることの検査に使う）。
 */
export const loadComposition = (html: string): CompositionPage => {
  const { elements, programs } = parseHtml(html);
  const traps: string[] = [];
  // 普通の function にして、new でも呼べるようにする（Date の構築も記録に残す）。
  const trap = (name: string) =>
    function () {
      traps.push(name);
      return 0;
    };
  const document = {
    getElementById: (id: string) =>
      elements.find((element) => element.attributes.get("id") === id) ?? null,
    querySelectorAll: (selector: string) =>
      elements.filter((element) => matches(selector, element)),
  };
  const sandbox: Record<string, unknown> = {
    Date: trap("Date"),
    __trap: (name: string) => traps.push(name),
    XMLHttpRequest: trap("XMLHttpRequest"),
    cancelAnimationFrame: trap("cancelAnimationFrame"),
    document,
    fetch: trap("fetch"),
    performance: { now: trap("performance.now") },
    requestAnimationFrame: trap("requestAnimationFrame"),
    setInterval: trap("setInterval"),
    setTimeout: trap("setTimeout"),
  };
  sandbox["window"] = sandbox;
  const context = createContext(sandbox);
  runInContext("Math.random = () => { __trap('Math.random'); return 0; };", context);
  for (const program of programs) runInContext(program, context);
  const hf = sandbox["__hf"] as Hf | undefined;
  assert.isDefined(hf, "the composition defines window.__hf");
  const motions = elements.filter((element) => element.attributes.has("data-nc-motion"));
  const byMotion = (index: number) =>
    motions.find((element) => element.attributes.get("data-nc-motion") === String(index));
  return {
    caption: () => document.getElementById("nc-caption")?.textContent ?? "",
    hf,
    motionCount: () => motions.length,
    motionOpacity: (index) => byMotion(index)?.styles.get("opacity"),
    motionStyle: (index, name) => byMotion(index)?.styles.get(name),
    styleOf: (selector) =>
      Object.fromEntries(
        elements.find((element) => matches(selector, element))?.styles.entries() ?? [],
      ),
    sceneVisibility: () =>
      document
        .querySelectorAll("[data-nc-scene]")
        .map((element) => element.styles.get("visibility")),
    seek: (t) => hf.seek(t),
    snapshot: () =>
      JSON.stringify(
        elements.map((element) => [
          element.tag,
          [...element.styles.entries()],
          element.textContent,
        ]),
      ),
    traps,
  };
};

/** composition-contract.md の segments の規則: 先頭が 0、隣どうしが厳密に一致、末尾が duration と厳密に一致。 */
export const assertSegmentsCover = (hf: Hf) => {
  const sorted = hf.segments.toSorted((a, b) => a.start - b.start);
  assert.isAbove(sorted.length, 0);
  assert.strictEqual(sorted[0]?.start, 0);
  sorted.forEach((segment, index) => {
    assert.isAbove(segment.duration, 0);
    const next = sorted[index + 1];
    const end = segment.start + segment.duration;
    if (next === undefined) {
      assert.strictEqual(end, hf.duration);
    } else {
      assert.strictEqual(end, next.start);
    }
  });
};

/** 時刻 t に seek した後の動く要素の opacity（数値）。 */
export const opacityAt = (page: CompositionPage, index: number, t: number) => {
  page.seek(t);
  return Number(page.motionOpacity(index));
};
