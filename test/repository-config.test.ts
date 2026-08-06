import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { parse } from "yaml";

const packageRoot = resolve(import.meta.dirname, "..");
const packageJsonPath = join(packageRoot, "package.json");
const dependabotPath = join(packageRoot, ".github", "dependabot.yml");
const expectedRepositoryUrl = "https://github.com/daiki-beppu/tayk.git";

function requireRecord(
  value: unknown,
  description: string
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${description} must be an object`);
  }
  return value as Record<string, unknown>;
}

function readDependabotUpdates(): Record<string, unknown>[] {
  const config = requireRecord(
    parse(readFileSync(dependabotPath, "utf-8")),
    "Dependabot config"
  );
  if (!Array.isArray(config["updates"])) {
    throw new TypeError("Dependabot updates must be an array");
  }
  return config["updates"].map((update, index) =>
    requireRecord(update, `Dependabot updates[${index}]`)
  );
}

describe("repository configuration", () => {
  test("should schedule each supported dependency ecosystem weekly", () => {
    // Given: the repository Dependabot configuration
    const updates = readDependabotUpdates();

    // When: updates are grouped by package ecosystem
    const updatesByEcosystem = Map.groupBy(
      updates,
      (update) => update["package-ecosystem"]
    );

    // Then: Bun, GitHub Actions, and Nix each use the shared update policy
    const supportedEcosystems = ["bun", "github-actions", "nix"] as const;
    expect(updatesByEcosystem.size).toBe(supportedEcosystems.length);
    for (const ecosystem of supportedEcosystems) {
      const ecosystemUpdates = updatesByEcosystem.get(ecosystem);
      expect(ecosystemUpdates).toHaveLength(1);
      expect(ecosystemUpdates?.[0]).toMatchObject({
        "commit-message": { prefix: "chore(deps)" },
        cooldown: { "default-days": 3 },
        labels: ["dependencies"],
        "open-pull-requests-limit": 5,
        schedule: {
          day: "monday",
          interval: "weekly",
          timezone: "Asia/Tokyo",
        },
      });
      expect(ecosystemUpdates?.[0]?.["schedule"]).toHaveProperty("time");
    }
  });

  // REQ-304-02 / TC-304-05
  test("should let Dependabot reach the pins inside composite actions", () => {
    // Given: the GitHub Actions updater
    const actionsUpdate = readDependabotUpdates().find(
      (update) => update["package-ecosystem"] === "github-actions"
    );

    // When: the paths it scans are resolved
    const directories = actionsUpdate?.["directories"];

    // Then: .github/actions/*/action.yml is covered, which `directory: /` is not
    expect(actionsUpdate?.["directory"]).toBeUndefined();
    expect(directories).toEqual(["/", "/.github/actions/*"]);
  });

  test("should declare exactly one dependency update bot", () => {
    // Renovate と Dependabot が同じ ecosystem を二重に見ると、同じ更新で PR が
    // 2 本立ち、片方（Renovate）は automerge で無レビューのまま入る。
    expect(readdirSync(packageRoot)).not.toContain("renovate.json");
  });

  test("should declare the repository used by npm trusted publishing", () => {
    const packageJson: unknown = JSON.parse(
      readFileSync(packageJsonPath, "utf-8")
    );

    expect(packageJson).toMatchObject({
      repository: {
        type: "git",
        url: expectedRepositoryUrl,
      },
    });
  });
});
