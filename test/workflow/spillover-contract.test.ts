import { describe, expect, test } from "bun:test";

import { parseYamlRecord, readRepositoryFile } from "../helpers";

const expectedReportContract = {
  format: "tayk-spillover",
  name: "spillover.md",
} as const;
const workflowContracts = [
  {
    path: ".takt/workflows/tayk-feature.yaml",
    reentry: "plan",
  },
  {
    path: ".takt/workflows/tayk-fix.yaml",
    reentry: "diagnose",
  },
] as const;
const spilloverStepPath = ".takt/steps/tayk-spillover.yaml";

interface Rule {
  condition?: unknown;
  next?: unknown;
}

interface Step {
  name?: unknown;
  output_contracts?: {
    report?: unknown;
  };
  rules?: Rule[];
  uses?: unknown;
}

interface Workflow {
  steps?: Step[];
}

function parseRepositoryYaml(relativePath: string): Record<string, unknown> {
  return parseYamlRecord({
    expectedShape: "a workflow object",
    relativePath,
    source: readRepositoryFile(relativePath),
  });
}

function readSpilloverOutputFormat(): string {
  return readRepositoryFile(
    `.takt/facets/output-contracts/${expectedReportContract.format}.md`
  );
}

describe("feature/fix spillover report contract", () => {
  test("[REQ-119-01] should declare the report contract once in the shared spillover step", () => {
    const spillover = parseRepositoryYaml(spilloverStepPath) as Step;

    expect(spillover.output_contracts?.report).toEqual([
      expectedReportContract,
    ]);
  });

  test("[REQ-119-01] should reuse the shared spillover step and preserve causal re-entry", () => {
    for (const contract of workflowContracts) {
      const workflow = parseRepositoryYaml(contract.path) as Workflow;
      const spillover = workflow.steps?.find(
        (step) => step.name === "spillover"
      );

      expect(spillover?.uses).toBe("tayk-spillover");
      expect(
        spillover?.rules?.some(
          (rule) =>
            typeof rule.condition === "string" &&
            rule.condition.includes("因果あり") &&
            rule.next === contract.reentry
        )
      ).toBe(true);
    }
  });

  test("[REQ-119-02] should require collection sources even without findings", () => {
    const outputFormat = readSpilloverOutputFormat();

    expect(outputFormat).toContain("## 収集元");
    expect(outputFormat).toContain("「収集元」は発見ゼロでも省略しない");
    expect(outputFormat).toContain(
      "「収集元」表と「発見なし」の 1 行だけでよい"
    );
  });

  test("[REQ-119-03] should record issue creation failures for manual recovery", () => {
    const outputFormat = readSpilloverOutputFormat();

    expect(outputFormat).toContain("## 起票の失敗");
    expect(outputFormat).toContain("失敗内容");
    expect(outputFormat).toContain("手動で起票するためのコマンド");
  });

  test("[REQ-119-04] should record findings returned to the current scope", () => {
    const outputFormat = readSpilloverOutputFormat();

    expect(outputFormat).toContain("## スコープ内へ引き戻した発見");
    expect(outputFormat).toContain("因果の説明");
    expect(outputFormat).toContain("対応する要件 ID");
  });

  test("should keep takt external and doctor in the pre-push gate", () => {
    expect(readRepositoryFile("package.json")).not.toContain('"takt":');
    expect(readRepositoryFile("lefthook.yml")).toContain(
      "run: takt workflow doctor"
    );
  });
});
