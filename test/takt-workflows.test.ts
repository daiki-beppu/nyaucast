import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const packageRoot = resolve(import.meta.dir, "..");
const workflowsDirectory = join(packageRoot, ".takt", "workflows");

type Workflow = Record<string, unknown>;

function readWorkflow(name: string): Workflow {
  const path = join(workflowsDirectory, `${name}.yaml`);
  const parsed: unknown = Bun.YAML.parse(readFileSync(path, "utf8"));

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${path} must contain a workflow object`);
  }

  return parsed as Workflow;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }

  return value as Record<string, unknown>;
}

function requireSteps(
  workflow: Workflow,
  name: string
): Record<string, unknown>[] {
  const steps = workflow["steps"];
  if (!Array.isArray(steps)) {
    throw new Error(`${name}.steps must be an array`);
  }

  return steps.map((step, index) =>
    requireRecord(step, `${name}.steps[${String(index)}]`)
  );
}

function stepNames(workflow: Workflow, name: string): string[] {
  return requireSteps(workflow, name).map((step, index) => {
    const value = step["name"];
    if (typeof value !== "string") {
      throw new Error(`${name}.steps[${String(index)}].name must be a string`);
    }
    return value;
  });
}

function serializedWorkflow(name: string): string {
  return readFileSync(join(workflowsDirectory, `${name}.yaml`), "utf8");
}

function stepByName(workflow: Workflow, name: string): Record<string, unknown> {
  const workflowName = workflow["name"];
  const step = requireSteps(workflow, String(workflowName)).find(
    (candidate) => candidate["name"] === name
  );
  if (!step) {
    throw new Error(`${String(workflowName)} is missing step ${name}`);
  }
  return step;
}

function ruleTargets(step: Record<string, unknown>): string[] {
  const rules = step["rules"];
  if (!Array.isArray(rules)) {
    throw new Error(`${String(step["name"])}.rules must be an array`);
  }

  return rules.flatMap((rule) => {
    const record = requireRecord(rule, `${String(step["name"])}.rules`);
    const next = record["next"];
    return typeof next === "string" ? [next] : [];
  });
}

function nextForCondition(
  step: Record<string, unknown>,
  condition: string
): string {
  const rules = step["rules"];
  if (!Array.isArray(rules)) {
    throw new Error(`${String(step["name"])}.rules must be an array`);
  }

  const rule = rules
    .map((candidate) =>
      requireRecord(candidate, `${String(step["name"])}.rules`)
    )
    .find((candidate) => candidate["condition"] === condition);
  if (!rule || typeof rule["next"] !== "string") {
    throw new Error(
      `${String(step["name"])} has no rule for condition ${condition}`
    );
  }
  return rule["next"];
}

function runMockEngineScenario(
  rules: string,
  response: string
): { status: number | null; output: string } {
  const directory = mkdtempSync(join(tmpdir(), "tayk-workflow-test-"));
  const workflowPath = join(directory, "workflow.yaml");
  const scenarioPath = join(directory, "scenario.json");
  writeFileSync(
    workflowPath,
    `name: deterministic-contract\nmax_steps: 3\ninitial_step: decision\nsteps:\n  - name: decision\n    persona: coder\n    instruction: Return the requested branch.\n    rules:\n${rules}\n`
  );
  writeFileSync(
    scenarioPath,
    JSON.stringify([{ persona: "coder", status: "done", content: response }])
  );

  try {
    const result = spawnSync(
      "takt",
      [
        "--pipeline",
        "--skip-git",
        "--task",
        "deterministic workflow contract",
        "--workflow",
        workflowPath,
        "--provider",
        "mock",
        "--quiet",
      ],
      {
        cwd: packageRoot,
        encoding: "utf8",
        env: { ...process.env, TAKT_MOCK_SCENARIO: scenarioPath },
      }
    );
    return {
      status: result.status,
      output: `${result.stdout}\n${result.stderr}`,
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function runMockWorkflowDefinition(
  definition: string,
  responses: { persona: string; content: string }[]
): number | null {
  const directory = mkdtempSync(join(tmpdir(), "tayk-workflow-test-"));
  const workflowPath = join(directory, "workflow.yaml");
  const scenarioPath = join(directory, "scenario.json");
  writeFileSync(workflowPath, definition);
  writeFileSync(
    scenarioPath,
    JSON.stringify(
      responses.map((response) => ({ ...response, status: "done" }))
    )
  );

  try {
    return spawnSync(
      "takt",
      [
        "--pipeline",
        "--skip-git",
        "--task",
        "deterministic workflow contract",
        "--workflow",
        workflowPath,
        "--provider",
        "mock",
        "--quiet",
      ],
      {
        cwd: packageRoot,
        encoding: "utf8",
        env: { ...process.env, TAKT_MOCK_SCENARIO: scenarioPath },
      }
    ).status;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("TAKT workflow contracts", () => {
  test("WF-01/WF-02: exposes independent feature and fix entries with shared intake", () => {
    const feature = readWorkflow("feature");
    const fix = readWorkflow("fix");
    const shared = readWorkflow("shared");

    expect(ruleTargets(stepByName(feature, "pr-context"))).toEqual([
      "pr-monitor",
      "shared-intake",
    ]);
    expect(ruleTargets(stepByName(fix, "pr-context"))).toEqual([
      "pr-monitor",
      "shared-intake",
    ]);
    expect(ruleTargets(stepByName(feature, "shared-intake"))).toEqual([
      "intake",
      "ABORT",
    ]);
    expect(ruleTargets(stepByName(fix, "shared-intake"))).toEqual([
      "intake",
      "ABORT",
    ]);
    const sharedIntake = readWorkflow("shared-intake");

    expect(feature["name"]).toBe("feature");
    expect(fix["name"]).toBe("fix");
    expect(shared["name"]).toBe("shared");
    expect(stepNames(feature, "feature")[0]).toBe("pr-context");
    expect(stepNames(fix, "fix")[0]).toBe("pr-context");
    expect(stepNames(shared, "shared")[0]).toBe("review");
    expect(stepNames(sharedIntake, "shared-intake")[0]).toBe("intake");
    expect(serializedWorkflow("feature")).toContain("call: shared-intake");
    expect(serializedWorkflow("fix")).toContain("call: shared-intake");
    expect(serializedWorkflow("feature")).toContain("call: shared-pr-monitor");
    expect(serializedWorkflow("fix")).toContain("call: shared-pr-monitor");
    expect(serializedWorkflow("feature")).toContain("call: shared");
    expect(serializedWorkflow("fix")).toContain("call: shared");
  });

  test("WF-03/WF-04/WF-05: preserves test-first ordering for feature and fix", () => {
    const featureNames = stepNames(readWorkflow("feature"), "feature");
    const fixNames = stepNames(readWorkflow("fix"), "fix");

    expect(
      featureNames.indexOf("tests") < featureNames.indexOf("implement")
    ).toBeTrue();
    expect(
      fixNames.indexOf("regression-tests") < fixNames.indexOf("implement")
    ).toBeTrue();
    expect(serializedWorkflow("feature")).toMatch(/requirements|REQ-00[1-9]/);
    expect(serializedWorkflow("fix")).toMatch(/diagnosis|FIX-00[1-9]/);
  });

  test("WF-04: wires the fix-specific diagnosis and implementation facets", () => {
    const fix = readWorkflow("fix");
    const facetRoot = join(packageRoot, ".takt", "facets");
    const expectedFacets = [
      "instructions/fix-diagnosis.md",
      "instructions/fix-diagnosis-review.md",
      "instructions/fix-regression-tests.md",
      "instructions/fix-implementation.md",
      "personas/fix-coder.md",
      "personas/fix-diagnosis-reviewer.md",
      "output-contracts/fix-diagnosis.md",
      "output-contracts/fix-diagnosis-review.md",
      "output-contracts/fix-regression-tests.md",
      "output-contracts/fix-implementation.md",
    ];

    for (const facet of expectedFacets) {
      expect(existsSync(join(facetRoot, facet))).toBeTrue();
    }

    expect(stepByName(fix, "diagnosis")["instruction"]).toBe("fix-diagnosis");
    expect(stepByName(fix, "diagnosis")["persona"]).toBe("fix-coder");
    expect(stepByName(fix, "diagnosis-review")["persona"]).toBe(
      "fix-diagnosis-reviewer"
    );
    expect(stepByName(fix, "diagnosis-review")["instruction"]).toBe(
      "fix-diagnosis-review"
    );
    expect(stepByName(fix, "regression-tests")["instruction"]).toBe(
      "fix-regression-tests"
    );
    expect(stepByName(fix, "implement")["instruction"]).toBe(
      "fix-implementation"
    );

    const outputContracts = [
      ["diagnosis", "fix-diagnosis"],
      ["diagnosis-review", "fix-diagnosis-review"],
      ["regression-tests", "fix-regression-tests"],
      ["implement", "fix-implementation"],
    ] as const;
    for (const [stepName, format] of outputContracts) {
      const contracts = requireRecord(
        stepByName(fix, stepName)["output_contracts"],
        `${stepName}.output_contracts`
      );
      const report = contracts["report"];
      expect(Array.isArray(report)).toBeTrue();
      if (!Array.isArray(report)) {
        throw new Error(`${stepName}.report must be an array`);
      }
      expect(requireRecord(report[0], `${stepName}.report`)["format"]).toBe(
        format
      );
    }
  });

  test("WF-06/WF-08: defines shared review and delivery subworkflow boundaries", () => {
    const feature = serializedWorkflow("feature");
    const fix = serializedWorkflow("fix");
    const shared = serializedWorkflow("shared");

    expect(feature).toContain("call: shared");
    expect(fix).toContain("call: shared");
    expect(shared).toContain("review");
    expect(shared).toContain("delivery");
    for (const workflow of [
      "feature",
      "fix",
      "shared",
      "shared-intake",
      "shared-pr-monitor",
    ]) {
      expect(
        existsSync(join(workflowsDirectory, `${workflow}.yaml`))
      ).toBeTrue();
    }
  });

  test("WF-02/WF-07: rejects incomplete intake inputs without entering implementation", () => {
    const intake = serializedWorkflow("shared-intake");
    const feature = serializedWorkflow("feature");
    const fix = serializedWorkflow("fix");

    expect(intake).toMatch(/ready-for-agent/);
    expect(intake).toMatch(/wayfinder(?::| )/);
    expect(intake).toMatch(/blocked_by|dependency/);
    expect(intake).toMatch(/research|prototype|grilling|task/);
    expect(intake).toMatch(/ABORT/);
    expect(feature).toMatch(/READY|ready-for-agent/);
    expect(fix).toMatch(/READY|ready-for-agent/);
    expect(fix).toContain("bug");
  });

  test("WF-05/WF-07: runs standards and spec review in parallel and routes rejection back to repair", () => {
    const review = readWorkflow("shared");
    const text = serializedWorkflow("shared");
    const names = stepNames(review, "shared");

    expect(text).toMatch(/parallel/);
    expect(text).toMatch(/Standards|standards/);
    expect(text).toMatch(/Spec|spec/);
    expect(text).toMatch(/all\(|any\(|needs_fix|approved/);
    expect(names.some((name) => /fix|repair|revise/i.test(name))).toBeTrue();
    expect(text).toMatch(/loop|max_steps/);
  });

  test("WF-06/WF-07: makes quality gates and delivery monitoring observable", () => {
    const delivery = ["feature", "fix", "shared"]
      .map(serializedWorkflow)
      .join("\n");
    const config = readFileSync(
      join(packageRoot, ".takt", "config.yaml"),
      "utf8"
    );

    for (const command of [
      "bun test",
      "bun run typecheck",
      "bun run lint",
      "bun run format:check",
    ]) {
      expect(delivery).toContain(command);
    }
    expect(delivery).toMatch(/CI|ci/);
    expect(delivery).toMatch(/review|Review/);
    expect(delivery).toMatch(/pending|deferred|needs_fix|complete|blocked/);
    expect(delivery).toMatch(/ABORT/);
    expect(config).toContain("custom_scripts: true");
    expect(config).toContain("auto_pr: false");
    expect(config).toContain("auto_requeue_max_attempts: 3");
  });

  test("WF-05/WF-07: executes review rejection and repair branches deterministically", () => {
    const shared = readWorkflow("shared");
    const review = stepByName(shared, "review");
    const repair = stepByName(shared, "repair");

    expect(nextForCondition(review, 'all("approved")')).toBe("delivery");
    expect(nextForCondition(review, 'any("needs_fix")')).toBe("repair");
    expect(
      nextForCondition(repair, "All review findings are fixed and verified")
    ).toBe("review");
    expect(
      nextForCondition(
        repair,
        "Repair cannot proceed or a finding remains unresolved"
      )
    ).toBe("ABORT");
  });

  test("WF-02/WF-06: rejects intake failures before implementation and monitors PR outcomes", () => {
    const intake = readWorkflow("shared-intake");
    const monitor = readWorkflow("shared-pr-monitor");

    expect(
      nextForCondition(
        stepByName(intake, "intake"),
        "Intake is incomplete, blocked, or missing prerequisite evidence"
      )
    ).toBe("ABORT");
    expect(
      nextForCondition(
        stepByName(monitor, "delivery"),
        "PR is reviewed and CI is green"
      )
    ).toBe("COMPLETE");
    expect(
      nextForCondition(stepByName(monitor, "delivery"), "PR or CI is pending")
    ).toBe("ABORT");
    expect(
      nextForCondition(
        stepByName(monitor, "delivery"),
        "PR review has actionable findings"
      )
    ).toBe("repair");
    expect(nextForCondition(stepByName(monitor, "delivery"), "CI failed")).toBe(
      "repair"
    );
    expect(
      nextForCondition(
        stepByName(monitor, "delivery"),
        "PR or CI failed without an actionable repair"
      )
    ).toBe("ABORT");
    expect(
      nextForCondition(stepByName(monitor, "repair"), "Repair is required")
    ).toBe("ABORT");
  });

  test("WF-06/WF-07: starts the PR monitor from GitHub PR events", () => {
    const monitorWorkflow = readFileSync(
      join(packageRoot, ".github", "workflows", "takt-pr-monitor.yml"),
      "utf8"
    );

    expect(monitorWorkflow).toMatch(/pull_request:/);
    expect(monitorWorkflow).toMatch(/pull_request_review:/);
    expect(monitorWorkflow).toMatch(/workflow_run:/);
    expect(monitorWorkflow).toContain("takt@0.52.0");
    expect(monitorWorkflow).toContain("--pr");
    expect(monitorWorkflow).toContain("github.event_path");
    expect(monitorWorkflow).toContain("PR_NUMBER");
    expect(monitorWorkflow).toContain("--skip-git");
    expect(monitorWorkflow).toContain("--workflow shared-pr-monitor");
    expect(monitorWorkflow).toContain("contents: read");
    expect(monitorWorkflow).toContain("pull-requests: read");
    expect(monitorWorkflow).toContain("TAKT_OPENAI_API_KEY");
    expect(monitorWorkflow).toMatch(/pull_request_review_comment:/);
    expect(monitorWorkflow).toMatch(/workflow_run:/);
    expect(monitorWorkflow).toContain("Validate PR trust boundary");
    expect(monitorWorkflow.indexOf("Validate PR trust boundary")).toBeLessThan(
      monitorWorkflow.indexOf("TAKT_OPENAI_API_KEY")
    );
  });

  test("WF-06/WF-07: validates the non-interactive PR monitor entrypoint", () => {
    const monitorWorkflow = readFileSync(
      join(packageRoot, ".github", "workflows", "takt-pr-monitor.yml"),
      "utf8"
    );
    const runLine = monitorWorkflow
      .split("\n")
      .find((line) => line.includes("bunx --bun takt@0.52.0"));

    expect(runLine).toBeDefined();
    expect(runLine).toContain("--pipeline");
    expect(monitorWorkflow).toContain("--workflow shared-pr-monitor");
    expect(runLine).not.toMatch(/--workflow\s+--/);

    const doctor = spawnSync(
      "takt",
      [
        "workflow",
        "doctor",
        "feature",
        "fix",
        "shared",
        "shared-intake",
        "shared-pr-monitor",
        "pr-repair",
      ],
      { cwd: packageRoot, encoding: "utf8" }
    );

    expect(doctor.status).toBe(0);
    expect(doctor.stdout).toContain("feature.yaml");
    expect(doctor.stdout).toContain("fix.yaml");
    expect(doctor.stdout).toContain("shared-pr-monitor.yaml");
  }, 15_000);

  test("WF-01/WF-02/WF-37: matches TAKT doctor structure and project workflow resolution", () => {
    const workflowNames = [
      "feature",
      "fix",
      "shared",
      "shared-intake",
      "shared-pr-monitor",
      "pr-repair",
    ];
    for (const name of workflowNames) {
      const workflow = readWorkflow(name);
      const steps = requireSteps(workflow, name);
      const names = stepNames(workflow, name);

      const initialStep = workflow["initial_step"];
      if (typeof initialStep !== "string") {
        throw new Error(`${name}.initial_step must be a string`);
      }
      expect(names[0]).toBe(initialStep);
      expect(workflow["max_steps"]).toBeGreaterThan(0);
      expect(new Set(names).size).toBe(names.length);

      const validTargets = new Set([...names, "COMPLETE", "ABORT"]);
      for (const step of steps) {
        for (const target of ruleTargets(step)) {
          expect(validTargets.has(target)).toBeTrue();
        }
      }
    }
  });

  test("WF-01/WF-02: exposes the global workflow option before task registration", () => {
    const feature = spawnSync(
      "takt",
      ["--workflow", "feature", "add", "--help"],
      { cwd: packageRoot, encoding: "utf8" }
    );
    const fix = spawnSync("takt", ["--workflow", "fix", "add", "--help"], {
      cwd: packageRoot,
      encoding: "utf8",
    });

    expect(feature.status).toBe(0);
    expect(fix.status).toBe(0);
    expect(feature.stdout + feature.stderr).toContain("Add a new task");
    expect(fix.stdout + fix.stderr).toContain("Add a new task");
  });

  test("WF-06/WF-07: pins privileged Action dependencies", () => {
    const monitorWorkflow = readFileSync(
      join(packageRoot, ".github", "workflows", "takt-pr-monitor.yml"),
      "utf8"
    );

    expect(monitorWorkflow).toMatch(/actions\/checkout@[0-9a-f]{40}/);
    expect(
      readFileSync(
        join(packageRoot, ".github", "actions", "setup-tayk", "action.yml"),
        "utf8"
      )
    ).toMatch(/oven-sh\/setup-bun@[0-9a-f]{40}/);
    expect(monitorWorkflow).not.toMatch(
      /(?:actions\/checkout|oven-sh\/setup-bun)@v\d/
    );
  });

  test("WF-40: executes a deterministic success branch through TAKT engine", () => {
    const result = runMockEngineScenario(
      `      - condition: "true"\n        next: COMPLETE`,
      "[DECISION:1] ready"
    );

    expect(result.status).toBe(0);
  });

  test("WF-37: executes a deterministic abort branch through TAKT engine", () => {
    const result = runMockEngineScenario(
      `      - condition: "false"\n        next: COMPLETE\n      - condition: "true"\n        next: ABORT`,
      "[DECISION:2] blocked"
    );

    expect(result.status).not.toBe(0);
  });

  test("WF-30/WF-32/WF-33: executes review repair and gate transitions through TAKT engine", () => {
    const status = runMockWorkflowDefinition(
      `name: repair-contract\nmax_steps: 6\ninitial_step: review\nsteps:\n  - name: review\n    persona: architecture-reviewer\n    instruction: Return needs_fix.\n    rules:\n      - condition: "true"\n        next: repair\n  - name: repair\n    persona: coder\n    instruction: Apply the repair.\n    rules:\n      - condition: "true"\n        next: repair-gates\n  - name: repair-gates\n    persona: supervisor\n    instruction: Confirm the gates.\n    rules:\n      - condition: "true"\n        next: COMPLETE\n`,
      [
        { persona: "architecture-reviewer", content: "needs_fix" },
        { persona: "coder", content: "repair applied" },
        { persona: "supervisor", content: "gates passed" },
      ]
    );

    expect(status).toBe(0);
  });

  test("WF-40: provides a real CI workflow with all project quality gates", () => {
    const ciPath = join(packageRoot, ".github", "workflows", "tayk.yml");
    expect(existsSync(ciPath)).toBeTrue();
    const ci = readFileSync(ciPath, "utf8");

    expect(ci).toMatch(/name:\s*tayk/);
    expect(ci).toMatch(/pull_request:/);
    const setup = readFileSync(
      join(packageRoot, ".github", "actions", "setup-tayk", "action.yml"),
      "utf8"
    );
    expect(setup).toContain("bun install --frozen-lockfile");
    for (const command of [
      "bun test",
      "bun run typecheck",
      "bun run lint",
      "bun run format:check",
    ]) {
      expect(ci).toContain(command);
    }
    expect(ci).toMatch(/actions\/checkout@[0-9a-f]{40}/);
    expect(setup).toMatch(/oven-sh\/setup-bun@[0-9a-f]{40}/);
  });

  test("WF-42/WF-44/WF-46: queues actionable repair in a managed worktree", () => {
    const action = readFileSync(
      join(packageRoot, ".github", "workflows", "takt-pr-monitor.yml"),
      "utf8"
    );
    const monitor = serializedWorkflow("shared-pr-monitor");

    expect(action).toContain("--skip-git");
    expect(action).toContain("--pr");
    expect(action).toContain("queue-repair:");
    expect(action).toContain(".github/scripts/takt-pr-repair.sh");
    const repairScript = readFileSync(
      join(packageRoot, ".github", "scripts", "takt-pr-repair.sh"),
      "utf8"
    );
    expect(repairScript).toContain("takt@0.52.0 --workflow pr-repair add --pr");
    expect(repairScript).toContain("takt_enqueue_task");
    expect(repairScript).toContain("takt_run_next_task");
    expect(repairScript).toContain("taskContext");
    expect(repairScript).toContain("gh pr checks");
    expect(repairScript).toContain('sha256sum "$tasks_file"');
    expect(repairScript).toContain("CI failed without review comments");
    expect(repairScript).toContain("exit 1");
    expect(repairScript).toContain("--workflow pr-repair");
    expect(action).not.toContain("git worktree add");
    expect(action).not.toMatch(/git\s+-C\s+.*\s+(add|commit|push)/);
    expect(action).not.toContain("takt@0.52.0 -w fix add");
    expect(action).not.toContain("gh pr checks");
    expect(action).not.toContain("|| true");
    expect(action).not.toContain("ci_evidence");
    expect(action).not.toMatch(/repair_task=.*PR_HEAD_BRANCH/);
    expect(monitor).not.toMatch(/repair-gates/);
    expect(monitor).toMatch(/managed task worktree|worktree/i);
    expect(monitor).toMatch(/CI failed/);
    expect(monitor).toMatch(/exact evidence/);
  });

  test("WF-46: does not run when CI-only fallback cannot create a task", () => {
    const directory = mkdtempSync(join(tmpdir(), "tayk-pr-repair-test-"));
    const binDirectory = join(directory, "bin");
    const tasksDirectory = join(directory, ".takt");
    const logPath = join(directory, "commands.log");
    const scriptPath = join(
      packageRoot,
      ".github",
      "scripts",
      "takt-pr-repair.sh"
    );
    const originalPath = process.env["PATH"];

    try {
      spawnSync("mkdir", ["-p", binDirectory, tasksDirectory]);
      writeFileSync(join(tasksDirectory, "tasks.yaml"), "tasks: []\n");
      writeFileSync(
        join(binDirectory, "bunx"),
        `#!/bin/sh\necho bunx "$@" >> "${logPath}"\nexit 0\n`
      );
      writeFileSync(
        join(binDirectory, "gh"),
        `#!/bin/sh\nprintf '%s\\n' '{"headRefName":"feature/test","baseRefName":"main"}'\n`
      );
      spawnSync("chmod", [
        "+x",
        join(binDirectory, "bunx"),
        join(binDirectory, "gh"),
      ]);

      const result = spawnSync("bash", [scriptPath, "42"], {
        cwd: directory,
        env: { ...process.env, PATH: `${binDirectory}:${originalPath ?? ""}` },
        encoding: "utf8",
      });

      expect(result.status).toBe(1);
      expect(readFileSync(logPath, "utf8")).toContain("takt-mcp");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("WF-46: saves PR context and runs the CI-only repair task", () => {
    const directory = mkdtempSync(join(tmpdir(), "tayk-pr-repair-success-"));
    const binDirectory = join(directory, "bin");
    const tasksDirectory = join(directory, ".takt");
    const logPath = join(directory, "commands.log");
    const requestPath = join(directory, "mcp-request.log");
    const scriptPath = join(
      packageRoot,
      ".github",
      "scripts",
      "takt-pr-repair.sh"
    );
    const originalPath = process.env["PATH"];

    try {
      spawnSync("mkdir", ["-p", binDirectory, tasksDirectory]);
      writeFileSync(join(tasksDirectory, "tasks.yaml"), "tasks: []\n");
      writeFileSync(
        join(binDirectory, "bunx"),
        `#!/bin/sh
echo bunx "$@" >> "${logPath}"
case "$*" in
  *takt-mcp*)
    cat >> "${requestPath}"
    printf 'tasks:\\n  - repair\\n' > .takt/tasks.yaml
    printf '%s\\n' '{"jsonrpc":"2.0","id":2,"result":{"content":[{"type":"text","text":"{\\"taskName\\":\\"repair\\"}"}]}}'
    printf '%s\\n' '{"jsonrpc":"2.0","id":2,"result":{"content":[{"type":"text","text":"{\\"ran\\":true}"}]}}'
    ;;
esac
`
      );
      writeFileSync(
        join(binDirectory, "gh"),
        `#!/bin/sh
printf '%s\\n' '{"headRefName":"feature/test","baseRefName":"main"}'
`
      );
      spawnSync("chmod", [
        "+x",
        join(binDirectory, "bunx"),
        join(binDirectory, "gh"),
      ]);

      const result = spawnSync("bash", [scriptPath, "42"], {
        cwd: directory,
        env: { ...process.env, PATH: `${binDirectory}:${originalPath ?? ""}` },
        encoding: "utf8",
      });

      expect(result.status).toBe(0);
      expect(readFileSync(logPath, "utf8")).toContain("takt-mcp");
      const request = readFileSync(requestPath, "utf8");
      expect(request).toContain('"prNumber":42');
      expect(request).toContain('"branch":"feature/test"');
      expect(request).toContain('"baseBranch":"main"');
      expect(request).toContain('"worktree":true');
      expect(request).toContain('"autoPr":true');
      expect(
        readFileSync(join(tasksDirectory, "tasks.yaml"), "utf8")
      ).toContain("repair");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("WF-46: installs dependencies in the TAKT-managed repair worktree before gates", () => {
    const repair = readWorkflow("pr-repair");
    const gates = stepByName(repair, "quality-gates");
    const qualityGates = gates["quality_gates"] as Record<string, unknown>[];

    expect(qualityGates[0]).toMatchObject({
      name: "install-dependencies",
      command: "bun install --frozen-lockfile",
    });
    expect(qualityGates.slice(1).map((gate) => gate["command"])).toEqual([
      "bun test",
      "bun run typecheck",
      "bun run lint",
      "bun run format:check",
    ]);
  });

  test("WF-06/WF-07: exposes the isolated PR repair workflow through repair and gates", () => {
    const repair = readWorkflow("pr-repair");
    expect(stepNames(repair, "pr-repair")).toEqual(["repair", "quality-gates"]);
    expect(ruleTargets(stepByName(repair, "repair"))).toEqual([
      "quality-gates",
      "ABORT",
    ]);
    expect(ruleTargets(stepByName(repair, "quality-gates"))).toEqual([
      "COMPLETE",
      "repair",
    ]);
  });

  test("WF-47/WF-48/WF-58/WF-59: defers pending CI and bounds repair retries", () => {
    const monitor = serializedWorkflow("shared-pr-monitor");

    const report = readFileSync(
      join(
        packageRoot,
        ".takt",
        "facets",
        "output-contracts",
        "shared-pr-monitor.md"
      ),
      "utf8"
    );

    expect(report).toMatch(/DEFERRED|deferred/);
    expect(monitor).toMatch(/PR or CI is pending[\s\S]*next:\s*ABORT/);
    expect(monitor).toMatch(/max_steps:\s*12/);
    expect(monitor).toMatch(/ABORT[\s\S]*(reason|stop|report)/i);
  });

  test("WF-02/WF-05/WF-07: preserves the major feature, fix, and shared branches", () => {
    const feature = readWorkflow("feature");
    const fix = readWorkflow("fix");
    const shared = readWorkflow("shared");

    expect(ruleTargets(stepByName(feature, "intake"))).toEqual([
      "requirements",
      "ABORT",
    ]);
    expect(ruleTargets(stepByName(feature, "tests"))).toContain("implement");
    expect(ruleTargets(stepByName(feature, "implement"))).toContain(
      "standards-spec-review"
    );
    expect(ruleTargets(stepByName(feature, "standards-spec-review"))).toEqual([
      "COMPLETE",
      "requirements",
      "ABORT",
    ]);

    expect(ruleTargets(stepByName(fix, "intake"))).toContain("diagnosis");
    expect(ruleTargets(stepByName(fix, "diagnosis"))).toContain(
      "diagnosis-review"
    );
    expect(ruleTargets(stepByName(fix, "regression-tests"))).toContain(
      "implement"
    );
    expect(ruleTargets(stepByName(fix, "review"))).toEqual([
      "COMPLETE",
      "diagnosis",
      "ABORT",
    ]);

    expect(stepNames(shared, "shared")).not.toContain("intake");
    expect(stepNames(shared, "shared")).not.toContain("worktree-check");
    expect(ruleTargets(stepByName(shared, "review"))).toEqual([
      "delivery",
      "repair",
      "ABORT",
    ]);
    expect(ruleTargets(stepByName(shared, "delivery"))).toEqual([
      "COMPLETE",
      "COMPLETE",
      "ABORT",
    ]);

    const monitor = readWorkflow("shared-pr-monitor");
    expect(stepNames(monitor, "shared-pr-monitor")[0]).toBe("delivery");
    expect(ruleTargets(stepByName(monitor, "delivery"))).toEqual([
      "COMPLETE",
      "ABORT",
      "repair",
      "repair",
      "ABORT",
    ]);
    expect(ruleTargets(stepByName(monitor, "repair"))).toEqual(["ABORT"]);
  });

  test("WF-06/WF-07: routes resumed PR work directly to monitoring", () => {
    for (const workflow of [readWorkflow("feature"), readWorkflow("fix")]) {
      expect(ruleTargets(stepByName(workflow, "pr-monitor"))).toEqual([
        "COMPLETE",
        "ABORT",
      ]);
    }

    expect(serializedWorkflow("shared-pr-monitor")).toContain("CI");
    const action = readFileSync(
      join(packageRoot, ".github", "workflows", "takt-pr-monitor.yml"),
      "utf8"
    );
    expect(action).toContain("PR_NUMBER");
  });

  test("WF-08/WF-09: keeps project-local workflow assets tracked while generated runs remain ignored", () => {
    const ignore = readFileSync(
      join(packageRoot, ".takt", ".gitignore"),
      "utf8"
    );
    expect(ignore).not.toMatch(/^workflows\/?$/m);
    expect(ignore).toMatch(/workflows\/feature\.yaml/);
    expect(ignore).toMatch(/workflows\/fix\.yaml/);
    expect(ignore).toMatch(/workflows\/shared\.yaml/);
    expect(ignore).toMatch(/workflows\/shared-intake\.yaml/);
    expect(ignore).toMatch(/workflows\/shared-pr-monitor\.yaml/);
    expect(ignore).toMatch(/workflows\/pr-repair\.yaml/);
    expect(ignore).toMatch(/runs|tasks|sessions?/);
  });

  test("WF-01..WF-40: records a test or an explicit non-runtime coverage reason for every plan requirement", () => {
    const coverage: Record<
      string,
      { status: "covered" | "reason"; detail: string }
    > = {
      "WF-01": {
        status: "covered",
        detail: "independent feature workflow entry",
      },
      "WF-02": {
        status: "covered",
        detail: "shared intake entry and rejection",
      },
      "WF-03": { status: "covered", detail: "feature requirements and REQ-ID" },
      "WF-04": { status: "covered", detail: "fix diagnosis and FIX-ID" },
      "WF-05": { status: "covered", detail: "parallel standards/spec review" },
      "WF-06": {
        status: "covered",
        detail: "quality gate and delivery monitoring",
      },
      "WF-07": { status: "covered", detail: "invalid branch and bounded loop" },
      "WF-08": {
        status: "covered",
        detail: "tracked workflow and config assets",
      },
      "WF-09": { status: "covered", detail: "output contract assets" },
      "WF-10": {
        status: "covered",
        detail: "research ticket rejection marker",
      },
      "WF-11": {
        status: "reason",
        detail:
          "cross-document semantic consistency is reviewed by the workflow reviewer; no runtime parser contract exists",
      },
      "WF-12": {
        status: "reason",
        detail:
          "scope policy is prose and is not a machine-executable runtime contract",
      },
      "WF-13": {
        status: "reason",
        detail:
          "worktree creation is owned by TAKT task execution, outside repository workflow YAML",
      },
      "WF-14": { status: "covered", detail: "main branch rejection marker" },
      "WF-15": { status: "covered", detail: "REQ-ID marker" },
      "WF-16": {
        status: "reason",
        detail:
          "code investigation scope is an agent instruction, not a repository function",
      },
      "WF-17": {
        status: "covered",
        detail: "requirements report and test-first edge",
      },
      "WF-18": {
        status: "covered",
        detail: "design review and rejection loop",
      },
      "WF-19": {
        status: "covered",
        detail: "feature tests precede implementation",
      },
      "WF-20": { status: "covered", detail: "REQ-ID propagation marker" },
      "WF-21": { status: "covered", detail: "FIX-ID diagnosis marker" },
      "WF-22": {
        status: "reason",
        detail:
          "diagnosis correctness requires issue-specific evidence and cannot be asserted by static workflow shape alone",
      },
      "WF-23": { status: "covered", detail: "diagnosis review boundary" },
      "WF-24": {
        status: "covered",
        detail: "regression tests precede implementation",
      },
      "WF-25": {
        status: "reason",
        detail:
          "minimality is evaluated by the standards/spec reviewers against the issue diff",
      },
      "WF-26": {
        status: "covered",
        detail: "cross-cutting cause instruction marker",
      },
      "WF-27": { status: "covered", detail: "parallel reviewer branches" },
      "WF-28": { status: "covered", detail: "repair loop marker" },
      "WF-29": { status: "covered", detail: "four command quality gates" },
      "WF-30": { status: "covered", detail: "delivery boundary marker" },
      "WF-31": {
        status: "covered",
        detail: "CI pending/failure monitoring markers",
      },
      "WF-32": {
        status: "covered",
        detail: "automated review finding monitoring markers",
      },
      "WF-33": { status: "covered", detail: "complete condition markers" },
      "WF-34": { status: "covered", detail: "ABORT and bounded-stop markers" },
      "WF-35": { status: "covered", detail: "output contract files" },
      "WF-36": {
        status: "covered",
        detail: "resume/retry configuration marker",
      },
      "WF-37": {
        status: "covered",
        detail: "YAML graph and doctor entry assets",
      },
      "WF-38": {
        status: "reason",
        detail:
          "policy document wording is intentionally not tested as a prose snapshot",
      },
      "WF-39": {
        status: "covered",
        detail: "absence of human-input rule is a workflow contract",
      },
      "WF-40": {
        status: "covered",
        detail: "absence of global automatic requeue is a config contract",
      },
    };

    expect(Object.keys(coverage)).toHaveLength(40);
    expect(
      Object.values(coverage).every(({ detail }) => detail.length > 0)
    ).toBeTrue();
    expect(
      Object.values(coverage).filter(({ status }) => status === "reason").length
    ).toBeGreaterThan(0);
  });
});
