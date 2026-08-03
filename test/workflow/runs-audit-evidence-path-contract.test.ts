import { describe, expect, test } from "bun:test";

import { readRepositoryFile } from "../helpers";

const repositoryRunsPath = "/Users/mba/02-yt/tayk/.takt/runs";
const cloneMetaPath = "/Users/mba/02-yt/tayk/.takt/clone-meta/*.json";
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

function expectTwoEvidencePaths(section: EvidenceSection): void {
  expect(section.text, section.name).toContain(repositoryRunsPath);
  expect(section.text, section.name).toContain(cloneMetaPath);
  expect(section.text, section.name).toMatch(/clonePath[\s\S]*\.takt\/runs/);
}

function expectNoObsoleteCloneClaim(section: EvidenceSection): void {
  expect(section.text, section.name).not.toMatch(
    /隔離クローン(?:に|には)[^\n]*(?:runs|run)[^\n]*(?:無い|ない|存在しない)/i
  );
  expect(section.text, section.name).not.toMatch(
    /runs[^\n]*複製されず[^\n]*逆引き(?:も)?できない/i
  );
}

function expectMissingCloneContinuation(section: EvidenceSection): void {
  expect(section.text, section.name).toMatch(
    /(?:存在しない|削除済み|辿れない)[^\n]*clonePath[\s\S]{0,180}(?:ABORTしない|中断しない)/i
  );
  expect(section.text, section.name).toMatch(
    /本体[^\n]*(?:実在|存在する)[^\n]*clone[\s\S]{0,180}(?:監査|処理)[^\n]*継続/i
  );
}

function expectMissingCloneVisibility(section: EvidenceSection): void {
  expect(section.text, section.name).toMatch(
    /(?:静かに|黙って)[^\n]*無視しない/
  );
  expect(section.text, section.name).toMatch(
    /カバレッジ(?:の)?欠落[^\n]*(?:記録|列挙)/
  );
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
  // REQ-196-01 / TC-196-01 / P-196-01
  test("should enumerate repository and clone-meta run evidence without the obsolete clone claim", () => {
    for (const section of evidenceSections()) {
      expectTwoEvidencePaths(section);
      expectNoObsoleteCloneClaim(section);
    }
  });

  test("should resolve clone-meta from the repository root in every lifecycle contract", () => {
    for (const path of [
      paths.analyze,
      paths.issueTracker,
      paths.plan,
      paths.planContract,
      paths.review,
      paths.supervise,
      paths.workflow,
    ]) {
      const source = readRepositoryFile(path);

      expect(source, path).toContain(cloneMetaPath);
      expect(source.replaceAll(cloneMetaPath, ""), path).not.toContain(
        ".takt/clone-meta/*.json"
      );
    }
  });

  // REQ-196-02 / TC-196-02 / P-196-02
  test("should continue auditable run coverage when a clonePath is missing", () => {
    for (const section of evidenceSections()) {
      expectMissingCloneContinuation(section);
    }
  });

  // REQ-196-03 / TC-196-03 / P-196-02
  test("should record missing clonePath coverage instead of silently ignoring it", () => {
    for (const section of evidenceSections()) {
      expectMissingCloneVisibility(section);
    }
  });

  // REQ-196-04 / TC-196-04 / P-196-02, P-196-03
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

  // REQ-196-07 / TC-196-05A / P-196-03
  test("should ABORT only when repository runs are unreadable or empty", () => {
    const planEvidence = extractBetween(
      readRepositoryFile(paths.plan),
      /^\*\*証拠パス/m,
      /^\*\*定義監査の固定対象/m,
      "plan evidence path"
    );

    expect(planEvidence).toMatch(
      /読めない[\s\S]*run が 1 件も無い[\s\S]*ABORT/
    );
    expect(planEvidence).toMatch(/存在しない `clonePath` は ABORTしない/);
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
