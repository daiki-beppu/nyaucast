import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

import { describe, expect, test } from "@effect/vitest";
import { parse } from "yaml";

import { withTemporaryDirectory } from "./helpers";

const packageRoot = resolve(import.meta.dirname, "..");
const canonicalCheckCommand = "pnpm run check";
const trustedRepositoryUrl = "https://github.com/daiki-beppu/nyaucast.git";

type JsonRecord = Record<string, unknown>;

interface WorkflowStep extends JsonRecord {
  run?: string;
  uses?: string;
  with?: JsonRecord;
}

function requireRecord(value: unknown, label: string): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as JsonRecord;
}

function readJson(path: string): JsonRecord {
  return requireRecord(JSON.parse(readFileSync(path, "utf8")), basename(path));
}

function readWorkflow(name: string): JsonRecord {
  return requireRecord(
    parse(readFileSync(join(packageRoot, ".github/workflows", name), "utf8")),
    name,
  );
}

function workflowJobs(workflow: JsonRecord): JsonRecord[] {
  return Object.values(requireRecord(workflow["jobs"], "workflow jobs")).map((job, index) =>
    requireRecord(job, `workflow job ${index}`),
  );
}

function jobSteps(job: JsonRecord): WorkflowStep[] {
  const steps = job["steps"];
  if (steps === undefined) {
    return [];
  }
  if (!Array.isArray(steps)) {
    throw new TypeError("workflow steps must be an array");
  }
  return steps.map((step, index) => requireRecord(step, `workflow step ${index}`));
}

const enforcedFallowRules = [
  "unused-dev-dependencies",
  "unused-optional-dependencies",
  "type-only-dependencies",
  "test-only-dependencies",
  "dev-dependencies-in-production",
  "re-export-cycle",
  "stale-suppressions",
  "require-suppression-reason",
  "unused-catalog-entries",
  "unused-dependency-overrides",
];

function readFallowConfig(): JsonRecord {
  return readJson(join(packageRoot, ".fallowrc.json"));
}

function srcPatterns(patterns: unknown): unknown[] {
  return (Array.isArray(patterns) ? patterns : []).filter(
    (pattern) => typeof pattern === "string" && pattern.startsWith("src/"),
  );
}

// 対象を書かない抑止コメントは、すべての検査を黙らせる
function silencingSuppressions(source: string): string[] {
  return [...source.matchAll(/fallow-ignore-(?:next-line|file)\b(.*)/g)]
    .filter(([, rest = ""]) => /^\s*$|\b(?:code-duplication|complexity)\b/.test(rest))
    .map(([comment]) => comment);
}

function releaseSteps(): WorkflowStep[] {
  return workflowJobs(readWorkflow("release.yml")).flatMap(jobSteps);
}

function publishStep(): WorkflowStep {
  for (const step of releaseSteps()) {
    if (step["name"] === "Publish package" && typeof step.run === "string") {
      return step;
    }
  }
  throw new Error("release workflow must contain the Publish package step");
}

function publishScript(): string {
  const script = publishStep().run;
  if (script === undefined) {
    throw new Error("Publish package must have a script");
  }
  return script;
}

function runBash(script: string, cwd: string, environment: NodeJS.ProcessEnv) {
  return spawnSync("bash", ["-euo", "pipefail", "-c", script], {
    cwd,
    encoding: "utf8",
    env: environment,
  });
}

function isolatedEnvironment(overrides: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const inherited = Object.entries(process.env).filter(
    ([name, value]) => value !== undefined && !name.startsWith("GIT_"),
  );
  return Object.fromEntries(
    [...inherited, ...Object.entries(overrides)].filter(([, value]) => value !== undefined),
  );
}

function runPublishWithFakePnpm(overrides: NodeJS.ProcessEnv) {
  return withTemporaryDirectory("nyaucast-release-publish-", (directory) => {
    const bin = join(directory, "bin");
    const callsFile = join(directory, "pnpm-calls.txt");
    mkdirSync(bin);
    writeFileSync(join(directory, "package.json"), '{"version":"0.0.0"}\n');
    writeFileSync(
      join(bin, "pnpm"),
      `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(callsFile)}\n`,
    );
    chmodSync(join(bin, "pnpm"), 0o755);
    const path = process.env["PATH"];
    if (path === undefined) {
      throw new Error("PATH is required");
    }

    const result = runBash(
      publishScript(),
      directory,
      isolatedEnvironment({ ...overrides, PATH: `${bin}:${path}` }),
    );
    return { result, calls: readFileSync(callsFile, "utf8").trim() };
  });
}

describe("K1 three identical check surfaces", () => {
  test("local, pre-push, and CI cannot silently diverge from the canonical check", () => {
    const manifest = readJson(join(packageRoot, "package.json"));
    const scripts = requireRecord(manifest["scripts"], "package scripts");
    const prePush = readFileSync(join(packageRoot, ".vite-hooks/pre-push"), "utf8").trim();
    const ciRuns = workflowJobs(readWorkflow("ci.yml"))
      .flatMap(jobSteps)
      .flatMap((step) => (typeof step.run === "string" ? [step.run.trim()] : []))
      .filter((command) => command.includes("check"));

    expect(typeof scripts["check"]).toBe("string");
    expect(prePush).toBe(canonicalCheckCommand);
    expect(ciRuns).toEqual([canonicalCheckCommand]);
  });

  test("the declared check gate set includes the lockfile gate without duplicates", () => {
    const manifest = readJson(join(packageRoot, "package.json"));
    const scripts = requireRecord(manifest["scripts"], "package scripts");
    const check = scripts["check"];
    if (typeof check !== "string") {
      throw new TypeError("scripts.check must be a string");
    }
    const gates = check.split("&&").map((gate) => gate.trim());

    expect(gates).toContain("pnpm run lockfile:check");
    expect(new Set(gates).size).toBe(gates.length);
    for (const gate of gates.filter((gate) => gate.startsWith("pnpm run "))) {
      expect(scripts).toHaveProperty(gate.slice("pnpm run ".length));
    }
  });

  test("the dependency graph remains visible in a single-document lockfile", () => {
    const lockfile = requireRecord(
      parse(readFileSync(join(packageRoot, "pnpm-lock.yaml"), "utf8")),
      "pnpm lockfile",
    );
    const rootImporter = requireRecord(
      requireRecord(lockfile["importers"], "lockfile importers")["."],
      "root importer",
    );

    expect(
      Object.keys(requireRecord(rootImporter["dependencies"], "root dependencies")),
    ).not.toHaveLength(0);
  });

  test("runtime dependencies cannot be silenced through fallow", () => {
    const manifest = readJson(join(packageRoot, "package.json"));
    const fallow = readJson(join(packageRoot, ".fallowrc.json"));
    const dependencies = Object.keys(
      manifest["dependencies"] === undefined
        ? {}
        : requireRecord(manifest["dependencies"], "runtime dependencies"),
    );
    const ignored = fallow["ignoreDependencies"];
    if (!Array.isArray(ignored)) {
      throw new TypeError("ignoreDependencies must be an array");
    }

    expect(dependencies.filter((dependency) => ignored.includes(dependency))).toEqual([]);
  });

  // semantic モードは識別子を同一視するので、Effect の定型（Tool.make・Context.Service・
  // Schema.TaggedError）どうしが重複に見える。除外で黙らせると完全な複製も見落とすため、
  // 識別子を区別するモード + near で定型を避け、除外は持たない。threshold は重複率の上限で、
  // 0 は「上限なし」なので、小さい正の値でないと重複がゲートを落とさない。
  test("src code cannot be silenced from duplicate detection", () => {
    const duplicates = requireRecord(readFallowConfig()["duplicates"], "duplicates");
    const fix = "重複は除外ではなく共通化で直す";

    expect(srcPatterns(duplicates["ignore"]), fix).toEqual([]);
    expect(duplicates["ignoredClones"] ?? [], fix).toEqual([]);
    expect(["weak", "mild", "strict"], "semantic は Effect の定型に当たる").toContain(
      duplicates["mode"],
    );
    expect(duplicates["near"], "near が無いと改名した複製を見落とす").toBe(true);
    expect(duplicates["threshold"], "0 は上限なしで、重複がゲートを落とさない").toBeGreaterThan(0);
    expect(duplicates["threshold"]).toBeLessThanOrEqual(0.01);
  });

  test("src code cannot be silenced from complexity checks", () => {
    const health = requireRecord(readFallowConfig()["health"], "health");
    const fix = "上限を超えた関数は分けて直す";

    expect(srcPatterns(health["ignore"]), fix).toEqual([]);
    expect(health["thresholdOverrides"] ?? [], fix).toEqual([]);
    expect(health["suggestInlineSuppression"], "抑止コメントの案を出さない").toBe(false);
    expect(health["maxCyclomatic"]).toBeLessThanOrEqual(5);
    expect(health["maxCognitive"]).toBeLessThanOrEqual(5);
    expect(health["maxCrap"]).toBeLessThanOrEqual(30);
  });

  test("dependency and suppression findings fail the gate instead of warning", () => {
    const rules = requireRecord(readFallowConfig()["rules"], "rules");

    expect(Object.fromEntries(enforcedFallowRules.map((rule) => [rule, rules[rule]]))).toEqual(
      Object.fromEntries(enforcedFallowRules.map((rule) => [rule, "error"])),
    );
  });

  test("src code carries no inline suppression of duplication or complexity", () => {
    const suppressions = readdirSync(join(packageRoot, "src"), { recursive: true })
      .map(String)
      .filter((path) => path.endsWith(".ts"))
      .flatMap((path) =>
        silencingSuppressions(readFileSync(join(packageRoot, "src", path), "utf8")).map(
          (comment) => `src/${path}: ${comment}`,
        ),
      );

    expect(suppressions, "重複と複雑度の違反は抑止せずに直す").toEqual([]);
  });
});

describe("K2 release guard", () => {
  test("a release commit outside main is rejected before publish", () => {
    withTemporaryDirectory("nyaucast-release-ancestor-", (directory) => {
      const environment = isolatedEnvironment({
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
      });
      const git = (...arguments_: string[]) => {
        const result = spawnSync("git", arguments_, {
          cwd: directory,
          encoding: "utf8",
          env: environment,
        });
        if (result.status !== 0) {
          throw new Error(result.stderr);
        }
        return result.stdout.trim();
      };
      git("init", "--initial-branch=main");
      git("config", "user.name", "Release Contract");
      git("config", "user.email", "release@example.invalid");
      writeFileSync(join(directory, "main.txt"), "reviewed\n");
      git("add", "main.txt");
      git("commit", "-m", "reviewed");
      const main = git("rev-parse", "HEAD");
      writeFileSync(join(directory, "candidate.txt"), "unreviewed\n");
      git("add", "candidate.txt");
      git("commit", "-m", "unreviewed");
      const candidate = git("rev-parse", "HEAD");
      git("update-ref", "refs/remotes/origin/main", main);

      const result = spawnSync(
        "bash",
        [join(packageRoot, ".github/scripts/check-release-ancestor.sh"), candidate, "origin/main"],
        { cwd: directory, encoding: "utf8", env: environment },
      );
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("is not an ancestor");

      const steps = releaseSteps();
      const guardIndex = steps.findIndex(
        (step) => typeof step.run === "string" && step.run.includes("check-release-ancestor.sh"),
      );
      const publishIndex = steps.findIndex((step) => step["name"] === "Publish package");
      expect(guardIndex).toBeGreaterThanOrEqual(0);
      expect(guardIndex).toBeLessThan(publishIndex);
    });
  });

  test("a tag whose version differs from package.json stops before publish", () => {
    const result = runBash(
      publishScript(),
      packageRoot,
      isolatedEnvironment({
        DRY_RUN: "false",
        GITHUB_EVENT_NAME: "push",
        GITHUB_REF_NAME: "v999.0.0",
      }),
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("does not match package version");
  });

  test("manual dispatch can invoke only a dry-run staged publish", () => {
    const { result, calls } = runPublishWithFakePnpm({
      DRY_RUN: "true",
      GITHUB_EVENT_NAME: "workflow_dispatch",
      GITHUB_REF_NAME: "main",
    });

    expect(requireRecord(publishStep()["env"], "publish environment")["DRY_RUN"]).toBe(
      "${{ github.event_name == 'workflow_dispatch' }}",
    );
    expect(result.status).toBe(0);
    expect(calls).toBe("stage publish --dry-run --no-git-checks");
  });

  test("a matching release tag stages the package instead of publishing it directly", () => {
    const { result, calls } = runPublishWithFakePnpm({
      DRY_RUN: "false",
      GITHUB_EVENT_NAME: "push",
      GITHUB_REF_NAME: "v0.0.0",
    });

    expect(result.status).toBe(0);
    expect(calls).toBe("stage publish --no-git-checks");
  });

  test("package metadata identifies the package name and the single bin entry", () => {
    const manifest = readJson(join(packageRoot, "package.json"));
    expect(manifest["name"]).toBe("nyaucast");
    expect(manifest["bin"]).toEqual({ nyaucast: "bin/nyaucast.js" });
  });

  test("package metadata identifies the trusted publishing repository", () => {
    const manifest = readJson(join(packageRoot, "package.json"));
    expect(manifest["repository"]).toEqual({
      type: "git",
      url: trustedRepositoryUrl,
    });
  });
});

describe("K4 credential and concurrency contracts", () => {
  test("every checkout refuses to persist credentials", () => {
    const checkoutSteps = readdirSync(join(packageRoot, ".github/workflows"))
      .filter((name) => /\.ya?ml$/.test(name))
      .flatMap((name) => workflowJobs(readWorkflow(name)))
      .flatMap(jobSteps)
      .filter((step) => typeof step.uses === "string" && step.uses.startsWith("actions/checkout@"));

    expect(checkoutSteps.length).toBeGreaterThan(0);
    for (const step of checkoutSteps) {
      expect(step.with?.["persist-credentials"]).toBe(false);
    }
  });

  test("CI and release concurrency groups cannot collide", () => {
    const ci = readWorkflow("ci.yml");
    const release = readWorkflow("release.yml");
    const quality = workflowJobs(ci).find((job) => job["runs-on"] !== undefined);
    if (quality === undefined) {
      throw new Error("CI quality job must exist");
    }
    const ciGroup = requireRecord(quality["concurrency"], "CI concurrency")["group"];
    const releaseGroup = requireRecord(release["concurrency"], "release concurrency")["group"];
    if (typeof ciGroup !== "string" || typeof releaseGroup !== "string") {
      throw new TypeError("concurrency groups must be strings");
    }

    expect(ci["concurrency"]).toBeUndefined();
    expect(ciGroup.toLowerCase()).not.toBe(releaseGroup.toLowerCase());
    expect(ciGroup.split("${{")[0]?.toLowerCase()).not.toBe(
      releaseGroup.split("${{")[0]?.toLowerCase(),
    );
  });
});
