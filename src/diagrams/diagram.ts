import { Schema } from "effect";

import {
  isCodePoint,
  parseMarkup,
  type Attribute,
  type ElementNode,
  type MarkupNode,
} from "./markup.ts";

// 図解の契約（docs/reference/diagram-contract.md）の語彙と規則。語彙はこの定数が正で、文書はこれを写す。
export const beatAttribute = "data-beat";
export const dimAttribute = "data-dim";
export const enterAttribute = "data-enter";
export const fromAttribute = "data-from";

const vocabulary = new Set([beatAttribute, dimAttribute, enterAttribute, fromAttribute]);
const enterValues = ["fade", "slide", "pop"];
const fromValues = ["left", "right", "top", "bottom"];

/** tool が生成する名前の接頭辞。図解はこの接頭辞の id・class を使えない。 */
const reservedPrefix = "nc-";

const forbiddenElements = new Set([
  "script",
  "style",
  "iframe",
  "object",
  "embed",
  "frame",
  "frameset",
  "link",
  "meta",
  "base",
  "html",
  "head",
  "body",
  "title",
  "audio",
  "video",
  "animate",
  "animatemotion",
  "animatetransform",
  "set",
]);

const referenceAttributes = new Set(["src", "srcset", "poster"]);

/** 違反の規則名。失敗のタグと同じく codec が参照する契約。 */
const DiagramRule = Schema.Literals([
  "malformed",
  "missing",
  "forbidden-element",
  "event-handler",
  "external-reference",
  "wall-clock-animation",
  "unknown-attribute",
  "invalid-position",
  "position-out-of-range",
  "simultaneous-motion",
  "invalid-enter",
  "invalid-from",
  "dim-not-after-beat",
  "duplicate-id",
  "reserved-name",
]);
type DiagramRule = typeof DiagramRule.Type;

const ViolationSchema = Schema.Struct({
  attribute: Schema.optionalKey(Schema.String),
  element: Schema.optionalKey(Schema.String),
  line: Schema.optionalKey(Schema.Finite),
  rule: DiagramRule,
  scene: Schema.Finite,
  value: Schema.optionalKey(Schema.String),
});
export type Violation = typeof ViolationSchema.Type;

/** 図解の違反をすべて並べた 1 回の失敗。並びはシーンの昇順、その中は文書の順。 */
export class InvalidDiagrams extends Schema.TaggedError<InvalidDiagrams>()("InvalidDiagrams", {
  videoId: Schema.String,
  violations: Schema.Array(ViolationSchema),
}) {}

/** シーンの形: 段落ごとの句の数。位置が実在するかの検査の基準になる。 */
export type SceneShape = readonly number[];

type Found = Omit<Violation, "scene">;

const lower = (name: string) => name.toLowerCase();
const localName = (name: string) => lower(name).split(":").at(-1) ?? "";

const found = (rule: DiagramRule, element: ElementNode, attribute?: Attribute): Found => ({
  ...(attribute === undefined ? {} : { attribute: attribute.name, value: attribute.value }),
  element: element.name,
  line: element.line,
  rule,
});

const attributeOf = (element: ElementNode, name: string) =>
  element.attributes.find((attribute) => lower(attribute.name) === name);

// ---- 位置 ----

const positionPattern = /^([1-9][0-9]*)(?:\.([1-9][0-9]*))?$/u;

type ParsedPosition =
  | { readonly kind: "invalid" }
  | { readonly kind: "out-of-range" }
  | { readonly kind: "ok"; readonly paragraph: number; readonly phrase: number };

// 巨大な値でも落ちず、範囲外になるよう、数値にする前に BigInt で上限と比べる。
const withinRange = (shape: SceneShape, paragraph: string, phrase: string) => {
  const phrases = shape[Number(paragraph) - 1];
  return (
    BigInt(paragraph) <= BigInt(shape.length) &&
    phrases !== undefined &&
    BigInt(phrase) <= BigInt(phrases)
  );
};

/** `P`（段落の頭 = `P.1`）か `P.K`（P 段落目の K 番目の句）。 */
const parsePosition = (value: string, shape: SceneShape): ParsedPosition => {
  const match = positionPattern.exec(value);
  if (match === null) return { kind: "invalid" };
  const [, paragraph = "", phrase = "1"] = match;
  return withinRange(shape, paragraph, phrase)
    ? { kind: "ok", paragraph: Number(paragraph), phrase: Number(phrase) }
    : { kind: "out-of-range" };
};

const positionKey = ({ paragraph, phrase }: { paragraph: number; phrase: number }) =>
  `${paragraph}.${phrase}`;

const positionOrder = ({ paragraph, phrase }: { paragraph: number; phrase: number }) =>
  paragraph * 1_000_000_000 + phrase;

// ---- 要素・属性の規則 ----

const allowedReference = /^\s*(?:#|data:image\/)/iu;
const urlCall = /url\(\s*["']?\s*([^)"']*)/giu;
const animatedProperty = /(?:^|;)\s*(?:-[a-z]+-)?(?:animation|transition)/iu;
// ブラウザは、文字列・コメント・エスケープを 1 回の字句解析で区別する。判定も同じ形にそろえる。
//   - 文字列（"…" と '…'）の中は、コメントでもエスケープでもない。宣言名や url( を作らない
//   - コメントは空白に置き換える（閉じていないコメントは末尾まで）
//   - 文字列の外のエスケープ（`\61nimation`・`\75rl(`）は戻す。範囲外の数値のエスケープは U+FFFD にする
const cssToken =
  /("(?:\\[\s\S]|[^"\\])*"?|'(?:\\[\s\S]|[^'\\])*'?)|(\/\*[\s\S]*?(?:\*\/|$))|\\(?:([0-9a-fA-F]{1,6})[ \t\n\r\f]?|([^\n\r\f]))/gu;

const unescapedCss = (hex: string | undefined, other: string | undefined) => {
  if (hex === undefined) return other ?? "";
  const code = Number.parseInt(hex, 16);
  return isCodePoint(code) ? String.fromCodePoint(code) : "\uFFFD";
};

const cssText = (value: string, literal: (text: string) => string) =>
  value.replaceAll(
    cssToken,
    (_, text: string | undefined, comment: string | undefined, hex, other) => {
      if (text !== undefined) return literal(text);
      return comment === undefined ? unescapedCss(hex, other) : " ";
    },
  );

// 宣言の判定では文字列を空にする（`content: ';animation: x'` は宣言ではない）。url( の判定では url("…") の対象を読むので文字列を残す。
const isAnimated = (style: string) => animatedProperty.test(cssText(style, () => '""'));

// srcset は「URL 記述子, URL 記述子」の列。data: の URL にもカンマがあるので、カンマでは分けず、空白で分けた語のうち記述子（1x・100w）以外をすべて URL として検査する。
const descriptor = /^\d+(?:\.\d+)?[wx],?$/u;

const candidatesAllowed = (value: string) =>
  value
    .split(/\s+/u)
    .filter((word) => word !== "" && !descriptor.test(word))
    .every((word) => allowedReference.test(word));

const referenceAllowed = (name: string, value: string) =>
  name === "srcset" ? candidatesAllowed(value) : allowedReference.test(value);

const isReference = (name: string, value: string) =>
  (referenceAttributes.has(name) || localName(name) === "href") && !referenceAllowed(name, value);

// url( の直後の文字列だけが呼び出しの引数。それ以外の文字列（`content: 'url(...)'`）は表示するだけの字面なので、空にして探索から外す。
const stringPattern = /(url\(\s*)?("(?:\\[\s\S]|[^"\\])*"?|'(?:\\[\s\S]|[^'\\])*'?)/giu;
const urlCalls = (value: string) =>
  cssText(value, (text) => text).replaceAll(stringPattern, (whole, call?: string) =>
    call === undefined ? '""' : whole,
  );

// image-set() は、url() で包まない素の文字列も画像の URL として読む。その引数の中の文字列も参照として検査する。
const imageSetCall = /(?:-webkit-)?image-set\(/giu;
const cssString = /"(?:\\[\s\S]|[^"\\])*"?|'(?:\\[\s\S]|[^'\\])*'?/gu;
const stringOrParen = new RegExp(`${cssString.source}|[()]`, "gu");

// 呼び出しの引数の中で、括弧の深さ 1 にある文字列（引用符を外したもの）。文字列の中の括弧は数えない。閉じていなければ末尾まで。
const depthAfter = (depth: number, token: string) =>
  token === "(" ? depth + 1 : token === ")" ? depth - 1 : depth;

const stringArguments = (afterOpen: string): string[] => {
  let depth = 1;
  const tokens = [...afterOpen.matchAll(stringOrParen)].map(([token]) => {
    depth = depthAfter(depth, token);
    return { depth, token };
  });
  const closing = tokens.findIndex((token) => token.depth === 0);
  return (closing === -1 ? tokens : tokens.slice(0, closing))
    .filter(({ depth: at, token }) => at === 1 && token !== "(" && token !== ")")
    .map(({ token }) => token.replace(/^["']|["']$/gu, ""));
};

// 呼び出しは文字列の外でだけ探す（`content: 'image-set(...)'` は字面）。文字列を同じ長さで伏せた版で位置を決め、
// 引数は伏せない版の同じ位置から読む。文字列以外の部分は 2 つの版で同じなので、位置がそろう。
const imageSetStrings = (value: string): string[] => {
  const text = cssText(value, (literal) => literal);
  const masked = cssText(value, (literal) => " ".repeat(literal.length));
  return [...masked.matchAll(imageSetCall)].flatMap((call) =>
    stringArguments(text.slice((call.index ?? 0) + call[0].length)),
  );
};

const callsExternalUrl = (value: string) =>
  [...urlCalls(value).matchAll(urlCall)].some(
    ([, target = ""]) => !allowedReference.test(target),
  ) || imageSetStrings(value).some((target) => !allowedReference.test(target));

const isReservedName = (name: string, value: string) =>
  (name === "id" && lower(value).startsWith(reservedPrefix)) ||
  (name === "class" &&
    value.split(/\s+/u).some((token) => lower(token).startsWith(reservedPrefix)));

type AttributeRule = readonly [DiagramRule, (name: string, value: string) => boolean];

const attributeRules: readonly AttributeRule[] = [
  ["event-handler", (name) => name.startsWith("on")],
  ["external-reference", (name, value) => isReference(name, value) || callsExternalUrl(value)],
  ["wall-clock-animation", (name, value) => name === "style" && isAnimated(value)],
  ["unknown-attribute", (name) => name.startsWith("data-") && !vocabulary.has(name)],
  ["reserved-name", isReservedName],
];

const checkAttribute = (element: ElementNode, attribute: Attribute) =>
  attributeRules
    .filter(([, applies]) => applies(lower(attribute.name), attribute.value))
    .map(([rule]) => found(rule, element, attribute));

const invalidEnter = (element: ElementNode) => {
  const enter = attributeOf(element, enterAttribute);
  const hasBeat = attributeOf(element, beatAttribute) !== undefined;
  return enter !== undefined && !(enterValues.includes(enter.value) && hasBeat);
};

// slide には向きが要る（既定の向きは無い）。slide 以外には向きを書けない。
const invalidFrom = (element: ElementNode) => {
  const from = attributeOf(element, fromAttribute);
  const slides = attributeOf(element, enterAttribute)?.value === "slide";
  return from === undefined ? slides : !(fromValues.includes(from.value) && slides);
};

const checkVocabulary = (element: ElementNode): Found[] => [
  ...(invalidEnter(element)
    ? [found("invalid-enter", element, attributeOf(element, enterAttribute))]
    : []),
  ...(invalidFrom(element)
    ? [
        found(
          "invalid-from",
          element,
          attributeOf(element, fromAttribute) ?? attributeOf(element, enterAttribute),
        ),
      ]
    : []),
];

// ---- 動き（beat と dim）の規則 ----

interface Motion {
  readonly attribute: Attribute;
  readonly paragraph: number;
  readonly phrase: number;
}

const motionAttributes = [beatAttribute, dimAttribute];

const positionProblem = (element: ElementNode, attribute: Attribute, parsed: ParsedPosition) =>
  parsed.kind === "invalid"
    ? [found("invalid-position", element, attribute)]
    : [found("position-out-of-range", element, attribute)];

/** 位置の構文・範囲の違反と、検査に使える動きに分ける。 */
const readMotions = (element: ElementNode, shape: SceneShape) =>
  motionAttributes
    .map((name) => attributeOf(element, name))
    .filter((attribute): attribute is Attribute => attribute !== undefined)
    .map((attribute) => ({ attribute, parsed: parsePosition(attribute.value, shape) }));

const motionsOf = (read: ReturnType<typeof readMotions>): Motion[] =>
  read.flatMap(({ attribute, parsed }) => (parsed.kind === "ok" ? [{ attribute, ...parsed }] : []));

const dimBeforeBeat = (motions: readonly Motion[]) => {
  const beat = motions.find(({ attribute }) => lower(attribute.name) === beatAttribute);
  const dim = motions.find(({ attribute }) => lower(attribute.name) === dimAttribute);
  return beat !== undefined && dim !== undefined && positionOrder(dim) <= positionOrder(beat)
    ? dim
    : undefined;
};

/** 同時に動くのは 1 か所だけ: 同じ位置を 2 つの動きが指したら、2 つ目を違反にする。 */
const checkMotions = (element: ElementNode, shape: SceneShape, claimed: Set<string>): Found[] => {
  const read = readMotions(element, shape);
  const motions = motionsOf(read);
  const dimmed = dimBeforeBeat(motions);
  return [
    ...read.flatMap(({ attribute, parsed }) =>
      parsed.kind === "ok" ? [] : positionProblem(element, attribute, parsed),
    ),
    ...motions.flatMap((motion) =>
      claim(claimed, positionKey(motion))
        ? []
        : [found("simultaneous-motion", element, motion.attribute)],
    ),
    ...(dimmed === undefined ? [] : [found("dim-not-after-beat", element, dimmed.attribute)]),
  ];
};

// 位置を初めて使うなら true。使われていれば false。
const claim = (claimed: Set<string>, key: string) => {
  const fresh = !claimed.has(key);
  claimed.add(key);
  return fresh;
};

// ---- 文書全体 ----

type Visited = ElementNode | { readonly kind: "instruction"; readonly line: number };

const visit = (nodes: readonly MarkupNode[]): Visited[] =>
  nodes.flatMap((node) => {
    if (node.kind === "text") return [];
    return node.kind === "instruction" ? [node] : [node, ...visit(node.children)];
  });

interface Claims {
  readonly ids: Set<string>;
  readonly positions: Set<string>;
}

const checkId = (
  element: ElementNode,
  takenIds: ReadonlySet<string>,
  ids: Set<string>,
): Found[] => {
  const id = attributeOf(element, "id");
  if (id === undefined) return [];
  const duplicated = takenIds.has(id.value) || ids.has(id.value);
  ids.add(id.value);
  return duplicated ? [found("duplicate-id", element, id)] : [];
};

const checkElement = (
  node: Visited,
  shape: SceneShape,
  takenIds: ReadonlySet<string>,
  claims: Claims,
): Found[] => {
  if (node.kind === "instruction") {
    return [{ element: "?", line: node.line, rule: "forbidden-element" }];
  }
  return [
    ...(forbiddenElements.has(localName(node.name)) ? [found("forbidden-element", node)] : []),
    ...node.attributes.flatMap((attribute) => checkAttribute(node, attribute)),
    ...checkId(node, takenIds, claims.ids),
    ...checkVocabulary(node),
    ...checkMotions(node, shape, claims.positions),
  ];
};

export interface DiagramReview {
  /** 図解が使っている id（シーンをまたいだ重複の検査に使う）。 */
  readonly ids: readonly string[];
  readonly nodes: readonly MarkupNode[];
  readonly violations: readonly Violation[];
}

/**
 * 図解 1 枚を検査し、違反を文書の順にすべて集める（最初の違反で止めない）。
 * 整形式でなければ、壊れた木から検査を続けず `malformed` の 1 件だけを返す。
 * `takenIds` は、前のシーンの図解が使っている id（シーンをまたいだ重複を違反にする）。
 */
export const reviewDiagram = (
  html: string,
  scene: number,
  shape: SceneShape,
  takenIds: ReadonlySet<string> = new Set(),
): DiagramReview => {
  const parsed = parseMarkup(html);
  if (!parsed.ok) {
    return { ids: [], nodes: [], violations: [{ line: parsed.line, rule: "malformed", scene }] };
  }
  const claims: Claims = { ids: new Set(), positions: new Set() };
  const violations = visit(parsed.nodes)
    .flatMap((node) => checkElement(node, shape, takenIds, claims))
    .map((violation) => ({ ...violation, scene }));
  return { ids: [...claims.ids], nodes: parsed.nodes, violations };
};

/** そのシーンの図解が無い（組み立て時だけの違反）。 */
export const missingDiagram = (scene: number): Violation => ({ rule: "missing", scene });

/** 動く要素（beat か dim を持つ）か。組み立てが動きの番号を付ける対象。 */
export const isMotionElement = (element: ElementNode) =>
  motionAttributes.some((name) => attributeOf(element, name) !== undefined);

/** 要素の位置（`P` と `P.K`）を段落・句の番号にする。検査済みの図解だけに使う。 */
export const motionPosition = (element: ElementNode, name: string, shape: SceneShape) => {
  const attribute = attributeOf(element, name);
  const parsed = attribute === undefined ? undefined : parsePosition(attribute.value, shape);
  return parsed?.kind === "ok" ? { paragraph: parsed.paragraph, phrase: parsed.phrase } : undefined;
};
