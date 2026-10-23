import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, test } from "vitest";

import { check } from "./new-date.ts";

const withRoot = (files: Readonly<Record<string, string>>, run: (root: string) => void) => {
  const root = mkdtempSync(join(tmpdir(), "new-date-"));
  try {
    for (const [path, content] of Object.entries(files)) {
      const full = join(root, path);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content);
    }
    run(root);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
};

describe("new-date check", () => {
  test("reports argument-less new Date() in src non-test files with location, reason and ADR-0014", () => {
    withRoot({ "src/clock.ts": "const now = new Date();\nconst t = new Date( );\n" }, (root) => {
      const violations = check(root);
      expect(violations).toHaveLength(2);
      expect(violations[0]).toContain("src/clock.ts:1");
      expect(violations[1]).toContain("src/clock.ts:2");
      for (const violation of violations) {
        expect(violation).toContain("ADR-0014");
      }
    });
  });

  test("reports argument-less new Date() split across lines", () => {
    withRoot(
      { "src/split.ts": "const a = 1;\nconst b = new Date(\n);\nconst c = new\nDate();\n" },
      (root) => {
        const violations = check(root);
        expect(violations).toHaveLength(2);
        expect(violations[0]).toContain("src/split.ts:2");
        expect(violations[1]).toContain("src/split.ts:4");
      },
    );
  });

  test("returns an empty array for new Date with arguments", () => {
    withRoot(
      { "src/at.ts": "const a = new Date(ms).toISOString();\nconst b = new Date(\n  ms,\n);\n" },
      (root) => {
        expect(check(root)).toEqual([]);
      },
    );
  });

  test("ignores test files and files outside src", () => {
    withRoot(
      {
        "scripts/x.ts": "const a = new Date();\n",
        "src/clock.test.ts": "const a = new Date();\n",
        "src/plain.ts": "export const x = 1;\n",
      },
      (root) => {
        expect(check(root)).toEqual([]);
      },
    );
  });
});
