import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
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
  readKnowledge: (workflow: WorkflowDefinition, path: string) => unknown;
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
    readKnowledge: (workflow, path) =>
      requireStep(workflow, path, "diagnose").knowledge,
    workflow: "fix",
  },
  {
    label: "fix.diagnose_fix",
    readKnowledge: (workflow, path) =>
      requireStep(workflow, path, "diagnose_fix").knowledge,
    workflow: "fix",
  },
  {
    label: "fix.repair",
    readKnowledge: (workflow, path) =>
      requireStep(workflow, path, "repair").knowledge,
    workflow: "fix",
  },
  {
    label: "fix.impl_review.arch-review",
    readKnowledge: (workflow, path) =>
      requireParallelStep(workflow, path, "impl_review", "arch-review")
        .knowledge,
    workflow: "fix",
  },
  {
    label: "fix.fix",
    readKnowledge: (workflow, path) =>
      requireStep(workflow, path, "fix").knowledge,
    workflow: "fix",
  },
  {
    label: "fix.final_gate.args.supervise_knowledge",
    readKnowledge: (workflow, path) =>
      requireStep(workflow, path, "final_gate").args?.supervise_knowledge,
    workflow: "fix",
  },
  {
    label: "feature.plan",
    readKnowledge: (workflow, path) =>
      requireStep(workflow, path, "plan").knowledge,
    workflow: "feature",
  },
  {
    label: "feature.design_review.design-arch-review",
    readKnowledge: (workflow, path) =>
      requireParallelStep(workflow, path, "design_review", "design-arch-review")
        .knowledge,
    workflow: "feature",
  },
  {
    label: "feature.design_fix",
    readKnowledge: (workflow, path) =>
      requireStep(workflow, path, "design_fix").knowledge,
    workflow: "feature",
  },
  {
    label: "feature.impl_review.arch-review",
    readKnowledge: (workflow, path) =>
      requireParallelStep(workflow, path, "impl_review", "arch-review")
        .knowledge,
    workflow: "feature",
  },
  {
    label: "feature.fix",
    readKnowledge: (workflow, path) =>
      requireStep(workflow, path, "fix").knowledge,
    workflow: "feature",
  },
  {
    label: "feature.final_gate.args.supervise_knowledge",
    readKnowledge: (workflow, path) =>
      requireStep(workflow, path, "final_gate").args?.supervise_knowledge,
    workflow: "feature",
  },
  {
    label: "audit.plan",
    readKnowledge: (workflow, path) =>
      requireStep(workflow, path, "plan").knowledge,
    workflow: "audit",
  },
  {
    label: "audit.audit",
    readKnowledge: (workflow, path) =>
      requireStep(workflow, path, "audit").knowledge,
    workflow: "audit",
  },
  {
    label: "audit.supervise",
    readKnowledge: (workflow, path) =>
      requireStep(workflow, path, "supervise").knowledge,
    workflow: "audit",
  },
  {
    label: "audit.review",
    readKnowledge: (workflow, path) =>
      requireStep(workflow, path, "review").knowledge,
    workflow: "audit",
  },
] as const;

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
        entrance.readKnowledge(workflows[entrance.workflow], path)
      );
    })
    .map((entrance) => entrance.label);
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

    const fixture = {
      ...workflows,
      fix: parseWorkflowSource(
        readRepositoryFile(workflowPaths.fix).replace(
          "      - architecture",
          "      - tayk-domain"
        ),
        "fixture/tayk-fix.yaml"
      ),
    };
    expect(findMissingEntrances(fixture)).toContain("fix.diagnose");
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
