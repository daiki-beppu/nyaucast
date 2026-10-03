// 図解の断片（XHTML と SVG）を、XML として整形式かを確かめながら木にし、HTML の規則で書き出す。
// 読むときは XML の規則（名前の大文字小文字を区別し、`<div/>` は空の要素）、書くときは HTML の規則（閉じタグを明示し、void 要素は閉じない）。
// この差が抜け道（`<Script>`・閉じない `<div/>`）にならないよう、検査は木に対して行い、出力も木から作る。

export interface Attribute {
  readonly name: string;
  readonly value: string;
}

export interface ElementNode {
  readonly attributes: readonly Attribute[];
  readonly children: readonly MarkupNode[];
  readonly kind: "element";
  readonly line: number;
  readonly name: string;
}

export interface TextNode {
  readonly kind: "text";
  readonly text: string;
}

export interface InstructionNode {
  readonly kind: "instruction";
  readonly line: number;
}

export type MarkupNode = ElementNode | InstructionNode | TextNode;

export type ParsedMarkup =
  | { readonly nodes: readonly MarkupNode[]; readonly ok: true }
  | { readonly line: number; readonly ok: false };

// コメント / CDATA / 処理命令 / 閉じタグ / 開きタグ（属性は引用符付きだけ）/ 本文。どれにも当たらない `<` は整形式でない。
const token =
  /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<\?[\s\S]*?\?>|<\/([^\s<>/]+)\s*>|<([A-Za-z_][^\s<>/]*)((?:\s+[^\s<>/=]+\s*=\s*(?:"[^"<]*"|'[^'<]*'))*)\s*(\/?)>|[^<]+/gy;
const attributePattern = /([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/gu;
const entityPattern = /&(?:(amp|lt|gt|quot|apos)|#(\d+)|#x([0-9a-fA-F]+));|&/gu;
const namedEntities: Record<string, string> = {
  amp: "&",
  apos: "'",
  gt: ">",
  lt: "<",
  quot: '"',
};

const lineAt = (source: string, index: number) => source.slice(0, index).split("\n").length;

export const isCodePoint = (code: number) =>
  code > 0 && code <= 0x10_ffff && (code < 0xd8_00 || code > 0xdf_ff);

const numericValue = ([whole, , decimal, hex]: RegExpMatchArray) => {
  const code = decimal === undefined ? Number.parseInt(hex ?? "", 16) : Number(decimal);
  return whole.startsWith("&#") && isCodePoint(code) ? String.fromCodePoint(code) : undefined;
};

const entityValue = (match: RegExpMatchArray) =>
  match[1] === undefined ? numericValue(match) : namedEntities[match[1]];

/** 実体参照を戻す。XML の 5 つと数値参照だけを受け、それ以外（`&nbsp;` や単独の `&`）なら undefined。 */
const decode = (text: string) => {
  const values = [...text.matchAll(entityPattern)].map(entityValue);
  if (values.includes(undefined)) return undefined;
  let next = 0;
  return text.replace(entityPattern, () => values[next++] ?? "");
};

const parseAttributes = (source: string) => {
  const attributes = [...source.matchAll(attributePattern)].map(
    ([, name = "", double, single]) => ({ name, value: decode(double ?? single ?? "") }),
  );
  const names = attributes.map((attribute) => attribute.name.toLowerCase());
  const distinct = new Set(names).size === names.length;
  return distinct && attributes.every((attribute) => attribute.value !== undefined)
    ? attributes.map(({ name, value }) => ({ name, value: value ?? "" }))
    : undefined;
};

interface Frame {
  readonly attributes: readonly Attribute[];
  readonly children: MarkupNode[];
  readonly line: number;
  readonly name: string;
}

interface Builder {
  failedAt: number | undefined;
  readonly roots: MarkupNode[];
  readonly stack: Frame[];
}

const append = (builder: Builder, node: MarkupNode) => {
  (builder.stack.at(-1)?.children ?? builder.roots).push(node);
};

const close = (builder: Builder) => {
  const frame = builder.stack.pop();
  if (frame !== undefined) append(builder, { ...frame, kind: "element" });
};

const open = (builder: Builder, match: RegExpMatchArray, line: number) => {
  const [, , , name = "", attributeSource = "", selfClosing] = match;
  const attributes = parseAttributes(attributeSource);
  if (attributes === undefined) {
    builder.failedAt = line;
    return;
  }
  builder.stack.push({ attributes, children: [], line, name });
  if (selfClosing === "/") close(builder);
};

const closeNamed = (builder: Builder, name: string, line: number) => {
  if (builder.stack.at(-1)?.name === name) close(builder);
  else builder.failedAt = line;
};

const text = (builder: Builder, raw: string, line: number) => {
  const decoded = decode(raw);
  if (decoded === undefined) builder.failedAt = line;
  else append(builder, { kind: "text", text: decoded });
};

// コメントは捨て、処理命令は検査で禁止するために木に残す。
const other = (builder: Builder, whole: string, line: number) => {
  if (whole.startsWith("<?")) append(builder, { kind: "instruction", line });
  else if (!whole.startsWith("<")) text(builder, whole, line);
};

const consume = (builder: Builder, match: RegExpMatchArray, line: number) => {
  const [whole, cdata, closing, opening] = match;
  if (cdata !== undefined) return append(builder, { kind: "text", text: cdata });
  if (closing !== undefined) return closeNamed(builder, closing, line);
  if (opening !== undefined) return open(builder, match, line);
  return other(builder, whole, line);
};

const feed = (builder: Builder, source: string, matches: readonly RegExpMatchArray[]) => {
  for (const match of matches) {
    if (builder.failedAt === undefined) consume(builder, match, lineAt(source, match.index ?? 0));
  }
};

const build = (source: string, matches: readonly RegExpMatchArray[]): ParsedMarkup => {
  const builder: Builder = { failedAt: undefined, roots: [], stack: [] };
  feed(builder, source, matches);
  const failedAt = builder.failedAt ?? builder.stack[0]?.line;
  return failedAt === undefined
    ? { nodes: builder.roots, ok: true }
    : { line: failedAt, ok: false };
};

// トークンが本文の終わりまで切れ目なく続いていなければ、続かなくなった位置が壊れている。
const reachedIndex = (matches: readonly RegExpMatchArray[]) => {
  const last = matches.at(-1);
  return last === undefined ? 0 : (last.index ?? 0) + last[0].length;
};

/** 断片を木にする。整形式でなければ、最初に壊れた行を返す（壊れた木から検査を続けない）。 */
export const parseMarkup = (source: string): ParsedMarkup => {
  const matches = [...source.matchAll(token)];
  const reached = reachedIndex(matches);
  return reached === source.length
    ? build(source, matches)
    : { line: lineAt(source, reached), ok: false };
};

const voidElements = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "source",
  "track",
  "wbr",
]);

const escapeText = (value: string) =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const escapeAttribute = (value: string) => escapeText(value).replaceAll('"', "&quot;");

const attributeHtml = ({ name, value }: Attribute) => ` ${name}="${escapeAttribute(value)}"`;

const nodeHtml = (node: MarkupNode): string => {
  if (node.kind === "text") return escapeText(node.text);
  if (node.kind === "instruction") return "";
  const open = `<${node.name}${node.attributes.map(attributeHtml).join("")}>`;
  return voidElements.has(node.name.toLowerCase())
    ? open
    : `${open}${node.children.map(nodeHtml).join("")}</${node.name}>`;
};

/** 木を HTML に書き出す。テキストと属性はエスケープし、void 要素以外は閉じタグを明示する。 */
export const markupHtml = (nodes: readonly MarkupNode[]) => nodes.map(nodeHtml).join("");
