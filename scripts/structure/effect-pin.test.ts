import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, test } from "vitest";

import { check } from "./effect-pin.ts";

const withRoot = (files: Readonly<Record<string, string>>, run: (root: string) => void) => {
  const root = mkdtempSync(join(tmpdir(), "effect-pin-"));
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

const pkg = (value: unknown) => ({ "package.json": JSON.stringify(value) });

describe("effect-pin check", () => {
  test("reports range versions of effect and @effect/* in dependencies and devDependencies with ADR-0014", () => {
    withRoot(
      pkg({
        dependencies: { effect: "^4.0.5" },
        devDependencies: { "@effect/vitest": "~4.0.5", "vite-plus": "^1.0.0" },
      }),
      (root) => {
        const violations = check(root);
        expect(violations).toHaveLength(2);
        expect(violations.some((v) => v.includes("effect") && v.includes("^4.0.5"))).toBe(true);
        expect(violations.some((v) => v.includes("@effect/vitest"))).toBe(true);
        for (const violation of violations) {
          expect(violation).toContain("ADR-0014");
        }
      },
    );
  });

  test("reports a range version in dependencies only (devDependencies exact)", () => {
    withRoot(
      pkg({
        dependencies: { "@effect/sql-libsql": ">=4.0.5" },
        devDependencies: { effect: "4.0.5" },
      }),
      (root) => {
        const violations = check(root);
        expect(violations).toHaveLength(1);
        expect(violations[0]).toContain("@effect/sql-libsql");
      },
    );
  });

  test("reports non x.y.z versions such as 4.0 and 4.0.5-beta.1", () => {
    withRoot(
      pkg({ dependencies: { "@effect/a": "4.0", "@effect/b": "4.0.5-beta.1", effect: "latest" } }),
      (root) => {
        expect(check(root)).toHaveLength(3);
      },
    );
  });

  test("returns an empty array when every effect package is exact", () => {
    withRoot(
      pkg({
        dependencies: { effect: "4.0.5", "@effect/sql-libsql": "4.0.5" },
        devDependencies: { "@effect/tsgo": "0.47.2" },
      }),
      (root) => {
        expect(check(root)).toEqual([]);
      },
    );
  });

  test("ignores range versions of other packages, including names that merely start with effect", () => {
    withRoot(
      pkg({ dependencies: { effect: "4.0.5", effector: "^1.0.0", yaml: "^2.0.0" } }),
      (root) => {
        expect(check(root)).toEqual([]);
      },
    );
  });

  test("handles a package.json without dependencies or devDependencies", () => {
    withRoot(pkg({ name: "x" }), (root) => {
      expect(check(root)).toEqual([]);
    });
  });
});
