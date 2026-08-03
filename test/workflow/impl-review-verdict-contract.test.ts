import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { parse } from "yaml";

const packageRoot = resolve(import.meta.dirname, "../..");
const parentStepName = "impl_review";
const receptacleCondition = "when(true)";
const backtrackAlias = "<backtrack>";

/**
 * #212 で実装レビューが callable から親へ展開されたため、検査対象は 2 本になった。
 * `backtrackStep` は provisional 指摘でゲートが塞がれたときの差し戻し先で、
 * feature / fix の間で意図的に異なる唯一の遷移である（ADR-0008 決定 12 改訂）。
 */
const workflows = [
  { backtrackStep: "plan", path: ".takt/workflows/tayk-feature.yaml" },
  { backtrackStep: "diagnose", path: ".takt/workflows/tayk-fix.yaml" },
] as const;

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
  kind: "all" | "any";
  targets: string[];
}

interface ParentRule {
  aggregate?: AggregateCondition;
  next: string;
  raw: string;
  when?: string;
}

interface SubStepVerdicts {
  name: string;
  verdicts: string[];
}

interface ImplReviewContract {
  parentRules: ParentRule[];
  step: WorkflowStep;
  subStepVerdicts: SubStepVerdicts[];
}

function readRepositoryFile(relativePath: string): string {
  return readFileSync(join(packageRoot, relativePath), "utf-8");
}

/**
 * 括弧・引用符を尊重してトップレベルの区切りで分割する。takt の
 * `splitTopLevelClauses` と同じトークナイズでないと `all(...) && when(...)` の
 * 左右を取り違える。
 */
function splitTopLevel(expression: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let inString = false;
  let start = 0;

  for (let index = 0; index < expression.length; index += 1) {
    const current = expression[index];

    if (current === '"') {
      inString = !inString;
      continue;
    }
    if (inString) {
      continue;
    }
    if (current === "(") {
      depth += 1;
      continue;
    }
    if (current === ")") {
      depth -= 1;
      continue;
    }
    if (depth === 0 && expression.startsWith(separator, index)) {
      parts.push(expression.slice(start, index).trim());
      start = index + separator.length;
      index += separator.length - 1;
    }
  }
  parts.push(expression.slice(start).trim());
  return parts;
}

function parseWorkflow(relativePath: string): WorkflowDefinition {
  const value: unknown = parse(readRepositoryFile(relativePath));

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${relativePath} must contain a workflow object`);
  }
  return value;
}

function requireParentStep(workflowPath: string): WorkflowStep {
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

function requireSubSteps(
  step: WorkflowStep,
  workflowPath: string
): WorkflowSubStep[] {
  if (!Array.isArray(step.parallel) || step.parallel.length === 0) {
    throw new TypeError(
      `${workflowPath} ${parentStepName} must declare parallel sub-steps`
    );
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
 * sub-step の verdict ラベル。takt は `condition` の値の構文で決定的分岐か LLM 判定かを
 * 決めるため、`when(...)` 単体の条件は verdict ではない。
 */
function verdictLabelsOf(rules: WorkflowRule[], owner: string): string[] {
  const labels: string[] = [];

  for (const rule of rules) {
    if (typeof rule.condition !== "string") {
      continue;
    }
    if (splitTopLevel(rule.condition, "&&").length > 1) {
      throw new TypeError(
        `${owner} declares a composite sub-step condition this contract does not model: ${rule.condition}`
      );
    }
    if (rule.condition.startsWith("when(")) {
      continue;
    }
    labels.push(rule.condition);
  }

  if (labels.length === 0) {
    throw new TypeError(`${owner} must declare at least one verdict condition`);
  }
  return labels;
}

function parseAggregateClause(clause: string): AggregateCondition | undefined {
  const matched = /^(all|any)\((.*)\)$/s.exec(clause);
  const kind = matched?.[1];
  const argsText = matched?.[2];

  if (kind === undefined || argsText === undefined) {
    return undefined;
  }

  const targets: unknown = JSON.parse(`[${argsText}]`);

  if (
    !Array.isArray(targets) ||
    !targets.every((target): target is string => typeof target === "string")
  ) {
    throw new TypeError(`${clause} must list quoted verdict labels`);
  }
  return { kind: kind === "all" ? "all" : "any", targets };
}

/** 未知の構文は投げ、宣言済みの aggregate targets の読み落としを防ぐ。 */
function parseParentRule(rule: WorkflowRule, owner: string): ParentRule {
  const condition = rule.condition;
  const next = rule.next;

  if (typeof condition !== "string" || typeof next !== "string") {
    throw new TypeError(`${owner} must declare a condition and a next step`);
  }

  const clauses = splitTopLevel(condition, "&&");
  const parsed: ParentRule = { next, raw: condition };

  for (const clause of clauses) {
    const aggregate = parseAggregateClause(clause);

    if (aggregate !== undefined) {
      parsed.aggregate = aggregate;
      continue;
    }
    if (clause.startsWith("when(") && clause.endsWith(")")) {
      parsed.when = clause.slice("when(".length, -1).trim();
      continue;
    }
    throw new TypeError(`${owner} declares an unsupported clause: ${clause}`);
  }

  if (parsed.aggregate === undefined && parsed.when === undefined) {
    throw new TypeError(`${owner} declares a rule with no evaluable clause`);
  }
  return parsed;
}

function requireAggregateRule(
  rules: readonly ParentRule[],
  kind: "all" | "any",
  workflowPath: string
): ParentRule {
  const rule = rules.find((candidate) => candidate.aggregate?.kind === kind);

  if (rule === undefined) {
    throw new TypeError(
      `${workflowPath} ${parentStepName} must declare an ${kind}() rule`
    );
  }
  return rule;
}

function readImplReviewContract(workflowPath: string): ImplReviewContract {
  const step = requireParentStep(workflowPath);
  const subSteps = requireSubSteps(step, workflowPath);
  const owner = `${workflowPath} ${parentStepName}`;

  return {
    parentRules: requireRules(step.rules, owner).map((rule, index) =>
      parseParentRule(rule, `${owner} rules[${index}]`)
    ),
    step,
    subStepVerdicts: subSteps.map((subStep) => {
      const name = subStep.name ?? "(unnamed)";
      return {
        name,
        verdicts: verdictLabelsOf(
          requireRules(subStep.rules, `${owner}.${name}`),
          `${owner}.${name}`
        ),
      };
    }),
  };
}

/** 意図された唯一の差分（差し戻し先）を伏せて、複製 2 本を構造比較できるようにする。 */
function normalizeBacktrack(
  step: WorkflowStep,
  backtrackStep: string
): WorkflowStep {
  if (step.rules === undefined) {
    return step;
  }
  return {
    ...step,
    rules: step.rules.map((rule) =>
      rule.next === backtrackStep ? { ...rule, next: backtrackAlias } : rule
    ),
  };
}

const contracts = new Map<string, ImplReviewContract>(
  workflows.map((workflow) => [
    workflow.path,
    readImplReviewContract(workflow.path),
  ])
);

function requireContract(workflowPath: string): ImplReviewContract {
  const contract = contracts.get(workflowPath);

  if (contract === undefined) {
    throw new TypeError(`${workflowPath} contract was not loaded`);
  }
  return contract;
}

describe("impl_review verdict aggregation contract", () => {
  test("[REQ-197-04] should position all() targets against the declared sub-step order", () => {
    for (const { path } of workflows) {
      const { parentRules, subStepVerdicts } = requireContract(path);
      const targets = requireAggregateRule(parentRules, "all", path).aggregate
        ?.targets;

      expect(targets).toHaveLength(subStepVerdicts.length);

      for (const [index, target] of (targets ?? []).entries()) {
        expect(subStepVerdicts[index]?.verdicts).toContain(target);
      }
    }
  });

  test("[REQ-197-04] should cover every non-approving verdict with the any() rule", () => {
    for (const { path } of workflows) {
      const { parentRules, subStepVerdicts } = requireContract(path);
      const allTargets =
        requireAggregateRule(parentRules, "all", path).aggregate?.targets ?? [];
      const fixTargets =
        parentRules.find((rule) => rule.next === "fix")?.aggregate?.targets ??
        [];
      const nonApproving = subStepVerdicts.flatMap((subStep, index) =>
        subStep.verdicts.filter((verdict) => verdict !== allTargets[index])
      );

      expect(nonApproving).not.toBeEmpty();
      expect(
        nonApproving.filter((verdict) => !fixTargets.includes(verdict))
      ).toEqual([]);
    }
  });

  test("[REQ-197-04] should keep the deterministic receptacle as the last rule", () => {
    for (const { path } of workflows) {
      const lastRule = requireContract(path).parentRules.at(-1);

      expect(lastRule?.raw).toBe(receptacleCondition);
      expect(lastRule?.next).toBe(parentStepName);
    }
  });

  test("[REQ-197-04] should keep both impl_review duplicates identical apart from the backtrack target", () => {
    const [featureWorkflow, fixWorkflow] = workflows;

    expect(
      normalizeBacktrack(
        requireContract(featureWorkflow.path).step,
        featureWorkflow.backtrackStep
      )
    ).toEqual(
      normalizeBacktrack(
        requireContract(fixWorkflow.path).step,
        fixWorkflow.backtrackStep
      )
    );
  });
});
