import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { packageRoot, readRepositoryFile } from "../helpers";

const removedAssets = [
  ".takt/steps/reviewers.yaml",
  ".takt/steps/finding-contract-final-gate.yaml",
  ".takt/steps/fix.yaml",
  ".takt/facets/instructions/findings-manager.md",
  ".takt/facets/output-contracts/findings-manager.md",
  ".takt/facets/instructions/supervise-finding-contract.md",
  ".takt/facets/instructions/review-merge-readiness.md",
  ".takt/facets/instructions/tayk-review-adr-conformance-impl.md",
] as const;

describe("takt 0.60 review contract migration", () => {
  test("removes project assets superseded by review adjudication", () => {
    for (const path of removedAssets) {
      expect(existsSync(join(packageRoot, path))).toBeFalse();
    }
  });

  test.each([
    ".takt/workflows/tayk-feature.yaml",
    ".takt/workflows/tayk-fix.yaml",
  ])("%s has no removed Finding Contract runtime syntax", (path) => {
    const source = readRepositoryFile(path);

    expect(source).not.toContain("finding_contract:");
    expect(source).not.toContain("findings-manager");
    expect(source).not.toContain("merge-readiness-finding-contract");
  });

  test("keeps agent operation docs on the supported takt version", () => {
    const issueTracker = readRepositoryFile("docs/agents/issue-tracker.md");
    const agentInstructions = readRepositoryFile("CLAUDE.md");

    expect(issueTracker).toContain("host 前提: takt 0.60.0");
    expect(issueTracker).not.toContain("0.59.1");
    expect(issueTracker).not.toContain("7 観点個別レビュー");
    expect(agentInstructions).not.toContain("Finding Contract の publication");
  });

  test("removes the old reviewer-count rule from tayk ADR knowledge", () => {
    const knowledge = readRepositoryFile(".takt/facets/knowledge/tayk-adr.md");

    expect(knowledge).not.toContain("7 観点 reviewer の一部を落とす");
    expect(knowledge).toContain("security reviewer");
    expect(knowledge).toContain("final gate");
  });
});
