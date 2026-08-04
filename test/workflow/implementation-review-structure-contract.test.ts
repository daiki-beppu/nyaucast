import { describe, expect, test } from "bun:test";

import { parseYamlRecord, readRepositoryFile } from "../helpers";

const expectedReviewerRoster = [
  "arch-review",
  "ai-antipattern-review",
  "coding-review",
  "implementation-semantics-review",
  "contract-lifecycle-review",
  "robustness-review",
  "adr-conformance-review",
] as const;

const paths = {
  feature: ".takt/workflows/tayk-feature.yaml",
  fix: ".takt/workflows/tayk-fix.yaml",
  reviewers: ".takt/steps/reviewers.yaml",
} as const;

const provisionalConditionPrefix = "when(findings.provisional.count > 0";
const expectedProvisionalNext = {
  feature: "replan",
  fix: "diagnose",
} as const;

const expectedAggregateSuffix = {
  approval:
    " && when(findings.open.count == 0 && findings.provisional.count == 0 && findings.conflicts.count == 0)",
  fix: " && when(findings.conflicts.count == 0)",
} as const;

interface Aggregate {
  kind: "all" | "any";
  suffix: string;
  targets: string[];
}

interface YamlRecord extends Record<string, unknown> {
  condition?: unknown;
  name?: unknown;
  next?: unknown;
  parallel?: unknown;
  rules?: unknown;
  self?: unknown;
  steps?: unknown;
  uses?: unknown;
}

interface ReviewContract {
  approving: string[];
  fixTargets: string[];
  overlay: YamlRecord;
  reviewerNames: string[];
  verdicts: string[][];
}

interface RepositoryDefinitions {
  feature: YamlRecord;
  fix: YamlRecord;
  reviewers: YamlRecord;
}

const quotedJsonString = String.raw`"(?:\\.|[^"\\])*"`;
const aggregatePattern = new RegExp(
  String.raw`^(all|any)\(\s*(${quotedJsonString}(?:\s*,\s*${quotedJsonString})*)\s*\)(\s*&&[\s\S]+)?$`
);

function readYaml(path: string): YamlRecord {
  return parseYamlRecord({
    expectedShape: "an object",
    relativePath: path,
    source: readRepositoryFile(path),
  });
}

function readDefinitions(): RepositoryDefinitions {
  return {
    feature: readYaml(paths.feature),
    fix: readYaml(paths.fix),
    reviewers: readYaml(paths.reviewers),
  };
}

function requireRecord(value: unknown, label: string): YamlRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as YamlRecord;
}

function requireArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`${label} must be an array`);
  }
  return value;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new TypeError(`${label} must be a string`);
  }
  return value;
}

function parseAggregate(condition: string): Aggregate | undefined {
  const match = condition.match(aggregatePattern);
  if (match === null) {
    if (/^(?:all|any)\s*\(/.test(condition)) {
      throw new TypeError(`malformed aggregate condition: ${condition}`);
    }
    return undefined;
  }

  const kind = match[1];
  if (kind !== "all" && kind !== "any") {
    throw new TypeError(`unsupported aggregate kind: ${String(kind)}`);
  }
  const parsedTargets: unknown = JSON.parse(`[${match[2]}]`);
  if (!Array.isArray(parsedTargets) || parsedTargets.length === 0) {
    throw new TypeError(`aggregate must contain string targets: ${condition}`);
  }
  return {
    kind,
    suffix: match[3] ?? "",
    targets: parsedTargets.map((target, index) =>
      requireString(target, `aggregate target ${index}`)
    ),
  };
}

function formatAggregate(aggregate: Aggregate): string {
  return `${aggregate.kind}(${aggregate.targets.map((target) => JSON.stringify(target)).join(", ")})${aggregate.suffix}`;
}

function requireReviewerOverlay(
  workflow: YamlRecord,
  label: string
): YamlRecord {
  const steps = requireArray(workflow.steps, `${label}.steps`);
  const matches = steps.filter((value) => {
    const step = requireRecord(value, `${label}.steps item`);
    return step.name === "reviewers" && step.uses === "reviewers";
  });
  if (matches.length !== 1) {
    throw new TypeError(`${label} must contain exactly one reviewers overlay`);
  }
  return requireRecord(matches[0], `${label}.reviewers`);
}

function requireSharedReviewerNames(fragment: YamlRecord): string[] {
  return requireArray(fragment.parallel, "reviewers.parallel").map(
    (value, index) => {
      const reviewer = requireRecord(value, `reviewers.parallel[${index}]`);
      return requireString(reviewer.name, `reviewers.parallel[${index}].name`);
    }
  );
}

function requireRules(overlay: YamlRecord): {
  parallel: YamlRecord;
  self: YamlRecord[];
} {
  const rules = requireRecord(overlay.rules, "reviewers.rules");
  return {
    parallel: requireRecord(rules.parallel, "reviewers.rules.parallel"),
    self: requireArray(rules.self, "reviewers.rules.self").map((value, index) =>
      requireRecord(value, `reviewers.rules.self[${index}]`)
    ),
  };
}

function requireAggregateRule(
  rules: YamlRecord[],
  kind: Aggregate["kind"],
  next: string,
  expectedSuffix: string
): Aggregate {
  const matches = rules.flatMap((rule, index) => {
    const condition = requireString(
      rule.condition,
      `self rule ${index}.condition`
    );
    const aggregate = parseAggregate(condition);
    return aggregate?.kind === kind && rule.next === next ? [aggregate] : [];
  });
  if (matches.length !== 1) {
    throw new TypeError(
      `reviewers must contain one ${kind}(...) rule to ${next}`
    );
  }
  const match = matches[0];
  if (match === undefined) {
    throw new TypeError(
      `reviewers must contain one ${kind}(...) rule to ${next}`
    );
  }
  if (match.suffix !== expectedSuffix) {
    throw new TypeError(
      `reviewers ${kind}(...) rule to ${next} must use the required suffix`
    );
  }
  return match;
}

function requireVerdicts(
  parallel: YamlRecord,
  reviewerNames: string[]
): string[][] {
  return reviewerNames.map((reviewerName) => {
    const entries = requireArray(
      parallel[reviewerName],
      `reviewers.rules.parallel.${reviewerName}`
    );
    if (entries.length === 0) {
      throw new TypeError(`${reviewerName} must declare at least one verdict`);
    }
    return entries.map((value, index) => {
      const verdict = requireRecord(value, `${reviewerName}[${index}]`);
      return requireString(
        verdict.condition,
        `${reviewerName}[${index}].condition`
      );
    });
  });
}

function inspectReviewContract(
  fragment: YamlRecord,
  workflow: YamlRecord,
  label: string
): ReviewContract {
  const reviewerNames = requireSharedReviewerNames(fragment);
  expect(reviewerNames).toEqual([...expectedReviewerRoster]);

  const overlay = requireReviewerOverlay(workflow, label);
  const rules = requireRules(overlay);
  expect(Object.keys(rules.parallel)).toEqual(reviewerNames);

  const verdicts = requireVerdicts(rules.parallel, reviewerNames);
  const approving = requireAggregateRule(
    rules.self,
    "all",
    "final_gate",
    expectedAggregateSuffix.approval
  ).targets;
  expect(approving).toHaveLength(reviewerNames.length);
  for (const [index, target] of approving.entries()) {
    expect(verdicts[index]).toContain(target);
  }

  return {
    approving,
    fixTargets: requireAggregateRule(
      rules.self,
      "any",
      "fix",
      expectedAggregateSuffix.fix
    ).targets,
    overlay,
    reviewerNames,
    verdicts,
  };
}

function assertNegativeVerdictCoverage(contract: ReviewContract): void {
  const negativeVerdicts = contract.verdicts.map((verdicts, index) =>
    verdicts.filter((verdict) => verdict !== contract.approving[index])
  );
  if (negativeVerdicts.every((verdicts) => verdicts.length === 0)) {
    throw new TypeError("reviewers must declare at least one negative verdict");
  }

  let tuples: string[][] = [[]];
  for (const verdicts of contract.verdicts) {
    tuples = tuples.flatMap((tuple) =>
      verdicts.map((verdict) => [...tuple, verdict])
    );
  }
  const uncovered = tuples.find(
    (tuple) =>
      !tuple.every((verdict, index) => verdict === contract.approving[index]) &&
      !tuple.some((verdict) => contract.fixTargets.includes(verdict))
  );
  if (uncovered !== undefined) {
    throw new TypeError(
      `negative verdict tuple does not reach fix: ${uncovered.join(" | ")}`
    );
  }
}

function normalizeOverlay(
  overlay: YamlRecord,
  expectedNext: string
): YamlRecord {
  const normalized = structuredClone(overlay);
  const self = requireRules(normalized).self;
  const provisionalRules = self.filter((rule, index) =>
    requireString(rule.condition, `self rule ${index}.condition`).startsWith(
      provisionalConditionPrefix
    )
  );
  if (provisionalRules.length !== 1) {
    throw new TypeError(
      "reviewers must contain exactly one provisional re-entry rule"
    );
  }
  const provisionalRule = provisionalRules[0];
  if (provisionalRule === undefined) {
    throw new TypeError(
      "reviewers must contain exactly one provisional re-entry rule"
    );
  }
  if (
    requireString(provisionalRule.next, "provisional re-entry rule.next") !==
    expectedNext
  ) {
    throw new TypeError(
      `reviewers provisional re-entry must transition to ${expectedNext}`
    );
  }
  provisionalRule.next = "PROVISIONAL_REENTRY";
  return normalized;
}

function assertEquivalentOverlays(feature: YamlRecord, fix: YamlRecord): void {
  expect(
    normalizeOverlay(
      requireReviewerOverlay(feature, "feature"),
      expectedProvisionalNext.feature
    )
  ).toEqual(
    normalizeOverlay(
      requireReviewerOverlay(fix, "fix"),
      expectedProvisionalNext.fix
    )
  );
}

function assertRepositoryContract(definitions: RepositoryDefinitions): void {
  const feature = inspectReviewContract(
    definitions.reviewers,
    definitions.feature,
    "feature"
  );
  const fix = inspectReviewContract(
    definitions.reviewers,
    definitions.fix,
    "fix"
  );
  assertNegativeVerdictCoverage(feature);
  assertNegativeVerdictCoverage(fix);
  assertEquivalentOverlays(definitions.feature, definitions.fix);
}

function rewriteAggregate(
  workflow: YamlRecord,
  kind: Aggregate["kind"],
  next: string,
  update: (aggregate: Aggregate) => Aggregate
): void {
  const overlay = requireReviewerOverlay(workflow, "mutation");
  const rules = requireRules(overlay).self;
  const rule = rules.find((candidate) => {
    const aggregate = parseAggregate(
      requireString(candidate.condition, "condition")
    );
    return aggregate?.kind === kind && candidate.next === next;
  });
  if (rule === undefined) {
    throw new TypeError(`mutation requires ${kind}(...) rule to ${next}`);
  }
  const aggregate = parseAggregate(requireString(rule.condition, "condition"));
  if (aggregate === undefined) {
    throw new TypeError("mutation target must be an aggregate");
  }
  rule.condition = formatAggregate(
    update({ ...aggregate, targets: [...aggregate.targets] })
  );
}

function updateAggregate(
  workflow: YamlRecord,
  kind: Aggregate["kind"],
  next: string,
  update: (targets: string[]) => string[]
): void {
  rewriteAggregate(workflow, kind, next, (aggregate) => ({
    ...aggregate,
    targets: update(aggregate.targets),
  }));
}

function removeReviewerBundle(
  definitions: RepositoryDefinitions,
  reviewerIndex: number
): void {
  requireArray(definitions.reviewers.parallel, "reviewers.parallel").splice(
    reviewerIndex,
    1
  );
  const reviewerName = expectedReviewerRoster[reviewerIndex];
  if (reviewerName === undefined) {
    throw new TypeError(`reviewer index ${reviewerIndex} is out of range`);
  }
  for (const workflow of [definitions.feature, definitions.fix]) {
    const overlay = requireReviewerOverlay(workflow, "mutation");
    const rules = requireRecord(overlay.rules, "reviewers.rules");
    const parallel = Object.fromEntries(
      Object.entries(requireRecord(rules.parallel, "parallel")).filter(
        ([name]) => name !== reviewerName
      )
    );
    rules.parallel = parallel;
    updateAggregate(workflow, "all", "final_gate", (targets) => {
      targets.splice(reviewerIndex, 1);
      return targets;
    });

    const remainingReviewerNames = Object.keys(parallel);
    const remainingVerdicts = requireVerdicts(parallel, remainingReviewerNames);
    const approval = requireAggregateRule(
      requireRules(overlay).self,
      "all",
      "final_gate",
      expectedAggregateSuffix.approval
    ).targets;
    const remainingNegativeTargets = [
      ...new Set(
        remainingVerdicts.flatMap((verdicts, index) =>
          verdicts.filter((verdict) => verdict !== approval[index])
        )
      ),
    ];
    updateAggregate(workflow, "any", "fix", () => remainingNegativeTargets);
  }
}

function reorderParallelKeys(workflow: YamlRecord): void {
  const overlay = requireReviewerOverlay(workflow, "mutation");
  const rules = requireRecord(overlay.rules, "reviewers.rules");
  const entries = Object.entries(requireRecord(rules.parallel, "parallel"));
  const first = entries[0];
  const second = entries[1];
  if (first === undefined || second === undefined) {
    throw new TypeError("mutation requires at least two reviewer keys");
  }
  [entries[0], entries[1]] = [second, first];
  rules.parallel = Object.fromEntries(entries);
}

describe("[REQ-286-01] reviewer order and approval position contract", () => {
  test("should accept the repository reviewer roster and positional approval mapping", () => {
    const definitions = readDefinitions();

    expect(() => {
      assertRepositoryContract(definitions);
    }).not.toThrow();
  });

  test.each([...expectedReviewerRoster])(
    "should reject an internally consistent omission of %s",
    (reviewerName) => {
      const definitions = structuredClone(readDefinitions());
      removeReviewerBundle(
        definitions,
        expectedReviewerRoster.indexOf(reviewerName)
      );

      expect(() => {
        assertRepositoryContract(definitions);
      }).toThrow();
    }
  );

  test("should reject an internally consistent reviewer replacement", () => {
    const definitions = structuredClone(readDefinitions());
    const originalName = expectedReviewerRoster[0];
    const replacementName = "replacement-review";
    const fragmentReviewer = requireArray(
      definitions.reviewers.parallel,
      "reviewers.parallel"
    )
      .map((reviewer) => requireRecord(reviewer, "reviewer"))
      .find((reviewer) => reviewer.name === originalName);
    if (fragmentReviewer === undefined) {
      throw new TypeError(`fixture must contain ${originalName}`);
    }
    fragmentReviewer.name = replacementName;
    for (const workflow of [definitions.feature, definitions.fix]) {
      const overlay = requireReviewerOverlay(workflow, "mutation");
      const rules = requireRecord(overlay.rules, "reviewers.rules");
      rules.parallel = Object.fromEntries(
        Object.entries(requireRecord(rules.parallel, "parallel")).map(
          ([name, verdicts]) => [
            name === originalName ? replacementName : name,
            verdicts,
          ]
        )
      );
    }

    expect(() => {
      assertRepositoryContract(definitions);
    }).toThrow();
  });

  test("should reject an overlay whose reviewer keys are out of order", () => {
    const definitions = structuredClone(readDefinitions());
    reorderParallelKeys(definitions.feature);

    expect(() => {
      assertRepositoryContract(definitions);
    }).toThrow();
  });

  test("should reject approval targets mapped to another reviewer position", () => {
    const definitions = structuredClone(readDefinitions());
    updateAggregate(definitions.feature, "all", "final_gate", (targets) => {
      const distinctPair = targets.findIndex(
        (target, index) => index > 0 && target !== targets[0]
      );
      if (distinctPair < 1) {
        throw new TypeError(
          "fixture must contain distinct positional verdicts"
        );
      }
      const first = targets[0];
      const second = targets[distinctPair];
      if (first === undefined || second === undefined) {
        throw new TypeError("fixture must contain two positional verdicts");
      }
      [targets[0], targets[distinctPair]] = [second, first];
      return targets;
    });

    expect(() => {
      assertRepositoryContract(definitions);
    }).toThrow();
  });

  test.each([-1, 1])(
    "should reject an approval target count offset by %i",
    (offset) => {
      const definitions = structuredClone(readDefinitions());
      updateAggregate(definitions.feature, "all", "final_gate", (targets) =>
        offset < 0 ? targets.slice(0, -1) : [...targets, "unexpected"]
      );

      expect(() => {
        assertRepositoryContract(definitions);
      }).toThrow();
    }
  );

  test.each([
    [
      "missing steps",
      (definitions: RepositoryDefinitions) => delete definitions.feature.steps,
    ],
    [
      "non-array fragment parallel",
      (definitions: RepositoryDefinitions) => {
        definitions.reviewers.parallel = {};
      },
    ],
    [
      "non-map overlay parallel",
      (definitions: RepositoryDefinitions) => {
        const overlay = requireReviewerOverlay(definitions.feature, "mutation");
        requireRecord(overlay.rules, "rules").parallel = [];
      },
    ],
    [
      "empty reviewer verdicts",
      (definitions: RepositoryDefinitions) => {
        const overlay = requireReviewerOverlay(definitions.feature, "mutation");
        const parallel = requireRules(overlay).parallel;
        parallel[expectedReviewerRoster[0]] = [];
      },
    ],
    [
      "non-array reviewer verdicts",
      (definitions: RepositoryDefinitions) => {
        const overlay = requireReviewerOverlay(definitions.feature, "mutation");
        const parallel = requireRules(overlay).parallel;
        parallel[expectedReviewerRoster[0]] = null;
      },
    ],
  ] as const)("should reject %s", (_label, mutate) => {
    const definitions = structuredClone(readDefinitions());
    mutate(definitions);

    expect(() => {
      assertRepositoryContract(definitions);
    }).toThrow(TypeError);
  });
});

describe("[REQ-286-02] negative verdict fix coverage contract", () => {
  test("should route every repository negative verdict tuple to fix", () => {
    const definitions = readDefinitions();
    const contract = inspectReviewContract(
      definitions.reviewers,
      definitions.feature,
      "feature"
    );

    expect(() => {
      assertNegativeVerdictCoverage(contract);
    }).not.toThrow();
  });

  for (const reviewerName of expectedReviewerRoster) {
    test(`should reject an uncovered negative verdict from ${reviewerName}`, () => {
      const definitions = structuredClone(readDefinitions());
      const overlay = requireReviewerOverlay(definitions.feature, "mutation");
      const parallel = requireRules(overlay).parallel;
      const verdictEntries = requireArray(parallel[reviewerName], reviewerName);
      const approving = requireAggregateRule(
        requireRules(overlay).self,
        "all",
        "final_gate",
        expectedAggregateSuffix.approval
      ).targets[expectedReviewerRoster.indexOf(reviewerName)];
      const negativeEntry = verdictEntries
        .map((entry) => requireRecord(entry, reviewerName))
        .find((entry) => entry.condition !== approving);
      if (negativeEntry === undefined) {
        throw new TypeError(
          `${reviewerName} fixture must contain a negative verdict`
        );
      }
      negativeEntry.condition = `UNCOVERED_${reviewerName}`;

      const contract = inspectReviewContract(
        definitions.reviewers,
        definitions.feature,
        "feature"
      );
      expect(() => {
        assertNegativeVerdictCoverage(contract);
      }).toThrow(/does not reach fix/);
    });
  }

  test("should reject a negative aggregate that no longer transitions to fix", () => {
    const definitions = structuredClone(readDefinitions());
    const overlay = requireReviewerOverlay(definitions.feature, "mutation");
    const fixRule = requireRules(overlay).self.find((rule) => {
      const aggregate = parseAggregate(
        requireString(rule.condition, "condition")
      );
      return aggregate?.kind === "any" && rule.next === "fix";
    });
    if (fixRule === undefined) {
      throw new TypeError("fixture must contain a fix aggregate");
    }
    fixRule.next = "final_gate";

    expect(() => {
      inspectReviewContract(
        definitions.reviewers,
        definitions.feature,
        "feature"
      );
    }).toThrow(/one any\(\.\.\.\) rule to fix/);
  });

  test("should reject vacuous coverage when every reviewer only approves", () => {
    const definitions = structuredClone(readDefinitions());
    const overlay = requireReviewerOverlay(definitions.feature, "mutation");
    const rules = requireRules(overlay);
    const approving = requireAggregateRule(
      rules.self,
      "all",
      "final_gate",
      expectedAggregateSuffix.approval
    ).targets;
    for (const [index, reviewerName] of Object.keys(rules.parallel).entries()) {
      rules.parallel[reviewerName] = [{ condition: approving[index] }];
    }
    const contract = inspectReviewContract(
      definitions.reviewers,
      definitions.feature,
      "feature"
    );

    expect(() => {
      assertNegativeVerdictCoverage(contract);
    }).toThrow(/at least one negative verdict/);
  });

  test.each([
    ["all", "final_gate"],
    ["any", "fix"],
  ] as const)(
    "should reject a changed %s(...)->%s suffix in both overlays",
    (kind, next) => {
      const definitions = structuredClone(readDefinitions());
      for (const workflow of [definitions.feature, definitions.fix]) {
        rewriteAggregate(workflow, kind, next, (aggregate) => ({
          ...aggregate,
          suffix: " && when(false)",
        }));
      }

      expect(() => {
        assertRepositoryContract(definitions);
      }).toThrow();
    }
  );
});

describe("[REQ-286-03] feature and fix overlay equivalence contract", () => {
  test("should accept the sole provisional re-entry destination difference", () => {
    const definitions = readDefinitions();

    expect(() => {
      assertEquivalentOverlays(definitions.feature, definitions.fix);
    }).not.toThrow();
  });

  test.each(["condition", "transition", "verdict mapping"] as const)(
    "should reject a feature-only %s change",
    (mutation) => {
      const definitions = structuredClone(readDefinitions());
      const overlay = requireReviewerOverlay(definitions.feature, "mutation");
      const rules = requireRules(overlay);
      if (mutation === "condition") {
        const firstRule = rules.self[0];
        if (firstRule === undefined) {
          throw new TypeError("fixture must contain a first self rule");
        }
        firstRule.condition = "when(findings.conflicts.count > 1)";
      } else if (mutation === "transition") {
        const secondRule = rules.self[1];
        if (secondRule === undefined) {
          throw new TypeError("fixture must contain a second self rule");
        }
        secondRule.next = "final_gate";
      } else {
        requireArray(
          rules.parallel[expectedReviewerRoster[0]],
          expectedReviewerRoster[0]
        ).reverse();
      }

      expect(() => {
        assertEquivalentOverlays(definitions.feature, definitions.fix);
      }).toThrow();
    }
  );

  test("should not normalize a non-provisional transition difference", () => {
    const definitions = structuredClone(readDefinitions());
    const featureOverlay = requireReviewerOverlay(
      definitions.feature,
      "mutation"
    );
    const rule = requireRules(featureOverlay).self.find(
      (candidate) => candidate.next === "fix"
    );
    if (rule === undefined) {
      throw new TypeError("fixture must contain a non-provisional fix rule");
    }
    rule.next = "diagnose";

    expect(() => {
      assertEquivalentOverlays(definitions.feature, definitions.fix);
    }).toThrow();
  });

  test.each([
    ["feature", expectedProvisionalNext.feature],
    ["fix", expectedProvisionalNext.fix],
  ] as const)(
    "should reject an unexpected %s provisional re-entry destination",
    (workflowName, expectedNext) => {
      const definitions = structuredClone(readDefinitions());
      const overlay = requireReviewerOverlay(
        definitions[workflowName],
        "mutation"
      );
      const provisional = requireRules(overlay).self.find((rule, index) =>
        requireString(
          rule.condition,
          `self rule ${index}.condition`
        ).startsWith(provisionalConditionPrefix)
      );
      if (provisional === undefined) {
        throw new TypeError("fixture must contain a provisional rule");
      }
      provisional.next = "ABORT";

      expect(() => {
        assertEquivalentOverlays(definitions.feature, definitions.fix);
      }).toThrow(
        `reviewers provisional re-entry must transition to ${expectedNext}`
      );
    }
  );

  test("should reject multiple provisional re-entry rules", () => {
    const definitions = structuredClone(readDefinitions());
    const featureOverlay = requireReviewerOverlay(
      definitions.feature,
      "mutation"
    );
    const rules = requireRecord(featureOverlay.rules, "reviewers.rules");
    const self = requireArray(rules.self, "reviewers.rules.self");
    const provisional = self.find((rule) =>
      String(requireRecord(rule, "self rule").condition).startsWith(
        provisionalConditionPrefix
      )
    );
    if (provisional === undefined) {
      throw new TypeError("fixture must contain a provisional rule");
    }
    self.push(structuredClone(provisional));

    expect(() => {
      assertEquivalentOverlays(definitions.feature, definitions.fix);
    }).toThrow(/exactly one provisional/);
  });
});

describe("[REQ-286-04] static aggregate inspection contract", () => {
  test("should preserve the trailing when expression as opaque text", () => {
    const opaqueSuffix =
      " && when(custom.deep(call(1, 2)) && opaque.value == 3)";
    const aggregate = parseAggregate(`any("needs_fix")${opaqueSuffix}`);

    expect(aggregate?.suffix).toBe(opaqueSuffix);
  });

  test.each(["all(approved)", 'any("needs_fix", 1)', 'all("approved"'])(
    "should reject malformed aggregate %s",
    (condition) => {
      expect(() => parseAggregate(condition)).toThrow(TypeError);
    }
  );
});
