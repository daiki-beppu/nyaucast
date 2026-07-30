import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const packageRoot = resolve(import.meta.dirname, "../..");
const contractPath = ".takt/facets/output-contracts/tayk-architecture-audit.md";
const supervisorPath =
  ".takt/facets/instructions/tayk-architecture-audit-supervise.md";
const loopMonitorPath = ".takt/facets/instructions/tayk-loop-monitor-audit.md";
const workflowPath = ".takt/workflows/tayk-audit-architecture.yaml";

const requiredFindingFields = [
  { name: "Finding ID", pattern: /Finding ID/i },
  { name: "確信度", pattern: /確信度/ },
  { name: "対応時期", pattern: /対応時期/ },
  { name: "公開入口", pattern: /公開入口/ },
  { name: "依存方向", pattern: /依存方向/ },
  { name: "call chain", pattern: /call chain|呼び出しチェーン/i },
  { name: "現在保証", pattern: /現在.{0,5}保証/ },
  { name: "不足保証", pattern: /不足.{0,5}保証/ },
  { name: "分類", pattern: /分類/ },
  { name: "リスク", pattern: /リスク/ },
  { name: "受け入れ条件", pattern: /受け入れ条件|受入条件/ },
] as const;

interface ReportContract {
  format: string;
  name: string;
}

interface PackageManifest {
  scripts: Record<string, string>;
}

function readRepositoryFile(relativePath: string): string {
  return readFileSync(join(packageRoot, relativePath), "utf-8");
}

function readMarkdownSection(source: string, heading: string): string {
  const lines = source.split("\n");
  const start = lines.indexOf(heading);
  if (start === -1) {
    throw new Error(`missing Markdown section: ${heading}`);
  }

  const level = /^#+/.exec(heading)?.[0].length;
  if (level === undefined) {
    throw new Error(`section heading must start with #: ${heading}`);
  }

  const end = lines.findIndex((line, index) => {
    if (index <= start) {
      return false;
    }
    const candidateLevel = /^#+(?= )/.exec(line)?.[0].length;
    return candidateLevel !== undefined && candidateLevel <= level;
  });
  return lines.slice(start + 1, end === -1 ? undefined : end).join("\n");
}

function readDelimitedSection(
  source: string,
  startMarker: string,
  endMarker: string
): string {
  const start = source.indexOf(startMarker);
  if (start === -1) {
    throw new Error(`missing section marker: ${startMarker}`);
  }
  const end = source.indexOf(endMarker, start + startMarker.length);
  if (end === -1) {
    throw new Error(`missing section marker: ${endMarker}`);
  }
  return source.slice(start + startMarker.length, end);
}

function readIssueTemplate(findingsSection: string): string {
  const lines = findingsSection.split("\n");
  const start = lines.findIndex((line) => /^### +Issue\b/i.test(line));
  if (start === -1) {
    throw new Error("Findings must contain an Issue template");
  }
  const end = lines.findIndex(
    (line, index) => index > start && line.startsWith("### ")
  );
  return lines.slice(start, end === -1 ? undefined : end).join("\n");
}

function readFieldLabels(issueTemplate: string): string[] {
  return issueTemplate
    .split("\n")
    .map((line) => /^-\s+(?:\*\*)?([^:：]+)(?:\*\*)?[:：]/.exec(line)?.[1])
    .filter((label): label is string => label !== undefined)
    .map((label) => label.replaceAll(/[*_`]/g, "").trim());
}

function readFieldValue(issueTemplate: string, fieldName: string): string {
  const field = issueTemplate
    .split("\n")
    .map((line) => /^-\s+(?:\*\*)?([^:：]+)(?:\*\*)?[:：]\s*(.*)$/.exec(line))
    .find((match) => {
      const label = match?.[1]?.replaceAll(/[*_`]/g, "").trim();
      return label === fieldName;
    });
  if (field?.[2] === undefined) {
    throw new Error(`missing field value: ${fieldName}`);
  }
  return field[2].trim();
}

function expectRequiredFindingFields(source: string): void {
  const fieldLines = source
    .split("\n")
    .filter((line) => /^-\s+(?:\*\*)?[^:：]+(?:\*\*)?[:：]/.test(line));
  const labels = readFieldLabels(source);
  for (const field of requiredFindingFields) {
    expect(
      labels.some((label) => field.pattern.test(label)),
      `missing required field: ${field.name}`
    ).toBeTrue();
    const matchingLine = fieldLines.find((line) => field.pattern.test(line));
    expect(
      matchingLine,
      `missing required field line: ${field.name}`
    ).not.toMatch(/任意|optional/i);
  }
}

function expectRequiredFindingConcepts(source: string): void {
  for (const field of requiredFindingFields) {
    expect(
      field.pattern.test(source),
      `missing required concept: ${field.name}`
    ).toBeTrue();
  }
}

function expectUniqueFindingIdRequirement(source: string): void {
  expect(source).toMatch(/全 Finding ID.+空でなく/);
  expect(source).toMatch(/監査内で重複していない/);
}

function readMaintenanceRules(contract: string): string[] {
  const marker = "**表の維持ルール（最重要 — 違反したレポートは無効）:**";
  const start = contract.indexOf(marker);
  if (start === -1) {
    throw new Error(`missing section marker: ${marker}`);
  }
  return contract
    .slice(start + marker.length)
    .split("\n")
    .filter((line) => line.startsWith("- "));
}

function readWorkflowStep(workflow: string, stepName: string): string {
  const lines = workflow.split("\n");
  const start = lines.indexOf(`  - name: ${stepName}`);
  if (start === -1) {
    throw new Error(`workflow must declare the ${stepName} step`);
  }
  const end = lines.findIndex(
    (line, index) => index > start && line.startsWith("  - name: ")
  );
  return lines.slice(start, end === -1 ? undefined : end).join("\n");
}

function readReportContract(step: string): ReportContract {
  const match =
    /output_contracts:\n\s+report:\n\s+- name: (\S+)\n\s+format: (\S+)/.exec(
      step
    );
  if (match?.[1] === undefined || match[2] === undefined) {
    throw new Error("step must declare its report output contract");
  }
  return { format: match[2], name: match[1] };
}

function readPackageManifest(): PackageManifest {
  const manifest: unknown = JSON.parse(readRepositoryFile("package.json"));
  if (
    typeof manifest !== "object" ||
    manifest === null ||
    !("scripts" in manifest) ||
    typeof manifest.scripts !== "object" ||
    manifest.scripts === null
  ) {
    throw new TypeError("package.json must declare scripts");
  }
  return manifest as PackageManifest;
}

describe("architecture audit Issue-ready contract", () => {
  test("[REQ-120-01 / TC-120-01A] should allow only APPROVE and REJECT when declaring Result", () => {
    const contract = readRepositoryFile(contractPath);
    const result = /^## Result:\s*(.*)$/m.exec(contract)?.[1];
    if (result === undefined) {
      throw new Error("contract must declare a Result line");
    }

    expect(result.split("/").map((choice) => choice.trim())).toEqual([
      "APPROVE",
      "REJECT",
    ]);
  });

  test("[REQ-120-02 / TC-120-02A] should provide an Issue template and title field when declaring Findings", () => {
    const findings = readMarkdownSection(
      readRepositoryFile(contractPath),
      "## Findings"
    );
    const issueTemplate = readIssueTemplate(findings);

    expect(readFieldLabels(issueTemplate)).toContain("Issue タイトル");
  });

  test("[REQ-120-02 / TC-120-02B] should remove legacy Finding and title lists when using Issue sections", () => {
    const contract = readRepositoryFile(contractPath);
    const findings = readMarkdownSection(contract, "## Findings");

    expect(findings).not.toMatch(
      /^\|\s*#\s*\|\s*Severity\s*\|\s*Category\s*\|/m
    );
    expect(contract).not.toMatch(/^## Suggested Issue Titles\s*$/m);
  });

  test("[REQ-120-03 / TC-120-03A] should require every Issue field inside the Finding template", () => {
    const findings = readMarkdownSection(
      readRepositoryFile(contractPath),
      "## Findings"
    );

    expectRequiredFindingFields(readIssueTemplate(findings));
  });

  test("[REQ-120-03 / TC-120-03C] should keep confidence and timing unrestricted when declaring Finding values", () => {
    const findings = readMarkdownSection(
      readRepositoryFile(contractPath),
      "## Findings"
    );
    const issueTemplate = readIssueTemplate(findings);

    expect(readFieldValue(issueTemplate, "確信度")).toBe("{確信度}");
    expect(readFieldValue(issueTemplate, "対応時期")).toBe("{対応時期}");
  });

  test("[REQ-120-03 / TC-120-03B] should require every Issue field before supervisor approval", () => {
    const verification = readDelimitedSection(
      readRepositoryFile(supervisorPath),
      "**検証手順:**",
      "**structured output の記入:**"
    );

    expectRequiredFindingConcepts(verification);
    expect(verification).toMatch(/全(?:て| )?の? Finding|全 Finding/);
    expect(verification).toMatch(/approve|承認/i);
  });

  test("[REQ-120-04 / TC-120-04A] should preserve one Issue and title per Finding without consolidation", () => {
    const rules = readMaintenanceRules(readRepositoryFile(contractPath));

    expect(
      rules.some((rule) =>
        /1 Finding\s*=\s*1 Issue セクション\s*=\s*1 Issue タイトル/.test(rule)
      )
    ).toBeTrue();
    expect(
      rules.some((rule) =>
        /複数 Finding.+(?:統合|まとめ).*(?:禁止|しない)/.test(rule)
      )
    ).toBeTrue();
  });

  test("[REQ-120-04 / TC-120-04B] should reject consolidated Findings before supervisor approval", () => {
    const verification = readDelimitedSection(
      readRepositoryFile(supervisorPath),
      "**検証手順:**",
      "**structured output の記入:**"
    );

    expect(verification).toMatch(
      /1 Finding\s*=\s*1 Issue セクション\s*=\s*1 Issue タイトル/
    );
    expect(verification).toMatch(
      /複数 Finding.+(?:統合|まとめ).*(?:禁止|しない)/
    );
    expect(verification).toMatch(/approve|承認/i);
  });

  test("[REQ-120-04 / TC-120-04C] should reject empty or duplicate Finding IDs before supervisor approval", () => {
    const verification = readDelimitedSection(
      readRepositoryFile(supervisorPath),
      "**検証手順:**",
      "**structured output の記入:**"
    );

    expectUniqueFindingIdRequirement(verification);
    expect(verification).toMatch(/Finding ID が空または重複している.+rework/);
  });

  test("[REQ-120-05 / TC-120-05A] should keep Audit Scope one-to-one with Audit Targets", () => {
    const rules = readMaintenanceRules(readRepositoryFile(contractPath));

    expect(
      rules.some(
        (rule) =>
          /Audit Scope.+Audit Targets.+一対一/.test(rule) &&
          rule.includes("同じ #・同じ行数・同じ対象名") &&
          rule.includes("削除・統合・要約は禁止")
      )
    ).toBeTrue();
  });

  test("[REQ-120-05 / TC-120-05B] should retain pending Audit Scope rows as hourglass entries", () => {
    const rules = readMaintenanceRules(readRepositoryFile(contractPath));

    expect(rules.some((rule) => /未着手.+⏳.+行を残す/.test(rule))).toBeTrue();
  });

  test("[REQ-120-05 / TC-120-05C] should prevent audited rows from returning to pending", () => {
    const rules = readMaintenanceRules(readRepositoryFile(contractPath));

    expect(rules.some((rule) => /✅.+⏳.+戻さない/.test(rule))).toBeTrue();
  });

  test("[REQ-120-05 / TC-120-05D] should retain accumulated audit content when Result is REJECT", () => {
    const rules = readMaintenanceRules(readRepositoryFile(contractPath));

    expect(
      rules.some(
        (rule) =>
          rule.includes("Result が REJECT") &&
          /Audit Scope.+既存の Findings.+Modules with No Blocking Issues/.test(
            rule
          ) &&
          rule.includes("全行維持") &&
          /ブロッキング指摘を.+追加/.test(rule)
      )
    ).toBeTrue();
  });

  test("[REQ-120-06 / TC-120-06A] should require complete Issue-ready Findings when loop monitor publishes", () => {
    const instruction = readRepositoryFile(loopMonitorPath);
    const completedBranch = readDelimitedSection(
      instruction,
      "- 全対象が ✅",
      "\n- ✅ の行数"
    );

    expect(completedBranch).toMatch(/全(?:て| )?の? Finding|全 Finding/);
    expect(completedBranch).toMatch(/独立.+Issue セクション/);
    expect(completedBranch).toMatch(/Issue タイトル/);
    expect(completedBranch).toMatch(
      /複数 Finding.+(?:統合|まとめ).*(?:禁止|しない)/
    );
    expectRequiredFindingConcepts(completedBranch);
    expect(completedBranch).toMatch(/publish へ進めてよい/);
  });

  test("[REQ-120-06 / TC-120-06B] should reject empty or duplicate Finding IDs when loop monitor publishes", () => {
    const completedBranch = readDelimitedSection(
      readRepositoryFile(loopMonitorPath),
      "- 全対象が ✅",
      "\n- ✅ の行数"
    );

    expectUniqueFindingIdRequirement(completedBranch);
    expect(completedBranch).toMatch(/満たす場合だけ.+publish へ進めてよい/);
  });

  test("[REQ-120-07 / TC-120-07A] should wire audit and review to the architecture audit report contract", () => {
    const workflow = readRepositoryFile(workflowPath);
    const expected = {
      format: "tayk-architecture-audit",
      name: "02-architecture-audit.md",
    };

    expect(readReportContract(readWorkflowStep(workflow, "audit"))).toEqual(
      expected
    );
    expect(readReportContract(readWorkflowStep(workflow, "review"))).toEqual(
      expected
    );
  });

  test("[REQ-120-07 / TC-120-07B] should wire the loop monitor judge to its audit instruction", () => {
    const workflow = readRepositoryFile(workflowPath);
    const loopMonitors = workflow.slice(
      workflow.indexOf("loop_monitors:"),
      workflow.indexOf("\nsteps:")
    );

    expect(loopMonitors).toMatch(
      /judge:\n\s+persona: supervisor\n\s+instruction: tayk-loop-monitor-audit/
    );
  });

  test("[REQ-120-07 / TC-120-07C] should reach Bun tests from the check script", () => {
    const { scripts } = readPackageManifest();

    expect(
      scripts["check"]?.split("&&").map((command) => command.trim())
    ).toContain("bun run test");
    expect(scripts["test"]).toBe("bun test");
  });

  test("[REQ-120-07 / TC-120-07D] should publish only after the wired supervisor approves", () => {
    const supervise = readWorkflowStep(
      readRepositoryFile(workflowPath),
      "supervise"
    );

    expect(supervise).toMatch(
      /^\s+instruction: tayk-architecture-audit-supervise$/m
    );
    expect(supervise).toMatch(
      /condition: when\(structured\.supervise\.verdict == "approve"\)\n\s+next: publish/
    );
  });
});
