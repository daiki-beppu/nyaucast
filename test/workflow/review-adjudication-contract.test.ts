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
] as const;

describe("Finding Contract removal", () => {
  test("removes project assets that takt 0.59 no longer resolves", () => {
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
});
