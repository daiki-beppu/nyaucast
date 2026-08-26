import { describe, expect, test } from "vite-plus/test";

import { inspectInstalledPackage } from "./package-smoke-support";

describe("K3 package smoke", () => {
  test("a published tarball remains executable without leaking source or tests", () => {
    inspectInstalledPackage(({ allowedRoots, entrypointStatus, packedPaths }) => {
      expect(entrypointStatus).toBe(0);
      expect(packedPaths).not.toContainEqual(expect.stringMatching(/\.test\.ts$/));
      expect(packedPaths).not.toContainEqual(expect.stringMatching(/^src\//));
      expect(packedPaths).toEqual(
        expect.arrayContaining(["package.json", "bin/tayk.js", "dist/index.js"]),
      );
      const npmMetadata = new Set(["package.json", "README.md", "LICENSE"]);
      for (const path of packedPaths.filter((path) => !npmMetadata.has(path))) {
        expect(allowedRoots.some((root) => path === root || path.startsWith(`${root}/`))).toBe(
          true,
        );
      }
    });
  });
});
