import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { parse } from "yaml";

const packageRoot = resolve(import.meta.dirname, "../..");
const workflowPath = ".takt/workflows/tayk-impl-review.yaml";
const parentStepName = "impl_review";
const receptacleCondition = "when(true)";

interface WorkflowRule {
  condition?: string;
  next?: string;
  return?: string;
}

interface WorkflowSubStep {
  name?: string;
  rules?: WorkflowRule[];
}

interface WorkflowStep {
  name?: string;
  parallel?: WorkflowSubStep[];
  rules?: WorkflowRule[];
}

interface WorkflowDefinition {
  steps?: WorkflowStep[];
}

interface AggregateCondition {
  aggregate: "all" | "any";
  targets: string[];
}

function readRepositoryFile(relativePath: string): string {
  return readFileSync(join(packageRoot, relativePath), "utf-8");
}

function parseWorkflow(relativePath: string): WorkflowDefinition {
  const value: unknown = parse(readRepositoryFile(relativePath));

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${relativePath} must contain a workflow object`);
  }
  return value;
}

function requireParentStep(): WorkflowStep {
  const steps = parseWorkflow(workflowPath).steps;

  if (!Array.isArray(steps)) {
    throw new TypeError(`${workflowPath} must declare steps`);
  }

  const step = steps.find((candidate) => candidate.name === parentStepName);

  if (step === undefined) {
    throw new TypeError(
      `${workflowPath} must declare the ${parentStepName} step`
    );
  }
  return step;
}

function requireSubSteps(step: WorkflowStep): WorkflowSubStep[] {
  if (!Array.isArray(step.parallel) || step.parallel.length === 0) {
    throw new TypeError(`${parentStepName} must declare parallel sub-steps`);
  }
  return step.parallel;
}

function requireRules(
  rules: WorkflowRule[] | undefined,
  owner: string
): WorkflowRule[] {
  if (!Array.isArray(rules) || rules.length === 0) {
    throw new TypeError(`${owner} must declare rules`);
  }
  return rules;
}

/**
 * takt は `condition` の値の構文で決定的分岐か LLM 判定かを決める。verdict ラベルは
 * `when(...)` を含まない semantic condition だけが該当する。
 */
function semanticConditions(rules: WorkflowRule[], owner: string): string[] {
  const labels = rules
    .map((rule) => rule.condition)
    .filter((condition): condition is string => typeof condition === "string")
    .filter((condition) => !condition.startsWith("when("));

  if (labels.length === 0) {
    throw new TypeError(`${owner} must declare at least one verdict condition`);
  }
  return labels;
}

function parseAggregateCondition(
  condition: string
): AggregateCondition | undefined {
  const matched = /^(all|any)\((.*)\)$/s.exec(condition);
  const aggregate = matched?.[1];
  const argsText = matched?.[2];

  if (aggregate === undefined || argsText === undefined) {
    return undefined;
  }

  const targets: unknown = JSON.parse(`[${argsText}]`);

  if (
    !Array.isArray(targets) ||
    !targets.every((target): target is string => typeof target === "string")
  ) {
    throw new TypeError(`${condition} must list quoted verdict labels`);
  }
  return { aggregate: aggregate === "all" ? "all" : "any", targets };
}

function requireAggregateRule(
  rules: WorkflowRule[],
  aggregate: "all" | "any"
): { condition: AggregateCondition; rule: WorkflowRule } {
  for (const rule of rules) {
    const condition =
      rule.condition === undefined
        ? undefined
        : parseAggregateCondition(rule.condition);

    if (condition?.aggregate === aggregate) {
      return { condition, rule };
    }
  }
  throw new TypeError(`${parentStepName} must declare an ${aggregate}() rule`);
}

/**
 * takt の AggregateEvaluator と同じ判定を再現する。`all()` は引数が2個以上のとき
 * 並列 sub-step と位置対応で照合し、`any()` は集合の包含で照合する。
 */
function matchesAll(verdicts: string[], targets: string[]): boolean {
  if (targets.length === 1) {
    return verdicts.every((verdict) => verdict === targets[0]);
  }
  return (
    verdicts.length === targets.length &&
    verdicts.every((verdict, index) => verdict === targets[index])
  );
}

function matchesAny(verdicts: string[], targets: string[]): boolean {
  return verdicts.some((verdict) => targets.includes(verdict));
}

function cartesianProduct(groups: string[][]): string[][] {
  let combinations: string[][] = [[]];

  for (const group of groups) {
    combinations = combinations.flatMap((combination) =>
      group.map((value) => [...combination, value])
    );
  }
  return combinations;
}

const parentStep = requireParentStep();
const subSteps = requireSubSteps(parentStep);
const parentRules = requireRules(parentStep.rules, parentStepName);
const subStepVerdicts = subSteps.map((subStep) => {
  const name = subStep.name ?? "(unnamed)";
  return {
    name,
    verdicts: semanticConditions(
      requireRules(subStep.rules, `${parentStepName}.${name}`),
      `${parentStepName}.${name}`
    ),
  };
});

describe("impl_review verdict aggregation contract", () => {
  test("[REQ-197-01] should position all() targets against the declared sub-step order", () => {
    const { condition } = requireAggregateRule(parentRules, "all");

    expect(condition.targets).toHaveLength(subSteps.length);

    for (const [index, target] of condition.targets.entries()) {
      expect(subStepVerdicts[index]?.verdicts).toContain(target);
    }
  });

  test("[REQ-197-02] should route every all() match to COMPLETE and any() match to fix", () => {
    expect(requireAggregateRule(parentRules, "all").rule.next).toBe("COMPLETE");
    expect(requireAggregateRule(parentRules, "any").rule.next).toBe("fix");
  });

  test("[REQ-197-03] should classify every verdict combination without a rule mismatch", () => {
    const allTargets = requireAggregateRule(parentRules, "all").condition
      .targets;
    const anyTargets = requireAggregateRule(parentRules, "any").condition
      .targets;
    const combinations = cartesianProduct(
      subStepVerdicts.map((subStep) => subStep.verdicts)
    );

    expect(combinations).not.toBeEmpty();

    const unclassified = combinations.filter(
      (verdicts) =>
        !(matchesAll(verdicts, allTargets) || matchesAny(verdicts, anyTargets))
    );

    expect(unclassified).toEqual([]);
  });

  test("[REQ-197-04] should keep the deterministic receptacle as the last rule", () => {
    const lastRule = parentRules.at(-1);

    expect(lastRule?.condition).toBe(receptacleCondition);
    expect(lastRule?.next).toBe(parentStepName);
  });
});
