import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { parse } from "yaml";

import { packageRoot, withTemporaryDirectory } from "./helpers";

type SpawnResult = ReturnType<typeof Bun.spawnSync>;
interface CommandResult {
  exitCode: number;
  stderr: NonNullable<SpawnResult["stderr"]>;
  stdout: NonNullable<SpawnResult["stdout"]>;
}
interface WorkflowStep {
  "continue-on-error"?: boolean;
  if?: boolean | string;
  name?: string;
  run?: string;
  uses?: string;
  with?: Record<string, unknown>;
}

const releaseWorkflowPath = join(packageRoot, ".github/workflows/release.yml");
const ancestorHelperPath = join(
  packageRoot,
  ".github/scripts/check-release-ancestor.sh"
);
const packageVersion = "0.0.2";
const releaseTag = `v${packageVersion}`;
const inheritedPath = process.env["PATH"];

if (inheritedPath === undefined) {
  throw new Error("PATH is required for the release integration test");
}

function runCommand(
  command: string[],
  cwd: string,
  env: Record<string, string | undefined>
): CommandResult {
  const result = Bun.spawnSync(command, {
    cwd,
    env,
    stderr: "pipe",
    stdout: "pipe",
  });
  if (result.stdout === undefined || result.stderr === undefined) {
    throw new Error("Subprocess output pipes were not available");
  }
  return result;
}

function runGit(cwd: string, ...arguments_: string[]): CommandResult {
  const result = Bun.spawnSync(["git", ...arguments_], {
    cwd,
    stderr: "pipe",
    stdout: "pipe",
  });
  if (result.stdout === undefined || result.stderr === undefined) {
    throw new Error("git output pipes were not available");
  }
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString());
  }
  return result;
}

function gitOutput(cwd: string, ...arguments_: string[]): string {
  return runGit(cwd, ...arguments_)
    .stdout.toString()
    .trim();
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be a record`);
  }
  return value as Record<string, unknown>;
}

function releaseSteps(): WorkflowStep[] {
  const workflow = requireRecord(
    parse(readFileSync(releaseWorkflowPath, "utf-8")),
    "release workflow"
  );
  const jobs = requireRecord(workflow["jobs"], "release workflow jobs");
  const publish = requireRecord(jobs["publish"], "publish job");
  if (!Array.isArray(publish["steps"])) {
    throw new TypeError("publish job steps must be an array");
  }
  return publish["steps"].map((step, index) =>
    requireRecord(step, `publish step ${index}`)
  );
}

function publishJob(): Record<string, unknown> {
  const workflow = requireRecord(
    parse(readFileSync(releaseWorkflowPath, "utf-8")),
    "release workflow"
  );
  const jobs = requireRecord(workflow["jobs"], "release workflow jobs");
  return requireRecord(jobs["publish"], "publish job");
}

function findRunStep(pattern: RegExp): WorkflowStep | undefined {
  return releaseSteps().find(
    (step) => typeof step.run === "string" && pattern.test(step.run)
  );
}

function initializeReleaseRepository(directory: string): {
  candidate: string;
  main: string;
  remote: string;
} {
  const remote = join(directory, "remote.git");
  const source = join(directory, "source");
  mkdirSync(source);
  runGit(directory, "init", "--bare", remote);
  runGit(source, "init", "-b", "main");
  runGit(source, "config", "user.email", "release-test@example.invalid");
  runGit(source, "config", "user.name", "Release Test");
  writeFileSync(
    join(source, "package.json"),
    `${JSON.stringify({ version: packageVersion }, undefined, 2)}\n`
  );
  writeFileSync(join(source, ".gitignore"), "artifact/\n");
  const scripts = join(source, ".github/scripts");
  mkdirSync(scripts, { recursive: true });
  copyFileSync(ancestorHelperPath, join(scripts, "check-release-ancestor.sh"));
  runGit(source, "add", "package.json", ".gitignore", ".github");
  runGit(source, "commit", "-m", "main release");
  const main = gitOutput(source, "rev-parse", "HEAD");
  runGit(source, "remote", "add", "origin", remote);
  runGit(source, "push", "-u", "origin", "main");
  runGit(source, "switch", "-c", "candidate");
  writeFileSync(join(source, "candidate.txt"), "not reviewed\n");
  runGit(source, "add", "candidate.txt");
  runGit(source, "commit", "-m", "unreviewed candidate");
  const candidate = gitOutput(source, "rev-parse", "HEAD");
  runGit(source, "tag", releaseTag);
  runGit(source, "push", "origin", releaseTag);
  return { candidate, main, remote };
}

function cloneCandidate(
  directory: string,
  remote: string,
  candidate: string
): string {
  const runner = join(directory, "runner");
  runGit(directory, "clone", remote, runner);
  runGit(runner, "checkout", "--detach", candidate);
  return runner;
}

function runAncestorHelper(
  cwd: string,
  candidate: string,
  reference: string
): CommandResult {
  return runCommand(
    ["bash", ancestorHelperPath, candidate, reference],
    cwd,
    process.env
  );
}

function extractPublishScript(): string {
  const publishStep = findRunStep(/\bnpm publish\b/);
  if (typeof publishStep?.run !== "string") {
    throw new TypeError("release workflow must contain the publish command");
  }
  const match = /bash -euc '\n([\s\S]*?)\n'\s*$/.exec(publishStep.run);
  if (match?.[1] === undefined) {
    throw new Error("publish step must invoke bash -euc with an inline script");
  }
  return match[1];
}

function installNpmStub(directory: string): {
  callsPath: string;
  path: string;
} {
  const bin = join(directory, "bin");
  const callsPath = join(directory, "npm-calls");
  mkdirSync(bin);
  const npm = join(bin, "npm");
  writeFileSync(
    npm,
    '#!/usr/bin/env bash\nprintf "%s\\n" "$*" >> "$NPM_CALL_LOG"\n'
  );
  chmodSync(npm, 0o755);
  return { callsPath, path: `${bin}:${inheritedPath}` };
}

function runPublishDecision(
  cwd: string,
  tag: string,
  dryRun: boolean,
  stub: ReturnType<typeof installNpmStub>
): CommandResult {
  return runCommand(["bash", "-euc", extractPublishScript()], cwd, {
    ...process.env,
    DRY_RUN: String(dryRun),
    GITHUB_REF_NAME: tag,
    NPM_CALL_LOG: stub.callsPath,
    PATH: stub.path,
  });
}

function npmCalls(path: string): string[] {
  if (!existsSync(path)) {
    return [];
  }
  return readFileSync(path, "utf-8").trim().split("\n");
}

function runReleaseGuard(cwd: string, candidate: string): CommandResult {
  const guardStep = findRunStep(/check-release-ancestor\.sh/);
  if (typeof guardStep?.run !== "string") {
    throw new TypeError("release workflow must invoke the ancestor helper");
  }
  return runCommand(["bash", "-euc", guardStep.run], cwd, {
    ...process.env,
    GITHUB_SHA: candidate,
  });
}

function repositorySnapshot(cwd: string, sentinel: string): object {
  return {
    head: gitOutput(cwd, "rev-parse", "HEAD"),
    refs: gitOutput(cwd, "show-ref"),
    sentinel: readFileSync(sentinel, "utf-8"),
    status: gitOutput(cwd, "status", "--porcelain"),
  };
}

describe("release ancestor guard", () => {
  // REQ-77-01 / TC-77-01 / P-77-01
  test("should stop before npm publish when the tagged commit is outside main", () => {
    withTemporaryDirectory("tayk-release-ancestor-", (directory) => {
      const repository = initializeReleaseRepository(directory);
      const runner = cloneCandidate(
        directory,
        repository.remote,
        repository.candidate
      );
      const stub = installNpmStub(directory);

      const guard = runReleaseGuard(runner, repository.candidate);
      if (guard.exitCode === 0) {
        runPublishDecision(runner, releaseTag, false, stub);
      }

      expect(npmCalls(stub.callsPath)).toEqual([]);
    });
  });

  // REQ-77-02 / TC-77-02 / P-77-01
  test("should run an unmasked main fetch and ancestor guard before publishing", () => {
    const steps = releaseSteps();
    const checkoutIndex = steps.findIndex(
      (step) => step.uses?.startsWith("actions/checkout@") === true
    );
    const fetchIndex = steps.findIndex((step) =>
      /\bgit fetch origin main\b/.test(step.run ?? "")
    );
    const guardIndex = steps.findIndex(
      (step) => step.run?.includes("check-release-ancestor.sh") === true
    );
    const publishIndex = steps.findIndex((step) =>
      /\bnpm publish\b/.test(step.run ?? "")
    );
    const checkout = steps[checkoutIndex];

    expect(checkout?.with?.["fetch-depth"]).toBe(0);
    expect(fetchIndex).toBeGreaterThan(checkoutIndex);
    expect(guardIndex).toBeGreaterThanOrEqual(fetchIndex);
    expect(publishIndex).toBeGreaterThan(guardIndex);
    for (const step of steps.slice(fetchIndex, guardIndex + 1)) {
      expect(typeof step.if).not.toBe("string");
      expect(step.if).not.toBe(false);
      expect([undefined, false]).toContain(step["continue-on-error"]);
      expect(step.run ?? "").not.toMatch(/\|\|\s*true\b|;\s*true\b/);
    }
  });

  // REQ-77-03a / TC-77-03A / P-77-02
  test("should allow a candidate that is an ancestor of origin main", () => {
    expect(existsSync(ancestorHelperPath)).toBe(true);
    withTemporaryDirectory("tayk-release-ancestor-", (directory) => {
      const repository = initializeReleaseRepository(directory);
      const runner = cloneCandidate(
        directory,
        repository.remote,
        repository.main
      );

      const result = runAncestorHelper(runner, repository.main, "origin/main");

      expect(result.exitCode).toBe(0);
    });
  });

  // REQ-77-03b / TC-77-03B / P-77-03, P-77-04
  test("should reject non-ancestor and unresolvable inputs with diagnostics", () => {
    expect(existsSync(ancestorHelperPath)).toBe(true);
    withTemporaryDirectory("tayk-release-ancestor-", (directory) => {
      const repository = initializeReleaseRepository(directory);
      const runner = cloneCandidate(
        directory,
        repository.remote,
        repository.candidate
      );
      const cases = [
        [repository.candidate, "origin/main"],
        ["missing-candidate", "origin/main"],
        [repository.main, "missing-reference"],
      ] as const;

      for (const [candidate, reference] of cases) {
        const result = runAncestorHelper(runner, candidate, reference);
        expect(result.exitCode).not.toBe(0);
        expect(result.stderr.toString().trim()).not.toBe("");
      }
    });
  });

  // REQ-77-04 / TC-77-04 / P-77-01
  test("should reject a tag and package version mismatch before npm publish", () => {
    withTemporaryDirectory("tayk-release-version-", (directory) => {
      const repository = initializeReleaseRepository(directory);
      const runner = cloneCandidate(
        directory,
        repository.remote,
        repository.main
      );
      const stub = installNpmStub(directory);

      const result = runPublishDecision(runner, "v9.9.9", false, stub);

      expect(result.exitCode).not.toBe(0);
      expect(npmCalls(stub.callsPath)).toEqual([]);
    });
  });

  // REQ-77-05 / TC-77-05 / P-77-02
  test("should run only npm publish dry-run for a manual main release", () => {
    withTemporaryDirectory("tayk-release-dry-run-", (directory) => {
      const repository = initializeReleaseRepository(directory);
      const runner = cloneCandidate(
        directory,
        repository.remote,
        repository.main
      );
      const stub = installNpmStub(directory);

      const guard = runReleaseGuard(runner, repository.main);
      expect(guard.exitCode).toBe(0);
      const result = runPublishDecision(runner, releaseTag, true, stub);

      expect(result.exitCode).toBe(0);
      expect(npmCalls(stub.callsPath)).toEqual(["publish --dry-run"]);
    });
  });

  // REQ-77-06 / TC-77-06 / P-77-01
  test("should keep the release regression test connected to the repository gate", () => {
    const packageJson = JSON.parse(
      readFileSync(join(packageRoot, "package.json"), "utf-8")
    ) as { scripts: Record<string, string> };

    expect(packageJson.scripts["check"]).toMatch(/\bbun run test\b/);
    expect(packageJson.scripts["test"]).toBe("bun test");
  });

  // REQ-77-07 / TC-77-07 / P-77-02, P-77-03
  test("should leave repository state and ignored artifacts unchanged", () => {
    withTemporaryDirectory("tayk-release-read-only-", (directory) => {
      const repository = initializeReleaseRepository(directory);
      const runner = cloneCandidate(
        directory,
        repository.remote,
        repository.candidate
      );
      const artifactDirectory = join(runner, "artifact");
      const sentinel = join(artifactDirectory, "sentinel");
      mkdirSync(artifactDirectory);
      writeFileSync(sentinel, "keep\n");
      const candidates = [repository.main, repository.candidate];

      for (const candidate of candidates) {
        const before = repositorySnapshot(runner, sentinel);
        runAncestorHelper(runner, candidate, "origin/main");
        expect(repositorySnapshot(runner, sentinel)).toEqual(before);
      }
    });
  });

  // REQ-77-08 / TC-77-08 / P-77-01
  test("should preserve the CI dependency and trusted publishing permissions", () => {
    const job = publishJob();
    const permissions = requireRecord(
      job["permissions"],
      "publish permissions"
    );

    expect(job["needs"]).toBe("ci");
    expect(permissions["contents"]).toBe("read");
    expect(permissions["id-token"]).toBe("write");
  });
});
