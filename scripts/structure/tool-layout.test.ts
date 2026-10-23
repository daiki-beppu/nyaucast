import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, test } from "vitest";

import { check } from "./tool-layout.ts";

const withRoot = (files: readonly string[], run: (root: string) => void) => {
  const root = mkdtempSync(join(tmpdir(), "tool-layout-"));
  try {
    mkdirSync(join(root, "src", "tools"), { recursive: true });
    for (const path of files) {
      const full = join(root, path);
      if (path.endsWith("/")) {
        mkdirSync(full, { recursive: true });
      } else {
        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, "export {};\n");
      }
    }
    run(root);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
};

describe("tool-layout check", () => {
  test("returns an empty array when every tool has a test in a per-kind directory, with arbitrary names", () => {
    withRoot(
      [
        "src/tools/alpha/one.ts",
        "src/tools/alpha/one.test.ts",
        "src/tools/alpha/two.thing.ts",
        "src/tools/alpha/two.thing.test.ts",
        "src/tools/beta/x.ts",
        "src/tools/beta/x.test.ts",
      ],
      (root) => {
        expect(check(root)).toEqual([]);
      },
    );
  });

  test("reports a file directly under src/tools with its path, reason and ADR-0014", () => {
    withRoot(["src/tools/stray.ts", "src/tools/kind/a.ts", "src/tools/kind/a.test.ts"], (root) => {
      const violations = check(root);
      expect(violations).toHaveLength(1);
      expect(violations[0]).toContain("src/tools/stray.ts");
      expect(violations[0]).toContain("ADR-0014");
    });
  });

  test("reports a tool definition without a same-named test, naming the definition path", () => {
    withRoot(["src/tools/kind/a.ts", "src/tools/kind/a.test.ts", "src/tools/kind/b.ts"], (root) => {
      const violations = check(root);
      expect(violations).toHaveLength(1);
      expect(violations[0]).toContain("src/tools/kind/b.ts");
      expect(violations[0]).toContain("ADR-0014");
    });
  });

  test("does not accept a test with a different name as the test of a definition", () => {
    withRoot(["src/tools/kind/a.ts", "src/tools/kind/other.test.ts"], (root) => {
      const violations = check(root);
      expect(violations).toHaveLength(1);
      expect(violations[0]).toContain("src/tools/kind/a.ts");
    });
  });

  test("reports a subdirectory inside a kind directory, naming its path", () => {
    withRoot(
      ["src/tools/kind/a.ts", "src/tools/kind/a.test.ts", "src/tools/kind/nested/"],
      (root) => {
        const violations = check(root);
        expect(violations).toHaveLength(1);
        expect(violations[0]).toContain("src/tools/kind/nested");
        expect(violations[0]).toContain("ADR-0014");
      },
    );
  });

  test("reports each violated rule independently", () => {
    withRoot(["src/tools/stray.ts", "src/tools/kind/b.ts", "src/tools/kind/nested/"], (root) => {
      const violations = check(root);
      expect(violations).toHaveLength(3);
      expect(violations.some((v) => v.includes("src/tools/stray.ts"))).toBe(true);
      expect(violations.some((v) => v.includes("src/tools/kind/b.ts"))).toBe(true);
      expect(violations.some((v) => v.includes("src/tools/kind/nested"))).toBe(true);
    });
  });
});
