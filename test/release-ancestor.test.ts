import { afterAll, beforeAll, describe, expect, test } from "bun:test";
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

// #190: lefthook pre-push 配下では GIT_DIR / GIT_INDEX_FILE 等が子プロセスへ
// 紛れ込み、fixture の git 操作が呼び出し元リポジトリへ向かう（linked worktree
// からの push では git がフックへ絶対パスの GIT_DIR を渡すため必ず発火する）。
// フック文脈の変数を落とし、グローバル / システム config も隔離した環境を組む。
function hermeticGitEnvironment(
  globalConfigPath: string,
  baseEnvironment: Record<string, string | undefined> = process.env
): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [name, value] of Object.entries(baseEnvironment)) {
    if (value !== undefined && !/^(?:GIT_|LEFTHOOK)/.test(name)) {
      environment[name] = value;
    }
  }
  environment["GIT_CONFIG_GLOBAL"] = globalConfigPath;
  environment["GIT_CONFIG_NOSYSTEM"] = "1";
  environment["GIT_TERMINAL_PROMPT"] = "0";
  return environment;
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

function runGit(
  environment: Record<string, string>,
  cwd: string,
  ...arguments_: string[]
): CommandResult {
  // 環境要因で repository 解決が揺れても対象が cwd から動かないよう -C を常置する（#190）
  const result = Bun.spawnSync(["git", "-C", cwd, ...arguments_], {
    cwd,
    env: environment,
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

function gitOutput(
  environment: Record<string, string>,
  cwd: string,
  ...arguments_: string[]
): string {
  return runGit(environment, cwd, ...arguments_)
    .stdout.toString()
    .trim();
}

// #190: fixture の git 操作が呼び出し元リポジトリへ漏れていないことを実行前後で
// 検査する。HEAD・作業ツリー・local config のいずれかの変化 = 漏れの検出。
const callerRepositoryEnvironment = hermeticGitEnvironment("/dev/null");

function callerRepositoryState(): Record<string, string> {
  return {
    configuration: gitOutput(
      callerRepositoryEnvironment,
      packageRoot,
      "config",
      "--local",
      "--list"
    ),
    head: gitOutput(
      callerRepositoryEnvironment,
      packageRoot,
      "rev-parse",
      "HEAD"
    ),
    status: gitOutput(
      callerRepositoryEnvironment,
      packageRoot,
      "--no-optional-locks",
      "status",
      "--porcelain"
    ),
  };
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

function initializeReleaseRepository(
  environment: Record<string, string>,
  directory: string,
  releaseTagTarget: "candidate" | "main"
): {
  candidate: string;
  main: string;
  remote: string;
  taggedCommit: string;
} {
  const remote = join(directory, "remote.git");
  const source = join(directory, "source");
  mkdirSync(source);
  runGit(environment, directory, "init", "--bare", remote);
  runGit(environment, source, "init", "-b", "main");
  runGit(
    environment,
    source,
    "config",
    "user.email",
    "release-test@example.invalid"
  );
  runGit(environment, source, "config", "user.name", "Release Test");
  writeFileSync(
    join(source, "package.json"),
    `${JSON.stringify({ version: packageVersion }, undefined, 2)}\n`
  );
  writeFileSync(join(source, ".gitignore"), "artifact/\n");
  const scripts = join(source, ".github/scripts");
  mkdirSync(scripts, { recursive: true });
  copyFileSync(ancestorHelperPath, join(scripts, "check-release-ancestor.sh"));
  runGit(environment, source, "add", "package.json", ".gitignore", ".github");
  runGit(environment, source, "commit", "-m", "main release");
  const main = gitOutput(environment, source, "rev-parse", "HEAD");
  runGit(environment, source, "remote", "add", "origin", remote);
  runGit(environment, source, "push", "-u", "origin", "main");
  runGit(environment, source, "switch", "-c", "candidate");
  writeFileSync(join(source, "candidate.txt"), "not reviewed\n");
  runGit(environment, source, "add", "candidate.txt");
  runGit(environment, source, "commit", "-m", "unreviewed candidate");
  const candidate = gitOutput(environment, source, "rev-parse", "HEAD");
  const releaseCommit = releaseTagTarget === "main" ? main : candidate;
  runGit(environment, source, "tag", releaseTag, releaseCommit);
  runGit(environment, source, "push", "origin", releaseTag);
  const taggedCommit = gitOutput(
    environment,
    source,
    "rev-list",
    "-n",
    "1",
    releaseTag
  );
  return { candidate, main, remote, taggedCommit };
}

function cloneCandidate(
  environment: Record<string, string>,
  directory: string,
  remote: string,
  candidate: string
): string {
  const runner = join(directory, "runner");
  runGit(environment, directory, "clone", remote, runner);
  runGit(environment, runner, "checkout", "--detach", candidate);
  return runner;
}

function runAncestorHelper(
  environment: Record<string, string>,
  cwd: string,
  candidate: string,
  reference: string
): CommandResult {
  return runCommand(
    ["bash", ancestorHelperPath, candidate, reference],
    cwd,
    environment
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
  environment: Record<string, string>,
  cwd: string,
  tag: string,
  dryRun: boolean,
  stub: ReturnType<typeof installNpmStub>
): CommandResult {
  return runCommand(["bash", "-euc", extractPublishScript()], cwd, {
    ...environment,
    DRY_RUN: String(dryRun),
    GITHUB_REF_NAME: tag,
    NPM_CALL_LOG: stub.callsPath,
    PATH: stub.path,
  });
}

function markDependenciesAvailable(cwd: string): void {
  mkdirSync(join(cwd, "node_modules"));
}

function npmCalls(path: string): string[] {
  if (!existsSync(path)) {
    return [];
  }
  return readFileSync(path, "utf-8").trim().split("\n");
}

function runReleaseGuard(
  environment: Record<string, string>,
  cwd: string,
  candidate: string
): CommandResult {
  const guardStep = findRunStep(/check-release-ancestor\.sh/);
  if (typeof guardStep?.run !== "string") {
    throw new TypeError("release workflow must invoke the ancestor helper");
  }
  return runCommand(["bash", "-euc", guardStep.run], cwd, {
    ...environment,
    GITHUB_SHA: candidate,
  });
}

function repositorySnapshot(
  environment: Record<string, string>,
  cwd: string,
  sentinel: string
): object {
  return {
    head: gitOutput(environment, cwd, "rev-parse", "HEAD"),
    refs: gitOutput(environment, cwd, "show-ref"),
    sentinel: readFileSync(sentinel, "utf-8"),
    status: gitOutput(environment, cwd, "status", "--porcelain"),
  };
}

describe("release ancestor guard", () => {
  let callerStateBeforeTests: Record<string, string> = {};

  beforeAll(() => {
    callerStateBeforeTests = callerRepositoryState();
  });

  afterAll(() => {
    expect(callerRepositoryState()).toEqual(callerStateBeforeTests);
  });

  // REQ-77-01 / TC-77-01 / P-77-01
  test("should stop before npm publish when the tagged commit is outside main", () => {
    withTemporaryDirectory("tayk-release-ancestor-", (directory) => {
      const environment = hermeticGitEnvironment(join(directory, "gitconfig"));
      const repository = initializeReleaseRepository(
        environment,
        directory,
        "candidate"
      );
      const runner = cloneCandidate(
        environment,
        directory,
        repository.remote,
        repository.taggedCommit
      );
      const stub = installNpmStub(directory);

      expect(repository.taggedCommit).toBe(repository.candidate);
      const guard = runReleaseGuard(
        environment,
        runner,
        repository.taggedCommit
      );
      if (guard.exitCode === 0) {
        runPublishDecision(environment, runner, releaseTag, false, stub);
      }

      expect(npmCalls(stub.callsPath)).toEqual([]);
    });
  });

  // REQ-77-02 / TC-77-02 / P-77-01
  // REQ-304-04 / TC-304-08
  test("should run an unmasked ancestor guard against origin main before publishing", () => {
    const steps = releaseSteps();
    const checkoutIndex = steps.findIndex(
      (step) => step.uses?.startsWith("actions/checkout@") === true
    );
    const guardIndex = steps.findIndex(
      (step) => step.run?.includes("check-release-ancestor.sh") === true
    );
    const publishIndex = steps.findIndex((step) =>
      /\bnpm publish\b/.test(step.run ?? "")
    );
    const checkout = steps[checkoutIndex];

    // origin/main は fetch-depth: 0 の checkout が供給する。persist-credentials:
    // false で認証ヘッダが無いため、ここで追加の network fetch を挟んではならない。
    expect(checkout?.with?.["fetch-depth"]).toBe(0);
    expect(
      steps.some((step) => /\bgit fetch\b/.test(step.run ?? ""))
    ).toBeFalse();
    expect(steps[guardIndex]?.run).toContain("origin/main");
    expect(guardIndex).toBeGreaterThan(checkoutIndex);
    expect(publishIndex).toBeGreaterThan(guardIndex);
    for (const step of steps.slice(checkoutIndex + 1, guardIndex + 1)) {
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
      const environment = hermeticGitEnvironment(join(directory, "gitconfig"));
      const repository = initializeReleaseRepository(
        environment,
        directory,
        "candidate"
      );
      const runner = cloneCandidate(
        environment,
        directory,
        repository.remote,
        repository.main
      );

      const result = runAncestorHelper(
        environment,
        runner,
        repository.main,
        "origin/main"
      );

      expect(result.exitCode).toBe(0);
    });
  });

  // REQ-77-03b / TC-77-03B / P-77-03, P-77-04
  test("should reject non-ancestor and unresolvable inputs with diagnostics", () => {
    expect(existsSync(ancestorHelperPath)).toBe(true);
    withTemporaryDirectory("tayk-release-ancestor-", (directory) => {
      const environment = hermeticGitEnvironment(join(directory, "gitconfig"));
      const repository = initializeReleaseRepository(
        environment,
        directory,
        "candidate"
      );
      const runner = cloneCandidate(
        environment,
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
        const result = runAncestorHelper(
          environment,
          runner,
          candidate,
          reference
        );
        expect(result.exitCode).not.toBe(0);
        expect(result.stderr.toString().trim()).not.toBe("");
      }
    });
  });

  // REQ-77-04 / TC-77-04 / P-77-01
  test("should reject a tag and package version mismatch before npm publish", () => {
    withTemporaryDirectory("tayk-release-version-", (directory) => {
      const environment = hermeticGitEnvironment(join(directory, "gitconfig"));
      const repository = initializeReleaseRepository(
        environment,
        directory,
        "candidate"
      );
      const runner = cloneCandidate(
        environment,
        directory,
        repository.remote,
        repository.main
      );
      const stub = installNpmStub(directory);
      markDependenciesAvailable(runner);

      const result = runPublishDecision(
        environment,
        runner,
        "v9.9.9",
        false,
        stub
      );

      expect(result.exitCode).not.toBe(0);
      expect(npmCalls(stub.callsPath)).toEqual([]);
    });
  });

  // REQ-77-05, REQ-77-06 / TC-77-05, TC-77-06 / P-77-01, P-77-02
  // REQ-304-04 / TC-304-08
  test("should run only npm publish dry-run for a manual main release", () => {
    withTemporaryDirectory("tayk-release-dry-run-", (directory) => {
      const environment = hermeticGitEnvironment(join(directory, "gitconfig"));
      const repository = initializeReleaseRepository(
        environment,
        directory,
        "candidate"
      );
      const runner = cloneCandidate(
        environment,
        directory,
        repository.remote,
        repository.main
      );
      const stub = installNpmStub(directory);
      markDependenciesAvailable(runner);

      const guard = runReleaseGuard(environment, runner, repository.main);
      expect(guard.exitCode).toBe(0);
      const result = runPublishDecision(
        environment,
        runner,
        releaseTag,
        true,
        stub
      );

      expect(result.exitCode).toBe(0);
      expect(npmCalls(stub.callsPath)).toEqual(["publish --dry-run"]);
    });
  });

  // REQ-287-04 / REQ-287-05 / TC-287-04A / TC-287-05A
  test("should run npm publish exactly once for a matching tag on main", () => {
    withTemporaryDirectory("tayk-release-publish-", (directory) => {
      const environment = hermeticGitEnvironment(join(directory, "gitconfig"));
      const repository = initializeReleaseRepository(
        environment,
        directory,
        "main"
      );
      const runner = cloneCandidate(
        environment,
        directory,
        repository.remote,
        repository.taggedCommit
      );
      const stub = installNpmStub(directory);
      markDependenciesAvailable(runner);

      expect(repository.taggedCommit).toBe(repository.main);
      const guard = runReleaseGuard(
        environment,
        runner,
        repository.taggedCommit
      );
      expect(guard.exitCode).toBe(0);
      const result = runPublishDecision(
        environment,
        runner,
        releaseTag,
        false,
        stub
      );

      expect(result.exitCode).toBe(0);
      expect(npmCalls(stub.callsPath)).toEqual(["publish"]);
    });
  });

  // REQ-77-07 / TC-77-07 / P-77-02, P-77-03
  test("should leave repository state and ignored artifacts unchanged", () => {
    withTemporaryDirectory("tayk-release-read-only-", (directory) => {
      const environment = hermeticGitEnvironment(join(directory, "gitconfig"));
      const repository = initializeReleaseRepository(
        environment,
        directory,
        "candidate"
      );
      const runner = cloneCandidate(
        environment,
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
        const before = repositorySnapshot(environment, runner, sentinel);
        runAncestorHelper(environment, runner, candidate, "origin/main");
        expect(repositorySnapshot(environment, runner, sentinel)).toEqual(
          before
        );
      }
    });
  });

  // REQ-77-08 / TC-77-08 / P-77-01
  // REQ-304-04 / TC-304-08
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

  // #190: pre-push フック環境（GIT_DIR 等）が漏れていても fixture の git 操作が
  // 呼び出し元へ向かわないことの回帰テスト。密閉が外れると GIT_DIR の指す先に
  // repository が作られ、fixture のコミットが temp の外へ漏れる
  test("should shield fixture git operations from a leaked hook environment", () => {
    withTemporaryDirectory("tayk-release-hermetic-", (directory) => {
      const leakedGitDirectory = join(directory, "leaked-caller.git");
      const environment = hermeticGitEnvironment(join(directory, "gitconfig"), {
        ...process.env,
        GIT_DIR: leakedGitDirectory,
        GIT_INDEX_FILE: join(directory, "leaked-index"),
        LEFTHOOK: "1",
      });

      const repository = initializeReleaseRepository(
        environment,
        directory,
        "candidate"
      );

      expect(repository.candidate).not.toBe(repository.main);
      expect(existsSync(leakedGitDirectory)).toBe(false);
    });
  });
});
