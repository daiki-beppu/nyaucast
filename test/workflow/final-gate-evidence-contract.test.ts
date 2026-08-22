import { describe, expect, test } from "bun:test";

import { parseYamlRecord, readRepositoryFile } from "../helpers";

interface Step {
  args?: Record<string, unknown>;
  call?: string;
  name?: string;
  uses?: string;
  with?: Record<string, unknown>;
}

function requireStep(path: string, name: string): Step {
  const workflow = parseYamlRecord({
    expectedShape: "a workflow object",
    relativePath: path,
    source: readRepositoryFile(path),
  }) as { steps?: Step[] };
  const step = workflow.steps?.find((candidate) => candidate.name === name);
  if (step === undefined) {
    throw new Error(`${path} must declare ${name}`);
  }
  return step;
}

describe("takt 0.60 final-gate contract", () => {
  test("uses requirement scenarios from feature planning through final gate", () => {
    const workflowPath = ".takt/workflows/tayk-feature.yaml";
    const plan = requireStep(workflowPath, "plan");
    const tests = requireStep(workflowPath, "write_tests");
    const review = requireStep(workflowPath, "peer_review");

    expect(plan.uses).toBe("development-core-plan");
    expect(plan.with?.["plan_instruction"]).toBe("scenario-based-plan");
    expect(tests.uses).toBe("development-core-write-tests");
    expect(tests.with?.["testing_instruction"]).toBe(
      "scenario-based-write-tests-first"
    );
    expect(review.call).toBe("peer-review");
    expect(review.args?.["final_gate_instruction"]).toBe(
      "scenario-based-supervise-review-resolution"
    );
    expect(review.args?.["final_gate_policy"]).toContain("tayk-traceability");
    expect(review.args?.["final_gate_policy"]).toContain("tayk-toolchain");
  });

  test("keeps fix on the standard peer-review final gate", () => {
    const review = requireStep(".takt/workflows/tayk-fix.yaml", "peer_review");

    expect(review.call).toBe("peer-review");
    expect(review.args?.["final_gate_instruction"]).toBeUndefined();
    expect(review.args?.["final_gate_policy"]).toContain(
      "existing-system-respect"
    );
  });
});
