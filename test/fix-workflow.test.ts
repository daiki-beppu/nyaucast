import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const packageRoot = resolve(import.meta.dir, "..");
const workflowPath = join(packageRoot, ".takt", "workflows", "fix.yaml");
const workflowText = readFileSync(workflowPath, "utf8");
const workflow = Bun.YAML.parse(workflowText) as Record<string, unknown>;

type Step = Record<string, unknown>;

function steps(): Step[] {
  const value = workflow["steps"];
  if (!Array.isArray(value)) {
    throw new Error("fix.steps must be an array");
  }
  return value as Step[];
}

function step(name: string): Step {
  const found = steps().find((candidate) => candidate["name"] === name);
  if (!found) {
    throw new Error(`fix is missing step ${name}`);
  }
  return found;
}

function targets(name: string): string[] {
  const rules = step(name)["rules"];
  if (!Array.isArray(rules)) {
    throw new Error(`${name}.rules must be an array`);
  }
  return rules.flatMap((rule) => {
    if (typeof rule !== "object" || rule === null || Array.isArray(rule)) {
      throw new Error(`${name}.rules must contain objects`);
    }
    const next = (rule as Record<string, unknown>)["next"];
    return typeof next === "string" ? [next] : [];
  });
}

test("fix workflow is an independent entry with fix-specific facets", () => {
  expect(workflow["name"]).toBe("fix");
  expect(workflow["initial_step"]).toBe("pr-context");

  for (const facet of [
    "instructions/fix-diagnosis.md",
    "instructions/fix-diagnosis-review.md",
    "instructions/fix-regression-tests.md",
    "instructions/fix-implementation.md",
    "personas/fix-coder.md",
    "personas/fix-diagnosis-reviewer.md",
    "output-contracts/fix-diagnosis.md",
    "output-contracts/fix-diagnosis-review.md",
    "output-contracts/fix-regression-tests.md",
    "output-contracts/fix-implementation.md",
  ]) {
    expect(existsSync(join(packageRoot, ".takt", "facets", facet))).toBeTrue();
  }
});

test("fix workflow gates intake, diagnosis, and test-first implementation", () => {
  expect(workflowText).toContain("症状");
  expect(workflowText).toContain("再現条件");
  expect(workflowText).toContain("期待動作");
  expect(workflowText).toContain("bug");
  expect(workflowText).toContain("ready-for-agent");

  expect(targets("intake")).toEqual(["diagnosis", "ABORT"]);
  expect(targets("diagnosis")).toEqual(["diagnosis-review", "ABORT"]);
  expect(targets("diagnosis-review")).toEqual([
    "regression-tests",
    "diagnosis",
    "ABORT",
  ]);
  expect(targets("regression-tests")).toEqual(["implement", "ABORT"]);
  expect(targets("implement")).toEqual(["review", "ABORT"]);
  expect(
    workflowText.indexOf("name: regression-tests") <
      workflowText.indexOf("name: implement")
  ).toBeTrue();
});

test("fix workflow bounds diagnosis replanning and delegates shared review delivery", () => {
  const monitors = workflow["loop_monitors"];
  expect(Array.isArray(monitors)).toBeTrue();
  if (!Array.isArray(monitors)) {
    return;
  }
  expect(monitors).toHaveLength(1);
  expect(JSON.stringify(monitors[0])).toContain('"threshold":3');
  expect(JSON.stringify(monitors[0])).toContain("ABORT");

  expect(step("diagnosis")["instruction"]).toBe("fix-diagnosis");
  expect(step("diagnosis-review")["instruction"]).toBe("fix-diagnosis-review");
  expect(step("regression-tests")["instruction"]).toBe("fix-regression-tests");
  expect(step("implement")["instruction"]).toBe("fix-implementation");
  expect(step("review")["call"]).toBe("shared");
  expect(targets("review")).toEqual(["COMPLETE", "diagnosis", "ABORT"]);
});
