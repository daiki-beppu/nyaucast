import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import {
  parseYamlRecord,
  readRepositoryFile,
  withTemporaryDirectory,
} from "../helpers";

const paths = {
  analyze: ".takt/facets/instructions/tayk-audit-runs-analyze.md",
  auditContract: ".takt/facets/output-contracts/tayk-runs-audit.md",
  issueTracker: "docs/agents/issue-tracker.md",
  plan: ".takt/facets/instructions/tayk-audit-runs-plan.md",
  planContract: ".takt/facets/output-contracts/tayk-runs-audit-plan.md",
  review: ".takt/facets/instructions/tayk-audit-runs-review.md",
  supervise: ".takt/facets/instructions/tayk-audit-runs-supervise.md",
  workflow: ".takt/workflows/tayk-audit-runs.yaml",
} as const;

interface EvidenceSection {
  name: string;
  text: string;
}

interface CommandResult {
  exitCode: number;
  stderr: string;
  stdout: string;
}

interface EvidenceFixture {
  cloneRoot: string;
  linkedWorktreeRoot: string;
  mainRoot: string;
  missingClones: { branch: string; clonePath: string }[];
}

interface WorkflowRule {
  condition?: string;
  next?: string;
}

interface WorkflowStep {
  name?: string;
  rules?: WorkflowRule[];
}

interface WorkflowDefinition {
  steps?: WorkflowStep[];
}

type RepositoryRunsState =
  | "empty"
  | "missing"
  | "permission-denied"
  | "populated"
  | "broken-symlink"
  | "regular-file";

const preflightStartMarker = "<!-- evidence-preflight:start -->";
const preflightEndMarker = "<!-- evidence-preflight:end -->";
const inheritedPath = process.env["PATH"];

if (inheritedPath === undefined) {
  throw new Error("PATH is required for the evidence-path integration test");
}

function hermeticGitEnvironment(
  globalConfigPath: string
): Record<string, string> {
  const environment: Record<string, string> = {};

  for (const [name, value] of Object.entries(process.env)) {
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
  environment: Record<string, string>
): CommandResult {
  const result = Bun.spawnSync(command, {
    cwd,
    env: environment,
    stderr: "pipe",
    stdout: "pipe",
  });
  if (result.stdout === undefined || result.stderr === undefined) {
    throw new Error("subprocess output pipes were not available");
  }
  return {
    exitCode: result.exitCode,
    stderr: result.stderr.toString(),
    stdout: result.stdout.toString(),
  };
}

function runGit(
  environment: Record<string, string>,
  cwd: string,
  ...arguments_: string[]
): string {
  const result = runCommand(
    ["git", "-C", cwd, ...arguments_],
    cwd,
    environment
  );

  if (result.exitCode !== 0) {
    throw new Error(`git ${arguments_.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

function extractCanonicalPreflight(): string {
  const source = readRepositoryFile(paths.plan);
  const start = source.indexOf(preflightStartMarker);
  const end = source.indexOf(preflightEndMarker);

  if (start === -1 || end === -1 || end <= start) {
    throw new Error(
      "plan facet must contain the canonical evidence preflight markers"
    );
  }
  const markedSection = source.slice(start + preflightStartMarker.length, end);
  const blocks = [
    ...markedSection.matchAll(/```(?:bash|sh)\s*\n([\s\S]*?)```/g),
  ];

  if (blocks.length !== 1 || blocks[0]?.[1] === undefined) {
    throw new Error(
      "canonical evidence preflight must be one shell command block"
    );
  }
  return blocks[0][1];
}

function runCanonicalPreflight(
  cwd: string,
  environment: Record<string, string>
): CommandResult {
  return runCommand(
    ["bash", "-c", extractCanonicalPreflight()],
    cwd,
    environment
  );
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function parseJsonObject(
  source: string,
  label: string
): Record<string, unknown> {
  const value: unknown = JSON.parse(source.trim());

  return requireRecord(value, label);
}

function requireArray(
  value: unknown,
  label: string
): Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`${label} must be an array`);
  }
  return value.map((entry, index) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new TypeError(`${label}[${index}] must be an object`);
    }
    return entry as Record<string, unknown>;
  });
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value)}\n`);
}

function createRepositoryRuns(
  mainRoot: string,
  state: RepositoryRunsState
): void {
  const taktRoot = join(mainRoot, ".takt");
  const runsRoot = join(taktRoot, "runs");
  mkdirSync(taktRoot, { recursive: true });

  switch (state) {
    case "missing": {
      return;
    }
    case "regular-file": {
      writeFileSync(runsRoot, "not a directory\n");
      return;
    }
    case "broken-symlink": {
      symlinkSync(join(mainRoot, "missing-runs-target"), runsRoot);
      return;
    }
    case "empty":
    case "permission-denied": {
      mkdirSync(runsRoot);
      if (state === "permission-denied") {
        chmodSync(runsRoot, 0o000);
      }
      return;
    }
    case "populated": {
      const runRoot = join(runsRoot, "main-run");
      mkdirSync(runRoot, { recursive: true });
      writeJson(join(runRoot, "meta.json"), { workflow: "fixture-main" });
      return;
    }
    default: {
      throw new TypeError("unsupported repository runs state");
    }
  }
}

function withEvidenceFixture(
  runsState: RepositoryRunsState,
  execute: (
    fixture: EvidenceFixture,
    environment: Record<string, string>
  ) => void
): void {
  withTemporaryDirectory(
    "tayk evidence path ",
    (temporaryRoot) => {
      const mainRoot = join(temporaryRoot, "main checkout");
      const linkedWorktreeRoot = join(temporaryRoot, "linked worktree");
      const cloneRoot = join(temporaryRoot, "external clone evidence");
      const globalConfigPath = join(temporaryRoot, "global-git-config");
      const environment = hermeticGitEnvironment(globalConfigPath);
      const missingClones = [
        {
          branch: "takt/288/missing-alpha",
          clonePath: join(temporaryRoot, "missing clone alpha"),
        },
        {
          branch: "takt/288/missing-beta",
          clonePath: join(temporaryRoot, "missing clone beta"),
        },
      ];

      writeFileSync(globalConfigPath, "");
      mkdirSync(mainRoot, { recursive: true });
      runGit(environment, mainRoot, "init");
      runGit(
        environment,
        mainRoot,
        "config",
        "user.email",
        "fixture@example.invalid"
      );
      runGit(environment, mainRoot, "config", "user.name", "Evidence Fixture");
      runGit(environment, mainRoot, "commit", "--allow-empty", "-m", "fixture");
      runGit(
        environment,
        mainRoot,
        "worktree",
        "add",
        linkedWorktreeRoot,
        "HEAD"
      );

      createRepositoryRuns(mainRoot, runsState);
      if (runsState === "populated") {
        const cloneRunRoot = join(cloneRoot, ".takt", "runs", "clone-run");
        const cloneMetaRoot = join(mainRoot, ".takt", "clone-meta");
        mkdirSync(cloneRunRoot, { recursive: true });
        mkdirSync(cloneMetaRoot, { recursive: true });
        writeJson(join(cloneRunRoot, "meta.json"), {
          workflow: "fixture-clone",
        });
        writeJson(join(cloneMetaRoot, "valid.json"), {
          branch: "takt/288/valid",
          clonePath: cloneRoot,
        });
        for (const [index, missing] of missingClones.entries()) {
          writeJson(join(cloneMetaRoot, `missing-${index}.json`), missing);
        }
      }

      try {
        execute(
          { cloneRoot, linkedWorktreeRoot, mainRoot, missingClones },
          environment
        );
      } finally {
        if (runsState === "permission-denied") {
          chmodSync(join(mainRoot, ".takt", "runs"), 0o700);
        }
      }
    },
    realpathSync
  );
}

function parseWorkflow(): WorkflowDefinition {
  return parseYamlRecord({
    expectedShape: "a workflow object",
    relativePath: paths.workflow,
    source: readRepositoryFile(paths.workflow),
  });
}

function planRules(): WorkflowRule[] {
  const plan = parseWorkflow().steps?.find((step) => step.name === "plan");

  if (!Array.isArray(plan?.rules)) {
    throw new TypeError("tayk-audit-runs plan step must declare rules");
  }
  return plan.rules;
}

function expectAbortOnlyRouting(reason: string): void {
  const matching = planRules().filter(
    (rule) =>
      typeof rule.condition === "string" && rule.condition.includes(reason)
  );

  expect(matching.length, `${reason} routing count`).toBeGreaterThan(0);
  expect(
    matching.every((rule) => rule.next === "ABORT"),
    reason
  ).toBe(true);
}

function extractBetween(
  source: string,
  startPattern: RegExp,
  endPattern: RegExp,
  label: string
): string {
  const start = source.search(startPattern);

  if (start === -1) {
    throw new Error(`missing section start: ${label}`);
  }
  const tail = source.slice(start);
  const end = tail.search(endPattern);

  if (end <= 0) {
    throw new Error(`missing section end: ${label}`);
  }
  return tail.slice(0, end);
}

function extractMarkdownSection(source: string, heading: string): string {
  const lines = source.split("\n");
  const escapedHeading = heading.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const headingPattern = new RegExp(`^(#{2,6})\\s+${escapedHeading}\\s*$`, "i");
  const start = lines.findIndex((line) => headingPattern.test(line));

  if (start === -1) {
    throw new Error(`missing section: ${heading}`);
  }
  const level = /^#+/.exec(lines[start] ?? "")?.[0].length;

  if (level === undefined) {
    throw new Error(`invalid heading: ${heading}`);
  }
  const end = lines.findIndex(
    (line, index) =>
      index > start &&
      /^#{1,6}\s+/.test(line) &&
      (/^#+/.exec(line)?.[0].length ?? 7) <= level
  );
  return lines.slice(start, end === -1 ? undefined : end).join("\n");
}

function extractFrom(
  source: string,
  startPattern: RegExp,
  label: string
): string {
  const start = source.search(startPattern);

  if (start === -1) {
    throw new Error(`missing section start: ${label}`);
  }
  return source.slice(start);
}

function evidenceSections(): EvidenceSection[] {
  const workflowSource = readRepositoryFile(paths.workflow);
  const leadingComments = workflowSource.slice(
    0,
    workflowSource.indexOf("name:")
  );
  const workflowDescription = extractBetween(
    workflowSource,
    /^description:/m,
    /^max_steps:/m,
    "workflow description"
  );
  const planDescription = extractBetween(
    workflowSource,
    /^ {2}- name: plan$/m,
    /^ {4}tags:/m,
    "plan step description"
  );
  const planEvidence = extractBetween(
    readRepositoryFile(paths.plan),
    /^\*\*証拠パス/m,
    /^\*\*定義監査の固定対象/m,
    "plan evidence path"
  );
  const analyzeEvidence = extractBetween(
    readRepositoryFile(paths.analyze),
    /^run 監査を分解/m,
    /^\*\*やること/m,
    "analyze evidence introduction"
  );
  const issueTracker = readRepositoryFile(paths.issueTracker)
    .split("\n")
    .filter(
      (line) => line.includes("tayk-audit-runs") || line.startsWith("  フロー:")
    )
    .join("\n");

  return [
    {
      name: "workflow overview and plan step",
      text: [leadingComments, workflowDescription, planDescription].join("\n"),
    },
    { name: "plan evidence path", text: planEvidence },
    { name: "analyze evidence introduction", text: analyzeEvidence },
    { name: "issue tracker operation", text: issueTracker },
  ];
}

function expectScopeDeclaration(section: EvidenceSection): void {
  expect(section.text, section.name).toMatch(
    /(?:レポート|監査レポート)[^\n]*冒頭/
  );
  expect(section.text, section.name).toMatch(/対象範囲宣言/);
  expect(section.text, section.name).toMatch(
    /(?:辿れない|欠落)[^\n]*meta[^\n]*件数/
  );
  expect(section.text, section.name).toMatch(
    /(?:各|すべての)[^\n]*branch[^\n]*名/
  );
}

describe("tayk-audit-runs evidence path contract", () => {
  // REQ-288-01 / TC-288-01A
  test("should derive the main checkout from the common directory when a linked worktree path contains spaces", () => {
    withEvidenceFixture("populated", (fixture, environment) => {
      const worktreeTopLevel = runGit(
        environment,
        fixture.linkedWorktreeRoot,
        "rev-parse",
        "--show-toplevel"
      );
      const result = runCanonicalPreflight(
        fixture.linkedWorktreeRoot,
        environment
      );
      const output = parseJsonObject(result.stdout, "preflight stdout");

      expect(worktreeTopLevel).toBe(fixture.linkedWorktreeRoot);
      expect(worktreeTopLevel).not.toBe(fixture.mainRoot);
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(output["status"]).toBe("ok");
      expect(output["repositoryRoot"]).toBe(fixture.mainRoot);
    });
  });

  // REQ-288-01 / TC-288-01B
  test("should keep root derivation in the plan preflight and document the linked-worktree boundary", () => {
    const plan = readRepositoryFile(paths.plan);
    const workflow = readRepositoryFile(paths.workflow);
    const issueTracker = readRepositoryFile(paths.issueTracker);
    const preflight = extractCanonicalPreflight();

    expect(preflight).toContain("git rev-parse --git-common-dir");
    expect(preflight).not.toContain("git rev-parse --show-toplevel");
    for (const [label, source] of [
      ["plan", plan],
      ["workflow", workflow],
      ["issue tracker", issueTracker],
    ] as const) {
      expect(source, label).toMatch(/linked worktree/i);
      expect(source, label).toMatch(
        /(?:独立|隔離)[^\n]*(?:clone|クローン)[^\n]*対象外/i
      );
    }
    for (const path of [paths.analyze, paths.review, paths.supervise]) {
      const source = readRepositoryFile(path);
      expect(source, path).toMatch(
        /計画(?:レポート)?[^\n]*(?:解決|記録)[^\n]*実パス/
      );
      expect(source, path).not.toContain("git rev-parse --git-common-dir");
    }

    const obsoleteCheckout = ["", "Users", "mba", "02-yt", "tayk"].join("/");
    for (const path of Object.values(paths)) {
      expect(readRepositoryFile(path), path).not.toContain(obsoleteCheckout);
    }
  });

  // REQ-288-02 / TC-288-02
  test("should resolve repository runs from the main checkout when executed in a linked worktree", () => {
    withEvidenceFixture("populated", (fixture, environment) => {
      const result = runCanonicalPreflight(
        fixture.linkedWorktreeRoot,
        environment
      );
      const output = parseJsonObject(result.stdout, "preflight stdout");
      const repositoryRuns = requireRecord(
        output["repositoryRuns"],
        "repositoryRuns"
      );

      expect(result.exitCode).toBe(0);
      expect(repositoryRuns["path"]).toBe(
        join(fixture.mainRoot, ".takt", "runs")
      );
      expect(repositoryRuns["runCount"]).toBe(1);
    });
  });

  // REQ-288-03 / TC-288-03
  test("should use clonePath unchanged when resolving clone runs", () => {
    withEvidenceFixture("populated", (fixture, environment) => {
      const result = runCanonicalPreflight(
        fixture.linkedWorktreeRoot,
        environment
      );
      const output = parseJsonObject(result.stdout, "preflight stdout");
      const cloneRuns = requireArray(output["cloneRuns"], "cloneRuns");

      expect(result.exitCode).toBe(0);
      expect(cloneRuns).toEqual([
        {
          branch: "takt/288/valid",
          path: join(fixture.cloneRoot, ".takt", "runs"),
          runCount: 1,
        },
      ]);
    });
  });

  // REQ-288-04 / TC-288-04
  test("should abort with the executed Git command and diagnostic when Git root derivation fails", () => {
    withTemporaryDirectory("tayk evidence non-git ", (directory) => {
      const environment = hermeticGitEnvironment(join(directory, "gitconfig"));
      writeFileSync(join(directory, "gitconfig"), "");
      const actualGit = runCommand(
        ["git", "rev-parse", "--git-common-dir"],
        directory,
        environment
      );
      const result = runCanonicalPreflight(directory, environment);
      const error = parseJsonObject(result.stderr, "preflight stderr");

      expect(result.exitCode).not.toBe(0);
      expect(result.stdout).toBe("");
      expect(error["status"]).toBe("abort");
      expect(error["reason"]).toBe("git-common-dir");
      expect(error["command"]).toBe("git rev-parse --git-common-dir");
      expect(error["diagnostic"]).toBe(actualGit.stderr.trim());
      expect(String(error["diagnostic"])).not.toBe("");
      expectAbortOnlyRouting("git-common-dir");
    });
  });

  // REQ-288-05 / TC-288-05A
  test("should abort when repository runs are missing", () => {
    withEvidenceFixture("missing", (fixture, environment) => {
      const result = runCanonicalPreflight(
        fixture.linkedWorktreeRoot,
        environment
      );
      const error = parseJsonObject(result.stderr, "preflight stderr");

      expect(result.exitCode).not.toBe(0);
      expect(result.stdout).toBe("");
      expect(error["status"]).toBe("abort");
      expect(error["reason"]).toBe("repository-runs-unreadable");
      expect(String(error["command"])).not.toBe("");
      expect(String(error["diagnostic"])).toContain(
        join(fixture.mainRoot, ".takt", "runs")
      );
      expectAbortOnlyRouting("repository-runs-unreadable");
    });
  });

  // REQ-288-05 / TC-288-05B
  test("should abort when repository runs are empty", () => {
    withEvidenceFixture("empty", (fixture, environment) => {
      const result = runCanonicalPreflight(
        fixture.linkedWorktreeRoot,
        environment
      );
      const error = parseJsonObject(result.stderr, "preflight stderr");

      expect(result.exitCode).not.toBe(0);
      expect(result.stdout).toBe("");
      expect(error["status"]).toBe("abort");
      expect(error["reason"]).toBe("repository-runs-empty");
      expect(String(error["command"])).not.toBe("");
      expect(String(error["diagnostic"])).toContain(
        join(fixture.mainRoot, ".takt", "runs")
      );
      expectAbortOnlyRouting("repository-runs-empty");
    });
  });

  // REQ-288-05 / TC-288-05C
  test("should abort when repository runs are not a readable directory", () => {
    for (const state of [
      "regular-file",
      "broken-symlink",
      "permission-denied",
    ] as const) {
      withEvidenceFixture(state, (fixture, environment) => {
        const result = runCanonicalPreflight(
          fixture.linkedWorktreeRoot,
          environment
        );
        const error = parseJsonObject(result.stderr, "preflight stderr");

        expect(result.exitCode, state).not.toBe(0);
        expect(result.stdout, state).toBe("");
        expect(error["status"], state).toBe("abort");
        expect(error["reason"], state).toBe("repository-runs-unreadable");
        expect(String(error["command"]), state).not.toBe("");
        expect(String(error["diagnostic"]), state).toContain(
          join(fixture.mainRoot, ".takt", "runs")
        );
      });
    }
  });

  // REQ-288-06 / TC-288-06; maintains REQ-196-02 / TC-196-02
  test("should continue with repository and valid clone runs when clonePath is missing", () => {
    withEvidenceFixture("populated", (fixture, environment) => {
      const result = runCanonicalPreflight(
        fixture.linkedWorktreeRoot,
        environment
      );
      const output = parseJsonObject(result.stdout, "preflight stdout");

      expect(result.exitCode).toBe(0);
      expect(output["status"]).toBe("ok");
      expect(
        requireRecord(output["repositoryRuns"], "repositoryRuns")["runCount"]
      ).toBe(1);
      expect(requireArray(output["cloneRuns"], "cloneRuns")).toHaveLength(1);
      expect(
        requireArray(output["missingClones"], "missingClones")
      ).toHaveLength(2);
    });
  });

  // REQ-288-07 / TC-288-07A; maintains REQ-196-03 / TC-196-03
  test("should report every missing clone branch and clonePath as coverage loss", () => {
    withEvidenceFixture("populated", (fixture, environment) => {
      const result = runCanonicalPreflight(
        fixture.linkedWorktreeRoot,
        environment
      );
      const output = parseJsonObject(result.stdout, "preflight stdout");

      expect(result.exitCode).toBe(0);
      expect(output["missingCloneCount"]).toBe(2);
      expect(output["missingCloneBranches"]).toEqual(
        fixture.missingClones.map(({ branch }) => branch)
      );
      expect(requireArray(output["missingClones"], "missingClones")).toEqual(
        fixture.missingClones
      );
    });
  });

  // REQ-288-07 / TC-288-07B; maintains REQ-196-04 / TC-196-04
  test("should declare missing meta counts and branch names at the start of reports", () => {
    for (const section of evidenceSections()) {
      expectScopeDeclaration(section);
    }

    expectScopeDeclaration({
      name: "plan output Evidence Path Check",
      text: extractMarkdownSection(
        readRepositoryFile(paths.planContract),
        "Evidence Path Check"
      ),
    });
    expectScopeDeclaration({
      name: "audit output opening",
      text: extractBetween(
        readRepositoryFile(paths.auditContract),
        /^```markdown/m,
        /^## Audit Scope/m,
        "audit report opening"
      ),
    });
  });

  // REQ-288-04 / REQ-288-05 / TC-288-04 / TC-288-05A / TC-288-05B / TC-288-05C
  test("should route only a successful evidence preflight from plan to analyze", () => {
    const rules = planRules();
    const analyzeRules = rules.filter((rule) => rule.next === "analyze");

    expect(analyzeRules).toHaveLength(1);
    expect(analyzeRules[0]?.condition).toMatch(/status[^\n]*ok/i);
    for (const reason of [
      "git-common-dir",
      "repository-runs-unreadable",
      "repository-runs-empty",
    ]) {
      expectAbortOnlyRouting(reason);
      expect(
        analyzeRules.every(
          (rule) =>
            typeof rule.condition !== "string" ||
            !rule.condition.includes(reason)
        ),
        reason
      ).toBe(true);
    }
  });

  // REQ-288-02 / REQ-288-03 / REQ-288-04 / REQ-288-05 / REQ-288-07
  test("should persist the canonical preflight result in the plan report contract", () => {
    const evidencePathCheck = extractMarkdownSection(
      readRepositoryFile(paths.planContract),
      "Evidence Path Check"
    );

    for (const field of [
      "status",
      "reason",
      "command",
      "diagnostic",
      "repositoryRoot",
      "repositoryRuns",
      "cloneRuns",
      "missingCloneCount",
      "missingCloneBranches",
    ]) {
      expect(evidencePathCheck, field).toContain(field);
    }
  });

  // REQ-196-07 / TC-196-05B / P-196-03
  test("should inventory every scoped meta.json before selecting Audit Targets", () => {
    const plan = readRepositoryFile(paths.plan);
    const planContract = readRepositoryFile(paths.planContract);
    const inventory = extractMarkdownSection(planContract, "Run Inventory");
    const enumeration = extractMarkdownSection(
      planContract,
      "Enumeration Evidence"
    );

    expect(plan).toMatch(/スコープ全体[^\n]*機械的に集計してから対象を選ぶ/);
    expect(plan.indexOf("各 run の `meta.json`")).toBeLessThan(
      plan.indexOf("Audit Targets 表")
    );
    expect(inventory).toMatch(
      /Workflow[\s\S]*Runs[\s\S]*Aborted[\s\S]*Completed/
    );
    expect(enumeration).toMatch(/meta\.json[^\n]*集計/);
  });

  // REQ-196-07 / TC-196-05C / P-196-03
  test("should keep Audit Targets within the fixed 24 and run 21 limits", () => {
    const planLimit = extractBetween(
      readRepositoryFile(paths.plan),
      /^\*\*Audit Targets の粒度と上限/m,
      /^## Recovery Inventory/m,
      "plan Audit Targets limits"
    );
    const contractLimit = extractBetween(
      readRepositoryFile(paths.planContract),
      /^\*\*Audit Targets の契約/m,
      /^\*\*Recovery Inventory の契約/m,
      "plan contract Audit Targets limits"
    );

    for (const section of [planLimit, contractLimit]) {
      expect(section).toMatch(/固定 3 対象[^\n]*24 以下/);
      expect(section).toMatch(/run 対象[^\n]*21 以下/);
    }
  });

  // REQ-196-07 / TC-196-05D / P-196-03
  test("should assign Audit Targets and Recovery Inventory exactly once across parts", () => {
    const analyze = readRepositoryFile(paths.analyze);
    const assignment = extractBetween(
      analyze,
      /^\*\*やること/m,
      /^\*\*重要/m,
      "analyze target assignment"
    );
    const recovery = extractMarkdownSection(
      analyze,
      "Recovery Inventory の分析"
    );

    expect(assignment).toMatch(/全 Audit Target[^\n]*3 グループ/);
    expect(assignment).toMatch(/排他的[\s\S]*一度ずつ/);
    expect(recovery).toMatch(/全 run[^\n]*漏れなく[^\n]*排他的/);
    expect(recovery).toMatch(/Audit Targets とは独立した集合/);
  });

  // REQ-196-07 / TC-196-05E / P-196-03
  test("should preserve one-to-one Audit Scope and Recovery Coverage rows", () => {
    const analyze = extractBetween(
      readRepositoryFile(paths.analyze),
      /^\*\*統合時の必須事項/m,
      /^\*\*統合時のトークン消費集計/m,
      "analyze integration requirements"
    );
    const review = extractBetween(
      readRepositoryFile(paths.review),
      /^\*\*出力の原則/m,
      /^\*\*厳禁/m,
      "review output rules"
    );
    const supervise = extractBetween(
      readRepositoryFile(paths.supervise),
      /^\*\*検証手順/m,
      /^## 通常 Finding/m,
      "supervise verification"
    );
    const planContract = readRepositoryFile(paths.planContract);
    const auditContract = extractFrom(
      readRepositoryFile(paths.auditContract),
      /^\*\*表の維持ルール/m,
      "audit table rules"
    );

    expect(analyze).toMatch(/Audit Scope[^\n]*Audit Targets[^\n]*一対一/);
    expect(readRepositoryFile(paths.analyze)).toMatch(
      /Recovery Inventory[^\n]*独立した集合[\s\S]*全 run[^\n]*漏れなく[^\n]*排他的/
    );
    for (const section of [review, planContract, auditContract]) {
      expect(section).toMatch(/Audit (?:Targets|Scope)[\s\S]{0,240}一対一/);
      expect(section).toMatch(
        /Recovery (?:Inventory|Coverage)[\s\S]{0,240}一対一/
      );
    }
    expect(supervise).toMatch(/Audit Scope[^\n]*Audit Targets[^\n]*一対一/);
    expect(supervise).toMatch(
      /Recovery Coverage[^\n]*Recovery Inventory[^\n]*run および絶対パスで照合/
    );
    for (const section of [review, supervise, auditContract]) {
      expect(section).toMatch(
        /(?:欠落|削除)[^\n]*(?:統合|重複)|行の欠落・集約・重複/
      );
    }
  });

  test("should propagate each run evidence path through planning and analysis", () => {
    const planContract = readRepositoryFile(paths.planContract);
    const auditContract = readRepositoryFile(paths.auditContract);
    const analyze = readRepositoryFile(paths.analyze);
    const review = readRepositoryFile(paths.review);
    const supervise = readRepositoryFile(paths.supervise);

    expect(extractMarkdownSection(planContract, "Audit Targets")).toMatch(
      /Runs[\s\S]*Evidence Paths[\s\S]*run 絶対パス/
    );
    expect(extractMarkdownSection(planContract, "Recovery Inventory")).toMatch(
      /Run[\s\S]*Evidence Path[\s\S]*run 絶対パス/
    );
    for (const heading of ["Audit Scope", "Recovery Coverage", "Findings"]) {
      expect(extractMarkdownSection(auditContract, heading), heading).toMatch(
        /Evidence Path/
      );
    }
    for (const section of [analyze, review, supervise]) {
      expect(section).toMatch(/run[^\n]*絶対パス|絶対パス[^\n]*run/);
    }
    expect(supervise).toMatch(
      /Finding[^\n]*run の絶対パス[^\n]*計画レポート[^\n]*一致/
    );
  });

  test("should reject supervision when missing-clone scope declarations diverge", () => {
    const verification = extractBetween(
      readRepositoryFile(paths.supervise),
      /^\*\*検証手順/m,
      /^## 通常 Finding/m,
      "supervise verification"
    );

    expect(verification).toMatch(
      /計画レポート冒頭[^\n]*分析レポート冒頭[^\n]*照合/
    );
    expect(verification).toMatch(/辿れない meta[^\n]*件数/);
    expect(verification).toMatch(/全 `branch` 名/);
    expect(verification).toMatch(/一致しなければ \*\*rework\*\*/);
  });

  // REQ-196-07 / TC-196-05F / P-196-03
  test("should preserve complete Token Usage aggregation across reanalysis", () => {
    const analyze = extractBetween(
      readRepositoryFile(paths.analyze),
      /^\*\*統合時のトークン消費集計/m,
      /^\*\*制約/m,
      "analyze Token Usage aggregation"
    );
    const review = readRepositoryFile(paths.review);
    const supervise = readRepositoryFile(paths.supervise);
    const contract = extractMarkdownSection(
      readRepositoryFile(paths.auditContract),
      "Token Usage"
    );

    expect(analyze).toMatch(/Run Inventory と同じスコープの全 run/);
    expect(analyze).toMatch(/workflow 別[\s\S]*合計[\s\S]*中央値/);
    expect(analyze).toMatch(/step 別[\s\S]*割合/);
    expect(analyze).toMatch(/集計対象外[\s\S]*件数と理由/);
    expect(review).toMatch(/Token Usage 節はそのまま保持/);
    expect(supervise).toMatch(
      /Token Usage 節[\s\S]*集計対象外[^\n]*件数と理由/
    );
    expect(contract).toMatch(/Workflow 別[\s\S]*Step 別[\s\S]*所見/);
  });

  // REQ-196-07 / TC-196-05G / P-196-03
  test("should advance at least four targets without discarding prior results", () => {
    const review = readRepositoryFile(paths.review);
    const outputRules = extractBetween(
      review,
      /^\*\*出力の原則/m,
      /^\*\*厳禁/m,
      "review output rules"
    );
    const auditRules = extractFrom(
      readRepositoryFile(paths.auditContract),
      /^\*\*表の維持ルール/m,
      "audit table rules"
    );

    expect(review).toMatch(/最低 4 対象/);
    expect(outputRules).toMatch(/分析済み行・Findings[^\n]*保持/);
    expect(auditRules).toMatch(/Targets with No Findings[^\n]*全行維持/);
    expect(outputRules).toMatch(/✅ を ⏳ に戻さない/);
  });

  // REQ-196-07 / TC-196-05H / P-196-03
  test("should route structural, evidence, and complete supervision outcomes distinctly", () => {
    const supervise = readRepositoryFile(paths.supervise);
    const verification = extractBetween(
      supervise,
      /^\*\*検証手順/m,
      /^## 通常 Finding/m,
      "supervise verification"
    );
    const structured = extractBetween(
      supervise,
      /^\*\*structured output の記入/m,
      /^\*\*厳禁/m,
      "supervise structured output"
    );

    expect(verification).toMatch(
      /行の欠落・集約・重複・番号ずれ[^\n]*table_broken/
    );
    expect(verification).toMatch(
      /引用[^\n]*(?:見つからない|食い違う)[^\n]*rework/
    );
    expect(verification).toMatch(/全行 ✅[^\n]*品質十分[^\n]*approve/);
    expect(structured).toMatch(/approve \/ rework \/ table_broken/);
  });

  // REQ-196-07 / TC-196-06 / P-196-01, P-196-03
  test("should validate both run evidence paths without weakening Finding evidence", () => {
    for (const instructionPath of [paths.review, paths.supervise]) {
      const instruction = readRepositoryFile(instructionPath);
      const normalEvidence = extractMarkdownSection(
        instruction,
        "通常 Finding の Evidence"
      );
      const recoveryEvidence = extractMarkdownSection(
        instruction,
        "回収 Finding の Evidence"
      );

      expect(instruction).toMatch(
        /計画(?:レポート)?[^\n]*(?:記録|列挙)[^\n]*実パス/
      );
      expect(instruction).toMatch(
        /本体[^\n]*run[^\n]*(?:clone|クローン)[^\n]*run/
      );
      expect(normalEvidence).toMatch(
        /trace\.md[\s\S]*meta\.json[\s\S]*monitor\.json/
      );
      expect(normalEvidence).toMatch(/定義ファイル[^\n]*(?:パス|引用)/);
      expect(recoveryEvidence).toMatch(/元レポート[^\n]*(?:開|照合)/);
      expect(recoveryEvidence).toMatch(
        /回収 Finding に限る|回収 Finding にだけ適用/
      );
    }
  });
});
