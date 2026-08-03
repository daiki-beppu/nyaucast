import { describe, expect, test } from "bun:test";

import { readRepositoryFile } from "../helpers";

const expectedReportContract = {
  format: "tayk-spillover",
  name: "spillover.md",
} as const;
const workflowPaths = [
  ".takt/workflows/tayk-feature.yaml",
  ".takt/workflows/tayk-fix.yaml",
] as const;

interface ReportContract {
  format: string;
  name: string;
}

function readSpilloverStep(workflowPath: string): string {
  const lines = readRepositoryFile(workflowPath).split("\n");
  const start = lines.indexOf("  - name: spillover");

  if (start === -1) {
    throw new Error(`${workflowPath} must declare the spillover step`);
  }

  const nextStep = lines.findIndex(
    (line, index) => index > start && line.startsWith("  - name: ")
  );
  return lines.slice(start, nextStep === -1 ? undefined : nextStep).join("\n");
}

function readSpilloverReportContract(workflowPath: string): ReportContract {
  const contract =
    /^ {4}output_contracts:\n {6}report:\n {8}- name: (\S+)\n {10}format: (\S+)$/m.exec(
      readSpilloverStep(workflowPath)
    );

  if (contract?.[1] === undefined || contract[2] === undefined) {
    throw new Error(
      `${workflowPath} spillover must declare its report output contract`
    );
  }

  return { format: contract[2], name: contract[1] };
}

function readSpilloverOutputFormat(workflowPath: string): string {
  const contract = readSpilloverReportContract(workflowPath);
  return readRepositoryFile(
    `.takt/facets/output-contracts/${contract.format}.md`
  );
}

describe("feature/fix spillover report contract", () => {
  test("[REQ-119-01] should wire the spillover report contract into both workflows", () => {
    for (const workflowPath of workflowPaths) {
      expect(readSpilloverReportContract(workflowPath)).toEqual(
        expectedReportContract
      );
    }
  });

  test("[REQ-119-02] should require collection sources even without findings", () => {
    for (const workflowPath of workflowPaths) {
      const outputFormat = readSpilloverOutputFormat(workflowPath);

      expect(outputFormat).toContain("## 収集元");
      expect(outputFormat).toContain("「収集元」は発見ゼロでも省略しない");
      expect(outputFormat).toContain(
        "「収集元」表と「発見なし」の 1 行だけでよい"
      );
    }
  });

  test("[REQ-119-03] should record issue creation failures for manual recovery", () => {
    for (const workflowPath of workflowPaths) {
      const outputFormat = readSpilloverOutputFormat(workflowPath);

      expect(outputFormat).toContain("## 起票の失敗");
      expect(outputFormat).toContain("失敗内容");
      expect(outputFormat).toContain("手動で起票するためのコマンド");
    }
  });

  test("[REQ-119-04] should record findings returned to the current scope", () => {
    for (const workflowPath of workflowPaths) {
      const outputFormat = readSpilloverOutputFormat(workflowPath);

      expect(outputFormat).toContain("## スコープ内へ引き戻した発見");
      expect(outputFormat).toContain("因果の説明");
      expect(outputFormat).toContain("対応する要件 ID");
    }
  });

  test("[REQ-119-05] should keep both spillover report contracts identical", () => {
    const [featureWorkflowPath, fixWorkflowPath] = workflowPaths;

    expect(readSpilloverReportContract(featureWorkflowPath)).toEqual(
      readSpilloverReportContract(fixWorkflowPath)
    );
  });
});
