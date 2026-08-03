import { readFileSync } from "node:fs";
import path from "node:path";

type ReviewName = "spec" | "adr" | "antipattern" | "coding" | "testing";

interface ReviewCounts {
  blocking: number;
  nonBlocking: number;
  resolved: number;
}

export interface ReviewAggregate {
  reviewCounts: Record<ReviewName, ReviewCounts>;
  blockingCounts: Record<ReviewName, number>;
  specBreakdown: {
    unimplemented: number;
    unverified: number;
    previouslyUnresolved: number;
    indeterminate: boolean;
  };
  nonBlockingCount: number;
  resolvedCount: number;
}

export interface ValidatedReviewSynthesis {
  status: "complete";
  verdict: "APPROVE" | "REJECT";
  blocking_counts: Record<ReviewName, number>;
  spec_breakdown: {
    unimplemented: number;
    unverified: number;
    previously_unresolved: number;
    indeterminate: boolean;
  };
  non_blocking_count: number;
  resolved_count: number;
  decision_line: string;
  failure_reason: "";
}

const reportFiles: Record<ReviewName, string> = {
  adr: "adr-conformance-review.md",
  antipattern: "ai-antipattern-review.md",
  coding: "coding-review.md",
  spec: "spec-conformance-review.md",
  testing: "testing-review.md",
};
const reviewNames: ReviewName[] = [
  "adr",
  "antipattern",
  "coding",
  "spec",
  "testing",
];

const section = (markdown: string, heading: RegExp): string | undefined => {
  const lines = markdown.split(/\r?\n/u);
  const start = lines.findIndex((line) => heading.test(line));
  if (start === -1) {
    return undefined;
  }
  const end = lines.findIndex(
    (line, index) => index > start && /^##\s+/u.test(line)
  );
  return lines.slice(start + 1, end === -1 ? undefined : end).join("\n");
};

const splitRow = (line: string): string[] => {
  const cells: string[] = [];
  let current = "";
  let escaped = false;
  for (const character of line.trim().slice(1, -1)) {
    if (escaped) {
      current += character;
      escaped = false;
    } else if (character === "\\") {
      escaped = true;
      current += character;
    } else if (character === "|") {
      cells.push(current.trim());
      current = "";
    } else {
      current += character;
    }
  }
  cells.push(current.trim());
  return cells;
};

const tableRows = (markdownSection: string | undefined): string[][] => {
  if (markdownSection === undefined) {
    return [];
  }
  const tableLines = markdownSection
    .split(/\r?\n/u)
    .filter((line) => /^\s*\|.*\|\s*$/u.test(line));
  const separator = tableLines.findIndex((line) =>
    splitRow(line).every((cell) => /^:?-{3,}:?$/u.test(cell))
  );
  if (separator === -1) {
    return [];
  }
  return tableLines.slice(separator + 1).map(splitRow);
};

const requiredSectionRows = (
  markdown: string,
  heading: RegExp,
  owner: string
): string[][] => {
  const matched = section(markdown, heading);
  if (matched === undefined) {
    throw new Error(`${owner} must contain ${heading.source}`);
  }
  return tableRows(matched);
};

const resultOf = (markdown: string, owner: string): string => {
  const result =
    /^## 結果:\s*(?<result>APPROVE|REJECT|NEEDS_ADR_REVISION|判定不能)\s*$/mu.exec(
      markdown
    )?.groups?.["result"];
  if (result === undefined) {
    throw new Error(`${owner} must contain a supported result`);
  }
  return result;
};

const countStandardReview = (markdown: string): ReviewCounts => ({
  blocking: tableRows(section(markdown, /^## ブロッキング指摘\s*$/u)).length,
  nonBlocking: tableRows(
    section(markdown, /^## 非ブロッキング指摘(?:（.*）)?\s*$/u)
  ).length,
  resolved: tableRows(section(markdown, /^## 解消済み(?:（.*）)?\s*$/u)).length,
});

const countAdrReview = (markdown: string): ReviewCounts => ({
  blocking:
    tableRows(section(markdown, /^## 今回の指摘（new）\s*$/u)).length +
    tableRows(section(markdown, /^## 継続指摘（persists）\s*$/u)).length,
  nonBlocking: tableRows(
    section(markdown, /^## 非ブロッキング指摘(?:（.*）)?\s*$/u)
  ).length,
  resolved: tableRows(section(markdown, /^## 解消済み（resolved）\s*$/u))
    .length,
});

const specKind = (
  value: string
): keyof Omit<ReviewAggregate["specBreakdown"], "indeterminate"> => {
  if (value === "未実装") {
    return "unimplemented";
  }
  if (value === "検証なし" || value === "実装あり・検証なし") {
    return "unverified";
  }
  if (value === "既出未解消" || value === "未解消の既出指摘") {
    return "previouslyUnresolved";
  }
  throw new Error(`unsupported spec blocking kind: ${value}`);
};

export const buildReviewAggregate = (
  reports: Record<ReviewName, string>
): ReviewAggregate => {
  const specRows = tableRows(
    section(reports.spec, /^## ブロッキング指摘\s*$/u)
  );
  const specBreakdown: ReviewAggregate["specBreakdown"] = {
    indeterminate: resultOf(reports.spec, reportFiles.spec) === "判定不能",
    previouslyUnresolved: 0,
    unimplemented: 0,
    unverified: 0,
  };
  for (const row of specRows) {
    const kind = row.at(2);
    if (kind === undefined) {
      throw new Error(`${reportFiles.spec} blocking row must contain 種別`);
    }
    specBreakdown[specKind(kind)] += 1;
  }
  const declaredSpecBreakdown =
    /^内訳:\s*未実装\s*(?<unimplemented>\d+)\s*\/\s*検証なし\s*(?<unverified>\d+)\s*\/\s*既出未解消\s*(?<previouslyUnresolved>\d+)\s*\/\s*判定不能\s*(?<indeterminate>true|false)\s*$/mu.exec(
      reports.spec
    )?.groups;
  if (
    declaredSpecBreakdown === undefined ||
    Number(declaredSpecBreakdown["unimplemented"]) !==
      specBreakdown.unimplemented ||
    Number(declaredSpecBreakdown["unverified"]) !== specBreakdown.unverified ||
    Number(declaredSpecBreakdown["previouslyUnresolved"]) !==
      specBreakdown.previouslyUnresolved ||
    (declaredSpecBreakdown["indeterminate"] === "true") !==
      specBreakdown.indeterminate
  ) {
    throw new Error(
      `${reportFiles.spec} declared breakdown does not match blocking rows`
    );
  }

  const counts: Record<ReviewName, ReviewCounts> = {
    adr: countAdrReview(reports.adr),
    antipattern: countStandardReview(reports.antipattern),
    coding: countStandardReview(reports.coding),
    spec: {
      blocking: specRows.length,
      nonBlocking: tableRows(
        section(reports.spec, /^## 非ブロッキング指摘\s*$/u)
      ).length,
      resolved: 0,
    },
    testing: countStandardReview(reports.testing),
  };

  for (const name of reviewNames) {
    const result = resultOf(reports[name], reportFiles[name]);
    const expectedBlocking = counts[name].blocking > 0;
    const isBlockingResult =
      result === "REJECT" || result === "NEEDS_ADR_REVISION";
    if (name === "spec" && specBreakdown.indeterminate) {
      if (counts.spec.blocking !== 0) {
        throw new Error(
          "indeterminate spec review must not contain blocking rows"
        );
      }
    } else if (expectedBlocking !== isBlockingResult) {
      throw new Error(
        `${reportFiles[name]} result does not match its blocking row count`
      );
    }
  }

  return {
    blockingCounts: {
      adr: counts.adr.blocking,
      antipattern: counts.antipattern.blocking,
      coding: counts.coding.blocking,
      spec: counts.spec.blocking,
      testing: counts.testing.blocking,
    },
    nonBlockingCount: Object.values(counts).reduce(
      (total, count) => total + count.nonBlocking,
      0
    ),
    resolvedCount: Object.values(counts).reduce(
      (total, count) => total + count.resolved,
      0
    ),
    reviewCounts: counts,
    specBreakdown,
  };
};

const blockingTotal = (aggregate: ReviewAggregate): number =>
  Object.values(aggregate.blockingCounts).reduce(
    (total, count) => total + count,
    0
  );

export const renderDecisionLine = (aggregate: ReviewAggregate): string => {
  const counts = aggregate.blockingCounts;
  const spec = aggregate.specBreakdown;
  const verdict = blockingTotal(aggregate) > 0 ? "REJECT" : "APPROVE";
  return `判定: ${verdict} | ブロッキング: ${blockingTotal(aggregate)} (spec:${counts.spec} adr:${counts.adr} antipattern:${counts.antipattern} coding:${counts.coding} testing:${counts.testing}) | spec内訳: 未実装${spec.unimplemented}/検証なし${spec.unverified}/既出未解消${spec.previouslyUnresolved}/判定不能:${spec.indeterminate} | 非ブロッキング: ${aggregate.nonBlockingCount} | 解消済み: ${aggregate.resolvedCount}`;
};

const assertSummaryCounts = (
  summary: string,
  aggregate: ReviewAggregate
): void => {
  const expectedLine = renderDecisionLine(aggregate);
  const decisionLines = summary
    .split(/\r?\n/u)
    .filter((line) => line.startsWith("判定:"));
  if (decisionLines.length !== 1 || decisionLines[0] !== expectedLine) {
    throw new Error(
      "review summary decision line does not match report details"
    );
  }

  const expectedSections: [string, RegExp, number][] = [
    ["blocking", /^## ブロッキング指摘\s*$/u, blockingTotal(aggregate)],
    ["nonBlocking", /^## 非ブロッキング指摘\s*$/u, aggregate.nonBlockingCount],
    ["resolved", /^## 解消済み(?:（.*）)?\s*$/u, aggregate.resolvedCount],
  ];
  for (const [kind, heading, expected] of expectedSections) {
    const actual = tableRows(section(summary, heading)).length;
    if (actual !== expected) {
      throw new Error(
        `review summary ${kind} rows (${actual}) do not match report details (${expected})`
      );
    }
  }

  const sources = requiredSectionRows(
    summary,
    /^## 収集元\s*$/u,
    "review-summary.md"
  );
  if (sources.length !== 5) {
    throw new Error("review summary must contain all five source rows");
  }
  for (const name of reviewNames) {
    const source = sources.find(
      (row) => row[0]?.includes(reportFiles[name]) === true
    );
    if (source === undefined || source[1] !== "✅") {
      throw new Error(`review summary must mark ${reportFiles[name]} as read`);
    }
    if (
      Number(source[2]) !== aggregate.blockingCounts[name] ||
      Number(source[3]) !== aggregate.reviewCounts[name].nonBlocking
    ) {
      throw new Error(
        `${reportFiles[name]} source counts do not match details`
      );
    }
  }
  const sourceNonBlocking = sources.reduce(
    (total, row) => total + Number(row[3]),
    0
  );
  if (sourceNonBlocking !== aggregate.nonBlockingCount) {
    throw new Error("source non-blocking counts do not match report details");
  }
};

export const validateReviewSynthesis = (
  reports: Record<ReviewName, string>,
  summary: string
): ValidatedReviewSynthesis => {
  const aggregate = buildReviewAggregate(reports);
  assertSummaryCounts(summary, aggregate);
  const total = blockingTotal(aggregate);
  return {
    blocking_counts: aggregate.blockingCounts,
    decision_line: renderDecisionLine(aggregate),
    failure_reason: "",
    non_blocking_count: aggregate.nonBlockingCount,
    resolved_count: aggregate.resolvedCount,
    spec_breakdown: {
      indeterminate: aggregate.specBreakdown.indeterminate,
      previously_unresolved: aggregate.specBreakdown.previouslyUnresolved,
      unimplemented: aggregate.specBreakdown.unimplemented,
      unverified: aggregate.specBreakdown.unverified,
    },
    status: "complete",
    verdict: total > 0 ? "REJECT" : "APPROVE",
  };
};

const requiredOption = (arguments_: string[], option: string): string => {
  const index = arguments_.indexOf(option);
  const value = arguments_[index + 1];
  if (index === -1 || value === undefined || value.startsWith("--")) {
    throw new Error(`${option} is required`);
  }
  return value;
};

const readReports = (directory: string): Record<ReviewName, string> => ({
  adr: readFileSync(path.join(directory, reportFiles.adr), "utf-8"),
  antipattern: readFileSync(
    path.join(directory, reportFiles.antipattern),
    "utf-8"
  ),
  coding: readFileSync(path.join(directory, reportFiles.coding), "utf-8"),
  spec: readFileSync(path.join(directory, reportFiles.spec), "utf-8"),
  testing: readFileSync(path.join(directory, reportFiles.testing), "utf-8"),
});

const run = (arguments_: string[]): void => {
  const reportDirectory = requiredOption(arguments_, "--report-dir");
  const reports = readReports(reportDirectory);
  if (arguments_.includes("--decision-line")) {
    process.stdout.write(
      `${renderDecisionLine(buildReviewAggregate(reports))}\n`
    );
    return;
  }
  const summaryPath = requiredOption(arguments_, "--summary");
  const result = validateReviewSynthesis(
    reports,
    readFileSync(summaryPath, "utf-8")
  );
  process.stdout.write(`${JSON.stringify(result)}\n`);
};

if (import.meta.main) {
  try {
    run(process.argv.slice(2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
