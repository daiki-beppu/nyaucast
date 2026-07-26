import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const packageRoot = resolve(import.meta.dir, "..");
const workflowsDirectory = join(packageRoot, ".takt", "workflows");

type RecordValue = Record<string, unknown>;

function readWorkflow(name: string): RecordValue {
  const value: unknown = Bun.YAML.parse(
    readFileSync(join(workflowsDirectory, `${name}.yaml`), "utf8")
  );

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name}.yaml must contain an object`);
  }
  return value as RecordValue;
}

function stepsOf(workflow: RecordValue, name: string): RecordValue[] {
  const steps = workflow["steps"];
  if (!Array.isArray(steps)) {
    throw new Error(`${name}.steps must be an array`);
  }
  return steps.map((step, index) => {
    if (typeof step !== "object" || step === null || Array.isArray(step)) {
      throw new Error(`${name}.steps[${String(index)}] must be an object`);
    }
    return step as RecordValue;
  });
}

function stepOf(workflowName: string, stepName: string): RecordValue {
  const workflow = readWorkflow(workflowName);
  const step = stepsOf(workflow, workflowName).find(
    (candidate) => candidate["name"] === stepName
  );
  if (!step) {
    throw new Error(`${workflowName} is missing step ${stepName}`);
  }
  return step;
}

function workflowText(name: string): string {
  return readFileSync(join(workflowsDirectory, `${name}.yaml`), "utf8");
}

function actionText(): string {
  return readFileSync(
    join(packageRoot, ".github", "workflows", "takt-pr-monitor.yml"),
    "utf8"
  );
}

function actionJob(name: string): string {
  const action = actionText();
  const job = new RegExp(
    `\\n  ${name}:[\\s\\S]*?(?=\\n  [a-zA-Z][\\w-]*:|$)`
  ).exec(action);
  if (!job) {
    throw new Error(`missing action job ${name}`);
  }
  return job[0];
}

describe("planned TAKT workflow contracts", () => {
  test("WF-02: feature intake requires both feature labels", () => {
    const intake = workflowText("feature");

    expect(intake).toMatch(/enhancement/);
    expect(intake).toMatch(/ready-for-agent/);
    expect(intake).toMatch(/condition: READY issue[\s\S]*next: requirements/);
  });

  test("WF-02: shared intake requires map, child issue, and native dependency evidence", () => {
    const intake = workflowText("shared-intake");

    expect(intake).toMatch(/wayfinder:map/);
    expect(intake).toMatch(/Destination/);
    expect(intake).toMatch(/Notes/);
    expect(intake).toMatch(/Decisions so far/);
    expect(intake).toMatch(/sub-issue|child issue/i);
    expect(intake).toMatch(/blocked_by|blocking dependency/i);
    expect(intake).toMatch(/missing|contradictory|required/i);
  });

  test("WF-18/WF-23: feature design and fix diagnosis loops stop after three cycles", () => {
    const feature = readWorkflow("feature");
    const fix = readWorkflow("fix");

    for (const [name, workflow] of [
      ["feature", feature],
      ["fix", fix],
    ] as const) {
      const monitors = workflow["loop_monitors"];
      expect(Array.isArray(monitors), `${name} loop monitors`).toBeTrue();
      if (!Array.isArray(monitors)) {
        continue;
      }
      expect(
        monitors.some((monitor) => {
          if (typeof monitor !== "object" || monitor === null) {
            return false;
          }
          const record = monitor as RecordValue;
          return record["threshold"] === 3;
        })
      ).toBeTrue();
    }
  });

  test("WF-29: PR repair uses four executable command gates", () => {
    const gates = stepOf("pr-repair", "quality-gates")["quality_gates"];

    expect(Array.isArray(gates)).toBeTrue();
    if (!Array.isArray(gates)) {
      return;
    }
    const commands = gates.map((gate) => {
      if (typeof gate !== "object" || gate === null || Array.isArray(gate)) {
        throw new Error("quality gate must be an object");
      }
      const record = gate as RecordValue;
      expect(record["type"]).toBe("command");
      return record["command"];
    });
    expect(commands).toEqual([
      "bun install --frozen-lockfile",
      "bun test",
      "bun run typecheck",
      "bun run lint",
      "bun run format:check",
    ]);
  });

  test("WF-29/WF-58: a failed PR repair gate returns to repair and is bounded", () => {
    const repair = readWorkflow("pr-repair");
    const gates = stepOf("pr-repair", "quality-gates");
    const rules = gates["rules"];

    expect(repair["max_steps"]).toBe(12);
    expect(JSON.stringify(rules)).toMatch(/REPAIR_REQUIRED/);
    expect(JSON.stringify(rules)).toMatch(/repair/);
    expect(workflowText("pr-repair")).toMatch(/loop_monitors|threshold:\s*3/);
  });

  test("WF-42/WF-44: PR monitor is non-interactive and cannot edit the checkout", () => {
    const monitor = actionJob("monitor");
    const monitorLine = monitor
      .split("\n")
      .find((line) => line.includes("takt@0.52.0"));

    expect(monitorLine).toBeDefined();
    expect(monitorLine).toContain("--pipeline");
    expect(monitorLine).toContain("--skip-git");
    expect(monitorLine).toContain("--pr");
    expect(monitor).not.toContain("continue-on-error: true");
    expect(monitor).not.toMatch(/git\s+(add|commit|push)/);
  });

  test("WF-47/WF-48: monitor does not subscribe to check_run and records deferred resume evidence", () => {
    const action = actionText();
    const monitorWorkflow = workflowText("shared-pr-monitor");

    expect(action).not.toMatch(/^\s+check_run:/m);
    expect(action).toMatch(/workflow_run:/);
    expect(action).toMatch(/pull_request_review_comment:/);
    expect(
      readFileSync(
        join(
          packageRoot,
          ".takt",
          "facets",
          "output-contracts",
          "shared-pr-monitor.md"
        ),
        "utf8"
      )
    ).toMatch(/DEFERRED/);
    expect(monitorWorkflow).toMatch(/resume|再開|event/i);
    expect(monitorWorkflow).toMatch(/pr-monitor-summary\.md/);
  });

  test("WF-52/WF-53/WF-54: repair secrets are confined to trusted same-repository execution", () => {
    const action = actionText();
    const repair = actionJob("queue-repair");

    expect(action).toMatch(/head\.repo\.full_name/);
    expect(action).toMatch(/github\.repository/);
    expect(action).toMatch(/TAKT_OPENAI_API_KEY/);
    expect(action).toMatch(/GH_TOKEN/);
    expect(repair).toMatch(/contents:\s*write/);
    expect(repair).toMatch(/pull-requests:\s*read/);
    expect(repair).toMatch(/issues:\s*read/);
    expect(repair).toMatch(/checks:\s*read/);
    expect(repair).toMatch(/actions:\s*read/);
  });

  test("WF-57: CI and PR monitor share the pinned Bun bootstrap contract", () => {
    const packageJson = JSON.parse(
      readFileSync(join(packageRoot, "package.json"), "utf8")
    ) as RecordValue;

    expect(packageJson["packageManager"]).toBeDefined();
    if (typeof packageJson["packageManager"] !== "string") {
      return;
    }
    expect(packageJson["packageManager"]).toMatch(/^bun@\d+\.\d+\.\d+$/);
    expect(
      readFileSync(
        join(packageRoot, ".github", "actions", "setup-tayk", "action.yml"),
        "utf8"
      )
    ).toContain("bun install --frozen-lockfile");
  });

  test("WF-46: TAKT owns PR repair commits for the linked PR", () => {
    const action = actionText();
    const repairScript = readFileSync(
      join(packageRoot, ".github", "scripts", "takt-pr-repair.sh"),
      "utf8"
    );

    expect(action).toMatch(/PR_NUMBER/);
    expect(action).toContain(".github/scripts/takt-pr-repair.sh");
    expect(repairScript).toContain('add --pr "$pr_number"');
    expect(repairScript).toContain("CI failed without review comments");
    expect(repairScript).toMatch(
      /tasks_before[\s\S]*tasks_after[\s\S]*did not persist a repair task/
    );
    expect(repairScript).toContain("takt_enqueue_task");
    expect(repairScript).toContain("takt_run_next_task");
    expect(action).not.toMatch(/git\s+-C\s+.*\s+(add|commit|push)/);
    expect(workflowText("pr-repair")).toMatch(/PR|修正/i);
  });

  test("WF-08/WF-09: integration validation is tracked and generated runs stay ignored", () => {
    const validation = readFileSync(
      join(packageRoot, ".takt", "validation", "feature-fix-workflow.md"),
      "utf8"
    );
    const ignore = readFileSync(
      join(packageRoot, ".takt", ".gitignore"),
      "utf8"
    );

    expect(validation).toMatch(/integration|統合/i);
    expect(ignore).toMatch(/validation|scripts|runtime/i);
    expect(ignore).toMatch(/runs|tasks|sessions?/);
  });
});
