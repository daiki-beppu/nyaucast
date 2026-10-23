import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, test } from "vitest";

import { check } from "./migration-names.ts";

const withRoot = (files: readonly string[], run: (root: string) => void) => {
  const root = mkdtempSync(join(tmpdir(), "migration-names-"));
  try {
    for (const path of files) {
      const full = join(root, "src", "db", "migrations", path);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, "export {};\n");
    }
    run(root);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
};

describe("migration-names check", () => {
  test("reports a misnamed migration even when other files match", () => {
    withRoot(["0001_initial.ts", "foo.ts"], (root) => {
      const violations = check(root);
      expect(violations).toHaveLength(1);
      expect(violations[0]).toContain("src/db/migrations/foo.ts");
      expect(violations[0]).toContain("ADR-0014");
    });
  });

  test("reports numbers that are not exactly 4 digits", () => {
    withRoot(["001_initial.ts", "00001_x.ts", "0002_ok.ts"], (root) => {
      const violations = check(root);
      expect(violations).toHaveLength(2);
      expect(violations.some((v) => v.includes("001_initial.ts"))).toBe(true);
      expect(violations.some((v) => v.includes("00001_x.ts"))).toBe(true);
    });
  });

  test("returns an empty array for well-named migrations", () => {
    withRoot(["0001_initial.ts", "0002_explainer_videos.ts"], (root) => {
      expect(check(root)).toEqual([]);
    });
  });

  test("ignores test files, the allow-listed append-only.ts and non-ts files", () => {
    withRoot(["0001_initial.ts", "append-only.ts", "foo.test.ts", "README.md"], (root) => {
      expect(check(root)).toEqual([]);
    });
  });

  test("does not allow-list other helper names", () => {
    withRoot(["0001_initial.ts", "append-only-2.ts"], (root) => {
      expect(check(root)).toHaveLength(1);
    });
  });
});
