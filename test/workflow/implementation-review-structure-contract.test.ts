import { describe, expect, test } from "bun:test";

import { parseYamlRecord, readRepositoryFile } from "../helpers";

const workflowPaths = {
  feature: ".takt/workflows/tayk-feature.yaml",
  fix: ".takt/workflows/tayk-fix.yaml",
} as const;

interface Rule {
  condition?: string;
  next?: string;
}

interface Step {
  args?: Record<string, unknown>;
  call?: string;
  kind?: string;
  name?: string;
  rules?: Rule[];
  uses?: string;
}

function readWorkflow(
  path: string
): Record<string, unknown> & { steps?: Step[] } {
  return parseYamlRecord({
    expectedShape: "a workflow object",
    relativePath: path,
    source: readRepositoryFile(path),
  });
}

function requireStep(path: string, name: string): Step {
  const step = readWorkflow(path).steps?.find(
    (candidate) => candidate.name === name
  );
  if (step === undefined) {
    throw new Error(`${path} must declare ${name}`);
  }
  return step;
}

function route(step: Step, condition: string): string | undefined {
  return step.rules?.find((rule) => rule.condition === condition)?.next;
}

describe("takt 0.59 review convergence wiring", () => {
  test.each(Object.entries(workflowPaths))(
    "%s uses the builtin peer-review adjudication and verified-remediation flow",
    (_name, path) => {
      const source = readRepositoryFile(path);
      const review = requireStep(path, "peer_review");

      expect(review.kind).toBe("workflow_call");
      expect(review.call).toBe("peer-review");
      expect(source).not.toContain("finding_contract:");
      expect(source).not.toContain("findings.");
      expect(source).not.toContain("finding-conflict-adjudication");
      expect(review.args?.["review_policy_additions"]).toContain(
        "tayk-review-convergence"
      );
      expect(review.args?.["fix_policy"]).toContain("tayk-scope-spillover");
      expect(review.args?.["verification_policy"]).toContain("review");
      expect(route(review, "COMPLETE")).toBe("spillover");
      expect(route(review, "ABORT")).toBe("ABORT");
    }
  );

  test("returns peer-review replanning to the workflow-specific planning gate", () => {
    expect(
      route(requireStep(workflowPaths.feature, "peer_review"), "need_replan")
    ).toBe("replan");
    expect(
      route(requireStep(workflowPaths.fix, "peer_review"), "need_replan")
    ).toBe("diagnose");
  });

  test("shares spillover while preserving workflow-specific causal re-entry", () => {
    const feature = requireStep(workflowPaths.feature, "spillover");
    const fix = requireStep(workflowPaths.fix, "spillover");

    expect(feature.uses).toBe("tayk-spillover");
    expect(fix.uses).toBe("tayk-spillover");
    expect(feature.rules?.[0]?.next).toBe("plan");
    expect(fix.rules?.[0]?.next).toBe("diagnose");
  });
});
