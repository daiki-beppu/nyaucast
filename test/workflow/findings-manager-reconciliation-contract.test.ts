import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const packageRoot = resolve(import.meta.dirname, "../..");
const facetPaths = [
  ".takt/facets/instructions/findings-manager.md",
  ".takt/facets/output-contracts/findings-manager.md",
] as const;

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

function readRepositoryFile(relativePath: string): string {
  return readFileSync(join(packageRoot, relativePath), "utf-8");
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
