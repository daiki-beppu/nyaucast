import { describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { parse } from "yaml";

import { packageRoot, withTemporaryDirectory } from "./helpers";

// REQ-70-01 / REQ-70-03 / REQ-70-04 / REQ-70-05 / REQ-70-06
// TC-70-01A / TC-70-01B / TC-70-03A / TC-70-03B / TC-70-04A / TC-70-04B / TC-70-05A / TC-70-05B / TC-70-06A
const subprocessTimeoutMilliseconds = 20_000;
const invalidCheckScriptMessage =
  "check script must contain only bun run commands joined by &&";
const ciCheckCommand = "nix develop --command bun run check";
const prePushCommands = {
  check: "bun run check",
  "workflow-doctor": "takt workflow doctor",
} as const;

type FacetCommandScope =
  | { container: "root" }
  | {
      container: "ordered-list-item";
      introduction: string;
      ordinal: number;
    };

const rootFacetCommandScope = { container: "root" } as const;
const completionGateInstruction = "完了前に、CI と同一の検査ゲートを通す:";
const expectedLockfileCheckCommand =
  "bun install --frozen-lockfile --dry-run --ignore-scripts";
const lockfileName = "bun.lock";
const prepareSentinelName = "prepare-ran";

/**
 * 「ローカルで CI を再現する」を指示する facet。
 *
 * `tayk-write-tests.md` / `tayk-reproduce.md` はここに含めない。あの 2 つの `bun test` は
 * ゲートの再現ではなく **red の観測**（ADR-0008 決定 5 / 9 / 10）であり、まだ実装が無い状態で
 * 全ゲートを通すことは設計上できない。
 */
const gateInstructingFacets = [
  {
    commandScope: rootFacetCommandScope,
    path: ".takt/facets/policies/tayk-toolchain.md",
    sectionHeading: "## 検査ゲート",
  },
  {
    commandScope: {
      container: "ordered-list-item",
      introduction: completionGateInstruction,
      ordinal: 4,
    },
    path: ".takt/facets/instructions/tayk-implement.md",
    sectionHeading: "## 手順",
  },
  {
    commandScope: {
      container: "ordered-list-item",
      introduction: completionGateInstruction,
      ordinal: 6,
    },
    path: ".takt/facets/instructions/tayk-repair.md",
    sectionHeading: "## 手順",
  },
] as const;
const replanMonitorInstructionPath =
  ".takt/facets/instructions/tayk-loop-monitor-replan.md";
const planContractPath = ".takt/facets/output-contracts/tayk-plan.md";

/**
 * ゲート集合の複製を検出する表記。`test` は red 観測にも使うため対象外。
 *
 * `lint` だけ後読みで絞るのは、`lint:fix` が fix 系でありゲートの複製ではないため。
 * 末尾改行で代用すると、行末以外に現れた `bun run lint` を取りこぼす。
 */
const enumeratedGateCommands = [
  /bun run typecheck/,
  /bun run lint(?![\w:-])/,
  /bun run format:check/,
  /bun run fallow/,
] as const;

setDefaultTimeout(60_000);

function requireRecord(
  value: unknown,
  description: string
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${description} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireRecordProperty(
  record: Record<string, unknown>,
  property: string,
  description: string
): Record<string, unknown> {
  return requireRecord(record[property], description);
}

function requireArrayProperty(
  record: Record<string, unknown>,
  property: string,
  description: string
): unknown[] {
  const value = record[property];
  if (!Array.isArray(value)) {
    throw new TypeError(`${description} must be an array`);
  }
  return value;
}

function parseYamlRecord(
  source: string,
  description: string
): Record<string, unknown> {
  const parsed: unknown = parse(source);
  return requireRecord(parsed, description);
}

function readStepRun(
  step: Record<string, unknown>,
  description: string
): string | undefined {
  const run = step["run"];
  if (run !== undefined && typeof run !== "string") {
    throw new TypeError(`${description}.run must be a string`);
  }
  return run;
}

function extractJobSteps(
  steps: readonly unknown[],
  description: string
): Record<string, unknown>[] {
  return steps.map((step, index) => {
    const stepDescription = `${description}[${index}]`;
    const stepRecord = requireRecord(step, stepDescription);
    readStepRun(stepRecord, stepDescription);
    return stepRecord;
  });
}

function extractJobs(
  jobs: Record<string, unknown>
): Map<
  string,
  { record: Record<string, unknown>; steps: Record<string, unknown>[] }
> {
  return new Map(
    Object.entries(jobs).map(([jobName, job]) => {
      const jobRecord = requireRecord(job, `jobs.${jobName}`);
      const steps = jobRecord["steps"];
      const jobSteps =
        steps === undefined
          ? []
          : extractJobSteps(
              requireArrayProperty(jobRecord, "steps", `jobs.${jobName}.steps`),
              `jobs.${jobName}.steps`
            );
      return [jobName, { record: jobRecord, steps: jobSteps }];
    })
  );
}

function validateCiWorkflow(source: string): void {
  const workflow = parseYamlRecord(source, "workflow");
  const jobs = requireRecordProperty(workflow, "jobs", "jobs");
  const parsedJobs = extractJobs(jobs);
  const qualityJob = parsedJobs.get("quality");

  if (qualityJob === undefined || "if" in qualityJob.record) {
    throw new Error(`jobs.quality.steps must run ${ciCheckCommand}`);
  }

  const checkStep = qualityJob.steps.find(
    (step, index) =>
      readStepRun(step, `jobs.quality.steps[${index}]`) === ciCheckCommand &&
      !("if" in step)
  );
  if (checkStep === undefined) {
    throw new Error(`jobs.quality.steps must run ${ciCheckCommand}`);
  }

  for (const [jobName, job] of parsedJobs) {
    for (const [index, step] of job.steps.entries()) {
      const command = readStepRun(step, `jobs.${jobName}.steps[${index}]`);
      if (command === undefined) {
        continue;
      }
      if (enumeratedGateCommands.some((gate) => gate.test(command))) {
        throw new Error("CI jobs must not run individual gates");
      }
    }
  }
}

const hookExecutionLimitProperties = [
  "exclude",
  "exclude_tags",
  "files",
  "only",
  "skip",
] as const;
const commandExecutionLimitProperties = [
  "exclude",
  "file_types",
  "files",
  "glob",
  "only",
  "skip",
  "tags",
] as const;

function rejectExecutionLimits(
  record: Record<string, unknown>,
  properties: readonly string[],
  description: string
): void {
  const property = properties.find((candidate) => candidate in record);
  if (property !== undefined) {
    throw new Error(`${description}.${property} must not limit execution`);
  }
}

function readCommand(
  commands: Record<string, unknown>,
  commandName: keyof typeof prePushCommands
): Record<string, unknown> {
  const command = requireRecordProperty(
    commands,
    commandName,
    `pre-push.commands.${commandName}`
  );
  rejectExecutionLimits(
    command,
    commandExecutionLimitProperties,
    `pre-push.commands.${commandName}`
  );
  return command;
}

function readCommandRun(
  command: Record<string, unknown>,
  commandName: keyof typeof prePushCommands
): string {
  const run = command["run"];
  if (typeof run !== "string") {
    throw new TypeError(
      `pre-push.commands.${commandName}.run must be a string`
    );
  }
  return run;
}

function validatePrePushConfiguration(source: string): void {
  const configuration = parseYamlRecord(source, "lefthook configuration");
  const prePush = requireRecordProperty(configuration, "pre-push", "pre-push");
  rejectExecutionLimits(prePush, hookExecutionLimitProperties, "pre-push");
  const commands = requireRecordProperty(
    prePush,
    "commands",
    "pre-push.commands"
  );

  for (const [commandName, expectedRun] of Object.entries(prePushCommands)) {
    if (
      readCommandRun(
        readCommand(commands, commandName as keyof typeof prePushCommands),
        commandName as keyof typeof prePushCommands
      ) !== expectedRun
    ) {
      throw new Error(`pre-push.commands.${commandName}.run is invalid`);
    }
  }
}

interface Fence {
  containsCommands: boolean;
  indentation: number;
  marker: "`" | "~";
  minimumLength: number;
}

interface ListItem {
  contentIndentation: number;
  introduction: string;
  ordinal: number | null;
}

const shellFenceLanguages = new Set(["bash", "sh", "shell", "zsh"]);

function readFenceOpening(line: string): Fence | null {
  const match = /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(line);
  if (match === null) {
    return null;
  }
  const indentation = match[1];
  const delimiter = match[2];
  const infoString = match[3];
  if (
    indentation === undefined ||
    delimiter === undefined ||
    infoString === undefined
  ) {
    throw new Error("fence opening is invalid");
  }
  const language = infoString.trim().split(/\s+/, 1)[0]?.toLowerCase() ?? "";
  return {
    containsCommands: language === "" || shellFenceLanguages.has(language),
    indentation: indentation.length,
    marker: delimiter[0] as Fence["marker"],
    minimumLength: delimiter.length,
  };
}

function isFenceClosing(line: string, fence: Fence): boolean {
  const match = /^ {0,3}(`+|~+)[ \t]*$/.exec(line);
  const delimiter = match?.[1];
  return (
    delimiter !== undefined &&
    delimiter.startsWith(fence.marker) &&
    delimiter.length >= fence.minimumLength
  );
}

function readHeading(line: string): { level: number; text: string } | null {
  const match = /^(#{1,6})(?:[ \t]+(.*)|[ \t]*)$/.exec(line);
  if (match === null) {
    return null;
  }
  const marker = match[1];
  const rawText = match[2];
  if (marker === undefined) {
    throw new Error("facet heading is invalid");
  }
  const text = (rawText ?? "")
    .trim()
    .replace(/[ \t]+#+[ \t]*$/, "")
    .trimEnd();
  if (text === "") {
    return null;
  }
  return { level: marker.length, text };
}

function readListItem(line: string): ListItem | null {
  const ordered = /^(\d{1,9})[.)]([ \t]+)(.*)$/.exec(line);
  if (ordered !== null) {
    const ordinal = ordered[1];
    const whitespace = ordered[2];
    const introduction = ordered[3];
    if (
      ordinal === undefined ||
      whitespace === undefined ||
      introduction === undefined
    ) {
      throw new Error("ordered list item is invalid");
    }
    return {
      contentIndentation: ordinal.length + 1 + whitespace.length,
      introduction: introduction.trim(),
      ordinal: Math.trunc(Number(ordinal)),
    };
  }

  const unordered = /^[-+*]([ \t]+)(.*)$/.exec(line);
  const whitespace = unordered?.[1];
  const introduction = unordered?.[2];
  if (whitespace === undefined || introduction === undefined) {
    return null;
  }
  return {
    contentIndentation: 1 + whitespace.length,
    introduction: introduction.trim(),
    ordinal: null,
  };
}

function updateListItem(
  line: string,
  listItem: ListItem | null,
  nextListItem: ListItem | null
): ListItem | null {
  if (nextListItem !== null) {
    return nextListItem;
  }
  if (line.trim() === "" || listItem === null) {
    return listItem;
  }
  const indentation = line.length - line.trimStart().length;
  return indentation < listItem.contentIndentation ? null : listItem;
}

function matchesCommandScopeListItem(
  listItem: ListItem,
  commandScope: FacetCommandScope
): boolean {
  return (
    commandScope.container === "ordered-list-item" &&
    listItem.ordinal === commandScope.ordinal &&
    listItem.introduction === commandScope.introduction
  );
}

function matchesCommandScopeOrdinal(
  listItem: ListItem,
  commandScope: FacetCommandScope
): boolean {
  return (
    commandScope.container === "ordered-list-item" &&
    listItem.ordinal === commandScope.ordinal
  );
}

function isFenceInCommandScope(
  fence: Fence,
  listItem: ListItem | null,
  commandScope: FacetCommandScope
): boolean {
  if (commandScope.container === "root") {
    return listItem === null && fence.indentation === 0;
  }
  return (
    listItem !== null &&
    matchesCommandScopeListItem(listItem, commandScope) &&
    fence.indentation === listItem.contentIndentation
  );
}

function shouldCollectCommands(
  inSection: boolean,
  fence: Fence,
  listItem: ListItem | null,
  commandScope: FacetCommandScope
): boolean {
  return (
    inSection &&
    fence.containsCommands &&
    isFenceInCommandScope(fence, listItem, commandScope)
  );
}

function appendCommandBlock(
  commandBlocks: string[][],
  commandLines: string[] | null
): string[][] {
  if (commandLines === null) {
    return commandBlocks;
  }
  return [...commandBlocks, commandLines.filter((command) => command !== "")];
}

function countCommandScopeListItem(
  inSection: boolean,
  listItem: ListItem | null,
  commandScope: FacetCommandScope
): { items: number; ordinals: number } {
  if (!inSection || listItem === null) {
    return { items: 0, ordinals: 0 };
  }
  return {
    items: matchesCommandScopeListItem(listItem, commandScope) ? 1 : 0,
    ordinals: matchesCommandScopeOrdinal(listItem, commandScope) ? 1 : 0,
  };
}

function validateFacetCommandScope(
  sectionHeading: string,
  commandScope: FacetCommandScope,
  matchingItems: number,
  matchingOrdinals: number
): void {
  if (commandScope.container === "root") {
    return;
  }
  if (matchingItems !== 1 || matchingOrdinals !== 1) {
    throw new Error(
      `${sectionHeading} must contain exactly one command instruction item`
    );
  }
}

function extractFacetCommandBlocks(
  source: string,
  sectionHeading: string,
  commandScope: FacetCommandScope
): string[][] {
  const lines = source.split(/\r?\n/);
  const expectedHeading = readHeading(sectionHeading);
  if (expectedHeading === null) {
    throw new Error("facet section heading is invalid");
  }

  let commandBlocks: string[][] = [];
  let commandLines: string[] | null = null;
  let fence: Fence | null = null;
  let inComment = false;
  let inSection = false;
  let listItem: ListItem | null = null;
  let matchingCommandScopeItems = 0;
  let matchingCommandScopeOrdinals = 0;
  for (const line of lines) {
    if (inComment) {
      if (line.includes("-->")) {
        inComment = false;
      }
      continue;
    }

    if (fence !== null && isFenceClosing(line, fence)) {
      commandBlocks = appendCommandBlock(commandBlocks, commandLines);
      commandLines = null;
      fence = null;
      continue;
    }
    if (fence !== null) {
      if (commandLines !== null) {
        commandLines.push(line.trim());
      }
      continue;
    }

    if (line.includes("<!--")) {
      inComment = !line.includes("-->");
      continue;
    }

    const nextListItem = readListItem(line);
    listItem = updateListItem(line, listItem, nextListItem);
    const scopeCounts = countCommandScopeListItem(
      inSection,
      nextListItem,
      commandScope
    );
    matchingCommandScopeItems += scopeCounts.items;
    matchingCommandScopeOrdinals += scopeCounts.ordinals;

    const opening = readFenceOpening(line);
    if (opening !== null) {
      fence = opening;
      commandLines = shouldCollectCommands(
        inSection,
        opening,
        listItem,
        commandScope
      )
        ? []
        : null;
      continue;
    }

    const heading = readHeading(line);
    if (heading === null) {
      continue;
    }
    if (
      heading.level === expectedHeading.level &&
      heading.text === expectedHeading.text
    ) {
      inSection = true;
      continue;
    }
    if (inSection) {
      break;
    }
  }

  if (fence !== null) {
    throw new Error(`facet section ${sectionHeading} has an unclosed fence`);
  }
  if (!inSection) {
    throw new Error(`facet section ${sectionHeading} is missing`);
  }
  validateFacetCommandScope(
    sectionHeading,
    commandScope,
    matchingCommandScopeItems,
    matchingCommandScopeOrdinals
  );
  return commandBlocks;
}

function validateFacetGate(
  source: string,
  sectionHeading: string,
  commandScope: FacetCommandScope
): void {
  const commandBlocks = extractFacetCommandBlocks(
    source,
    sectionHeading,
    commandScope
  );
  if (
    !commandBlocks.some(
      (commands) => commands.length === 1 && commands[0] === "bun run check"
    )
  ) {
    throw new Error(`${sectionHeading} must run bun run check`);
  }
  for (const command of enumeratedGateCommands) {
    if (
      commandBlocks.some((commands) =>
        commands.some((line) => command.test(line))
      )
    ) {
      throw new Error(`${sectionHeading} must not run individual gates`);
    }
  }
}

function withCheckFixture(run: (directory: string) => void): void {
  withTemporaryDirectory("tayk-check-", run);
}

function readRepositoryFile(relativePath: string): string {
  return readFileSync(join(packageRoot, relativePath), "utf-8");
}

function readSection(markdown: string, heading: string): string {
  const start = markdown.indexOf(`${heading}\n`);
  if (start === -1) {
    throw new Error(`missing section: ${heading}`);
  }

  const contentStart = start + heading.length + 1;
  const nextHeading = markdown.indexOf("\n## ", contentStart);
  return markdown.slice(
    contentStart,
    nextHeading === -1 ? markdown.length : nextHeading
  );
}

function normalizeMarkdownText(value: string): string {
  return value.replaceAll("**", "").replaceAll(/\s+/g, " ").trim();
}

function readMarkdownTableRows(markdown: string): string[][] {
  const rows = markdown
    .split("\n")
    .filter((line) => line.trim().startsWith("|"))
    .map((line) =>
      line.trim().slice(1, -1).split("|").map(normalizeMarkdownText)
    );

  if (
    rows.length < 2 ||
    rows[1] === undefined ||
    !rows[1].every((cell) => /^:?-{3,}:?$/.test(cell))
  ) {
    throw new Error("missing markdown table");
  }

  return rows.slice(2);
}

function readDefinitionRows(
  markdown: string
): { definition: string; term: string }[] {
  return [...markdown.matchAll(/^(?:- )?\*\*([^*\r\n]+)\*\*: (.+)$/gm)].map(
    (match) => {
      const term = match[1];
      const definition = match[2];

      if (term === undefined || definition === undefined) {
        throw new Error("invalid definition row");
      }

      return {
        definition: normalizeMarkdownText(definition),
        term: normalizeMarkdownText(term),
      };
    }
  );
}

function readNumberedDecision(markdown: string, number: number): string {
  const prefix = `${number}. `;
  const line = markdown
    .split("\n")
    .find((candidate) => candidate.startsWith(prefix));

  if (line === undefined) {
    throw new Error(`missing decision: ${number}`);
  }

  return normalizeMarkdownText(line.slice(prefix.length));
}

function readCodecReleaseStatements(markdown: string): string[] {
  return markdown
    .split("。")
    .map(normalizeMarkdownText)
    .filter((sentence) => sentence.includes("codec"));
}

function extractBacktickPaths(markdown: string, prefix: string): string[] {
  return [...markdown.matchAll(/`([^`\r\n]+)`/g)]
    .map((match) => match[1])
    .filter((path): path is string => path?.startsWith(prefix) === true);
}

function listAdrPaths(): string[] {
  return readdirSync(join(packageRoot, "docs/adr"))
    .filter((name) => /^\d{4}-.*\.md$/.test(name))
    .toSorted()
    .map((name) => `docs/adr/${name}`);
}

function assertDomainArchitectureContract(markdown: string): void {
  const terms = readSection(markdown, "## 中核用語");
  const avoidedTerms = readSection(markdown, "## 禁止語（`_Avoid_`）");

  expect(readDefinitionRows(terms)).toEqual([
    {
      definition:
        "tayk が expose する型付き操作。agent が直接呼ぶ第一級インターフェース。primitive tool 1 層と、local store への読み口で構成される。ドット表記 (`benchmark.collect`) が正書で、MCP wire 名はアンダースコア変換した `benchmark_collect`。",
      term: "MCP tool",
    },
    {
      definition:
        "単一操作の細粒度 tool。`audio.master` / `thumbnail.generate` 等",
      term: "primitive tool",
    },
    {
      definition:
        "廃止された粗粒度の MCP tool。区間を歩くのは knowledge codec を読んだ agent であり、tool ではない",
      term: "workflow tool",
    },
    {
      definition:
        "core の MCP tool を各プロトコルへ橋渡しする薄いラッパ。MCP (primary) と CLI (`tayk <cmd>`) の 2 本。",
      term: "adapter",
    },
    {
      definition:
        "「いつ・どの MCP tool を・どう使うか」の知識パッケージ。tool の description が WHAT、codec が WHEN/HOW。5 本構成。",
      term: "knowledge codec",
    },
    {
      definition:
        "1 本の YouTube 動画としてまとめられる楽曲群とその成果物一式。",
      term: "collection",
    },
    {
      definition:
        "`TTP 収集・分析 → 企画 →[GO/NO-GO]→ サムネ生成 →[GO/NO-GO]→ 音源生成 → MIX/マスタリング → 動画生成 → upload → 公開後運用`。",
      term: "collection lifecycle",
    },
    {
      definition:
        "「徹底的にパクる」。benchmark チャンネルの当たりパターンを分析し自チャンネルの企画へ転写する戦略。分析に留まらず転写までを含む。",
      term: "TTP",
    },
    {
      definition:
        "`<CHANNEL_DIR>/data/local.db` の libSQL embedded DB。時系列データとコレクション状態 (②) の SSOT。",
      term: "local store",
    },
    {
      definition:
        "local store が兼ねる読み取り専用クエリ面。① ④ のミラーを含むが SSOT ではない。",
      term: "read model",
    },
    {
      definition:
        "ADR-0001 を確定させるために最初に end-to-end で通す垂直スライス = plan 区間。",
      term: "tracer",
    },
    {
      definition:
        "first-party 2 リポで collection フルライフサイクル 1 周を tayk だけで実走させる受け入れ検証。`v0.1.0` の唯一のリリースゲート。",
      term: "dogfood",
    },
    {
      definition:
        "リリースをブロックする欠陥は 3 種のみ — ①誤公開・誤メタデータ ②データ破壊 ③auth 破壊。これ以外はブロックせず issue 化する。",
      term: "critical regression",
    },
  ]);
  expect(
    readMarkdownTableRows(avoidedTerms).filter((row) =>
      row.some((cell) => cell.includes("tool"))
    )
  ).toEqual([["workflow tool", "primitive tool"]]);
}

function assertAdrReviewTerminologyContract(markdown: string): void {
  const terminology = readSection(markdown, "## 用語（CONTEXT.md）");

  expect(readMarkdownTableRows(terminology)).toEqual([
    [
      "`<対象ファイル>`",
      "workflow tool",
      "廃止済み。primitive tool 1 層と事実だけを返す読み口を使う",
    ],
  ]);
}

function assertDesignArchitectureContract(markdown: string): void {
  const procedure = readSection(markdown, "## 手順");

  expect(readMarkdownTableRows(procedure)).toEqual([
    [
      "要求の充足",
      "要件 ID ごとの方針が、その要件を実際に満たすか。方針が抽象すぎて実装が一意に決まらない箇所はないか",
    ],
    [
      "責務の配置",
      "業務ロジックが core にあり、adapter が薄いままか。MCP tool が primitive tool 1 層で、読み口が事実だけを返すか",
    ],
    [
      "データの流れ",
      "入出力の型が決まっているか。SSOT が データ 4 分類 のどれに当たるかが明示されているか",
    ],
    [
      "失敗の設計",
      "失敗経路が設計されているか。エラーが内部 throw → 境界変換になっているか",
    ],
    [
      "変更の広がり",
      "1 要件の実装が想定外に多くのファイルへ波及していないか。波及するなら、その必然性が説明されているか",
    ],
    [
      "未来への負債",
      "いま入れると後で剥がしにくくなる構造（暗黙の状態・グローバル・双方向依存）がないか",
    ],
  ]);
}

function assertAgentCodecReleaseContract(markdown: string): void {
  const scope = readSection(markdown, "## v0.1.0 のスコープ");

  expect(readCodecReleaseStatements(scope)).toEqual([
    "`collection-lifecycle` codec は v0.1 の中心成果物とする",
    "それ以外（自チャンネル実績分析 / dashboard / Remotion / `collection-lifecycle` 以外の codec）は v0.2 以降に 1 リリース 1 テーマで直列に積む",
  ]);
}

function readPackageScripts(): Record<string, string> {
  const parsed: unknown = JSON.parse(readRepositoryFile("package.json"));

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("package.json must contain a JSON object");
  }

  const scripts = (parsed as Record<string, unknown>)["scripts"];

  if (
    typeof scripts !== "object" ||
    scripts === null ||
    Array.isArray(scripts)
  ) {
    throw new Error("package.json must declare a scripts object");
  }

  return Object.fromEntries(
    Object.entries(scripts as Record<string, unknown>).map(
      ([name, command]) => {
        if (typeof command !== "string") {
          throw new TypeError(`script ${name} must be a string`);
        }
        return [name, command];
      }
    )
  );
}

function tokenizeCheckScript(checkScript: string): string[][] {
  const shellWord =
    /(?:[^\s'"\\;&|<>#$`()?*[\]{}~]+|'[^'\r\n]*'|"(?:\\[^\r\n]|[^"\\$`\r\n])*"|\\[^\r\n])+/y;
  const commands: string[][] = [];
  let command: string[] = [];
  let index = 0;

  while (index < checkScript.length) {
    const whitespace = /^[ \t]+/.exec(checkScript.slice(index));
    if (whitespace !== null) {
      index += whitespace[0].length;
      continue;
    }

    if (checkScript.startsWith("&&", index)) {
      if (command.length === 0) {
        throw new Error(invalidCheckScriptMessage);
      }
      commands.push(command);
      command = [];
      index += 2;
      continue;
    }

    shellWord.lastIndex = index;
    const word = shellWord.exec(checkScript);
    if (word === null) {
      throw new Error(invalidCheckScriptMessage);
    }
    command.push(word[0]);
    index = shellWord.lastIndex;
  }

  if (command.length === 0) {
    throw new Error(invalidCheckScriptMessage);
  }
  commands.push(command);
  return commands;
}

function decodeShellWord(word: string): string {
  let decoded = "";
  let quote: "'" | '"' | null = null;

  for (let index = 0; index < word.length; index += 1) {
    const character = word[index];
    if (character === "'" && quote !== '"') {
      quote = quote === "'" ? null : "'";
      continue;
    }
    if (character === '"' && quote !== "'") {
      quote = quote === '"' ? null : '"';
      continue;
    }
    if (character === "\\" && quote !== "'") {
      const escaped = word[index + 1];
      if (escaped === undefined) {
        throw new Error(invalidCheckScriptMessage);
      }
      decoded +=
        quote !== '"' || '$`"\\'.includes(escaped) ? escaped : `\\${escaped}`;
      index += 1;
      continue;
    }
    decoded += character;
  }

  return decoded;
}

function deriveExpectedGateNames(checkScript: string | undefined): string[] {
  if (checkScript === undefined || checkScript.trim() === "") {
    throw new Error(invalidCheckScriptMessage);
  }

  return tokenizeCheckScript(checkScript).map((command) => {
    const executable = command[0];
    const subcommand = command[1];
    const rawGateName = command[2];

    if (
      executable === undefined ||
      subcommand === undefined ||
      decodeShellWord(executable) !== "bun" ||
      decodeShellWord(subcommand) !== "run" ||
      rawGateName === undefined
    ) {
      throw new Error(invalidCheckScriptMessage);
    }

    const gateName = decodeShellWord(rawGateName);
    if (gateName === "" || gateName.startsWith("-")) {
      throw new Error(invalidCheckScriptMessage);
    }

    return gateName;
  });
}

function quoteShellArgument(argument: string): string {
  return `'${argument.replaceAll("'", "'\\''")}'`;
}

function createFacetFixture(
  sectionHeading: string,
  sectionBody: readonly string[],
  beforeSection: readonly string[] = [],
  afterSection: readonly string[] = []
): string {
  return [
    "# Fixture",
    ...beforeSection,
    sectionHeading,
    ...sectionBody,
    "## 次の節",
    ...afterSection,
    "",
  ].join("\n");
}

/**
 * 本物の `check` を各ゲートの stub に対して走らせる fixture を作る。
 *
 * `check` は `bun run test` を含むため、リポジトリ本体でそのまま実行すると
 * このテスト自身を経由して無限に再帰する。合成（順序と fail-fast）だけを見る。
 */
function createCheckFixture(
  directory: string,
  checkScript: string
): Record<string, string> {
  const gateNames = deriveExpectedGateNames(checkScript);

  writeFileSync(
    join(directory, "record.ts"),
    `import { appendFileSync, readFileSync } from "node:fs";

const gate = process.argv[2];
const recordPath = process.env["TAYK_GATE_RECORD"];
const failingIndex = process.env["TAYK_FAILING_INDEX"];

if (gate === undefined || recordPath === undefined || failingIndex === undefined) {
  throw new Error("gate recorder requires a gate, record path, and failing index");
}

const recordedGates = readFileSync(recordPath, "utf-8");
const executionIndex =
  recordedGates === "" ? 0 : recordedGates.split("\\n").length - 1;
appendFileSync(recordPath, \`\${gate}\\n\`);
process.exit(failingIndex === executionIndex.toString() ? 1 : 0);
`
  );

  const scripts = Object.fromEntries([
    ["check", checkScript],
    ...gateNames.map(
      (gate) => [gate, `bun record.ts ${quoteShellArgument(gate)}`] as const
    ),
  ]);

  writeFileSync(
    join(directory, "package.json"),
    `${JSON.stringify({ name: "tayk-check-fixture", private: true, scripts, type: "module", version: "0.0.0" }, null, 2)}\n`
  );

  return scripts;
}

function runCheck(
  directory: string,
  failingIndex: number | null
): { exitCode: number | null; executedGates: string[] } {
  const recordPath = join(directory, "gates.log");
  writeFileSync(recordPath, "");

  const result = Bun.spawnSync([process.execPath, "run", "check"], {
    cwd: directory,
    env: {
      ...process.env,
      TAYK_FAILING_INDEX: failingIndex === null ? "" : failingIndex.toString(),
      TAYK_GATE_RECORD: recordPath,
    },
    killSignal: "SIGKILL",
    stderr: "pipe",
    stdout: "pipe",
    timeout: subprocessTimeoutMilliseconds,
  });

  if (result.exitedDueToTimeout === true) {
    throw new Error(
      `check timed out\nstdout:\n${result.stdout.toString()}\nstderr:\n${result.stderr.toString()}`
    );
  }

  return {
    executedGates: readFileSync(recordPath, "utf-8")
      .split("\n")
      .filter((line) => line !== ""),
    exitCode: result.exitCode,
  };
}

interface LockfileCheckFixture {
  bunEnvironment: Record<string, string | undefined>;
  expectedFollowingGates: string[];
  lockfileBeforeCheck: string;
  recordPath: string;
}

interface LockfileCheckResult {
  executedGates: string[];
  exitCode: number | null;
  stderr: string;
}

function createIsolatedBunEnvironment(
  directory: string
): Record<string, string | undefined> {
  const configDirectory = join(directory, "bun-config");
  const cacheDirectory = join(directory, "bun-cache");
  mkdirSync(configDirectory);
  mkdirSync(cacheDirectory);

  return {
    ...process.env,
    BUN_INSTALL_CACHE_DIR: cacheDirectory,
    XDG_CONFIG_HOME: configDirectory,
  };
}

function runBunInstallForLockfile(
  directory: string,
  bunEnvironment: Record<string, string | undefined>
): void {
  const result = Bun.spawnSync(
    [process.execPath, "install", "--lockfile-only", "--ignore-scripts"],
    {
      cwd: directory,
      env: bunEnvironment,
      killSignal: "SIGKILL",
      stderr: "pipe",
      stdout: "pipe",
      timeout: subprocessTimeoutMilliseconds,
    }
  );

  if (result.exitedDueToTimeout === true || result.exitCode !== 0) {
    throw new Error(
      `lockfile fixture generation failed\nstdout:\n${result.stdout.toString()}\nstderr:\n${result.stderr.toString()}`
    );
  }
}

function writeGateRecorder(directory: string): void {
  writeFileSync(
    join(directory, "record.ts"),
    `import { appendFileSync } from "node:fs";

const gate = process.argv[2];
const recordPath = process.env["TAYK_GATE_RECORD"];

if (gate === undefined || recordPath === undefined) {
  throw new Error("gate recorder requires a gate and record path");
}

appendFileSync(recordPath, \`\${gate}\\n\`);
`
  );
}

function createLocalDependency(
  directory: string,
  dependencyName: string
): string {
  const dependencyDirectory = join(directory, dependencyName);
  mkdirSync(dependencyDirectory);
  writeFileSync(
    join(dependencyDirectory, "package.json"),
    `${JSON.stringify({ name: dependencyName, version: "1.0.0" }, null, 2)}\n`
  );
  return `file:./${dependencyName}`;
}

function createLockfileCheckFixture(
  directory: string,
  makeManifestInconsistent: boolean
): LockfileCheckFixture {
  const repositoryScripts = readPackageScripts();
  const checkScript = repositoryScripts["check"];
  const lockfileCheckCommand = repositoryScripts["lockfile:check"];

  if (checkScript === undefined || lockfileCheckCommand === undefined) {
    throw new Error(
      "package.json must declare check and lockfile:check scripts"
    );
  }

  const gateNames = deriveExpectedGateNames(checkScript);
  const expectedFollowingGates = gateNames.slice(1);
  const recordPath = join(directory, "gates.log");
  const scripts = Object.fromEntries([
    ["prepare", `bun -e "Bun.write('${prepareSentinelName}', '')"`],
    ["check", checkScript],
    ["lockfile:check", lockfileCheckCommand],
    ...expectedFollowingGates.map(
      (gate) => [gate, `bun record.ts ${quoteShellArgument(gate)}`] as const
    ),
  ]);
  const currentDependencyName = "fixture-current-local-dependency";
  const currentDependencyReference = createLocalDependency(
    directory,
    currentDependencyName
  );
  const packageManifest = {
    dependencies: {
      [currentDependencyName]: currentDependencyReference,
    },
    name: "tayk-lockfile-check-fixture",
    private: true,
    scripts,
    type: "module",
    version: "0.0.0",
  };

  writeGateRecorder(directory);
  writeFileSync(recordPath, "");
  writeFileSync(
    join(directory, "package.json"),
    `${JSON.stringify(packageManifest, null, 2)}\n`
  );

  const bunEnvironment = createIsolatedBunEnvironment(directory);
  runBunInstallForLockfile(directory, bunEnvironment);
  const lockfileBeforeCheck = readFileSync(
    join(directory, lockfileName),
    "latin1"
  );

  if (makeManifestInconsistent) {
    const addedDependencyName = "fixture-added-local-dependency";
    const addedDependencyReference = createLocalDependency(
      directory,
      addedDependencyName
    );
    writeFileSync(
      join(directory, "package.json"),
      `${JSON.stringify(
        {
          ...packageManifest,
          dependencies: {
            ...packageManifest.dependencies,
            [addedDependencyName]: addedDependencyReference,
          },
        },
        null,
        2
      )}\n`
    );
  }

  return {
    bunEnvironment,
    expectedFollowingGates,
    lockfileBeforeCheck,
    recordPath,
  };
}

function runLockfileCheckFixture(
  directory: string,
  fixture: LockfileCheckFixture
): LockfileCheckResult {
  const result = Bun.spawnSync([process.execPath, "run", "check"], {
    cwd: directory,
    env: {
      ...fixture.bunEnvironment,
      TAYK_GATE_RECORD: fixture.recordPath,
    },
    killSignal: "SIGKILL",
    stderr: "pipe",
    stdout: "pipe",
    timeout: subprocessTimeoutMilliseconds,
  });

  if (result.exitedDueToTimeout === true) {
    throw new Error(
      `lockfile check timed out\nstdout:\n${result.stdout.toString()}\nstderr:\n${result.stderr.toString()}`
    );
  }

  return {
    executedGates: readFileSync(fixture.recordPath, "utf-8")
      .split("\n")
      .filter((line) => line !== ""),
    exitCode: result.exitCode,
    stderr: result.stderr.toString(),
  };
}

function expectLockfileFixtureStateUnchanged(
  directory: string,
  lockfileBeforeCheck: string
): void {
  expect(existsSync(join(directory, "node_modules"))).toBeFalse();
  expect(existsSync(join(directory, prepareSentinelName))).toBeFalse();
  expect(readFileSync(join(directory, lockfileName), "latin1")).toBe(
    lockfileBeforeCheck
  );
}

describe("check command", () => {
  // REQ-114-01 / REQ-114-02 / TC-114-01A
  test("should run every check-derived gate exactly once in declaration order", () => {
    const checkScript = readPackageScripts()["check"];

    if (checkScript === undefined) {
      throw new Error("package.json must declare a check script");
    }

    const expectedGates = deriveExpectedGateNames(checkScript);

    withCheckFixture((directory) => {
      createCheckFixture(directory, checkScript);

      const result = runCheck(directory, null);

      expect(result).toEqual({
        executedGates: expectedGates,
        exitCode: 0,
      });
    });
  });

  // REQ-114-02 / TC-114-02B
  test("should stop at each failing position in the check-derived gate sequence", () => {
    const checkScript = readPackageScripts()["check"];

    if (checkScript === undefined) {
      throw new Error("package.json must declare a check script");
    }

    const derivedGates = deriveExpectedGateNames(checkScript);

    for (const failingIndex of derivedGates.keys()) {
      withCheckFixture((directory) => {
        createCheckFixture(directory, checkScript);

        const result = runCheck(directory, failingIndex);
        const expectedPrefix = derivedGates.slice(0, failingIndex + 1);

        expect(result.exitCode).not.toBe(0);
        expect(result.executedGates).toEqual(expectedPrefix);
      });
    }
  });

  // REQ-114-03 / TC-114-03A
  test.each([
    ["bun run alpha", ["alpha"]],
    ["bun run __proto__", ["__proto__"]],
    [
      " \tbun   run alpha --flag && bun run added argument\t ",
      ["alpha", "added"],
    ],
    [
      `bun run alpha --label "quality && gate" "left || right" "left \\| right" "a;b" "&" && bun run beta 'literal;value'`,
      ["alpha", "beta"],
    ],
    ["bun run alpha escaped\\|pipe", ["alpha"]],
    [
      `b\\un "run" "alpha'beta" "say \\"hi\\"" '$() is literal'`,
      ["alpha'beta"],
    ],
    [
      `bun run "alpha*beta" '?' '[a]' '{left,right}' '~' escaped\\* escaped\\? escaped\\[a\\] escaped\\{left,right\\} escaped\\~`,
      ["alpha*beta"],
    ],
  ])(
    "should follow the gates derived from %p without fixture changes",
    (checkScript, expectedGates) => {
      withCheckFixture((directory) => {
        const scripts = createCheckFixture(directory, checkScript);

        const result = runCheck(directory, null);

        expect(Object.keys(scripts)).toEqual([
          "check",
          ...new Set(expectedGates),
        ]);
        expect(result).toEqual({
          executedGates: expectedGates,
          exitCode: 0,
        });
      });
    }
  );

  // REQ-114-01 / TC-114-01B / TC-114-01C
  test.each([
    [undefined],
    [""],
    ["   "],
    ["bun run"],
    ['bun run ""'],
    ["bun run --silent"],
    ["bun run -b alpha"],
    ["&& bun run alpha"],
    ["bun run alpha &&"],
    ["bun run alpha && && bun run beta"],
    ["bun run alpha && echo skipped"],
    ["bun run alpha || bun run beta"],
    ["bun run alpha | bun run beta"],
    ["bun run alpha & bun run beta"],
    ["bun run alpha; bun run beta"],
    ["bun run alpha\nbun run beta"],
    ["bun run alpha > ignored"],
    ["bun run alpha < input"],
    ["bun run alpha $(echo injected)"],
    ["bun run alpha `echo injected`"],
    ["bun run alpha # ignored"],
    ['bun run alpha "unterminated'],
    ["bun run alpha 'unterminated"],
    ["bun run alpha dangling\\"],
    ["bun run alpha $EXPANDED_ARGUMENT"],
    ["bun run alpha (echo nested)"],
    ["bun run *"],
    ["bun run alpha ?"],
    ["bun run [a]*"],
    ["bun run ~"],
    ["bun run {alpha,beta}"],
  ])(
    "should reject an invalid check script before fixture creation",
    (checkScript) => {
      expect(() => deriveExpectedGateNames(checkScript)).toThrow(
        "check script must contain only bun run commands joined by &&"
      );
    }
  );

  // REQ-114-03 / TC-114-03B
  test("should fail each repeated script occurrence by its position", () => {
    const repeatedGates = ["typecheck", "lint", "typecheck"];
    const checkScript = repeatedGates
      .map((gate) => `bun run ${gate}`)
      .join(" && ");

    for (const failingIndex of repeatedGates.keys()) {
      withCheckFixture((directory) => {
        createCheckFixture(directory, checkScript);

        const result = runCheck(directory, failingIndex);
        const expectedPrefix = repeatedGates.slice(0, failingIndex + 1);

        expect(result.exitCode).not.toBe(0);
        expect(result.executedGates).toEqual(expectedPrefix);
      });
    }
  });

  // REQ-114-03 / TC-114-03C
  test("should stop at a failing __proto__ script", () => {
    const gates = ["alpha", "__proto__", "beta"];
    const checkScript = gates.map((gate) => `bun run ${gate}`).join(" && ");

    withCheckFixture((directory) => {
      createCheckFixture(directory, checkScript);

      const result = runCheck(directory, 1);

      expect(result.exitCode).not.toBe(0);
      expect(result.executedGates).toEqual(["alpha", "__proto__"]);
    });
  });

  // REQ-106-01 / TC-106-01A
  test("should reject a stale lockfile without changing dependency state", () => {
    expect(readPackageScripts()["lockfile:check"]).toBe(
      expectedLockfileCheckCommand
    );

    withCheckFixture((directory) => {
      const fixture = createLockfileCheckFixture(directory, true);

      const result = runLockfileCheckFixture(directory, fixture);
      const normalizedStderr = result.stderr.toLowerCase();

      expect(result.exitCode).not.toBe(0);
      expect(normalizedStderr).toContain("lockfile");
      expect(normalizedStderr).toMatch(
        /(frozen[\s\S]*(change|update)|(change|update)[\s\S]*frozen)/
      );
      expectLockfileFixtureStateUnchanged(
        directory,
        fixture.lockfileBeforeCheck
      );
    });
  });

  // REQ-106-03 / TC-106-03A
  test("should place lockfile:check first in the check-derived gate sequence", () => {
    const checkScript = readPackageScripts()["check"];

    expect(deriveExpectedGateNames(checkScript)[0]).toBe("lockfile:check");
  });

  // REQ-106-03 / TC-106-03B
  test("should stop before every following gate when lockfile validation fails", () => {
    withCheckFixture((directory) => {
      const fixture = createLockfileCheckFixture(directory, true);

      const result = runLockfileCheckFixture(directory, fixture);

      expect(result.exitCode).not.toBe(0);
      expect(result.executedGates).toEqual([]);
      expectLockfileFixtureStateUnchanged(
        directory,
        fixture.lockfileBeforeCheck
      );
    });
  });

  // REQ-106-04 / TC-106-04A
  test("should continue through every following gate when the lockfile is current", () => {
    withCheckFixture((directory) => {
      const fixture = createLockfileCheckFixture(directory, false);

      const result = runLockfileCheckFixture(directory, fixture);

      expect(result.exitCode).toBe(0);
      expect(result.executedGates).toEqual(fixture.expectedFollowingGates);
      expectLockfileFixtureStateUnchanged(
        directory,
        fixture.lockfileBeforeCheck
      );
    });
  });

  // REQ-82-02 / REQ-106-01 / REQ-106-02 / TC-106-01C / TC-106-02A
  test("should leave the gate set undefined outside package.json", () => {
    const workflow = readRepositoryFile(".github/workflows/ci.yml");

    expect(() => {
      validateCiWorkflow(workflow);
    }).not.toThrow();
    expect(workflow).toContain(ciCheckCommand);
    expect(workflow).not.toMatch(/\bbun\s+install\b/);
    expect(workflow).not.toContain("--frozen-lockfile");
    for (const command of enumeratedGateCommands) {
      expect(workflow).not.toMatch(command);
    }
  });

  // REQ-82-03 / REQ-106-01 / TC-106-01B
  test("should run the gates before push", () => {
    const configuration = readRepositoryFile("lefthook.yml");

    expect(() => {
      validatePrePushConfiguration(configuration);
    }).not.toThrow();
  });

  // REQ-82-04
  test("should point takt facets at the single gate command", () => {
    for (const facetContract of gateInstructingFacets) {
      const facet = readRepositoryFile(facetContract.path);

      expect(() => {
        validateFacetGate(
          facet,
          facetContract.sectionHeading,
          facetContract.commandScope
        );
      }).not.toThrow();
    }
  });

  // REQ-82-05
  test("should keep fix scripts on the rule set of their checking counterpart", () => {
    const scripts = readPackageScripts();
    const lint = scripts["lint"] ?? "";
    const lintFix = scripts["lint:fix"] ?? "";
    const formatCheck = scripts["format:check"] ?? "";
    const formatFix = scripts["format:fix"] ?? "";

    expect(lint).toContain("--type-aware");
    expect(lintFix).toContain("--type-aware");
    expect(lintFix).toContain("--config oxlint.config.ts");
    expect(formatCheck.endsWith(" .")).toBeTrue();
    expect(formatFix.endsWith(" .")).toBeTrue();
  });
});

describe("Issue #84 agent-facing architecture contracts", () => {
  // REQ-84-01 / TC-01
  test("should index every current ADR and define the tracer as the plan interval", () => {
    const knowledge = readRepositoryFile(".takt/facets/knowledge/tayk-adr.md");
    const index = readSection(knowledge, "## 判定前に必ず読むファイル");
    const decisionSeven = readSection(
      knowledge,
      "## ADR-0001 の決定に対する違反パターン"
    );

    const indexedAdrs = extractBacktickPaths(index, "docs/adr/")
      .filter((path) => path.endsWith(".md"))
      .toSorted();

    expect(indexedAdrs).toEqual(listAdrPaths());
    expect(readMarkdownTableRows(decisionSeven).at(-1)).toEqual([
      "決定 7（tracer 完走までの規約確定・黙って逸脱しない）",
      "tracer（plan 区間）未完走の段階で追加の制約を課す。ADR を改訂せずに逸脱する",
    ]);
  });

  // REQ-84-02 / TC-02
  test("should define one primitive tool layer, factual reads, and the plan tracer", () => {
    const knowledge = readRepositoryFile(
      ".takt/facets/knowledge/tayk-domain.md"
    );

    assertDomainArchitectureContract(knowledge);
  });

  // REQ-84-04 / TC-04
  test("should keep ADR-0001 provisional until the plan interval tracer completes", () => {
    const adr = readRepositoryFile("docs/adr/0001-thin-architecture.md");
    const decision = readSection(adr, "## Decision");
    const consequences = readSection(adr, "## Consequences");
    const tracerConsequences = consequences
      .split("\n")
      .filter((line) => line.startsWith("- ") && line.includes("tracer"))
      .map((line) => normalizeMarkdownText(line.slice(2)));

    expect(readNumberedDecision(decision, 7)).toBe(
      "本規約の確定は tracer（plan 区間）の end-to-end 完走をもって行う。tracer 実装中に破綻した項目は本 ADR を改訂して直す（黙って逸脱しない）"
    );
    expect(tracerConsequences).toEqual([
      "tracer（plan 区間）が本規約の最初の適用対象。ディレクトリ規約（`src/tools/<domain>.<name>.ts` 等）は tracer 実装で確定させ、本 ADR に追記する",
    ]);
  });

  // REQ-84-05 / TC-05
  test("should reserve v0.1 for collection-lifecycle and defer other codecs", () => {
    const instructions = readRepositoryFile("AGENTS.md");

    assertAgentCodecReleaseContract(instructions);
  });

  // REQ-84-06 / TC-06
  test("should use only a neutral implementation target in the plan contract", () => {
    const contract = readRepositoryFile(
      ".takt/facets/output-contracts/tayk-plan.md"
    );
    const implementationPlan = readSection(contract, "## 実装方針");

    expect(
      readMarkdownTableRows(implementationPlan).map((row) => row[1])
    ).toEqual(["`<対象ファイル>`"]);
  });

  // REQ-84-07 / TC-07
  test("should use only neutral implementation and test targets in test design", () => {
    const contract = readRepositoryFile(
      ".takt/facets/output-contracts/tayk-test-design.md"
    );
    const cases = readSection(contract, "## 要件 ↔ テストケース対応");
    const placement = readSection(contract, "## テストファイル配置");

    expect(readMarkdownTableRows(cases).map((row) => row[3])).toEqual([
      "`<対象ファイル>`",
    ]);
    expect(
      readMarkdownTableRows(placement).map((row) => row.slice(0, 2))
    ).toEqual([["`<テストファイル>`", "`<対象ファイル>`"]]);
  });

  // REQ-84-09 / TC-09
  test("should give ADR reviewers the current index and primitive tool terminology", () => {
    const contract = readRepositoryFile(
      ".takt/facets/output-contracts/tayk-adr-conformance-review.md"
    );
    const index = readSection(contract, "## 照合した ADR");
    const evidence = readSection(
      contract,
      "## 再走査証跡（2回目以降のレビューで必須）"
    );

    const indexedAdrs = extractBacktickPaths(index, "docs/adr/")
      .filter((path) => path.endsWith(".md"))
      .toSorted();

    expect(indexedAdrs).toEqual(listAdrPaths());
    assertAdrReviewTerminologyContract(contract);
    expect(readMarkdownTableRows(evidence)).toEqual([
      ["ADR-0001 決定 1", "`<対象ファイル>`（1 ファイルに凝集）"],
    ]);
  });

  // REQ-84-10 / TC-10
  test("should review designs against primitive tools and factual reads", () => {
    const instruction = readRepositoryFile(
      ".takt/facets/instructions/tayk-review-design-arch.md"
    );

    assertDesignArchitectureContract(instruction);
  });

  // REQ-84-11 / TC-21
  test("should keep the codec release boundary in ADR knowledge", () => {
    const knowledge = readRepositoryFile(".takt/facets/knowledge/tayk-adr.md");
    const scope = readSection(knowledge, "## スコープの規律");

    expect(readCodecReleaseStatements(scope)).toEqual([
      "その中心成果物は `collection-lifecycle` codec とする",
      "これに不要な拡張（自チャンネル実績分析 / dashboard / Remotion / `collection-lifecycle` 以外の 4 本の codec）は v0.2 以降へ送る",
    ]);
  });

  test("should reject an alias orchestration layer in the domain definitions", () => {
    const knowledge = readRepositoryFile(
      ".takt/facets/knowledge/tayk-domain.md"
    );
    const contradictoryKnowledge = knowledge.replace(
      "**knowledge codec**:",
      "- **orchestration layer**: primitive tool を束ねる粗粒度の現行層\n\n**knowledge codec**:"
    );

    expect(() => {
      assertDomainArchitectureContract(contradictoryKnowledge);
    }).toThrow();
  });

  test("should reject a contradictory workflow tool recommendation", () => {
    const contract = readRepositoryFile(
      ".takt/facets/output-contracts/tayk-adr-conformance-review.md"
    );
    const contradictoryContract = contract.replace(
      "| `<対象ファイル>` | workflow tool | 廃止済み。primitive tool 1 層と事実だけを返す読み口を使う |",
      "| `<対象ファイル>` | workflow tool | 廃止済み。primitive tool 1 層と事実だけを返す読み口を使う |\n| `<別の対象>` | orchestration tool | primitive tool を束ねる現行推奨層 |"
    );

    expect(() => {
      assertAdrReviewTerminologyContract(contradictoryContract);
    }).toThrow();
  });

  test("should reject an additional coarse-grained tool review layer", () => {
    const instruction = readRepositoryFile(
      ".takt/facets/instructions/tayk-review-design-arch.md"
    );
    const contradictoryInstruction = instruction.replace(
      "| データの流れ | 入出力の型が決まっているか。",
      "| データの流れ | orchestration tool が primitive tool を束ねる現行層か。入出力の型が決まっているか。"
    );

    expect(() => {
      assertDesignArchitectureContract(contradictoryInstruction);
    }).toThrow();
  });

  test("should reject collection-lifecycle from the deferred codec set", () => {
    const instructions = readRepositoryFile("AGENTS.md");
    const contradictoryInstructions = instructions.replace(
      "**それ以外（自チャンネル実績分析 / dashboard / Remotion / `collection-lifecycle` 以外の codec）は v0.2 以降**に 1 リリース 1 テーマで直列に積む。",
      "**それ以外（自チャンネル実績分析 / dashboard / Remotion / `collection-lifecycle` 以外の codec）は v0.2 以降**に 1 リリース 1 テーマで直列に積む。`collection-lifecycle` codec は v0.2 以降へ送る。"
    );

    expect(() => {
      assertAgentCodecReleaseContract(contradictoryInstructions);
    }).toThrow();
  });
});

describe("replan monitor report boundary", () => {
  // REQ-121-01 / TC-121-01 / P-121-01
  test("should use only parent-visible reports as monitor inputs", () => {
    const instruction = readRepositoryFile(replanMonitorInstructionPath);

    expect(instruction).not.toContain("intake-brief.md");
    expect(instruction).not.toContain("実装ブリーフ");
    expect(instruction).toContain("Report Directory 内の `plan.md`");
  });

  // REQ-121-02 / TC-121-02 / P-121-02
  test("should read unresolved issue details from the plan handoff", () => {
    const instruction = readRepositoryFile(replanMonitorInstructionPath);

    expect(instruction).toContain(
      "`plan.md` の「ブリーフからの引き継ぎ」に記録された issue の未決事項"
    );
  });

  // REQ-121-03 / TC-121-03 / P-121-03
  test("should require every intake handoff in the plan contract", () => {
    const contract = readRepositoryFile(planContractPath);
    const handoffSection = /## ブリーフからの引き継ぎ[\s\S]*?(?=\n## )/.exec(
      contract
    )?.[0];

    expect(handoffSection).toBeDefined();
    expect(handoffSection).toContain("確定している決定");
    expect(handoffSection).toContain("制約");
    expect(handoffSection).toContain("ブリーフの対象外");
    expect(contract).toContain("「ブリーフからの引き継ぎ」も省略不可");
  });

  // REQ-121-04 / TC-121-04 / P-121-04
  test("should keep callable child report exploration out of the instruction", () => {
    const instruction = readRepositoryFile(replanMonitorInstructionPath);

    expect(instruction).not.toMatch(/(?:intake-brief\.md|実装ブリーフ)/);
  });
});

describe("check entry structure", () => {
  // REQ-115-01 / TC-115-01A
  test("should accept the check entry when the quality job runs the exact command", () => {
    const workflow = readRepositoryFile(".github/workflows/ci.yml");

    expect(() => {
      validateCiWorkflow(workflow);
    }).not.toThrow();
  });

  // REQ-115-01 / TC-115-01B
  test.each([
    ["is missing", "jobs:\n  quality: {}\n"],
    ["is null", "jobs:\n  quality:\n    steps: null\n"],
    ["is an object", "jobs:\n  quality:\n    steps: {}\n"],
    ["is a string", "jobs:\n  quality:\n    steps: invalid\n"],
  ])(
    "should reject the CI contract when quality steps %s",
    (_condition, workflow) => {
      expect(() => {
        validateCiWorkflow(workflow);
      }).toThrow();
    }
  );

  // REQ-115-01 / TC-115-01C
  test.each([
    ["is missing", "jobs:\n  quality:\n    steps:\n      - name: Check\n"],
    ["is null", "jobs:\n  quality:\n    steps:\n      - run: null\n"],
    [
      "is an array",
      "jobs:\n  quality:\n    steps:\n      - run: [nix, develop]\n",
    ],
    [
      "is an object",
      "jobs:\n  quality:\n    steps:\n      - run: { command: check }\n",
    ],
  ])(
    "should reject the CI check entry when its run value %s",
    (_condition, workflow) => {
      expect(() => {
        validateCiWorkflow(workflow);
      }).toThrow();
    }
  );

  // REQ-115-01 / TC-115-01D
  test("should contain no individual gate commands when inspecting every real CI job", () => {
    const workflow = readRepositoryFile(".github/workflows/ci.yml");

    expect(() => {
      validateCiWorkflow(workflow);
    }).not.toThrow();
  });

  // REQ-115-01 / TC-115-01E
  test("should reject an individual gate command when another CI job runs it", () => {
    const workflow = [
      "jobs:",
      "  quality:",
      "    steps:",
      "      - run: nix develop --command bun run check",
      "  other:",
      "    steps:",
      "      - run: bun run typecheck",
      "",
    ].join("\n");

    expect(() => {
      validateCiWorkflow(workflow);
    }).toThrow();
  });

  // REQ-115-01 / TC-115-01F
  test("should ignore an individual gate command when it appears only in a CI comment", () => {
    const workflow = [
      "jobs:",
      "  quality:",
      "    steps:",
      "      - run: nix develop --command bun run check",
      "  # bun run typecheck",
      "",
    ].join("\n");

    expect(() => {
      validateCiWorkflow(workflow);
    }).not.toThrow();
  });

  // REQ-115-01 / TC-115-01G
  test.each([
    [
      "quality job",
      [
        "jobs:",
        "  quality:",
        "    if: false",
        "    steps:",
        "      - run: nix develop --command bun run check",
        "",
      ].join("\n"),
    ],
    [
      "check step",
      [
        "jobs:",
        "  quality:",
        "    steps:",
        "      - if: false",
        "        run: nix develop --command bun run check",
        "",
      ].join("\n"),
    ],
  ])(
    "should reject check execution limited by if on the %s",
    (_place, workflow) => {
      expect(() => {
        validateCiWorkflow(workflow);
      }).toThrow();
    }
  );

  // REQ-115-02 / TC-115-02A
  test("should accept pre-push when check and workflow doctor use their exact commands", () => {
    const configuration = readRepositoryFile("lefthook.yml");

    expect(() => {
      validatePrePushConfiguration(configuration);
    }).not.toThrow();
  });

  // REQ-115-02 / TC-115-02B
  test("should reject pre-push when check and workflow doctor commands are swapped", () => {
    const configuration = [
      "pre-push:",
      "  commands:",
      "    check:",
      "      run: takt workflow doctor",
      "    workflow-doctor:",
      "      run: bun run check",
      "",
    ].join("\n");

    expect(() => {
      validatePrePushConfiguration(configuration);
    }).toThrow();
  });

  // REQ-115-02 / TC-115-02C
  test.each([
    [
      "check",
      [
        "pre-push:",
        "  commands:",
        "    workflow-doctor:",
        "      run: takt workflow doctor",
        "",
      ].join("\n"),
    ],
    [
      "workflow-doctor",
      [
        "pre-push:",
        "  commands:",
        "    check:",
        "      run: bun run check",
        "",
      ].join("\n"),
    ],
  ])(
    "should reject pre-push when the %s command is missing",
    (_command, configuration) => {
      expect(() => {
        validatePrePushConfiguration(configuration);
      }).toThrow();
    }
  );

  // REQ-115-02 / TC-115-02D
  test.each([
    ["pre-push is null", "pre-push: null\n"],
    ["pre-push is an array", "pre-push: []\n"],
    ["commands is missing", "pre-push: {}\n"],
    ["commands is null", "pre-push:\n  commands: null\n"],
    ["commands is an array", "pre-push:\n  commands: []\n"],
    [
      "check is a string",
      [
        "pre-push:",
        "  commands:",
        "    check: bun run check",
        "    workflow-doctor:",
        "      run: takt workflow doctor",
        "",
      ].join("\n"),
    ],
    [
      "workflow-doctor is null",
      [
        "pre-push:",
        "  commands:",
        "    check:",
        "      run: bun run check",
        "    workflow-doctor: null",
        "",
      ].join("\n"),
    ],
    [
      "check run is an object",
      [
        "pre-push:",
        "  commands:",
        "    check:",
        "      run: { command: check }",
        "    workflow-doctor:",
        "      run: takt workflow doctor",
        "",
      ].join("\n"),
    ],
    [
      "workflow-doctor run is an array",
      [
        "pre-push:",
        "  commands:",
        "    check:",
        "      run: bun run check",
        "    workflow-doctor:",
        "      run: [takt, workflow, doctor]",
        "",
      ].join("\n"),
    ],
  ])(
    "should reject the lefthook contract when %s",
    (_condition, configuration) => {
      expect(() => {
        validatePrePushConfiguration(configuration);
      }).toThrow();
    }
  );

  // REQ-115-02 / TC-115-02E
  test.each([
    [
      "check has a suffix",
      [
        "pre-push:",
        "  commands:",
        "    check:",
        "      run: bun run check --silent",
        "    workflow-doctor:",
        "      run: takt workflow doctor",
        "",
      ].join("\n"),
    ],
    [
      "workflow doctor has a suffix",
      [
        "pre-push:",
        "  commands:",
        "    check:",
        "      run: bun run check",
        "    workflow-doctor:",
        "      run: takt workflow doctor --fix",
        "",
      ].join("\n"),
    ],
  ])("should reject pre-push when %s", (_condition, configuration) => {
    expect(() => {
      validatePrePushConfiguration(configuration);
    }).toThrow();
  });

  // REQ-115-02 / TC-115-02F
  test.each([...hookExecutionLimitProperties])(
    "should reject pre-push when the hook has the %s execution limit",
    (property) => {
      const configuration = [
        "pre-push:",
        `  ${property}: restricted`,
        "  commands:",
        "    check:",
        "      run: bun run check",
        "    workflow-doctor:",
        "      run: takt workflow doctor",
        "",
      ].join("\n");

      expect(() => {
        validatePrePushConfiguration(configuration);
      }).toThrow();
    }
  );

  // REQ-115-02 / TC-115-02G
  test.each(
    Object.keys(prePushCommands).flatMap((commandName) =>
      commandExecutionLimitProperties.map(
        (property) => [commandName, property] as const
      )
    )
  )(
    "should reject pre-push when %s has the %s execution limit",
    (commandName, property) => {
      const configuration = [
        "pre-push:",
        "  commands:",
        "    check:",
        "      run: bun run check",
        ...(commandName === "check" ? [`      ${property}: restricted`] : []),
        "    workflow-doctor:",
        "      run: takt workflow doctor",
        ...(commandName === "workflow-doctor"
          ? [`      ${property}: restricted`]
          : []),
        "",
      ].join("\n");

      expect(() => {
        validatePrePushConfiguration(configuration);
      }).toThrow();
    }
  );

  // REQ-115-03 / TC-115-03A
  test("should reject the CI entry when the expected command remains only in a comment", () => {
    const workflow = [
      "jobs:",
      "  quality:",
      "    steps:",
      "      - run: echo skipped",
      "      # run: nix develop --command bun run check",
      "",
    ].join("\n");

    expect(() => {
      validateCiWorkflow(workflow);
    }).toThrow();
  });

  // REQ-115-03 / TC-115-03B
  test("should reject the CI entry when only another job runs check", () => {
    const workflow = [
      "jobs:",
      "  quality:",
      "    steps:",
      "      - run: echo skipped",
      "  other:",
      "    steps:",
      "      - run: nix develop --command bun run check",
      "",
    ].join("\n");

    expect(() => {
      validateCiWorkflow(workflow);
    }).toThrow();
  });

  // REQ-115-03 / TC-115-03C
  test("should reject the hook entry when only pre-commit runs check", () => {
    const configuration = [
      "pre-commit:",
      "  commands:",
      "    check:",
      "      run: bun run check",
      "pre-push:",
      "  commands:",
      "    workflow-doctor:",
      "      run: takt workflow doctor",
      "",
    ].join("\n");

    expect(() => {
      validatePrePushConfiguration(configuration);
    }).toThrow();
  });

  // REQ-115-03 / TC-115-03D
  test("should reject the hook entry when check remains only in a comment", () => {
    const configuration = [
      "pre-push:",
      "  commands:",
      "    # check:",
      "    #   run: bun run check",
      "    workflow-doctor:",
      "      run: takt workflow doctor",
      "",
    ].join("\n");

    expect(() => {
      validatePrePushConfiguration(configuration);
    }).toThrow();
  });

  // REQ-115-03 / TC-115-03E
  test("should accept the CI entry when the same command also appears in a wrong position", () => {
    const workflow = [
      "jobs:",
      "  quality:",
      "    steps:",
      "      - run: nix develop --command bun run check",
      "  other:",
      "    steps:",
      "      - run: nix develop --command bun run check",
      "",
    ].join("\n");

    expect(() => {
      validateCiWorkflow(workflow);
    }).not.toThrow();
  });

  // REQ-115-04 / TC-115-04A
  test("should find an independent check command in every facet instruction section", () => {
    for (const facetContract of gateInstructingFacets) {
      const facet = readRepositoryFile(facetContract.path);

      expect(() => {
        validateFacetGate(
          facet,
          facetContract.sectionHeading,
          facetContract.commandScope
        );
      }).not.toThrow();
    }
  });

  // REQ-115-04 / TC-115-04B
  test("should reject a facet when check appears only before its instruction section", () => {
    const facet = createFacetFixture(
      "## 手順",
      ["説明だけです。"],
      ["bun run check"]
    );

    expect(() => {
      validateFacetGate(facet, "## 手順", rootFacetCommandScope);
    }).toThrow();
  });

  // REQ-115-04 / TC-115-04C
  test.each([
    ["plain prose", createFacetFixture("## 手順", ["実行する: bun run check"])],
    [
      "inline code",
      createFacetFixture("## 手順", ["実行する: `bun run check`"]),
    ],
  ])(
    "should reject a facet when check appears only as %s in its instruction section",
    (_condition, facet) => {
      expect(() => {
        validateFacetGate(facet, "## 手順", rootFacetCommandScope);
      }).toThrow();
    }
  );

  // REQ-115-04 / TC-115-04D
  test("should reject a facet when check appears after the next peer section", () => {
    const facet = createFacetFixture(
      "## 手順",
      ["説明だけです。"],
      [],
      ["```sh", "bun run check", "```"]
    );

    expect(() => {
      validateFacetGate(facet, "## 手順", rootFacetCommandScope);
    }).toThrow();
  });

  // REQ-115-04 / TC-115-04E
  test.each([
    ["the instruction heading is missing", "# Fixture\nbun run check\n"],
    ["the instruction section is empty", createFacetFixture("## 手順", [])],
    [
      "the command fence is not closed",
      createFacetFixture("## 手順", ["```sh", "bun run check"]),
    ],
  ])("should reject a facet when %s", (_condition, facet) => {
    expect(() => {
      validateFacetGate(facet, "## 手順", rootFacetCommandScope);
    }).toThrow();
  });

  // REQ-115-04 / TC-115-04F
  test.each([
    ["echo bun run check"],
    ["bun run check && echo done"],
    ["bun run check --flag"],
  ])("should reject a facet when its fenced command is only %s", (command) => {
    const facet = createFacetFixture("## 手順", ["```sh", command, "```"]);

    expect(() => {
      validateFacetGate(facet, "## 手順", rootFacetCommandScope);
    }).toThrow();
  });

  // REQ-115-04 / TC-115-04G
  test("should contain no individual gate commands in any facet command block", () => {
    for (const facetContract of gateInstructingFacets) {
      const commandBlocks = extractFacetCommandBlocks(
        readRepositoryFile(facetContract.path),
        facetContract.sectionHeading,
        facetContract.commandScope
      );

      for (const command of enumeratedGateCommands) {
        for (const commandLines of commandBlocks) {
          for (const commandLine of commandLines) {
            expect(commandLine).not.toMatch(command);
          }
        }
      }
    }
  });

  // REQ-115-04 / TC-115-04H
  test("should reject the toolchain facet when check remains only in prose", () => {
    const facet = createFacetFixture("## 検査ゲート", [
      "説明では bun run check に言及するだけです。",
    ]);

    expect(() => {
      validateFacetGate(facet, "## 検査ゲート", rootFacetCommandScope);
    }).toThrow();
  });

  // REQ-115-04 / TC-115-04I
  test("should reject a facet when check appears only in a text fence", () => {
    const facet = createFacetFixture("## 手順", [
      "```text",
      "bun run check",
      "```",
    ]);

    expect(() => {
      validateFacetGate(facet, "## 手順", rootFacetCommandScope);
    }).toThrow();
  });

  // REQ-115-04 / TC-115-04J
  test.each([
    [
      "fenced example",
      [
        "# Fixture",
        "```markdown",
        "## 手順",
        "```",
        "## 別の節",
        "```sh",
        "bun run check",
        "```",
        "",
      ].join("\n"),
    ],
    [
      "HTML comment",
      [
        "# Fixture",
        "<!--",
        "## 手順",
        "-->",
        "## 別の節",
        "```sh",
        "bun run check",
        "```",
        "",
      ].join("\n"),
    ],
  ])(
    "should reject a facet when the instruction heading appears only in a %s",
    (_place, facet) => {
      expect(() => {
        validateFacetGate(facet, "## 手順", rootFacetCommandScope);
      }).toThrow();
    }
  );

  // REQ-115-04 / TC-115-04K
  test.each([
    [
      "an indented backtick delimiter",
      [
        "# Fixture",
        "```markdown",
        "    ```",
        "## 手順",
        "```sh",
        "bun run check",
        "```",
        "",
      ].join("\n"),
    ],
    [
      "an indented tilde delimiter",
      [
        "# Fixture",
        "~~~markdown",
        "    ~~~",
        "## 手順",
        "~~~sh",
        "bun run check",
        "~~~",
        "",
      ].join("\n"),
    ],
  ])(
    "should reject a facet when the instruction heading follows %s inside an example fence",
    (_delimiter, facet) => {
      expect(() => {
        validateFacetGate(facet, "## 手順", rootFacetCommandScope);
      }).toThrow();
    }
  );

  // REQ-115-04 / TC-115-04L
  test("should reject a facet when the instruction heading has an attached closing sequence", () => {
    const facet = [
      "# Fixture",
      "## 手順###",
      "```sh",
      "bun run check",
      "```",
      "",
    ].join("\n");

    expect(() => {
      validateFacetGate(facet, "## 手順", rootFacetCommandScope);
    }).toThrow();
  });

  // REQ-115-04 / TC-115-04M
  test.each([
    [
      "a longer backtick delimiter with three leading spaces",
      ["````sh", "bun run check", "   `````"],
    ],
    [
      "a longer tilde delimiter with trailing whitespace",
      ["~~~~sh", "bun run check", "~~~~~ \t"],
    ],
  ])(
    "should accept a standalone check command closed by %s",
    (_delimiter, sectionBody) => {
      const facet = createFacetFixture("## 手順", sectionBody);

      expect(() => {
        validateFacetGate(facet, "## 手順", rootFacetCommandScope);
      }).not.toThrow();
    }
  );

  // REQ-115-04 / TC-115-04N
  test.each([
    ["the other marker", ["````sh", "bun run check", "~~~~"]],
    ["a shorter marker", ["````sh", "bun run check", "```"]],
    [
      "a delimiter with trailing content",
      ["```sh", "bun run check", "``` comment"],
    ],
  ])(
    "should reject a facet when a command fence is followed only by %s",
    (_delimiter, sectionBody) => {
      const facet = createFacetFixture("## 手順", sectionBody);

      expect(() => {
        validateFacetGate(facet, "## 手順", rootFacetCommandScope);
      }).toThrow();
    }
  );

  // REQ-115-04 / TC-115-04O
  test("should accept an instruction heading with a whitespace-separated closing sequence", () => {
    const facet = createFacetFixture("## 手順 ###", [
      "```sh",
      "bun run check",
      "```",
    ]);

    expect(() => {
      validateFacetGate(facet, "## 手順", rootFacetCommandScope);
    }).not.toThrow();
  });

  // REQ-115-04 / TC-115-04P
  test("should accept a standalone check command surrounded only by blank lines", () => {
    const facet = createFacetFixture("## 手順", [
      "```sh",
      "",
      "bun run check",
      "   ",
      "```",
    ]);

    expect(() => {
      validateFacetGate(facet, "## 手順", rootFacetCommandScope);
    }).not.toThrow();
  });

  // REQ-115-04 / TC-115-04Q
  test.each([
    ["a heredoc body", ["```sh", "cat <<EOF", "bun run check", "EOF", "```"]],
    [
      "a continued command",
      ["```sh", "printf '%s\\n' \\", "bun run check", "```"],
    ],
  ])(
    "should reject a facet when check appears only as a line within %s",
    (_context, sectionBody) => {
      const facet = createFacetFixture("## 手順", sectionBody);

      expect(() => {
        validateFacetGate(facet, "## 手順", rootFacetCommandScope);
      }).toThrow();
    }
  );

  // REQ-115-04 / TC-115-04R
  test.each(["###", "####", "#####", "######"])(
    "should reject a facet when check appears only under the %s explanation subsection",
    (headingMarker) => {
      const facet = createFacetFixture("## 手順", [
        `${headingMarker} 説明例`,
        "```sh",
        "bun run check",
        "```",
      ]);

      expect(() => {
        validateFacetGate(facet, "## 手順", rootFacetCommandScope);
      }).toThrow();
    }
  );

  // REQ-115-04 / TC-115-04S
  test.each([
    [
      "unordered list",
      [
        "# Fixture",
        "- 説明例",
        "  ## 手順",
        "  ```sh",
        "  bun run check",
        "  ```",
        "## 次の節",
        "",
      ].join("\n"),
    ],
    [
      "ordered list",
      [
        "# Fixture",
        "1. 説明例",
        "   ## 手順",
        "   ```sh",
        "   bun run check",
        "   ```",
        "## 次の節",
        "",
      ].join("\n"),
    ],
  ])(
    "should reject a facet when its instruction heading is nested in an %s",
    (_container, facet) => {
      expect(() => {
        validateFacetGate(facet, "## 手順", rootFacetCommandScope);
      }).toThrow();
    }
  );

  // REQ-115-04 / TC-115-04T
  test.each([
    ["unordered list", ["- 説明例", "  ```sh", "  bun run check", "  ```"]],
    ["ordered list", ["1. 説明例", "   ```sh", "   bun run check", "   ```"]],
  ])(
    "should reject a facet when check appears only in an %s below the instruction heading",
    (_container, sectionBody) => {
      const facet = createFacetFixture("## 手順", sectionBody);

      expect(() => {
        validateFacetGate(facet, "## 手順", rootFacetCommandScope);
      }).toThrow();
    }
  );

  // REQ-115-04 / TC-115-04U
  test.each([
    ["implement", 4],
    ["repair", 6],
  ])(
    "should reject the %s facet when check appears only in a same-numbered explanation item",
    (_facet, ordinal) => {
      const source = createFacetFixture("## 手順", [
        `${ordinal}. 説明用の手順例`,
        "   ```sh",
        "   bun run check",
        "   ```",
      ]);
      const commandScope = {
        container: "ordered-list-item",
        introduction: completionGateInstruction,
        ordinal,
      } as const;

      expect(() => {
        validateFacetGate(source, "## 手順", commandScope);
      }).toThrow();
    }
  );

  // REQ-115-04 / TC-115-04V
  test.each([
    ["implement", 4],
    ["repair", 6],
  ])(
    "should reject the %s facet when its command instruction item is duplicated",
    (_facet, ordinal) => {
      const source = createFacetFixture("## 手順", [
        `${ordinal}. ${completionGateInstruction}`,
        "   説明だけです。",
        `${ordinal}. ${completionGateInstruction}`,
        "   ```sh",
        "   bun run check",
        "   ```",
      ]);
      const commandScope = {
        container: "ordered-list-item",
        introduction: completionGateInstruction,
        ordinal,
      } as const;

      expect(() => {
        validateFacetGate(source, "## 手順", commandScope);
      }).toThrow();
    }
  );

  // REQ-115-04 / TC-115-04W
  test.each([
    ["implement", 4],
    ["repair", 6],
  ])(
    "should reject the %s facet when another item aliases the command ordinal",
    (_facet, ordinal) => {
      const source = createFacetFixture("## 手順", [
        `${ordinal}. 説明用の手順例`,
        "   説明だけです。",
        `${ordinal}. ${completionGateInstruction}`,
        "   ```sh",
        "   bun run check",
        "   ```",
      ]);
      const commandScope = {
        container: "ordered-list-item",
        introduction: completionGateInstruction,
        ordinal,
      } as const;

      expect(() => {
        validateFacetGate(source, "## 手順", commandScope);
      }).toThrow();
    }
  );
});
