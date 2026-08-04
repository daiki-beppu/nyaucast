import { describe, expect, test } from "bun:test";

import { parseYamlRecord, readRepositoryFile } from "../helpers";

const facetPaths = [
  ".takt/facets/instructions/findings-manager.md",
  ".takt/facets/output-contracts/findings-manager.md",
] as const;
const workflowPaths = {
  feature: ".takt/workflows/tayk-feature.yaml",
  fix: ".takt/workflows/tayk-fix.yaml",
} as const;

interface FindingsManager {
  instruction?: string;
  output_contract?: string;
}

interface WorkflowDefinition {
  finding_contract?: {
    manager?: FindingsManager;
  };
}

type FindingsManagerWiring = Record<"feature" | "fix", FindingsManager>;

interface DecisionRow {
  decision: string;
  engineOutcome: string;
  findingId: string;
  reference: string;
  relation: string;
}

interface OutcomeOwnerRow {
  idKind: string;
  outputField: string;
  rawOutcome: string;
}

function readDecisionRows(source: string): DecisionRow[] {
  const lines = source.split("\n");
  const heading = lines.indexOf("## tayk raw finding decision matrix");
  if (heading === -1) {
    throw new Error("missing tayk raw finding decision matrix");
  }

  const tableLines = lines.slice(heading + 3);
  const tableEnd = tableLines.findIndex((line) => !line.startsWith("|"));

  return tableLines
    .slice(0, tableEnd === -1 ? undefined : tableEnd)
    .map((line) =>
      line
        .split("|")
        .slice(1, -1)
        .map((cell) => cell.trim())
    )
    .map(([relation, reference, decision, findingId, engineOutcome]) => {
      if (
        relation === undefined ||
        reference === undefined ||
        decision === undefined ||
        findingId === undefined ||
        engineOutcome === undefined
      ) {
        throw new Error(`invalid decision matrix row: ${relation ?? ""}`);
      }
      return { decision, engineOutcome, findingId, reference, relation };
    });
}

function readOutcomeOwnerRows(source: string): OutcomeOwnerRow[] {
  const lines = source.split("\n");
  const heading = lines.indexOf("## tayk outcome ownership matrix");
  if (heading === -1) {
    throw new Error("missing tayk outcome ownership matrix");
  }

  const tableLines = lines.slice(heading + 3);
  const tableEnd = tableLines.findIndex((line) => !line.startsWith("|"));
  return tableLines
    .slice(0, tableEnd === -1 ? undefined : tableEnd)
    .map((line) =>
      line
        .split("|")
        .slice(1, -1)
        .map((cell) => cell.trim())
    )
    .map(([outputField, idKind, rawOutcome]) => {
      if (
        outputField === undefined ||
        idKind === undefined ||
        rawOutcome === undefined
      ) {
        throw new Error(`invalid outcome ownership row: ${outputField ?? ""}`);
      }
      return { idKind, outputField, rawOutcome };
    });
}

function requireFindingsManager(
  workflowName: keyof typeof workflowPaths
): FindingsManager {
  const path = workflowPaths[workflowName];
  const workflow = parseYamlRecord({
    expectedShape: "a workflow object",
    relativePath: path,
    source: readRepositoryFile(path),
  }) as WorkflowDefinition;
  const manager = workflow.finding_contract?.manager;
  if (manager === undefined) {
    throw new TypeError(`${path} must declare finding_contract.manager`);
  }
  return manager;
}

function readFindingsManagerWiring(): FindingsManagerWiring {
  return {
    feature: requireFindingsManager("feature"),
    fix: requireFindingsManager("fix"),
  };
}

function findInvalidFindingsManagerWiring(
  wiring: FindingsManagerWiring
): string[] {
  const invalid: string[] = [];
  for (const workflowName of ["feature", "fix"] as const) {
    for (const field of ["instruction", "output_contract"] as const) {
      if (wiring[workflowName][field] !== "findings-manager") {
        invalid.push(`${workflowName}.finding_contract.manager.${field}`);
      }
    }
  }
  return invalid;
}

describe("findings-manager reconciliation contract", () => {
  test.each([...facetPaths])("%s extends the builtin contract", (facetPath) => {
    expect(readRepositoryFile(facetPath).split("\n", 1)[0]).toBe(
      "{extends:findings-manager}"
    );
  });

  test.each([...facetPaths])(
    "%s routes a target mismatch to one provisional outcome",
    (facetPath) => {
      const rows = readDecisionRows(readRepositoryFile(facetPath));
      const mismatchRows = rows.filter(
        (row) =>
          row.reference === "mismatch" &&
          (row.relation === "persists" || row.relation === "reopened")
      );

      expect(mismatchRows).toHaveLength(2);
      expect(
        mismatchRows.map(({ decision, engineOutcome, findingId }) => ({
          decision,
          engineOutcome,
          findingId,
        }))
      ).toEqual([
        {
          decision: "new",
          engineOutcome: "provisional",
          findingId: "empty",
        },
        {
          decision: "new",
          engineOutcome: "provisional",
          findingId: "empty",
        },
      ]);
      expect(rows.some((row) => row.decision === "unsupported")).toBe(false);
    }
  );

  test.each([...facetPaths])(
    "%s keeps duplicate reconciliation outside raw outcomes",
    (facetPath) => {
      const rows = readOutcomeOwnerRows(readRepositoryFile(facetPath));

      expect(rows.filter((row) => row.rawOutcome === "yes")).toEqual([
        {
          idKind: "rawFindingId",
          outputField: "rawDecisions",
          rawOutcome: "yes",
        },
      ]);
      expect(
        rows.find((row) => row.outputField === "duplicateDecisions")
      ).toEqual({
        idKind: "existingFindingId",
        outputField: "duplicateDecisions",
        rawOutcome: "no",
      });
    }
  );
});

describe("[REQ-285-03] findings-manager root wiring contract", () => {
  test("TC-285-03a: both roots select the canonical project instruction and output contract", () => {
    expect(
      findInvalidFindingsManagerWiring(readFindingsManagerWiring())
    ).toEqual([]);
  });

  test.each([
    ["feature", "instruction"],
    ["feature", "output_contract"],
    ["fix", "instruction"],
    ["fix", "output_contract"],
  ] as const)(
    "TC-285-03b: rejects missing %s manager %s override",
    (workflowName, field) => {
      const fixture = structuredClone(readFindingsManagerWiring());
      if (field === "instruction") {
        delete fixture[workflowName].instruction;
      } else {
        delete fixture[workflowName].output_contract;
      }

      expect(findInvalidFindingsManagerWiring(fixture)).toEqual([
        `${workflowName}.finding_contract.manager.${field}`,
      ]);
    }
  );

  test.each([
    ["feature", "instruction"],
    ["feature", "output_contract"],
    ["fix", "instruction"],
    ["fix", "output_contract"],
  ] as const)(
    "TC-285-03c: rejects a wrong %s manager %s override",
    (workflowName, field) => {
      const fixture = structuredClone(readFindingsManagerWiring());
      fixture[workflowName][field] = "other-findings-manager";

      expect(findInvalidFindingsManagerWiring(fixture)).toEqual([
        `${workflowName}.finding_contract.manager.${field}`,
      ]);
    }
  );

  test.each(["instruction", "output_contract"] as const)(
    "TC-285-03d: rejects the same wrong manager %s on both roots",
    (field) => {
      const fixture = structuredClone(readFindingsManagerWiring());
      fixture.feature[field] = "other-findings-manager";
      fixture.fix[field] = "other-findings-manager";

      expect(findInvalidFindingsManagerWiring(fixture)).toEqual([
        `feature.finding_contract.manager.${field}`,
        `fix.finding_contract.manager.${field}`,
      ]);
    }
  );
});
