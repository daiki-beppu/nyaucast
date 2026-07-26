import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const packageRoot = resolve(import.meta.dir, "..");
const workflowPath = join(packageRoot, ".takt", "workflows", "feature.yaml");
const workflowText = readFileSync(workflowPath, "utf8");
const workflow = Bun.YAML.parse(workflowText) as Record<string, unknown>;

test("feature workflow resolves its dedicated facets and agents", () => {
  const policies = workflow["policies"] as Record<string, string>;
  const personas = workflow["personas"] as Record<string, string>;

  expect(Object.keys(policies)).toEqual(["coding", "testing", "review"]);
  expect(Object.keys(personas)).toEqual([
    "planner",
    "architecture-reviewer",
    "coder",
  ]);

  for (const relativePath of [
    ...Object.values(policies),
    ...Object.values(personas),
  ]) {
    expect(
      existsSync(join(packageRoot, ".takt", "workflows", relativePath))
    ).toBeTrue();
  }
});

test("feature workflow keeps requirements, design review, and test-first gates", () => {
  expect(workflow["initial_step"]).toBe("pr-context");
  expect(workflowText).toContain("name: requirements");
  expect(workflowText).toContain("name: design-review");
  expect(workflowText).toContain("name: tests");
  expect(workflowText.indexOf("name: tests")).toBeLessThan(
    workflowText.indexOf("name: implement")
  );
  expect(workflowText).toContain("REQ-001");
  expect(workflowText).toContain("next: requirements");
  expect(workflowText).toContain("next: ABORT");
});

test("feature workflow bounds design replanning and delegates review delivery", () => {
  const loopMonitors = workflow["loop_monitors"];

  expect(Array.isArray(loopMonitors)).toBeTrue();
  if (!Array.isArray(loopMonitors)) {
    return;
  }

  expect(loopMonitors).toHaveLength(1);
  const monitor = loopMonitors[0] as Record<string, unknown>;
  expect(monitor["cycle"]).toEqual(["requirements", "design-review"]);
  expect(monitor["threshold"]).toBe(3);
  expect(JSON.stringify(monitor)).toContain("ABORT");

  const steps = workflow["steps"] as Record<string, unknown>[];
  const intake = steps.find((step) => step["name"] === "intake");
  const designReview = steps.find((step) => step["name"] === "design-review");
  const tests = steps.find((step) => step["name"] === "tests");
  const implement = steps.find((step) => step["name"] === "implement");
  const finalReview = steps.find(
    (step) => step["name"] === "standards-spec-review"
  );

  expect(JSON.stringify(intake)).toContain('"next":"ABORT"');
  expect(JSON.stringify(designReview)).toContain('"next":"requirements"');
  expect(finalReview?.["call"]).toBe("shared");
  expect(JSON.stringify(finalReview)).toContain("need_replan");
  expect(JSON.stringify(tests)).toContain('"next":"implement"');
  expect(JSON.stringify(implement)).toContain('"next":"standards-spec-review"');
  expect(JSON.stringify(implement)).toContain('"next":"ABORT"');
});
