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

// REQ-304-07 / TC-304-09 is observed by running the repository's canonical gate.
describe("Nix workflow setup", () => {
  // REQ-304-05 / TC-304-06
  test.each([
    ["CI quality", ".github/workflows/ci.yml", ["jobs", "quality", "steps"]],
    [
      "release publish",
      ".github/workflows/release.yml",
      ["jobs", "publish", "steps"],
    ],
  ] as const)(
    "should delegate Nix setup to the shared action in %s",
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
        steps.some((step) => uses(step, "cachix/install-nix-action@"))
      ).toBeFalse();
      expect(
        steps.some((step) =>
          uses(step, "DeterminateSystems/magic-nix-cache-action@")
        )
      ).toBeFalse();
    }
  );

  // REQ-304-01 / TC-304-01 / P-304-01
  test("should use only the Cachix upstream Nix installer in the shared action", () => {
    // Given: the shared Nix setup action
    const action = parseYamlRecord({
      expectedShape: compositeActionObjectShape,
      relativePath: setupActionPath,
      source: readRepositoryFile(setupActionPath),
    });

    // When: its composite steps are resolved
    const steps = readSteps(action, ["runs", "steps"]);
    const cachixInstallers = steps.filter((step) =>
      uses(step, "cachix/install-nix-action@")
    );
    const determinateInstallers = steps.filter((step) =>
      uses(step, "DeterminateSystems/nix-installer-action@")
    );

    // Then: the supported upstream installer replaces the expired provider path
    expect(cachixInstallers).toHaveLength(1);
    expect(determinateInstallers).toHaveLength(0);
  });

  // REQ-304-01 / TC-304-02 / P-304-02
  test("should omit the Determinate-only input from every shared action step", () => {
    // Given: the shared Nix setup action
    const action = parseYamlRecord({
      expectedShape: compositeActionObjectShape,
      relativePath: setupActionPath,
      source: readRepositoryFile(setupActionPath),
    });

    // When: step inputs are resolved at their actual `with` boundaries
    const stepInputs = readSteps(action, ["runs", "steps"])
      .map((step) => step["with"])
      .filter((inputs) => inputs !== undefined)
      .map((inputs) => requireRecord(inputs, "step.with"));

    // Then: no input record can select the expired Determinate path
    expect(
      stepInputs.some((inputs) => Object.hasOwn(inputs, "determinate"))
    ).toBeFalse();
  });

  // REQ-304-02 / TC-304-03 / P-304-03
  test("should pin the Cachix installer to a full SHA with a version comment", () => {
    // Given: the source form of the shared action, where YAML comments remain visible
    const source = readRepositoryFile(setupActionPath);

    // When: the Cachix installer reference line is selected
    const installerLine = source
      .split("\n")
      .find((line) => line.includes("uses: cachix/install-nix-action@"));

    // Then: the reference uses the repository pinning convention
    expect(installerLine).toMatch(
      /^\s+uses: cachix\/install-nix-action@[0-9a-f]{40} # v\d+(?:\.\d+)*$/
    );
  });

  // REQ-304-06 / TC-304-04
  test("should keep the native cache with FlakeHub disabled during migration", () => {
    // Given: the shared Nix setup action
    const action = parseYamlRecord({
      expectedShape: compositeActionObjectShape,
      relativePath: setupActionPath,
      source: readRepositoryFile(setupActionPath),
    });

    // When: its cache steps are resolved
    const steps = readSteps(action, ["runs", "steps"]);
    const caches = steps.filter((step) =>
      uses(step, "DeterminateSystems/magic-nix-cache-action@")
    );

    // Then: FlakeHub login is disabled and the GitHub cache is enabled once
    expect(caches).toHaveLength(1);
    // cache action は既定で OIDC token が取れれば FlakeHub を使うため、id-token:
    // write を持つ release の publish job では明示的な無効化が要る。
    expect(
      requireRecord(caches[0]?.["with"], "cache.with")["use-flakehub"]
    ).toBe("disabled");
  });

  // REQ-304-03 / TC-304-07
  test("should keep the canonical check command on the Ubuntu quality job", () => {
    // Given: the CI workflow that consumes the shared setup action
    const workflow = parseYamlRecord({
      expectedShape: workflowObjectShape,
      relativePath: ".github/workflows/ci.yml",
      source: readRepositoryFile(".github/workflows/ci.yml"),
    });

    // When: the quality job and its executable steps are resolved
    const jobs = requireRecord(workflow["jobs"], "workflow.jobs");
    const quality = requireRecord(jobs["quality"], "jobs.quality");
    const checkSteps = readSteps(workflow, ["jobs", "quality", "steps"]);

    // Then: the supported runner still enters the canonical repository gate
    expect(quality["runs-on"]).toBe("ubuntu-24.04");
    expect(
      checkSteps.filter(
        (step) => step["run"] === "nix develop --command bun run check"
      )
    ).toHaveLength(1);
  });

  // REQ-304-02 / TC-304-03
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
