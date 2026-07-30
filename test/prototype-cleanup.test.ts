import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const packageRoot = resolve(import.meta.dirname, "..");
const prototypeRoot = "prototype/takt-collection-plan";
const assetDirectories = [
  "workflows",
  "facets",
  "schemas",
  "personas",
] as const;
const retainedDocumentPaths = [
  `${prototypeRoot}/FINDINGS.md`,
  `${prototypeRoot}/MAPPING.md`,
  `${prototypeRoot}/README.md`,
] as const;
const historicalConstraintsHeading =
  "## 検証で判明した機械的制約（#64 への申し送り）";
const deletedAssetReference =
  /(?<![/\w.-])(?:\.\/)?(?:(?:prototype\/takt-collection-plan)\/)?(?:workflows|facets|schemas|personas)\//;

type GitResult = ReturnType<typeof Bun.spawnSync>;
interface MarkdownFence {
  marker: "`" | "~";
  length: number;
}

function runGit(arguments_: readonly string[]): GitResult {
  return Bun.spawnSync(["git", ...arguments_], {
    cwd: packageRoot,
    stderr: "pipe",
    stdout: "pipe",
  });
}

function expectSuccessfulGit(result: GitResult): void {
  if (result.stderr === undefined) {
    throw new Error("git stderr was not captured");
  }

  expect(result.exitCode, result.stderr.toString()).toBe(0);
}

function outputLines(result: GitResult): string[] {
  if (result.stdout === undefined) {
    throw new Error("git stdout was not captured");
  }

  return result.stdout
    .toString()
    .split("\n")
    .filter((line) => line.length > 0);
}

function isMarkdownHeading(line: string): boolean {
  return /^ {0,3}#{1,6}(?:\s|$)/.test(line);
}

function isIndentedCode(line: string): boolean {
  return /^(?: {4}|\t)/.test(line);
}

function referencesDeletedAsset(line: string): boolean {
  return deletedAssetReference.test(line);
}

function findDeletedAssetReferencesInMarkdown(
  path: string,
  markdown: string
): string[] {
  const lines = markdown.split("\n");
  const references: string[] = [];
  let insideHistoricalConstraints = false;
  let openFence: MarkdownFence | null = null;

  for (const [index, line] of lines.entries()) {
    const fence = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence !== null) {
      const fenceRun = fence[1];
      if (fenceRun === undefined) {
        throw new Error(`invalid Markdown fence at ${path}:${index + 1}`);
      }

      const marker = fenceRun[0];
      if (marker !== "`" && marker !== "~") {
        throw new Error(`invalid Markdown fence at ${path}:${index + 1}`);
      }

      if (openFence === null) {
        openFence = { length: fenceRun.length, marker };
      } else {
        const isClosingFence =
          openFence.marker === marker &&
          fenceRun.length >= openFence.length &&
          /^[ \t]*$/.test(line.slice(fence[0].length));
        if (isClosingFence) {
          openFence = null;
        }
      }
    }

    if (openFence === null && /^##\s/.test(line)) {
      insideHistoricalConstraints = line === historicalConstraintsHeading;
    }

    const mustInspect =
      fence !== null ||
      openFence !== null ||
      !insideHistoricalConstraints ||
      isMarkdownHeading(line) ||
      isIndentedCode(line);

    if (mustInspect && referencesDeletedAsset(line)) {
      references.push(`${path}:${index + 1}: ${line.trim()}`);
    }
  }

  return references;
}

function findDeletedAssetReferences(path: string): string[] {
  return findDeletedAssetReferencesInMarkdown(
    path,
    readFileSync(join(packageRoot, path), "utf-8")
  );
}

describe("retired takt collection-plan prototype", () => {
  // REQ-87-01 / TC-87-01A / P-87-01
  test("should have no tracked prototype assets present in the working tree", () => {
    const result = runGit([
      "ls-files",
      ...assetDirectories.map((directory) => `${prototypeRoot}/${directory}/`),
    ]);
    expectSuccessfulGit(result);

    const presentAssets = outputLines(result).filter((path) =>
      existsSync(join(packageRoot, path))
    );

    expect(presentAssets).toEqual([]);
  });

  // REQ-87-02 / TC-87-02A / 予測 ID なし（既存挙動の回帰）
  test("should keep the ADR-0006 findings tracked and present", () => {
    const findingsPath = retainedDocumentPaths[0];
    const result = runGit(["ls-files", "--error-unmatch", findingsPath]);
    expectSuccessfulGit(result);

    expect(outputLines(result)).toEqual([findingsPath]);
    expect(existsSync(join(packageRoot, findingsPath))).toBe(true);
  });

  // REQ-87-02 / TC-87-02B / 予測 ID なし（既存挙動の回帰）
  test("should keep the minimal prototype documentation tracked and present", () => {
    for (const path of retainedDocumentPaths) {
      const result = runGit(["ls-files", "--error-unmatch", path]);
      expectSuccessfulGit(result);
      expect(outputLines(result)).toEqual([path]);
      expect(existsSync(join(packageRoot, path))).toBe(true);
    }
  });

  // REQ-87-03 / TC-87-03A / P-87-02a
  test("should not reference deleted assets outside the allowed historical record", () => {
    const references = retainedDocumentPaths.flatMap((path) =>
      findDeletedAssetReferences(path)
    );

    expect(references).toEqual([]);
  });
});

describe("deleted prototype asset reference detection", () => {
  test("should detect every deleted asset directory in each supported repository-relative path form", () => {
    const paths = assetDirectories.flatMap((directory) => [
      `${prototypeRoot}/${directory}/asset`,
      `./${prototypeRoot}/${directory}/asset`,
      `${directory}/asset`,
      `./${directory}/asset`,
    ]);
    const markdown = paths.join("\n");

    const references = findDeletedAssetReferencesInMarkdown(
      "fixture.md",
      markdown
    );

    expect(references).toEqual(
      paths.map((path, index) => `fixture.md:${index + 1}: ${path}`)
    );
  });

  test("should close a fence only with the same marker at a valid minimum length", () => {
    const cases = [
      { closing: "````", nonClosing: "```", opening: "````text" },
      { closing: "~~~~~", nonClosing: "~~~", opening: "~~~~text" },
      { closing: "```", nonClosing: "~~~", opening: "```text" },
      { closing: "```", nonClosing: "```not-closing", opening: "```text" },
    ] as const;

    for (const [index, fence] of cases.entries()) {
      const markdown = [
        historicalConstraintsHeading,
        fence.opening,
        fence.nonClosing,
        "workflows/inside-fence.yaml",
        fence.closing,
        "workflows/after-fence.yaml",
      ].join("\n");

      const references = findDeletedAssetReferencesInMarkdown(
        `fixture-${index}.md`,
        markdown
      );

      expect(references).toEqual([
        `fixture-${index}.md:4: workflows/inside-fence.yaml`,
      ]);
    }
  });
});
