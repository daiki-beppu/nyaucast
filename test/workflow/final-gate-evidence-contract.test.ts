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
const finalGateFragmentPath = ".takt/steps/finding-contract-final-gate.yaml";

interface WorkflowDefinition {
  steps?: WorkflowStep[];
}

interface WorkflowRule {
  condition?: string;
  next?: string;
}

interface WorkflowStep {
  args?: {
    supervise_knowledge?: unknown;
  };
  call?: string;
  kind?: string;
  name?: string;
  rules?: WorkflowRule[];
  uses?: string;
}

interface FinalGateWiring {
  fragment: WorkflowStep;
  roots: Record<"feature" | "fix", WorkflowStep>;
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

function readFinalGateWiring(): FinalGateWiring {
  return {
    fragment: parseYamlRecord({
      expectedShape: "a step fragment object",
      relativePath: finalGateFragmentPath,
      source: readRepositoryFile(finalGateFragmentPath),
    }),
    roots: {
      feature: requireFinalGate(workflowPaths.feature),
      fix: requireFinalGate(workflowPaths.fix),
    },
  };
}

function hasKnowledge(value: unknown, expected: string): boolean {
  return (
    value === expected || (Array.isArray(value) && value.includes(expected))
  );
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function findInvalidFinalGateWiring(wiring: FinalGateWiring): string[] {
  const invalid: string[] = [];
  for (const rootName of ["feature", "fix"] as const) {
    if (wiring.roots[rootName].uses !== "finding-contract-final-gate") {
      invalid.push(`${rootName}.final_gate.uses`);
    }
  }
  if (wiring.fragment.call !== "merge-readiness-finding-contract-final-gate") {
    invalid.push("fragment.call");
  }
  for (const knowledge of ["architecture", "takt"] as const) {
    if (!hasKnowledge(wiring.fragment.args?.supervise_knowledge, knowledge)) {
      invalid.push(`fragment.args.supervise_knowledge.${knowledge}`);
    }
  }
  return invalid;
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

describe("[REQ-285-02] final gate fragment wiring contract", () => {
  test("TC-285-02a: both roots reach the canonical builtin with required supervision knowledge", () => {
    expect(findInvalidFinalGateWiring(readFinalGateWiring())).toEqual([]);
  });

  test("TC-285-02b: rejects the same wrong project fragment on both roots", () => {
    const fixture = structuredClone(readFinalGateWiring());
    fixture.roots.feature.uses = "other-final-gate";
    fixture.roots.fix.uses = "other-final-gate";

    expect(findInvalidFinalGateWiring(fixture)).toEqual([
      "feature.final_gate.uses",
      "fix.final_gate.uses",
    ]);
  });

  test("TC-285-02c: rejects a project fragment that calls another builtin", () => {
    const fixture = structuredClone(readFinalGateWiring());
    fixture.fragment.call = "other-final-gate";

    expect(findInvalidFinalGateWiring(fixture)).toEqual(["fragment.call"]);
  });

  test.each(["architecture", "takt"] as const)(
    "TC-285-02d: rejects missing %s supervision knowledge",
    (knowledge) => {
      const fixture = structuredClone(readFinalGateWiring());
      const args = fixture.fragment.args;
      if (args === undefined || !isUnknownArray(args.supervise_knowledge)) {
        throw new TypeError(
          "final-gate fragment must declare knowledge as an array"
        );
      }
      const values = args.supervise_knowledge;
      args.supervise_knowledge = values.filter((value) => value !== knowledge);

      expect(findInvalidFinalGateWiring(fixture)).toEqual([
        `fragment.args.supervise_knowledge.${knowledge}`,
      ]);
    }
  );

  test("TC-285-02d: allows unrelated supervision knowledge", () => {
    const fixture = structuredClone(readFinalGateWiring());
    const args = fixture.fragment.args;
    if (args === undefined || !isUnknownArray(args.supervise_knowledge)) {
      throw new TypeError(
        "final-gate fragment must declare knowledge as an array"
      );
    }
    const values = args.supervise_knowledge;
    args.supervise_knowledge = [...values, "tayk-domain"];

    expect(findInvalidFinalGateWiring(fixture)).toEqual([]);
  });
});
