import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { parse } from "yaml";

const packageRoot = resolve(import.meta.dirname, "..");
const gitignorePath = join(packageRoot, ".gitignore");
const packageJsonPath = join(packageRoot, "package.json");
const dependabotPath = join(packageRoot, ".github", "dependabot.yml");
const expectedRepositoryUrl = "https://github.com/daiki-beppu/tayk.git";
const expectedGitignoreLines = [
  "node_modules/",
  ".worktrees/",
  ".claude/worktrees/",
  ".direnv/",
  ".env",
  "*.log",
  "data/",
  "prototype/out/",
];

function readGitignoreLines(): string[] {
  const contents = readFileSync(gitignorePath, "utf-8");
  expect(contents.endsWith("\n")).toBeTrue();
  return contents.slice(0, -1).split("\n");
}

function requireRecord(
  value: unknown,
  description: string
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${description} must be an object`);
  }
  return value as Record<string, unknown>;
}

function readDependabotUpdates(): Record<string, unknown>[] {
  const config = requireRecord(
    parse(readFileSync(dependabotPath, "utf-8")),
    "Dependabot config"
  );
  if (!Array.isArray(config["updates"])) {
    throw new TypeError("Dependabot updates must be an array");
  }
  return config["updates"].map((update, index) =>
    requireRecord(update, `Dependabot updates[${index}]`)
  );
}

describe("repository configuration", () => {
  test("should schedule each supported dependency ecosystem weekly", () => {
    // Given: the repository Dependabot configuration
    const updates = readDependabotUpdates();

    // When: updates are grouped by package ecosystem
    const updatesByEcosystem = Map.groupBy(
      updates,
      (update) => update["package-ecosystem"]
    );

    // Then: Bun, GitHub Actions, and Nix each use the shared update policy
    expect([...updatesByEcosystem.keys()]).toEqual([
      "bun",
      "github-actions",
      "nix",
    ]);
    for (const ecosystem of ["bun", "github-actions", "nix"]) {
      const ecosystemUpdates = updatesByEcosystem.get(ecosystem);
      expect(ecosystemUpdates).toHaveLength(1);
      expect(ecosystemUpdates?.[0]).toMatchObject({
        cooldown: { "default-days": 3 },
        directory: "/",
        "open-pull-requests-limit": 5,
        schedule: { interval: "weekly" },
      });
    }
  });

  test("should declare the repository used by npm trusted publishing", () => {
    const packageJson: unknown = JSON.parse(
      readFileSync(packageJsonPath, "utf-8")
    );

    expect(packageJson).toMatchObject({
      repository: {
        type: "git",
        url: expectedRepositoryUrl,
      },
    });
  });

  // REQ-88-01 / TC-88-01 / P-88-01
  test("should not declare .worktreeinclude when no copied asset exists", () => {
    const entries = readdirSync(packageRoot);

    expect(entries).not.toContain(".worktreeinclude");
  });

  // REQ-88-02 / TC-88-02 / P-88-02
  test("should not ignore dist when the package has no build output", () => {
    const distEntries = readGitignoreLines().filter((line) => line === "dist/");

    expect(distEntries).toHaveLength(0);
  });

  // REQ-88-02 / TC-88-03 / prediction ID: not applicable (existing regression)
  test("should preserve unrelated gitignore entries in order", () => {
    const unrelatedLines = readGitignoreLines().filter(
      (line) => line !== "dist/"
    );

    expect(unrelatedLines).toEqual(expectedGitignoreLines);
  });
});
