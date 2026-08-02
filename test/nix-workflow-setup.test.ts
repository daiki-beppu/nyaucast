import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { parse } from "yaml";

import { packageRoot } from "./helpers";

const setupAction = "./.github/actions/setup-nix";

function requireRecord(
  value: unknown,
  description: string
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${description} must be an object`);
  }
  return value as Record<string, unknown>;
}

function readYaml(path: string): Record<string, unknown> {
  const source = readFileSync(join(packageRoot, path), "utf-8");
  return requireRecord(parse(source), path);
}

function readSteps(
  document: Record<string, unknown>,
  path: readonly string[]
): Record<string, unknown>[] {
  let current: unknown = document;
  for (const segment of path) {
    current = requireRecord(current, path.join("."))[segment];
  }
  if (!Array.isArray(current)) {
    throw new TypeError(`${path.join(".")} must be an array`);
  }
  return current.map((step, index) =>
    requireRecord(step, `${path.join(".")}[${index}]`)
  );
}

function uses(step: Record<string, unknown>, prefix: string): boolean {
  return typeof step["uses"] === "string" && step["uses"].startsWith(prefix);
}

describe("Nix workflow setup", () => {
  test.each([
    ["CI quality", ".github/workflows/ci.yml", ["jobs", "quality", "steps"]],
    [
      "release publish",
      ".github/workflows/release.yml",
      ["jobs", "publish", "steps"],
    ],
  ] as const)(
    "should share upstream Nix and cache setup in %s",
    (_, path, stepsPath) => {
      // Given: a workflow job that enters the Nix development shell
      const workflow = readYaml(path);

      // When: its setup steps are resolved
      const steps = readSteps(workflow, stepsPath);

      // Then: the job delegates Nix installation and caching to the shared action
      expect(steps.filter((step) => step["uses"] === setupAction)).toHaveLength(
        1
      );
      expect(
        steps.some((step) =>
          uses(step, "DeterminateSystems/nix-installer-action@")
        )
      ).toBeFalse();
      expect(
        steps.some((step) =>
          uses(step, "DeterminateSystems/magic-nix-cache-action@")
        )
      ).toBeFalse();
    }
  );

  test("should configure upstream Nix with the native GitHub Actions cache", () => {
    // Given: the shared Nix setup action
    const action = readYaml(".github/actions/setup-nix/action.yml");

    // When: its composite steps are resolved
    const steps = readSteps(action, ["runs", "steps"]);
    const installer = steps.find((step) =>
      uses(step, "DeterminateSystems/nix-installer-action@")
    );
    const caches = steps.filter((step) =>
      uses(step, "DeterminateSystems/magic-nix-cache-action@")
    );

    // Then: FlakeHub login is disabled and the GitHub cache is enabled once
    expect(installer).toBeDefined();
    expect(
      requireRecord(installer?.["with"], "installer.with")["determinate"]
    ).toBeFalse();
    expect(caches).toHaveLength(1);
  });
});
