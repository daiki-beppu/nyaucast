import { describe, expect, test } from "bun:test";

import { parseYamlRecord, readRepositoryFile } from "../helpers";

interface YamlRecord extends Record<string, unknown> {
  condition?: unknown;
  edit?: unknown;
  instruction?: unknown;
  name?: unknown;
  next?: unknown;
  output_contracts?: unknown;
  rules?: unknown;
  steps?: unknown;
  uses?: unknown;
}

function requireRecord(value: unknown, label: string): YamlRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as YamlRecord;
}

function requireArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`${label} must be an array`);
  }
  return value;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new TypeError(`${label} must be a string`);
  }
  return value;
}

function readWorkflow(path: string): YamlRecord {
  return parseYamlRecord({
    expectedShape: "an object",
    relativePath: path,
    source: readRepositoryFile(path),
  });
}

function requireStep(workflow: YamlRecord, name: string): YamlRecord {
  const matches = requireArray(workflow.steps, "workflow.steps")
    .map((step, index) => requireRecord(step, `workflow.steps[${index}]`))
    .filter((step) => step.name === name);
  if (matches.length !== 1) {
    throw new TypeError(`workflow must contain exactly one ${name} step`);
  }
  const match = matches[0];
  if (match === undefined) {
    throw new TypeError(`workflow must contain exactly one ${name} step`);
  }
  return match;
}

function requireRules(step: YamlRecord): YamlRecord[] {
  return requireArray(step.rules, `${String(step.name)}.rules`).map(
    (rule, index) => requireRecord(rule, `${String(step.name)}.rules[${index}]`)
  );
}

function requireRule(step: YamlRecord, condition: string): YamlRecord {
  const matches = requireRules(step).filter(
    (rule) => rule.condition === condition
  );
  if (matches.length !== 1) {
    throw new TypeError(
      `${String(step.name)} must contain exactly one ${condition} rule`
    );
  }
  const match = matches[0];
  if (match === undefined) {
    throw new TypeError(
      `${String(step.name)} must contain exactly one ${condition} rule`
    );
  }
  return match;
}

function requireReportFormat(step: YamlRecord): string {
  const outputContracts = requireRecord(
    step.output_contracts,
    `${String(step.name)}.output_contracts`
  );
  const reports = requireArray(
    outputContracts["report"],
    `${String(step.name)}.output_contracts.report`
  );
  if (reports.length !== 1) {
    throw new TypeError(`${String(step.name)} must declare exactly one report`);
  }
  const report = requireRecord(reports[0], `${String(step.name)} report`);
  return requireString(report["format"], `${String(step.name)} report.format`);
}

describe("[REQ-292] replan ABORT safety contract", () => {
  test("should require a separate consistency review before the feature workflow may preserve and abort", () => {
    const feature = readWorkflow(".takt/workflows/tayk-feature.yaml");
    const replan = requireStep(feature, "replan");
    const review = requireStep(feature, "replan_abort_review");

    expect(requireRules(replan).some((rule) => rule.next === "ABORT")).toBe(
      false
    );
    expect(
      requireRule(
        replan,
        "確認済みの根拠により、プロジェクト内の変更や調査では解消できず、外部操作だけが残るか要件が両立不能である"
      ).next
    ).toBe("replan_abort_review");
    expect(requireReportFormat(replan)).toBe("tayk-replan-decision");
    expect(requireRule(review, "ABORT_CONFIRMED").next).toBe(
      "preserve_abort_worktree"
    );
    expect(requireRule(review, "REPLAN_REQUIRED").next).toBe("implement");
    expect(requireReportFormat(review)).toBe("tayk-replan-abort-review");
  });

  test("should write a recovery manifest before the only reviewed ABORT transition", () => {
    const feature = readWorkflow(".takt/workflows/tayk-feature.yaml");
    const preservation = requireStep(feature, "preserve_abort_worktree");

    expect(preservation.edit).toBe(false);
    expect(requireReportFormat(preservation)).toBe(
      "tayk-abort-worktree-recovery"
    );
    expect(requireRules(preservation)).toEqual([
      { condition: "when(true)", next: "ABORT" },
    ]);
  });

  test("should not duplicate the feature-only replan path in tayk-fix", () => {
    const fix = readWorkflow(".takt/workflows/tayk-fix.yaml");
    const stepNames = requireArray(fix.steps, "fix.steps").map((step, index) =>
      requireString(
        requireRecord(step, `fix.steps[${index}]`).name,
        "step.name"
      )
    );

    expect(stepNames).not.toContain("replan");
    expect(stepNames).not.toContain("replan_abort_review");
    expect(stepNames).not.toContain("preserve_abort_worktree");
  });
});
