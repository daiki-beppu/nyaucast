import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { parse } from "yaml";

const packageRoot = resolve(import.meta.dirname, "../..");
const facetPath = ".takt/facets/knowledge/architecture.md";
const adrPath = "docs/adr/0001-thin-architecture.md";
const workflowPaths = {
  audit: ".takt/workflows/tayk-audit-architecture.yaml",
  feature: ".takt/workflows/tayk-feature.yaml",
  fix: ".takt/workflows/tayk-fix.yaml",
} as const;

interface NormContract {
  id: `${string} ${"OK" | "REJECT" | "REQUIRED"}:`;
  keywords: readonly string[];
}

const requiredNorms = {
  adapter: [
    { id: "TA-06 OK:", keywords: ["adapter", "MCP", "CLI", "境界"] },
    { id: "TA-06 REJECT:", keywords: ["adapter", "業務ロジック"] },
  ],
  adrChange: [
    { id: "TA-07 REQUIRED:", keywords: ["ADR", "逸脱", "改訂", "同じ変更"] },
    { id: "TA-07 REJECT:", keywords: ["ADR", "改訂", "黙って逸脱"] },
  ],
  priority: {
    id: "TA-02 REQUIRED:",
    keywords: ["ADR-0001", "正書", "Vertical Slice", "競合"],
  },
  registry: [
    {
      id: "TA-04 OK:",
      keywords: ["entry point", "フラット", "import", "配列"],
    },
    { id: "TA-04 REJECT:", keywords: ["registry", "動的収集", "登録"] },
  ],
  serviceFrame: [
    { id: "TA-05 OK:", keywords: ["core", "throw", "adapter", "境界"] },
    {
      id: "TA-05 REJECT:",
      keywords: ["Result", "createService", "service frame"],
    },
  ],
  toolColocation: [
    {
      id: "TA-03 OK:",
      keywords: ["1 MCP tool", "1ファイル", "schema", "handler", "同居"],
    },
    {
      id: "TA-03 REJECT:",
      keywords: ["schema", "service", "index", "別ファイル"],
    },
  ],
} as const satisfies Record<string, NormContract | readonly NormContract[]>;

const allRequiredNorms = [
  requiredNorms.priority,
  ...requiredNorms.toolColocation,
  ...requiredNorms.registry,
  ...requiredNorms.serviceFrame,
  ...requiredNorms.adapter,
  ...requiredNorms.adrChange,
] as const;

type WorkflowName = keyof typeof workflowPaths;

interface WorkflowEntrance {
  label: string;
  location:
    | { field: "knowledge"; step: string }
    | { field: "knowledge"; parallel: string; step: string }
    | { field: "supervise_knowledge"; step: string };
  workflow: WorkflowName;
}

interface WorkflowStep {
  args?: {
    supervise_knowledge?: unknown;
  };
  knowledge?: unknown;
  name?: string;
  parallel?: WorkflowStep[];
}

interface WorkflowDefinition {
  steps?: WorkflowStep[];
}

function readRepositoryFile(relativePath: string): string {
  return readFileSync(join(packageRoot, relativePath), "utf-8");
}

function readMarkdownSection(source: string, heading: string): string {
  const lines = source.split("\n");
  const start = lines.indexOf(heading);
  if (start === -1) {
    throw new Error(`missing Markdown section: ${heading}`);
  }

  const level = /^#+/.exec(heading)?.[0].length;
  if (level === undefined) {
    throw new Error(`section heading must start with #: ${heading}`);
  }

  const end = lines.findIndex((line, index) => {
    if (index <= start) {
      return false;
    }
    const candidateLevel = /^#+(?= )/.exec(line)?.[0].length;
    return candidateLevel !== undefined && candidateLevel <= level;
  });
  return lines.slice(start + 1, end === -1 ? undefined : end).join("\n");
}

function normalizeNorm(line: string): string {
  return line
    .trim()
    .replace(/^[-*]\s+/, "")
    .replaceAll(/\s+/g, " ");
}

function findMissingNorms(
  source: string,
  expected: readonly NormContract[]
): NormContract[] {
  const section = readMarkdownSection(source, "## tayk 固有の優先規則");
  const actual = section.split("\n").map(normalizeNorm);
  return expected.filter(
    ({ id, keywords }) =>
      !actual.some(
        (line) =>
          line.includes(id) &&
          keywords.every((keyword) => line.includes(keyword))
      )
  );
}

function minimalFacet(lines: readonly string[]): string {
  return `# Architecture\n\n## tayk 固有の優先規則\n\n${lines.map((line) => `- ${line}`).join("\n")}\n`;
}

function renderNorms(contracts: readonly NormContract[]): string[] {
  return contracts.map(
    ({ id, keywords }) =>
      `${id} ${keywords.toReversed().join(" / ")} を確認する`
  );
}

function invertNorms(contracts: readonly NormContract[]): string[] {
  return renderNorms(contracts).map((line) => {
    if (line.includes(" REQUIRED:")) {
      return line.replace(" REQUIRED:", " OPTIONAL:");
    }
    if (line.includes(" OK:")) {
      return line.replace(" OK:", " REJECT:");
    }
    return line.replace(" REJECT:", " OK:");
  });
}

function expectNormContract(expected: readonly NormContract[]): void {
  const firstNorm = expected[0];
  if (firstNorm === undefined) {
    throw new Error("norm contract requires at least one expected line");
  }
  expect(findMissingNorms(readRepositoryFile(facetPath), expected)).toEqual([]);

  expect(
    findMissingNorms(minimalFacet(renderNorms(allRequiredNorms)), expected)
  ).toEqual([]);

  const withoutFirstNorm = allRequiredNorms.filter(
    (contract) => contract !== firstNorm
  );
  expect(
    findMissingNorms(minimalFacet(renderNorms(withoutFirstNorm)), expected)
  ).toContain(firstNorm);
  expect(
    findMissingNorms(minimalFacet(invertNorms(allRequiredNorms)), expected)
  ).toEqual([...expected]);
}

function parseWorkflowSource(source: string, path: string): WorkflowDefinition {
  const value: unknown = parse(source);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${path} must contain a workflow object`);
  }
  return value;
}

function parseWorkflow(path: string): WorkflowDefinition {
  return parseWorkflowSource(readRepositoryFile(path), path);
}

function requireStep(
  workflow: WorkflowDefinition,
  path: string,
  stepName: string
): WorkflowStep {
  if (!Array.isArray(workflow.steps)) {
    throw new TypeError(`${path} must declare steps`);
  }
  const step = workflow.steps.find((candidate) => candidate.name === stepName);
  if (step === undefined) {
    throw new TypeError(`${path} must declare the ${stepName} step`);
  }
  return step;
}

function requireParallelStep(
  workflow: WorkflowDefinition,
  path: string,
  parentStepName: string,
  parallelStepName: string
): WorkflowStep {
  const parent = requireStep(workflow, path, parentStepName);
  if (!Array.isArray(parent.parallel)) {
    throw new TypeError(
      `${path} ${parentStepName} must declare parallel steps`
    );
  }
  const step = parent.parallel.find(
    (candidate) => candidate.name === parallelStepName
  );
  if (step === undefined) {
    throw new TypeError(
      `${path} ${parentStepName} must declare ${parallelStepName}`
    );
  }
  return step;
}

const workflowEntrances: readonly WorkflowEntrance[] = [
  {
    label: "fix.diagnose",
    location: { field: "knowledge", step: "diagnose" },
    workflow: "fix",
  },
  {
    label: "fix.diagnose_fix",
    location: { field: "knowledge", step: "diagnose_fix" },
    workflow: "fix",
  },
  {
    label: "fix.repair",
    location: { field: "knowledge", step: "repair" },
    workflow: "fix",
  },
  {
    label: "fix.impl_review.arch-review",
    location: {
      field: "knowledge",
      parallel: "arch-review",
      step: "impl_review",
    },
    workflow: "fix",
  },
  {
    label: "fix.fix",
    location: { field: "knowledge", step: "fix" },
    workflow: "fix",
  },
  {
    label: "fix.final_gate.args.supervise_knowledge",
    location: { field: "supervise_knowledge", step: "final_gate" },
    workflow: "fix",
  },
  {
    label: "feature.plan",
    location: { field: "knowledge", step: "plan" },
    workflow: "feature",
  },
  {
    label: "feature.design_review.design-arch-review",
    location: {
      field: "knowledge",
      parallel: "design-arch-review",
      step: "design_review",
    },
    workflow: "feature",
  },
  {
    label: "feature.design_fix",
    location: { field: "knowledge", step: "design_fix" },
    workflow: "feature",
  },
  {
    label: "feature.impl_review.arch-review",
    location: {
      field: "knowledge",
      parallel: "arch-review",
      step: "impl_review",
    },
    workflow: "feature",
  },
  {
    label: "feature.fix",
    location: { field: "knowledge", step: "fix" },
    workflow: "feature",
  },
  {
    label: "feature.final_gate.args.supervise_knowledge",
    location: { field: "supervise_knowledge", step: "final_gate" },
    workflow: "feature",
  },
  {
    label: "audit.plan",
    location: { field: "knowledge", step: "plan" },
    workflow: "audit",
  },
  {
    label: "audit.audit",
    location: { field: "knowledge", step: "audit" },
    workflow: "audit",
  },
  {
    label: "audit.supervise",
    location: { field: "knowledge", step: "supervise" },
    workflow: "audit",
  },
  {
    label: "audit.review",
    location: { field: "knowledge", step: "review" },
    workflow: "audit",
  },
] as const;

function readEntranceKnowledge(
  workflow: WorkflowDefinition,
  path: string,
  location: WorkflowEntrance["location"]
): unknown {
  const step =
    "parallel" in location
      ? requireParallelStep(workflow, path, location.step, location.parallel)
      : requireStep(workflow, path, location.step);
  return location.field === "knowledge"
    ? step.knowledge
    : step.args?.supervise_knowledge;
}

function removeArchitectureReference(knowledge: unknown): unknown {
  if (knowledge === "architecture") {
    return undefined;
  }
  return Array.isArray(knowledge)
    ? knowledge.filter((entry) => entry !== "architecture")
    : knowledge;
}

function removeEntranceKnowledge(
  workflow: WorkflowDefinition,
  path: string,
  location: WorkflowEntrance["location"]
): void {
  const step =
    "parallel" in location
      ? requireParallelStep(workflow, path, location.step, location.parallel)
      : requireStep(workflow, path, location.step);
  if (location.field === "knowledge") {
    step.knowledge = removeArchitectureReference(step.knowledge);
    return;
  }
  if (step.args === undefined) {
    throw new TypeError(`${path} ${location.step} must declare args`);
  }
  step.args.supervise_knowledge = removeArchitectureReference(
    step.args.supervise_knowledge
  );
}

function hasBareArchitectureReference(knowledge: unknown): boolean {
  return (
    knowledge === "architecture" ||
    (Array.isArray(knowledge) && knowledge.includes("architecture"))
  );
}

function findMissingEntrances(
  workflows: Readonly<Record<WorkflowName, WorkflowDefinition>>
): string[] {
  return workflowEntrances
    .filter((entrance) => {
      const path = workflowPaths[entrance.workflow];
      return !hasBareArchitectureReference(
        readEntranceKnowledge(
          workflows[entrance.workflow],
          path,
          entrance.location
        )
      );
    })
    .map((entrance) => entrance.label);
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

interface TextContract {
  keywords: readonly string[];
  marker: string;
}

function expectTextContracts(
  lines: readonly string[],
  contracts: readonly TextContract[]
): void {
  for (const contract of contracts) {
    const line = lines.find((candidate) => candidate.includes(contract.marker));
    expect(line, `missing contract marker: ${contract.marker}`).toBeDefined();
    for (const keyword of contract.keywords) {
      expect(line, `${contract.marker} must include ${keyword}`).toContain(
        keyword
      );
    }
  }
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
  const terms = readMarkdownSection(markdown, "## 中核用語");
  const avoidedTerms = readMarkdownSection(markdown, "## 禁止語（`_Avoid_`）");
  const definitions = readDefinitionRows(terms);
  const definitionLines = definitions.map(
    ({ definition, term }) => `${term}: ${definition}`
  );

  expectTextContracts(definitionLines, [
    {
      keywords: ["型付き", "primitive tool", "local store"],
      marker: "MCP tool:",
    },
    { keywords: ["単一操作", "細粒度"], marker: "primitive tool:" },
    { keywords: ["廃止", "knowledge codec"], marker: "workflow tool:" },
    { keywords: ["core", "MCP", "CLI"], marker: "adapter:" },
    { keywords: ["MCP tool", "WHEN/HOW"], marker: "knowledge codec:" },
    { keywords: ["YouTube", "楽曲", "成果物"], marker: "collection:" },
    { keywords: ["TTP", "企画", "upload"], marker: "collection lifecycle:" },
    { keywords: ["benchmark", "分析", "転写"], marker: "TTP:" },
    { keywords: ["local.db", "libSQL", "SSOT"], marker: "local store:" },
    { keywords: ["local store", "読み取り", "SSOT"], marker: "read model:" },
    { keywords: ["ADR-0001", "end-to-end", "plan"], marker: "tracer:" },
    { keywords: ["first-party", "collection", "v0.1.0"], marker: "dogfood:" },
    {
      keywords: ["誤公開", "データ破壊", "auth"],
      marker: "critical regression:",
    },
  ]);
  expect(
    definitions.some(({ term }) => term.includes("orchestration"))
  ).toBeFalse();

  const avoidedRows = readMarkdownTableRows(avoidedTerms).map((row) =>
    row.join(" ")
  );
  expectTextContracts(avoidedRows, [
    { keywords: ["primitive tool"], marker: "workflow tool" },
  ]);
}

function assertAdrReviewTerminologyContract(markdown: string): void {
  const terminology = readMarkdownSection(markdown, "## 用語（CONTEXT.md）");
  const rows = readMarkdownTableRows(terminology).map((row) => row.join(" "));

  expectTextContracts(rows, [
    {
      keywords: ["廃止", "primitive tool", "事実"],
      marker: "workflow tool",
    },
  ]);
  expect(rows.some((row) => row.includes("orchestration tool"))).toBeFalse();
}

function assertDesignArchitectureContract(markdown: string): void {
  const procedure = readMarkdownSection(markdown, "## 手順");
  const rows = readMarkdownTableRows(procedure).map((row) => row.join(" "));

  expectTextContracts(rows, [
    { keywords: ["要件 ID", "方針", "実装"], marker: "要求の充足" },
    { keywords: ["core", "adapter", "primitive tool"], marker: "責務の配置" },
    { keywords: ["入出力", "SSOT", "データ 4 分類"], marker: "データの流れ" },
    { keywords: ["失敗経路", "throw", "境界変換"], marker: "失敗の設計" },
    { keywords: ["要件", "ファイル", "波及"], marker: "変更の広がり" },
    {
      keywords: ["暗黙の状態", "グローバル", "双方向依存"],
      marker: "未来への負債",
    },
  ]);
  expect(rows.some((row) => row.includes("orchestration tool"))).toBeFalse();
}

function assertAgentCodecReleaseContract(markdown: string): void {
  const scope = readMarkdownSection(markdown, "## v0.1.0 のスコープ");

  expect(readCodecReleaseStatements(scope)).toEqual([
    "`collection-lifecycle` codec は v0.1 の中心成果物とする",
    "それ以外（自チャンネル実績分析 / dashboard / Remotion / `collection-lifecycle` 以外の codec）は v0.2 以降に 1 リリース 1 テーマで直列に積む",
  ]);
}

const generalGuidance = [
  "ADR-0001 と競合しない範囲では、高凝集、低結合、循環依存の回避、責務と副作用の明確さを評価する。",
  "ただし、これらを理由に schema・service・repository 等の追加レイヤー、Vertical Slice、registry、service frame を導入してはならない。",
] as const;

function findMissingGeneralGuidance(source: string): string[] {
  const section = normalizeNorm(readMarkdownSection(source, "## 補助観点"));
  return generalGuidance.filter(
    (guidance) => !section.includes(normalizeNorm(guidance))
  );
}

describe("project architecture Knowledge contract", () => {
  // REQ-148-01 / TC-148-01 / P-148-01
  test("project の正規パスに architecture facet が存在する", () => {
    expect(readRepositoryFile(facetPath).length).toBeGreaterThan(0);
  });

  // REQ-148-02 / TC-148-02 / P-148-04
  test("ADR-0001 は一般レイヤー構成や Vertical Slice より優先される", () => {
    expectNormContract([requiredNorms.priority]);
  });

  // REQ-148-03 / TC-148-03 / P-148-04
  test("tool の基本単位と定義要素の同居を要求する", () => {
    expectNormContract(requiredNorms.toolColocation);
  });

  // REQ-148-04 / TC-148-04 / P-148-04
  test("registry を拒否してフラットな import 配列を要求する", () => {
    expectNormContract(requiredNorms.registry);
  });

  // REQ-148-05 / TC-148-05 / P-148-04
  test("追加 service frame を拒否して境界でのエラー変換を要求する", () => {
    expectNormContract(requiredNorms.serviceFrame);
  });

  // REQ-148-06 / TC-148-06 / P-148-04
  test("adapter を境界に限定して業務ロジックを拒否する", () => {
    expectNormContract(requiredNorms.adapter);
  });

  // REQ-148-07 / TC-148-07 / P-148-04
  test("ADR 逸脱時の同時改訂を要求して黙った逸脱を拒否する", () => {
    expectNormContract(requiredNorms.adrChange);
  });

  // REQ-148-08 / TC-148-08 / P-148-03, P-148-05
  test("16個の workflow 入口が同じ project override を裸名で参照する", () => {
    expect(readRepositoryFile(facetPath).length).toBeGreaterThan(0);
    const workflows = {
      audit: parseWorkflow(workflowPaths.audit),
      feature: parseWorkflow(workflowPaths.feature),
      fix: parseWorkflow(workflowPaths.fix),
    };
    expect(findMissingEntrances(workflows)).toEqual([]);

    for (const entrance of workflowEntrances) {
      const fixture = structuredClone(workflows);
      removeEntranceKnowledge(
        fixture[entrance.workflow],
        workflowPaths[entrance.workflow],
        entrance.location
      );
      expect(findMissingEntrances(fixture)).toEqual([entrance.label]);
    }
  });

  // REQ-148-09 / TC-148-09 / P-148-01, P-148-04
  test("追跡対象の project facet と ADR だけで規範を検証できる", () => {
    const facet = readRepositoryFile(facetPath);
    const adr = readRepositoryFile(adrPath);

    expect(findMissingNorms(facet, allRequiredNorms)).toEqual([]);
    expect(adr).toContain(
      "tool 定義ファイルに zod の入出力 schema・description・handler を同居させる"
    );
    expect(adr).toContain("registry を置かない");
    expect(adr).toContain("`Result` 型・`createService` フレーム");
  });

  // REQ-148-02 / TC-148-11 / existing behavior regression
  test("ADR と競合しない一般的な architecture 観点を許容する", () => {
    const facet = readRepositoryFile(facetPath);
    expect(findMissingGeneralGuidance(facet)).toEqual([]);

    const missingRestriction = facet.replace(generalGuidance[1], "");
    expect(findMissingGeneralGuidance(missingRestriction)).toContain(
      generalGuidance[1]
    );

    const inverted = facet
      .replace("ADR-0001 と競合しない範囲では", "ADR-0001 と競合する場合でも")
      .replace(
        generalGuidance[1],
        "一般的な architecture 観点を優先してよい。"
      );
    expect(findMissingGeneralGuidance(inverted)).toEqual([...generalGuidance]);
  });
});

describe("agent-facing architecture contracts", () => {
  // REQ-84-01 / TC-01
  test("should index every current ADR and define the tracer as the plan interval", () => {
    const knowledge = readRepositoryFile(".takt/facets/knowledge/tayk-adr.md");
    const index = readMarkdownSection(knowledge, "## 判定前に必ず読むファイル");
    const decisionSeven = readMarkdownSection(
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

  test("should allow domain definitions to be rephrased without losing their meaning", () => {
    const knowledge = readRepositoryFile(
      ".takt/facets/knowledge/tayk-domain.md"
    );
    const rephrasedKnowledge = knowledge.replace(
      /^\*\*knowledge codec\*\*:.*$/m,
      "**knowledge codec**: MCP tool の選択時期と利用法を示す WHEN/HOW の知識。"
    );

    assertDomainArchitectureContract(rephrasedKnowledge);
  });

  test("should reject a missing domain term", () => {
    const knowledge = readRepositoryFile(
      ".takt/facets/knowledge/tayk-domain.md"
    );
    const missingTermKnowledge = knowledge.replace(
      /^\*\*knowledge codec\*\*:.*\n/m,
      ""
    );

    expect(() => {
      assertDomainArchitectureContract(missingTermKnowledge);
    }).toThrow();
  });

  // REQ-84-04 / TC-04
  test("should keep ADR-0001 provisional until the plan interval tracer completes", () => {
    const adr = readRepositoryFile(adrPath);
    const decision = readMarkdownSection(adr, "## Decision");
    const consequences = readMarkdownSection(adr, "## Consequences");
    const tracerConsequences = consequences
      .split("\n")
      .filter((line) => line.startsWith("- ") && line.includes("tracer"))
      .map((line) => normalizeMarkdownText(line.slice(2)));

    expectTextContracts(
      [readNumberedDecision(decision, 7)],
      [
        {
          keywords: ["plan", "end-to-end", "ADR", "黙って逸脱"],
          marker: "tracer",
        },
      ]
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
    const implementationPlan = readMarkdownSection(contract, "## 実装方針");

    expect(
      readMarkdownTableRows(implementationPlan).map((row) => row[1])
    ).toEqual(["`<対象ファイル>`"]);
  });

  // REQ-84-07 / TC-07
  test("should use only neutral implementation and test targets in test design", () => {
    const contract = readRepositoryFile(
      ".takt/facets/output-contracts/tayk-test-design.md"
    );
    const cases = readMarkdownSection(contract, "## 要件 ↔ テストケース対応");
    const placement = readMarkdownSection(contract, "## テストファイル配置");

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
    const index = readMarkdownSection(contract, "## 照合した ADR");
    const evidence = readMarkdownSection(
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
    const scope = readMarkdownSection(knowledge, "## スコープの規律");

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
      "## データ 4 分類",
      "| `<別の対象>` | orchestration tool | primitive tool を束ねる現行推奨層 |\n\n## データ 4 分類"
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
      /^(\| データの流れ\s+\| )/m,
      "$1orchestration tool が primitive tool を束ねる現行層か。"
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
