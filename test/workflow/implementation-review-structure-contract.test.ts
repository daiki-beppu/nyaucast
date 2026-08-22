import { describe, expect, test } from "bun:test";

import { parseYamlRecord, readRepositoryFile } from "../helpers";

const workflowPaths = {
  feature: ".takt/workflows/tayk-feature.yaml",
  fix: ".takt/workflows/tayk-fix.yaml",
} as const;

const skillEnabledStepPaths = [
  ".takt/steps/implementation-high-replan-to-implement.yaml",
] as const;

interface Rule {
  condition?: string;
  next?: string;
}

interface Step {
  args?: Record<string, unknown>;
  call?: string;
  capabilities?: unknown;
  instruction?: string | string[];
  kind?: string;
  name?: string;
  output_contracts?: {
    report?: { format?: string; name?: string }[];
  };
  rules?: Rule[];
  uses?: string;
  with?: Record<string, unknown>;
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

describe("takt 0.60 review convergence wiring", () => {
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
      expect(review.args?.["security_review_knowledge_additions"]).toEqual([
        "takt",
        "architecture",
        "tayk-adr",
        "tayk-domain",
      ]);
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

  test("keeps edit and skill capabilities on every direct coding step", () => {
    expect(
      requireStep(workflowPaths.feature, "implement").capabilities
    ).toEqual(["edit", "enable-skills"]);
    expect(requireStep(workflowPaths.fix, "reproduce").capabilities).toEqual([
      "edit",
      "enable-skills",
    ]);
    expect(requireStep(workflowPaths.fix, "repair").capabilities).toEqual([
      "edit",
      "enable-skills",
    ]);
  });

  test("uses parameterized builtin fragments for planning and test writing", () => {
    const plan = requireStep(workflowPaths.feature, "plan");
    const writeTests = requireStep(workflowPaths.feature, "write_tests");

    expect(plan.uses).toBe("development-core-plan");
    expect(plan.with?.["plan_instruction"]).toBe("scenario-based-plan");
    expect(plan.capabilities).toEqual(["readonly", "enable-skills"]);
    expect(writeTests.uses).toBe("development-core-write-tests");
    expect(writeTests.with?.["testing_instruction"]).toBe(
      "scenario-based-write-tests-first"
    );
    expect(writeTests.capabilities).toEqual(["edit", "enable-skills"]);
  });

  test("enables skills on diagnosis and the remaining local replan fragment", () => {
    expect(requireStep(workflowPaths.fix, "diagnose").capabilities).toEqual([
      "readonly",
      "enable-skills",
    ]);

    for (const path of skillEnabledStepPaths) {
      const step = parseYamlRecord({
        expectedShape: "a step object",
        relativePath: path,
        source: readRepositoryFile(path),
      });

      expect(step["capabilities"]).toContain("enable-skills");
    }
  });

  test("composes builtin and tayk instructions instead of replacing upstream contracts", () => {
    expect(requireStep(workflowPaths.feature, "replan").instruction).toEqual([
      "scenario-based-replan-implementation",
      "tayk-replan-implementation",
    ]);
    expect(requireStep(workflowPaths.fix, "reproduce").instruction).toEqual([
      "write-tests-first",
      "tayk-reproduce",
    ]);
    expect(requireStep(workflowPaths.fix, "repair").instruction).toEqual([
      "implement-maintenance",
      "tayk-repair",
    ]);
    expect(
      readRepositoryFile(
        ".takt/facets/output-contracts/tayk-replan-decision.md"
      )
    ).toStartWith("{extends:scenario-based-plan}");
  });

  test("keeps tayk policy at the 0.60 final gate", () => {
    const featurePolicy = requireStep(workflowPaths.feature, "peer_review")
      .args?.["final_gate_policy"];
    const fixPolicy = requireStep(workflowPaths.fix, "peer_review").args?.[
      "final_gate_policy"
    ];

    expect(featurePolicy).toEqual([
      "coding",
      "testing",
      "review",
      "architecture",
      "takt",
      "tayk-traceability",
      "tayk-toolchain",
    ]);
    expect(fixPolicy).toEqual([
      "coding",
      "testing",
      "review",
      "architecture",
      "takt",
      "existing-system-respect",
      "tayk-traceability",
      "tayk-toolchain",
    ]);
  });
});
