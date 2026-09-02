import { describe, expect, test } from "vite-plus/test";

import { inspectInstalledPackage } from "./package-smoke-support";

describe("K3 package smoke", () => {
  test("a published tarball serves MCP tools and migrates its local store", async () => {
    const { allowedRoots, localDatabaseCreated, packedPaths, toolNames } =
      await inspectInstalledPackage();

    expect(toolNames.toSorted()).toEqual(["plan_check_title", "plan_init"]);
    expect(localDatabaseCreated).toBe(true);
    expect(packedPaths).not.toContainEqual(expect.stringMatching(/\.test\.ts$/));
    expect(packedPaths).not.toContainEqual(expect.stringMatching(/^src\//));
    expect(packedPaths).toEqual(
      expect.arrayContaining(["package.json", "bin/tayk.js", "dist/index.js"]),
    );
    expect(packedPaths).toContainEqual(expect.stringMatching(/^drizzle\/.*\.sql$/));
    const npmMetadata = new Set(["package.json", "README.md", "LICENSE"]);
    for (const path of packedPaths.filter((path) => !npmMetadata.has(path))) {
      expect(allowedRoots.some((root) => path === root || path.startsWith(`${root}/`))).toBe(true);
    }
  }, 120_000);
});
