import { describe, expect, test } from "bun:test";

import { parseYamlRecord, readRepositoryFile } from "../helpers";

interface Step {
  args?: Record<string, unknown>;
  call?: string;
  name?: string;
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

describe("takt 0.59 final-gate contract", () => {
  test("uses requirement scenarios from feature planning through final gate", () => {
    const planPath = ".takt/steps/implementation-high-plan-to-write-tests.yaml";
    const testsPath =
      ".takt/steps/implementation-high-write-tests-to-implement.yaml";
    const plan = parseYamlRecord({
      expectedShape: "a step fragment object",
      relativePath: planPath,
      source: readRepositoryFile(planPath),
    });
    const tests = parseYamlRecord({
      expectedShape: "a step fragment object",
      relativePath: testsPath,
      source: readRepositoryFile(testsPath),
    });
    const review = requireStep(
      ".takt/workflows/tayk-feature.yaml",
      "peer_review"
    );

    expect(plan["instruction"]).toBe("scenario-based-plan");
    expect(tests["instruction"]).toBe("scenario-based-write-tests-first");
    expect(review.call).toBe("peer-review");
    expect(review.args?.["final_gate_instruction"]).toBe(
      "scenario-based-supervise-review-resolution"
    );
  });

  test("keeps fix on the standard peer-review final gate", () => {
    const review = requireStep(".takt/workflows/tayk-fix.yaml", "peer_review");

    expect(review.call).toBe("peer-review");
    expect(review.args?.["final_gate_instruction"]).toBeUndefined();
  });
});
