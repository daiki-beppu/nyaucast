import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import { Layer } from "effect";
import { parse } from "yaml";

import { nyaucastCommand } from "../src/cli.ts";
import { CollectionToolkit, ExplainerToolkit } from "../src/mcp.ts";
import {
  unusedAuthLayer,
  unusedCloudflareLayer,
  unusedPostLayer,
  unusedVideoLayer,
} from "./helpers.ts";

const packageRoot = resolve(import.meta.dirname, "..");

export interface Violation {
  readonly file: string;
  readonly kind: "cli" | "frontmatter" | "layout" | "tag" | "tool";
  readonly subject: string;
}

/** CLI のコマンドの木。キーは "video produce" のような空白区切りのパス、値は子を持つか。 */
export type CliTree = ReadonlyMap<string, boolean>;

// ---- 既知の集合（出どころは実物の Toolkit・root Command・source） ----

export const knownToolNames = (): ReadonlySet<string> =>
  new Set([...Object.keys(ExplainerToolkit.tools), ...Object.keys(CollectionToolkit.tools)]);

type AnyCommand = ReturnType<typeof nyaucastCommand>;

const childrenOf = (command: { subcommands: AnyCommand["subcommands"] }) =>
  command.subcommands.flatMap((group) => [...group.commands]);

const walkCommands = (command: AnyCommand, path: string, tree: Map<string, boolean>) => {
  const children = childrenOf(command);
  tree.set(path, children.length > 0);
  for (const child of children) {
    walkCommands(child as AnyCommand, `${path} ${child.name}`, tree);
  }
};

export const knownCliTree = (): CliTree => {
  const tree = new Map<string, boolean>();
  const root = nyaucastCommand({
    auth: unusedAuthLayer,
    cloudflare: unusedCloudflareLayer,
    mcpServer: Layer.empty,
    post: unusedPostLayer,
    video: unusedVideoLayer,
  });
  walkCommands(root, root.name, tree);
  return tree;
};

const listSourceFiles = (directory: string): string[] =>
  readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      return listSourceFiles(path);
    }
    return path.endsWith(".ts") && !path.endsWith(".test.ts") ? [path] : [];
  });

const taggedErrorDefinition = /Schema\.TaggedError<\w+>\(\)\(\s*"(\w+)"/g;

export const knownFailureTags = (): ReadonlySet<string> => {
  const tags = new Set<string>();
  for (const file of listSourceFiles(join(packageRoot, "src"))) {
    for (const match of readFileSync(file, "utf8").matchAll(taggedErrorDefinition)) {
      tags.add(match[1] as string);
    }
  }
  return tags;
};

// ---- 本文の分解 ----

const fenceMarker = /^\s*(```|~~~)/;

// fence の開閉を 1 行ずつ進める。開いた種類と同じ marker で閉じ、別の種類の marker は中身として扱う。
const nextMarker = (marker: string | undefined, line: string): string | undefined => {
  if (!fenceMarker.test(line)) {
    return marker;
  }
  const opening = line.trim().slice(0, 3);
  if (marker === undefined) {
    return opening;
  }
  return marker === opening ? undefined : marker;
};

/** fence の外の行から inline code の中身を取り出す（fence の中の行は含めない）。 */
const inlineCodesOf = (text: string): string[] => {
  const proseLines: string[] = [];
  let marker: string | undefined;
  for (const line of text.split("\n")) {
    const next = nextMarker(marker, line);
    if (marker === undefined && next === undefined) {
      proseLines.push(line);
    }
    marker = next;
  }
  return [...proseLines.join("\n").matchAll(/`([^`\n]+)`/g)].map((match) => match[1] as string);
};

// ---- MCP tool 名 ----

const toolDomains = (known: ReadonlySet<string>) => [
  ...new Set([...known].map((name) => name.split("_")[0] as string)),
];

const literalCall = /Schema\.Literals?\(\s*(\[[^\]]*\]|"[^"]*")/g;

/** src の Schema.Literal(s) に書かれた文字列。`too_small` のような snake_case の値は tool 名ではない。 */
export const knownSchemaLiterals = (): ReadonlySet<string> => {
  const calls = listSourceFiles(join(packageRoot, "src")).flatMap((file) => [
    ...readFileSync(file, "utf8").matchAll(literalCall),
  ]);
  const values = calls.flatMap((call) => [...(call[1] as string).matchAll(/"([^"]*)"/g)]);
  return new Set(values.map((value) => value[1] as string));
};

/** 本文全体の snake_case の語のうち、実在する tool 名でも Schema のリテラルでもないものを返す。dotted の camelCase は常に実在しない扱い。 */
export const checkToolNames = (
  text: string,
  known: ReadonlySet<string>,
  literals: ReadonlySet<string>,
): string[] => {
  const domains = toolDomains(known);
  const snake = [...text.matchAll(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g)].map((match) => match[0]);
  const dotted = [
    ...text.matchAll(new RegExp(`\\b(?:${domains.join("|")})\\.[a-z]+[A-Z]\\w*`, "g")),
  ].map((match) => match[0]);
  return [...snake.filter((name) => !known.has(name) && !literals.has(name)), ...dotted];
};

// ---- CLI コマンド ----

const subcommandWord = /^[a-z][a-z0-9-]*$/;

// 本文のどこに書かれていても（地の文・inline code・fence）、`nyaucast` の後ろを改行・backtick・ASCII 以外の文字の手前まで読む。
const commandMentions = /\bnyaucast([^\n`\u0080-￿]*)/g;

const isSubcommandPosition = (
  word: string | undefined,
  path: string,
  tree: CliTree,
): word is string => word !== undefined && tree.get(path) === true && subcommandWord.test(word);

const violatingPath = (
  words: readonly string[],
  path: string,
  tree: CliTree,
): string | undefined => {
  const [word, ...rest] = words;
  if (!isSubcommandPosition(word, path, tree)) {
    return undefined;
  }
  const next = `${path} ${word}`;
  return tree.has(next) ? violatingPath(rest, next, tree) : next;
};

/** 本文に書かれた `nyaucast ...` を木にあてはめ、存在しないコマンドのパスを返す。 */
export const checkCliCommands = (text: string, tree: CliTree): string[] =>
  [...text.matchAll(commandMentions)].flatMap((mention) => {
    const words = (mention[1] as string).trim().split(/\s+/);
    const violation = violatingPath(words, "nyaucast", tree);
    return violation === undefined ? [] : [violation];
  });

// ---- 失敗のタグ ----

const tagShape = /^[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)+$/;

/** inline code の中身が失敗のタグの形で、実在しないものを返す。 */
export const checkFailureTags = (text: string, known: ReadonlySet<string>): string[] =>
  inlineCodesOf(text).filter((code) => tagShape.test(code) && !known.has(code));

// ---- frontmatter ----

const nameShape = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const maxNameLength = 64;
const maxDescriptionLength = 1024;
const allowedKeys = ["description", "name"];

// 1 行目と終端の行が、どちらも `---` だけの行であるときに限り frontmatter として受理する。
const frontmatterBlock = (content: string): string | undefined => {
  const lines = content.split("\n");
  const end = lines.indexOf("---", 1);
  return lines[0] === "---" && end !== -1 ? lines.slice(1, end).join("\n") : undefined;
};

const nameProblems = (name: string, directoryName: string): string[] => [
  ...(name === directoryName ? [] : [`name must equal the directory name ${directoryName}`]),
  ...(nameShape.test(name) && name.length <= maxNameLength
    ? []
    : ["name must be lowercase kebab-case within 64 characters"]),
];

const checkNameField = (name: unknown, directoryName: string): string[] =>
  typeof name === "string" ? nameProblems(name, directoryName) : ["name must be a string"];

const checkDescriptionField = (description: unknown): string[] => {
  if (typeof description !== "string" || description.trim() === "") {
    return ["description must be a non-empty string"];
  }
  return description.length > maxDescriptionLength
    ? ["description must be within 1024 characters"]
    : [];
};

const isMapping = (value: unknown): value is object =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** SKILL.md の先頭の frontmatter が規定の形か。違反の理由を返す。 */
export const checkFrontmatter = (content: string, directoryName: string): string[] => {
  const block = frontmatterBlock(content);
  if (block === undefined) {
    return ["frontmatter must start on the first line with --- and be closed with ---"];
  }
  const parsed: unknown = parse(block);
  if (!isMapping(parsed)) {
    return ["frontmatter must be a mapping"];
  }
  const extra = Object.keys(parsed).filter((key) => !allowedKeys.includes(key));
  return [
    ...extra.map((key) => `unexpected key ${key}`),
    ...checkNameField(Reflect.get(parsed, "name"), directoryName),
    ...checkDescriptionField(Reflect.get(parsed, "description")),
  ];
};

// ---- skills/ 全体 ----

const isDirectory = (path: string) => statSync(path).isDirectory();

const listMarkdown = (directory: string): string[] =>
  readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    if (isDirectory(path)) {
      return listMarkdown(path);
    }
    return path.endsWith(".md") ? [path] : [];
  });

/** skills/ の直下は codec のディレクトリだけで、それぞれが SKILL.md を持つこと。 */
const checkLayout = (skillsRoot: string): Violation[] =>
  readdirSync(skillsRoot).flatMap((entry) => {
    const path = join(skillsRoot, entry);
    const valid = isDirectory(path) && readdirSync(path).includes("SKILL.md");
    return valid ? [] : [{ file: path, kind: "layout" as const, subject: entry }];
  });

const checkSkillFrontmatter = (skillsRoot: string, skill: string): Violation[] => {
  const file = join(skillsRoot, skill, "SKILL.md");
  return checkFrontmatter(readFileSync(file, "utf8"), skill).map((subject) => ({
    file,
    kind: "frontmatter" as const,
    subject,
  }));
};

export interface KnownNames {
  readonly cli: CliTree;
  readonly literals: ReadonlySet<string>;
  readonly tags: ReadonlySet<string>;
  readonly tools: ReadonlySet<string>;
}

export const knownNames = (): KnownNames => ({
  cli: knownCliTree(),
  literals: knownSchemaLiterals(),
  tags: knownFailureTags(),
  tools: knownToolNames(),
});

const checkMarkdown = (file: string, known: KnownNames): Violation[] => {
  const text = readFileSync(file, "utf8");
  const tag = (kind: Violation["kind"], subjects: string[]) =>
    subjects.map((subject) => ({ file, kind, subject }));
  return [
    ...tag("tool", checkToolNames(text, known.tools, known.literals)),
    ...tag("cli", checkCliCommands(text, known.cli)),
    ...tag("tag", checkFailureTags(text, known.tags)),
  ];
};

/** skillsRoot 配下のすべての codec を検査し、違反を返す。 */
export const checkCodecs = (skillsRoot: string, known: KnownNames): Violation[] => {
  const layout = checkLayout(skillsRoot);
  const valid = readdirSync(skillsRoot).filter(
    (entry) => !layout.some((violation) => violation.subject === entry),
  );
  return [
    ...layout,
    ...valid.flatMap((skill) => checkSkillFrontmatter(skillsRoot, skill)),
    ...valid.flatMap((skill) =>
      listMarkdown(join(skillsRoot, skill)).flatMap((file) => checkMarkdown(file, known)),
    ),
  ];
};

export const skillsRootOfPackage = join(packageRoot, "skills");
