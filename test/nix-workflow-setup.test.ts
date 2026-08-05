import { describe, expect, test } from "bun:test";

import { parseYamlRecord, readRepositoryFile } from "./helpers";

const setupActionDirectory = ".github/actions/setup-nix";
const setupAction = `./${setupActionDirectory}`;
const setupActionPath = `${setupActionDirectory}/action.yml`;
const compositeActionObjectShape = "a composite action object";
const workflowObjectShape = "a workflow object";

function requireRecord(
  value: unknown,
  description: string
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${description} must be an object`);
  }
  return value as Record<string, unknown>;
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
      const workflow = parseYamlRecord({
        expectedShape: workflowObjectShape,
        relativePath: path,
        source: readRepositoryFile(path),
      });

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
    const action = parseYamlRecord({
      expectedShape: compositeActionObjectShape,
      relativePath: setupActionPath,
      source: readRepositoryFile(setupActionPath),
    });

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
    // installer 側の determinate: false は installer のログインしか止めない。cache
    // action は既定で OIDC token が取れれば FlakeHub を使うため、id-token: write を
    // 持つ release の publish job では別途これが要る。
    expect(
      requireRecord(caches[0]?.["with"], "cache.with")["use-flakehub"]
    ).toBe("disabled");
  });

  test("should pin every third-party action in the shared setup to a commit SHA", () => {
    // Given: the shared Nix setup action, which actionlint does not lint
    const action = parseYamlRecord({
      expectedShape: compositeActionObjectShape,
      relativePath: setupActionPath,
      source: readRepositoryFile(setupActionPath),
    });

    // When: its third-party step references are resolved
    const references = readSteps(action, ["runs", "steps"])
      .map((step) => step["uses"])
      .filter((reference) => typeof reference === "string");

    // Then: each is pinned to a full SHA rather than a floating tag
    expect(references).not.toHaveLength(0);
    for (const reference of references) {
      expect(reference).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
    }
  });
});
