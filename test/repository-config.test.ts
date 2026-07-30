import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const packageRoot = resolve(import.meta.dirname, "..");
const gitignorePath = join(packageRoot, ".gitignore");
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

describe("repository configuration", () => {
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
