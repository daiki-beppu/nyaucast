import { describe, expect, test } from "bun:test";

import { parseYamlRecord, readRepositoryFile } from "../helpers";

const paths = {
  analyze: ".takt/facets/instructions/tayk-audit-runs-analyze.md",
  auditContract: ".takt/facets/output-contracts/tayk-runs-audit.md",
  feature: ".takt/workflows/tayk-feature.yaml",
  file: ".takt/facets/instructions/tayk-audit-runs-file.md",
  filingContract: ".takt/facets/output-contracts/tayk-runs-audit-filing.md",
  fix: ".takt/workflows/tayk-fix.yaml",
  plan: ".takt/facets/instructions/tayk-audit-runs-plan.md",
  planContract: ".takt/facets/output-contracts/tayk-runs-audit-plan.md",
  review: ".takt/facets/instructions/tayk-audit-runs-review.md",
  supervise: ".takt/facets/instructions/tayk-audit-runs-supervise.md",
  workflow: ".takt/workflows/tayk-audit-runs.yaml",
} as const;

const recoverySourceFieldPatterns = [
  /Source Run|元 ?run/i,
  /Source Report|元レポート(?:相対パス)?/i,
  /Source Location|原記載(?:の)?場所|原記載位置/i,
  /Quote|引用/i,
  /Impact|実害/i,
  /Evidence|根拠/i,
] as const;
const normalInstructionEvidencePatterns = [
  /trace\.md/,
  /meta\.json/,
  /monitor\.json/,
  /定義ファイル/,
] as const;
const normalFileEvidencePatterns = [/trace\.md/, /定義ファイル/] as const;

interface WorkflowRule {
  condition?: string;
  next?: string;
}

interface WorkflowStep {
  name?: string;
  quality_gates?: string[];
  rules?: WorkflowRule[];
}

interface WorkflowDefinition {
  description?: string;
  steps?: WorkflowStep[];
}

function parseWorkflow(relativePath: string): WorkflowDefinition {
  return parseYamlRecord(
    readRepositoryFile(relativePath),
    relativePath,
    "a workflow object"
  );
}

function requireSteps(
  workflow: WorkflowDefinition,
  path: string
): WorkflowStep[] {
  if (!Array.isArray(workflow.steps)) {
    throw new TypeError(`${path} must declare steps`);
  }
  return workflow.steps;
}

function requireStep(
  workflow: WorkflowDefinition,
  path: string,
  name: string
): WorkflowStep {
  const step = requireSteps(workflow, path).find(
    (candidate) => candidate.name === name
  );
  if (step === undefined) {
    throw new Error(`${path} must declare the ${name} step`);
  }
  return step;
}

function requireRule(step: WorkflowStep, condition: RegExp): WorkflowRule {
  const rule = step.rules?.find(
    (candidate) =>
      typeof candidate.condition === "string" &&
      condition.test(candidate.condition)
  );
  if (rule === undefined) {
    throw new Error(`step ${step.name ?? "<unnamed>"} lacks the expected rule`);
  }
  return rule;
}

function extractSection(source: string, heading: string): string {
  const lines = source.split("\n");
  const escapedHeading = heading.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const headingPattern = new RegExp(`^(#{2,6})\\s+${escapedHeading}\\s*$`, "i");
  const start = lines.findIndex((line) => headingPattern.test(line));
  if (start === -1) {
    throw new Error(`missing section: ${heading}`);
  }

  const startLine = lines[start];
  if (startLine === undefined) {
    throw new Error(`missing section line: ${heading}`);
  }
  const level = /^#+/.exec(startLine)?.[0].length;
  if (level === undefined) {
    throw new Error(`invalid heading: ${heading}`);
  }
  const end = lines.findIndex(
    (line, index) =>
      index > start &&
      /^#{1,6}\s+/.test(line) &&
      (/^#+/.exec(line)?.[0].length ?? 7) <= level
  );
  return lines.slice(start, end === -1 ? undefined : end).join("\n");
}

function extractTableHeaders(section: string): string[] {
  const header = section.split("\n").find((line, index, lines) => {
    const next = lines[index + 1];
    return (
      line.trim().startsWith("|") &&
      next !== undefined &&
      /^\s*\|(?:\s*:?-+:?\s*\|)+\s*$/.test(next)
    );
  });
  if (header === undefined) {
    throw new Error("section must contain a Markdown table");
  }
  return header
    .split("|")
    .slice(1, -1)
    .map((cell) => cell.replaceAll(/[`*_]/g, "").trim());
}

function expectHeaders(headers: string[], required: readonly string[]): void {
  for (const field of required) {
    expect(headers).toContain(field);
  }
}

function expectHeaderPatterns(
  headers: string[],
  required: readonly RegExp[]
): void {
  for (const field of required) {
    expect(headers.some((header) => field.test(header))).toBe(true);
  }
}

function extractShellCommands(source: string): string[] {
  const commands: string[] = [];
  const lines = source.split("\n");
  let inShellFence = false;

  for (const line of lines) {
    const opening = /^```(?:bash|sh|shell|zsh)?\s*$/.exec(line.trim());
    if (!inShellFence && opening !== null) {
      inShellFence = true;
      continue;
    }
    if (inShellFence && line.trim() === "```") {
      inShellFence = false;
      continue;
    }
    if (inShellFence && line.trim().length > 0) {
      commands.push(line.trim());
    }
  }
  return commands;
}

function expectRecoverySelectionContract(): void {
  const inventoryHeaders = extractTableHeaders(
    extractSection(readRepositoryFile(paths.planContract), "Recovery Inventory")
  );
  expectHeaders(inventoryHeaders, [
    "Run",
    "Workflow",
    "Status",
    "Spillover Executed",
    "Target Reports",
  ]);

  const planRules = extractSection(
    readRepositoryFile(paths.plan),
    "Recovery Inventory"
  );
  expect(planRules).toMatch(/aborted[\s\S]*failed/i);
  expect(planRules).toMatch(/spillover[\s\S]*(?:未実行|実行がない)/i);
}

function expectRecoveryCoverageContract(): void {
  const coverageHeaders = extractTableHeaders(
    extractSection(readRepositoryFile(paths.auditContract), "Recovery Coverage")
  );
  expectHeaders(coverageHeaders, [
    "Run",
    "Target Reports",
    "Scanned Reports",
    "Extracted Findings",
    "Failed Paths",
    "Failure Reasons",
    "Status",
  ]);
}

function expectRecoveryEvidenceContract(): void {
  const auditFindings = extractSection(
    readRepositoryFile(paths.auditContract),
    "Findings"
  );
  const auditHeaders = extractTableHeaders(auditFindings);
  const filingHeaders = extractTableHeaders(
    extractSection(readRepositoryFile(paths.filingContract), "仕分け結果")
  );
  expectHeaderPatterns(auditHeaders, recoverySourceFieldPatterns);
  expect(auditFindings).toMatch(/recovery|回収/i);
  expectHeaderPatterns(filingHeaders, recoverySourceFieldPatterns);
  expect(filingHeaders.some((header) => /^(?:Result|判定)$/.test(header))).toBe(
    true
  );
}

function expectGitHubCommandContract(): void {
  const commands = extractShellCommands(readRepositoryFile(paths.file));
  expect(
    commands.some(
      (command) =>
        /^gh issue list\b/.test(command) && /--state\s+open\b/.test(command)
    )
  ).toBe(true);
  expect(commands.some((command) => /^gh issue comment\b/.test(command))).toBe(
    true
  );
  expect(commands.some((command) => /^gh issue create\b/.test(command))).toBe(
    true
  );
}

function expectFilingResultsContract(): void {
  const filingResults = extractSection(
    readRepositoryFile(paths.filingContract),
    "仕分け結果"
  );
  const filingHeaders = extractTableHeaders(filingResults);
  expect(filingHeaders.some((header) => /^(?:Result|判定)$/.test(header))).toBe(
    true
  );
  expectHeaders(filingHeaders, ["Issue"]);
  for (const result of ["起票", "既存へ追記", "記録のみ", "未回収"]) {
    expect(filingResults).toContain(result);
  }
}

function expectEvidenceValidationContract(): void {
  const review = readRepositoryFile(paths.review);
  const supervise = readRepositoryFile(paths.supervise);
  const workflow = parseWorkflow(paths.workflow);
  const fileGates = requireStep(workflow, paths.workflow, "file").quality_gates;

  if (!Array.isArray(fileGates)) {
    throw new TypeError("tayk-audit-runs file must declare quality gates");
  }
  const fileGateContract = fileGates.join("\n");

  for (const instruction of [review, supervise]) {
    const recoveryEvidence = extractSection(
      instruction,
      "回収 Finding の Evidence"
    );
    expect(recoveryEvidence).toMatch(/元レポート[^\n]*(?:開|読む)/);
    for (const field of recoverySourceFieldPatterns) {
      expect(recoveryEvidence).toMatch(field);
    }

    const normalEvidence = extractSection(
      instruction,
      "通常 Finding の Evidence"
    );
    for (const pattern of normalInstructionEvidencePatterns) {
      expect(normalEvidence).toMatch(pattern);
    }
  }

  for (const field of recoverySourceFieldPatterns) {
    expect(fileGateContract).toMatch(field);
  }
  for (const pattern of normalFileEvidencePatterns) {
    expect(fileGateContract).toMatch(pattern);
  }

  expectRecoveryEvidenceContract();
  expectFilingResultsContract();
}

function expectAbortWiringContract(): void {
  const contracts = [
    {
      abortConditions: {
        final_gate: /^ABORT$/,
        intake: /^(?:blocked|ABORT)$/,
        plan: /4 回目以降|方針を一意に決められない/,
      },
      path: paths.feature,
    },
    {
      abortConditions: {
        diagnose: /11 回目以降|再現条件を確定できない|原因が複数/,
        final_gate: /^ABORT$/,
        intake: /^(?:blocked|ABORT)$/,
        rediagnose: /4 回目以降/,
      },
      path: paths.fix,
    },
  ] as const;

  for (const contract of contracts) {
    const workflow = parseWorkflow(contract.path);
    const stepNames = requireSteps(workflow, contract.path).map(
      (step) => step.name
    );
    expect(stepNames.filter((name) => /abort/i.test(name ?? ""))).toEqual([]);
    expect(
      requireRule(
        requireStep(workflow, contract.path, "final_gate"),
        /^COMPLETE$/
      ).next
    ).toBe("spillover");
    expect(stepNames).toContain("spillover");

    for (const [stepName, condition] of Object.entries(
      contract.abortConditions
    )) {
      const step = requireStep(workflow, contract.path, stepName);
      const matchingRules = step.rules?.filter(
        (rule) =>
          typeof rule.condition === "string" && condition.test(rule.condition)
      );
      expect(matchingRules?.length).toBeGreaterThan(0);
      for (const rule of matchingRules ?? []) {
        expect(rule.next).toBe("ABORT");
      }
    }
  }
}

function expectRecoveryLaneContract(): void {
  const workflow = parseWorkflow(paths.workflow);
  expect(workflow.description).toMatch(/abort[\s\S]*failed/i);
  expect(workflow.description).toMatch(/spillover[\s\S]*未実行/i);

  const planRecovery = extractSection(
    readRepositoryFile(paths.plan),
    "Recovery Inventory"
  );
  const analyzeRecovery = extractSection(
    readRepositoryFile(paths.analyze),
    "Recovery Inventory の分析"
  );
  expect(planRecovery).toMatch(/完了済み|終了 run/i);
  expect(analyzeRecovery).toMatch(/reports\/\*\*\/\*\.md/);
  expect(analyzeRecovery).toMatch(/subworkflows/);
  expect(analyzeRecovery).toMatch(/スコープ外の発見/);
  expect(analyzeRecovery).toMatch(/非ブロッキング指摘/);
}

describe("tayk-audit-runs recovery contract", () => {
  // REQ-163-08 / TC-163-08B is distributed across the focused tests below.
  // REQ-199-05 / TC-08 / P-5
  test("tayk-fix keeps direct diagnosis ABORT reports recoverable while its overall limit changes", () => {
    expectAbortWiringContract();
  });

  test("[REQ-163-01 / TC-163-01A] should keep a run-level Recovery Inventory separate from Audit Targets when planning recovery", () => {
    const planContract = readRepositoryFile(paths.planContract);
    const auditTargetHeaders = extractTableHeaders(
      extractSection(planContract, "Audit Targets")
    );

    expectRecoverySelectionContract();
    expect(auditTargetHeaders).not.toContain("Spillover Executed");
    expect(auditTargetHeaders).not.toContain("Target Reports");
  });

  test("[REQ-163-01 / TC-163-01B] should exempt every eligible recovery run from Audit Targets sampling and grouping limits when inventorying runs", () => {
    const planRules = extractSection(
      readRepositoryFile(paths.plan),
      "Recovery Inventory"
    );
    const contractRules = extractSection(
      readRepositoryFile(paths.planContract),
      "Recovery Inventory"
    );

    for (const rules of [planRules, contractRules]) {
      expect(rules).toMatch(/1 run 1 行/);
      expect(rules).toMatch(/全件/);
      expect(rules).toMatch(/24[^\n]*(?:適用しない|上限外)/);
      expect(rules).toMatch(/代表[^\n]*(?:抽出しない|適用しない)/);
      expect(rules).toMatch(/集約[^\n]*(?:しない|適用しない)/);
    }
  });

  test("[REQ-163-02 / TC-163-02A] should record complete run-level Recovery Coverage when recovered reports are analyzed", () => {
    expectRecoveryCoverageContract();
  });

  test("[REQ-163-02 / TC-163-02B] should preserve report provenance as Evidence when a recovered Finding is emitted", () => {
    expectRecoveryEvidenceContract();
  });

  test("[REQ-163-03 / TC-163-03A] should validate recovered Evidence without weakening normal Evidence when Findings reach filing", () => {
    expectEvidenceValidationContract();
  });

  test("[REQ-163-04 / TC-163-04A] should expose distinct open-search, comment, and create CLI operations when filing Findings", () => {
    expectGitHubCommandContract();
    expectFilingResultsContract();
  });

  test("[REQ-163-05 / TC-163-05C] should preserve direct ABORT rules and normal spillover wiring when recovery uses a later audit", () => {
    expectAbortWiringContract();
  });

  test("[REQ-163-07 / TC-163-07B] should assign completed abort and failed report trees to a later audit while normal completion keeps spillover", () => {
    expectRecoveryLaneContract();
    expectAbortWiringContract();
  });
});
