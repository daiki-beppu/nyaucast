import { describe, expect, test } from "bun:test";

import { parseYamlRecord, readRepositoryFile } from "../helpers";

const instructionPaths = {
  review: ".takt/facets/instructions/review-merge-readiness.md",
  supervise: ".takt/facets/instructions/supervise-finding-contract.md",
} as const;
const workflowPaths = {
  feature: ".takt/workflows/tayk-feature.yaml",
  fix: ".takt/workflows/tayk-fix.yaml",
} as const;

interface WorkflowDefinition {
  steps?: WorkflowStep[];
}

interface WorkflowRule {
  condition?: string;
  next?: string;
}

interface WorkflowStep {
  args?: unknown;
  call?: string;
  kind?: string;
  name?: string;
  rules?: WorkflowRule[];
}

function requireFinalGate(path: string): WorkflowStep {
  const workflow = parseYamlRecord({
    expectedShape: "a workflow object",
    relativePath: path,
    source: readRepositoryFile(path),
  }) as WorkflowDefinition;
  const finalGate = workflow.steps?.find((step) => step.name === "final_gate");
  if (finalGate === undefined) {
    throw new Error(`${path} must declare final_gate`);
  }
  return finalGate;
}

function normalizeFinalGate(step: WorkflowStep): WorkflowStep {
  if (step.rules === undefined) {
    throw new Error("final_gate must declare rules");
  }
  return {
    ...step,
    rules: step.rules.map((rule) =>
      rule.condition === "need_replan" ? { ...rule, next: "REPLAN" } : rule
    ),
  };
}

function readProjectAddendum(path: string): string {
  return readRepositoryFile(path).split("\n").slice(1).join("\n").trim();
}

describe("[REQ-200-02][REQ-200-03] final gate facet override contract", () => {
  test.each(Object.entries(instructionPaths))(
    "should extend the builtin %s instruction from the project layer",
    (_stepName, path) => {
      const instruction = readRepositoryFile(path);
      const facetName = path.split("/").at(-1)?.replace(".md", "");

      expect(instruction.split("\n")[0]).toBe(`{extends:${facetName}}`);
      expect(readProjectAddendum(path).length).toBeGreaterThan(0);
    }
  );

  test("should apply the same project evidence addendum to review and supervise", () => {
    expect(readProjectAddendum(instructionPaths.review)).toBe(
      readProjectAddendum(instructionPaths.supervise)
    );
  });
});

describe("[REQ-200-05] duplicated final gate contract", () => {
  test("should keep feature and fix aligned except for their replan destination", () => {
    const feature = normalizeFinalGate(requireFinalGate(workflowPaths.feature));
    const fix = normalizeFinalGate(requireFinalGate(workflowPaths.fix));

    expect(feature).toEqual(fix);
  });
});
