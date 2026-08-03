import { describe, expect, test } from "bun:test";

import { parseYamlRecord, readRepositoryFile } from "../helpers";

const workflowPath = ".takt/workflows/tayk-fix.yaml";

interface WorkflowRule {
  condition?: string;
  next?: string;
}

interface ReportContract {
  format?: string;
  name?: string;
}

interface WorkflowStep {
  kind?: string;
  name?: string;
  output_contracts?: {
    report?: ReportContract[];
  };
  parallel?: WorkflowStep[];
  policy?: string[];
  rules?: WorkflowRule[];
}

interface LoopMonitor {
  cycle?: string[];
  judge?: {
    rules?: WorkflowRule[];
  };
  threshold?: number;
}

interface WorkflowDefinition {
  loop_monitors?: LoopMonitor[];
  steps?: WorkflowStep[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseWorkflow(): WorkflowDefinition {
  return parseYamlRecord(
    readRepositoryFile(workflowPath),
    workflowPath,
    "a workflow object"
  );
}

function requireSteps(workflow: WorkflowDefinition): WorkflowStep[] {
  if (!Array.isArray(workflow.steps)) {
    throw new TypeError(`${workflowPath} must declare steps`);
  }
  return workflow.steps;
}

function requireStep(workflow: WorkflowDefinition, name: string): WorkflowStep {
  const step = requireSteps(workflow).find(
    (candidate) => candidate.name === name
  );
  if (step === undefined) {
    throw new Error(`${workflowPath} must declare the ${name} step`);
  }
  return step;
}

function requireRules(step: WorkflowStep): WorkflowRule[] {
  if (!Array.isArray(step.rules)) {
    throw new TypeError(`step ${step.name ?? "<unnamed>"} must declare rules`);
  }
  return step.rules;
}

function requireRule(
  workflow: WorkflowDefinition,
  stepName: string,
  condition: RegExp
): WorkflowRule {
  const rule = requireRules(requireStep(workflow, stepName)).find(
    (candidate) =>
      typeof candidate.condition === "string" &&
      condition.test(candidate.condition)
  );
  if (rule === undefined) {
    throw new Error(`${stepName} lacks rule matching ${condition.source}`);
  }
  return rule;
}

function requireIterationLimit(step: WorkflowStep): {
  rule: WorkflowRule;
  threshold: number;
} {
  const rule = requireRules(step).find(
    (candidate) =>
      candidate.next === "ABORT" &&
      typeof candidate.condition === "string" &&
      /\d+ 回目以降/.test(candidate.condition)
  );
  if (rule?.condition === undefined) {
    throw new Error(
      `${step.name ?? "<unnamed>"} lacks an iteration ABORT rule`
    );
  }
  const match = /(\d+) 回目以降/.exec(rule.condition);
  if (match?.[1] === undefined) {
    throw new Error(
      `${step.name ?? "<unnamed>"} has an invalid iteration rule`
    );
  }
  return { rule, threshold: Number(match[1]) };
}

function requireLoopMonitors(workflow: WorkflowDefinition): LoopMonitor[] {
  if (!Array.isArray(workflow.loop_monitors)) {
    throw new TypeError(`${workflowPath} must declare loop monitors`);
  }
  return workflow.loop_monitors;
}

function expectRoute(
  workflow: WorkflowDefinition,
  stepName: string,
  condition: RegExp,
  next: string
): void {
  expect(requireRule(workflow, stepName, condition).next).toBe(next);
}

describe("tayk-fix diagnosis re-entry contract", () => {
  // REQ-201-01, REQ-201-02, REQ-201-03 / TC-01 / P-1
  test("diagnosis review aborts on its fourth cumulative visit after the loop monitor gets three continuous cycles", () => {
    const workflow = parseWorkflow();
    const review = requireStep(workflow, "diagnose_review");
    const limit = requireIterationLimit(review);
    const reviewMonitor = requireLoopMonitors(workflow).find(
      (monitor) =>
        monitor.cycle?.[0] === "diagnose_review" &&
        monitor.cycle.at(-1) === "diagnose_fix"
    );

    expect(reviewMonitor?.threshold).toBe(3);
    expect(limit.threshold).toBe(4);
    expect(limit.rule.next).toBe("ABORT");
    expect(5).toBeGreaterThanOrEqual(limit.threshold);
  });

  // REQ-201-01, REQ-201-04 / TC-02 / P-2
  test("diagnosis review keeps the unclassified retry fallback after its cumulative limit", () => {
    const workflow = parseWorkflow();
    const review = requireStep(workflow, "diagnose_review");
    const rules = requireRules(review);
    const limitIndex = rules.indexOf(requireIterationLimit(review).rule);
    const fallback = requireRule(workflow, "diagnose_review", /^when\(true\)$/);

    expect(fallback.next).toBe("diagnose");
    expect(limitIndex).toBeLessThan(rules.indexOf(fallback));
  });

  // REQ-201-01 / TC-03 / P-3
  test("every parallel diagnosis reviewer receives the cumulative visit limit", () => {
    const review = requireStep(parseWorkflow(), "diagnose_review");
    const reviewers = review.parallel;
    if (!Array.isArray(reviewers)) {
      throw new TypeError("diagnose_review must declare parallel reviewers");
    }

    expect(reviewers.length).toBeGreaterThan(0);
    expect(
      reviewers.every(
        (reviewer) =>
          reviewer.policy?.includes("tayk-diagnosis-review-limit") === true
      )
    ).toBe(true);
  });

  // REQ-199-01, REQ-199-03 / TC-01 / P-1
  test("cause re-exploration and report correction use structurally distinct entries", () => {
    const workflow = parseWorkflow();
    requireStep(workflow, "rediagnose");

    const causeRoutes = [
      ["diagnose_review", /NEED_REDIAGNOSE/],
      ["diagnose_fix", /原因の特定そのものを否定/],
      ["reproduce", /再現テストが green/],
      ["reproduce", /予測と違う/],
      ["reproduce", /既存挙動の回帰テストが修正前から red/],
      ["repair", /対症療法/],
      ["repair", /ADR と衝突/],
      ["repair", /red のまま/],
    ] as const;
    const classifiedRules = new Set<WorkflowRule>();
    for (const [stepName, condition] of causeRoutes) {
      const rule = requireRule(workflow, stepName, condition);
      classifiedRules.add(rule);
      expect(rule.next).toBe("rediagnose");
    }

    const correctionRoutes = [
      ["diagnose_fix", /4 回目以降/],
      ["fix", /情報不足/],
      ["final_gate", /^need_replan$/],
      ["spillover", /因果ありと判定した発見/],
      ["diagnose_review", /^when\(true\)$/],
      ["impl_review", /provisional\.fixpoint/],
      ["impl_review", /budgetExhausted.*provisional/],
      ["impl_review", /^when\(findings\.provisional\.count > 0/],
    ] as const;
    for (const [stepName, condition] of correctionRoutes) {
      const rule = requireRule(workflow, stepName, condition);
      classifiedRules.add(rule);
      expect(rule.next).toBe("diagnose");
    }
    const testDesignCorrection = requireRule(workflow, "reproduce", /環境依存/);
    expect(testDesignCorrection.next).toBe("diagnose_fix");

    const directDiagnosisReentries = requireSteps(workflow).flatMap((step) =>
      ["intake", "rediagnose"].includes(step.name ?? "")
        ? []
        : requireRules(step).filter((rule) =>
            ["diagnose", "rediagnose"].includes(rule.next ?? "")
          )
    );
    expect(directDiagnosisReentries.length).toBe(classifiedRules.size);
    expect(
      directDiagnosisReentries.every((rule) => classifiedRules.has(rule))
    ).toBe(true);
  });

  // REQ-199-02, REQ-199-04 / TC-02 / P-2, P-3
  test("a fourth diagnosis visit with one cause re-exploration does not exhaust that budget", () => {
    const workflow = parseWorkflow();
    const overallLimit = requireIterationLimit(
      requireStep(workflow, "diagnose")
    ).threshold;
    const diagnosisVisitsBeforeReexploration = 4;

    expect(diagnosisVisitsBeforeReexploration).toBeLessThan(overallLimit);
    expectRoute(workflow, "reproduce", /再現テストが green/, "rediagnose");
    expect(
      requireIterationLimit(requireStep(workflow, "rediagnose")).threshold
    ).toBe(4);
  });

  // REQ-199-01, REQ-199-02, REQ-199-05 / TC-02 / P-2, P-3
  test("provisional and unclassified review retries consume only the overall diagnosis budget", () => {
    const workflow = parseWorkflow();
    const retryRoutes = [
      ["diagnose_review", /^when\(true\)$/],
      ["impl_review", /provisional\.fixpoint/],
      ["impl_review", /budgetExhausted.*provisional/],
      ["impl_review", /^when\(findings\.provisional\.count > 0/],
    ] as const;

    for (const [stepName, condition] of retryRoutes) {
      expectRoute(workflow, stepName, condition, "diagnose");
    }
    expect(
      requireIterationLimit(requireStep(workflow, "rediagnose")).threshold
    ).toBe(4);
    expect(
      requireIterationLimit(requireStep(workflow, "diagnose")).threshold
    ).toBe(11);
  });

  // REQ-199-01, REQ-199-05 / TC-03 / P-4
  test("cause re-exploration continues three times and aborts on its fourth visit", () => {
    const workflow = parseWorkflow();
    const rediagnose = requireStep(workflow, "rediagnose");
    const limit = requireIterationLimit(rediagnose);

    expect(limit.threshold).toBe(4);
    expect(limit.rule.next).toBe("ABORT");
    expect(
      requireRules(rediagnose).some((rule) => rule.next === "diagnose")
    ).toBe(true);
  });

  // REQ-199-05 / TC-04 / P-5
  test("non-reexploration diagnosis visits continue ten times and abort on visit eleven", () => {
    const workflow = parseWorkflow();
    const limit = requireIterationLimit(requireStep(workflow, "diagnose"));

    expect(limit.threshold).toBe(11);
    expect(limit.rule.next).toBe("ABORT");
    expect(10).toBeLessThan(limit.threshold);
    expect(11).toBeGreaterThanOrEqual(limit.threshold);
  });

  // REQ-199-05 / TC-05 / P-4, P-5
  test("loop-monitor replans consume the cause budget and retain finite abort exits", () => {
    const monitors = requireLoopMonitors(parseWorkflow());
    const causeReplans = monitors.flatMap((monitor) =>
      (monitor.judge?.rules ?? []).filter((rule) =>
        ["diagnose", "rediagnose"].includes(rule.next ?? "")
      )
    );

    expect(causeReplans.length).toBeGreaterThan(0);
    expect(causeReplans.every((rule) => rule.next === "rediagnose")).toBe(true);
    expect(
      monitors.every(
        (monitor) =>
          monitor.judge?.rules?.some((rule) => rule.next === "ABORT") ?? false
      )
    ).toBe(true);

    const implementationReplan = monitors.find(
      (monitor) =>
        monitor.cycle?.[0] === "diagnose" &&
        monitor.cycle.at(-1) === "impl_review"
    );
    expect(implementationReplan?.cycle?.[0]).toBe("diagnose");

    const diagnosisReexploration = monitors.find(
      (monitor) => monitor.cycle?.at(-1) === "diagnose_review"
    );
    expect(diagnosisReexploration?.cycle).toEqual([
      "rediagnose",
      "diagnose",
      "diagnose_review",
    ]);
  });

  // REQ-199-01, REQ-199-05 / TC-07 / P-4
  test("an iteration budget still permits three attempts and stops the fourth", () => {
    const workflow = parseWorkflow();
    const limitedSteps = requireSteps(workflow).filter((step) =>
      requireRules(step).some(
        (rule) =>
          rule.next === "ABORT" &&
          typeof rule.condition === "string" &&
          rule.condition.includes("4 回目以降")
      )
    );

    expect(limitedSteps.length).toBeGreaterThan(0);
    for (const step of limitedSteps) {
      expect(requireIterationLimit(step).threshold).toBe(4);
    }
  });

  // REQ-199-03 / TC-09 / P-1
  test("state-dependent rules retain deterministic when() conditions", () => {
    const workflow = parseWorkflow();
    const allRules = [
      ...requireSteps(workflow).flatMap((step) => requireRules(step)),
      ...requireLoopMonitors(workflow).flatMap(
        (monitor) => monitor.judge?.rules ?? []
      ),
    ];
    const stateRules = allRules.filter(
      (rule) =>
        typeof rule.condition === "string" &&
        /(?:structured|context|effect|findings)\./.test(rule.condition)
    );

    expect(stateRules.length).toBeGreaterThan(0);
    expect(
      stateRules.every(
        (rule) =>
          typeof rule.condition === "string" &&
          /when\(.+\)/.test(rule.condition)
      )
    ).toBe(true);
  });

  // REQ-199-03, REQ-199-07 / TC-10, TC-11 / P-1, P-2, P-3, P-4, P-5
  test("diagnosis, parallel review, and spillover keep their parent report namespaces", () => {
    const workflow = parseWorkflow();
    const diagnosis = requireStep(workflow, "diagnose");
    const review = requireStep(workflow, "diagnose_review");
    const spillover = requireStep(workflow, "spillover");

    expect(diagnosis.kind).not.toBe("workflow_call");
    expect(diagnosis.output_contracts?.report).toEqual([
      { format: "tayk-diagnosis", name: "diagnosis.md" },
    ]);
    expect(review.kind).not.toBe("workflow_call");
    expect(
      review.parallel?.flatMap((step) => step.output_contracts?.report ?? [])
    ).toEqual([
      { format: "tayk-diagnosis-review", name: "diagnosis-review.md" },
      {
        format: "tayk-adr-conformance-review",
        name: "adr-conformance-diagnosis.md",
      },
      { format: "tayk-test-design-review", name: "regression-test-review.md" },
    ]);
    expect(spillover.kind).not.toBe("workflow_call");
    expect(spillover.output_contracts?.report).toEqual([
      { format: "tayk-spillover", name: "spillover.md" },
    ]);
  });
});
