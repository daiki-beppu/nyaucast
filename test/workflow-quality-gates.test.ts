import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const packageRoot = resolve(import.meta.dir, "..");
const workflowRoot = join(packageRoot, ".takt", "workflows");

type RecordValue = Record<string, unknown>;

function workflow(name: string): RecordValue {
  const parsed: unknown = Bun.YAML.parse(
    readFileSync(join(workflowRoot, `${name}.yaml`), "utf8")
  );
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${name}.yaml must contain an object`);
  }
  return parsed as RecordValue;
}

function records(value: unknown, label: string): RecordValue[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }
  return value.map((item, index) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new Error(`${label}[${String(index)}] must be an object`);
    }
    return item as RecordValue;
  });
}

function step(name: string, stepName: string): RecordValue {
  const steps = records(workflow(name)["steps"], `${name}.steps`);
  const found = steps.find((candidate) => candidate["name"] === stepName);
  if (!found) {
    throw new Error(`${name} is missing step ${stepName}`);
  }
  return found;
}

function targets(name: string, stepName: string): string[] {
  return records(step(name, stepName)["rules"], `${name}.${stepName}.rules`)
    .map((rule) => rule["next"])
    .filter((target): target is string => typeof target === "string");
}

test("workflow schema validation covers every project workflow and graph edge", () => {
  for (const name of [
    "feature",
    "fix",
    "shared",
    "shared-intake",
    "shared-pr-monitor",
    "pr-repair",
  ]) {
    const definition = workflow(name);
    const steps = records(definition["steps"], `${name}.steps`);
    const names = steps.map((candidate) => candidate["name"]);

    expect(definition["name"]).toBe(name);
    expect(typeof definition["description"]).toBe("string");
    expect(typeof definition["initial_step"]).toBe("string");
    expect(definition["max_steps"]).toBeGreaterThan(0);
    expect(names).toContain(definition["initial_step"]);
    expect(new Set(names).size).toBe(names.length);

    const validTargets = new Set([...names, "COMPLETE", "ABORT"]);
    for (const candidate of steps) {
      expect(typeof candidate["name"]).toBe("string");
      for (const rule of records(
        candidate["rules"],
        `${name}.${String(candidate["name"])}.rules`
      )) {
        expect(validTargets.has(rule["next"])).toBeTrue();
      }
    }
  }
});

test("feature and fix entries preserve their representative success and rejection paths", () => {
  expect(targets("feature", "pr-context")).toEqual([
    "pr-monitor",
    "shared-intake",
  ]);
  expect(targets("feature", "shared-intake")).toEqual(["intake", "ABORT"]);
  expect(targets("feature", "intake")).toEqual(["requirements", "ABORT"]);
  expect(targets("feature", "design-review")).toEqual([
    "tests",
    "requirements",
    "ABORT",
  ]);
  expect(targets("feature", "standards-spec-review")).toEqual([
    "COMPLETE",
    "requirements",
    "ABORT",
  ]);

  expect(targets("fix", "pr-context")).toEqual(["pr-monitor", "shared-intake"]);
  expect(targets("fix", "shared-intake")).toEqual(["intake", "ABORT"]);
  expect(targets("fix", "intake")).toEqual(["diagnosis", "ABORT"]);
  expect(targets("fix", "diagnosis-review")).toEqual([
    "regression-tests",
    "diagnosis",
    "ABORT",
  ]);
  expect(targets("fix", "review")).toEqual(["COMPLETE", "diagnosis", "ABORT"]);
});

test("review repair, quality gates, and bounded stop reasons are wired", () => {
  expect(targets("shared", "review")).toEqual(["delivery", "repair", "ABORT"]);
  expect(targets("shared", "repair")).toEqual(["review", "ABORT"]);
  expect(targets("pr-repair", "repair")).toEqual(["quality-gates", "ABORT"]);
  expect(targets("pr-repair", "quality-gates")).toEqual(["COMPLETE", "repair"]);

  const gates = records(
    step("pr-repair", "quality-gates")["quality_gates"],
    "pr-repair.quality-gates.quality_gates"
  );
  expect(gates.map((gate) => gate["command"])).toEqual([
    "bun install --frozen-lockfile",
    "bun test",
    "bun run typecheck",
    "bun run lint",
    "bun run format:check",
  ]);
  expect(JSON.stringify(workflow("pr-repair")["loop_monitors"])).toContain(
    '"threshold":3'
  );
  expect(JSON.stringify(workflow("pr-repair")["loop_monitors"])).toContain(
    "ABORT"
  );
});

test("reports and PR monitor preserve failure, retry, and resume evidence", () => {
  const monitor = readFileSync(
    join(
      packageRoot,
      ".takt",
      "facets",
      "output-contracts",
      "shared-pr-monitor.md"
    ),
    "utf8"
  );
  const action = readFileSync(
    join(packageRoot, ".github", "workflows", "takt-pr-monitor.yml"),
    "utf8"
  );
  const repairScript = readFileSync(
    join(packageRoot, ".github", "scripts", "takt-pr-repair.sh"),
    "utf8"
  );

  expect(monitor).toMatch(/PR number|PR 番号/i);
  expect(monitor).toMatch(/CI|review/i);
  expect(monitor).toMatch(/COMPLETE/);
  expect(monitor).toMatch(/DEFERRED/);
  expect(monitor).toMatch(/ACTIONABLE_REPAIR/);
  expect(monitor).toMatch(/resume|再開|event/i);
  expect(monitor).toMatch(/bounded|上限|stop|停止/i);
  expect(action).toContain("pull_request_review_comment:");
  expect(action).toContain("workflow_run:");
  expect(action).toContain("--workflow shared-pr-monitor");
  expect(action).toContain("--skip-git");
  expect(repairScript).toContain("--workflow pr-repair");
});
