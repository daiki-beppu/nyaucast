import { describe, expect, test } from "bun:test";

import { parseYamlRecord, readRepositoryFile } from "../helpers";

const workflowPaths = {
  audit: ".takt/workflows/tayk-audit-architecture.yaml",
  feature: ".takt/workflows/tayk-feature.yaml",
  fix: ".takt/workflows/tayk-fix.yaml",
} as const;

type WorkflowStep = Record<string, unknown> & {
  args?: Record<string, unknown>;
  knowledge?: unknown;
  name?: string;
  parallel?: WorkflowStep[];
};

function readWorkflow(path: string): { steps?: WorkflowStep[] } {
  return parseYamlRecord({
    expectedShape: "a workflow object",
    relativePath: path,
    source: readRepositoryFile(path),
  });
}

function requireStep(path: string, name: string): WorkflowStep {
  const step = readWorkflow(path).steps?.find(
    (candidate) => candidate.name === name
  );
  if (step === undefined) {
    throw new Error(`${path} must declare ${name}`);
  }
  return step;
}

function hasFacet(value: unknown, facet: string): boolean {
  return value === facet || (Array.isArray(value) && value.includes(facet));
}

describe("architecture knowledge contract", () => {
  test("keeps the thin-architecture decision rules in the project knowledge facet", () => {
    const knowledge = readRepositoryFile(
      ".takt/facets/knowledge/architecture.md"
    );

    for (const id of ["TA-02", "TA-03", "TA-04", "TA-05", "TA-06", "TA-07"]) {
      expect(knowledge).toContain(id);
    }
    expect(knowledge).toMatch(/registry/i);
    expect(knowledge).toMatch(/Result/);
    expect(knowledge).toMatch(/createService/);
    expect(knowledge).toMatch(/ADR/);
  });

  test("injects tayk architecture and ADR knowledge into both peer-review calls", () => {
    for (const path of [workflowPaths.feature, workflowPaths.fix]) {
      const review = requireStep(path, "peer_review");
      const knowledge = review.args?.["review_knowledge_additions"];

      expect(hasFacet(knowledge, "architecture")).toBeTrue();
      expect(hasFacet(knowledge, "tayk-adr")).toBeTrue();
      expect(hasFacet(knowledge, "tayk-domain")).toBeTrue();
      expect(hasFacet(review.args?.["fix_knowledge"], "tayk-adr")).toBeTrue();
      expect(
        hasFacet(review.args?.["verification_knowledge"], "tayk-adr")
      ).toBeTrue();
    }
  });

  test("keeps architecture knowledge at the pre-implementation and audit gates", () => {
    const featureReview = requireStep(workflowPaths.feature, "design_review");
    const fixReview = requireStep(workflowPaths.fix, "diagnose_review");
    const auditPlan = requireStep(workflowPaths.audit, "plan");

    expect(
      featureReview.parallel?.some((step) =>
        hasFacet(step.knowledge, "architecture")
      )
    ).toBeTrue();
    expect(
      fixReview.parallel?.some((step) =>
        hasFacet(step.knowledge, "architecture")
      )
    ).toBeTrue();
    expect(hasFacet(auditPlan.knowledge, "architecture")).toBeTrue();
  });
});
