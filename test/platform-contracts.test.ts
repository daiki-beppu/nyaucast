import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

import { describe, expect, test } from "@effect/vitest";
import { parse } from "yaml";

import { chromeCacheDirectory } from "../src/lib/chrome.ts";
import { chromeHeadlessShellBuildId } from "../src/lib/chrome-pin.ts";
import { checkGates } from "./check-gates.ts";
import { withTemporaryDirectory } from "./helpers";

const packageRoot = resolve(import.meta.dirname, "..");
const canonicalCheckCommand = "pnpm run check";
const trustedRepositoryUrl = "https://github.com/daiki-beppu/nyaucast.git";

type JsonRecord = Record<string, unknown>;

interface WorkflowStep extends JsonRecord {
  run?: string;
  uses?: string;
  with?: JsonRecord;
}

function requireRecord(value: unknown, label: string): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as JsonRecord;
}

function readJson(path: string): JsonRecord {
  return requireRecord(JSON.parse(readFileSync(path, "utf8")), basename(path));
}

function readWorkflow(name: string): JsonRecord {
  return requireRecord(
    parse(readFileSync(join(packageRoot, ".github/workflows", name), "utf8")),
    name,
  );
}

function workflowJobs(workflow: JsonRecord): JsonRecord[] {
  return Object.values(requireRecord(workflow["jobs"], "workflow jobs")).map((job, index) =>
    requireRecord(job, `workflow job ${index}`),
  );
}

function jobSteps(job: JsonRecord): WorkflowStep[] {
  const steps = job["steps"];
  if (steps === undefined) {
    return [];
  }
  if (!Array.isArray(steps)) {
    throw new TypeError("workflow steps must be an array");
  }
  return steps.map((step, index) => requireRecord(step, `workflow step ${index}`));
}

const enforcedFallowRules = [
  "unused-dependencies",
  "unused-dev-dependencies",
  "unused-optional-dependencies",
  "type-only-dependencies",
  "test-only-dependencies",
  "dev-dependencies-in-production",
  "re-export-cycle",
  "stale-suppressions",
  "require-suppression-reason",
  "unused-catalog-entries",
  "unused-dependency-overrides",
];

function readFallowConfig(): JsonRecord {
  return readJson(join(packageRoot, ".fallowrc.json"));
}

function srcPatterns(patterns: unknown): unknown[] {
  return (Array.isArray(patterns) ? patterns : []).filter(
    (pattern) => typeof pattern === "string" && pattern.startsWith("src/"),
  );
}

// 対象を書かない抑止コメントは、すべての検査を黙らせる
function silencingSuppressions(source: string): string[] {
  return [...source.matchAll(/fallow-ignore-(?:next-line|file)\b(.*)/g)]
    .filter(([, rest = ""]) => /^\s*$|\b(?:code-duplication|complexity)\b/.test(rest))
    .map(([comment]) => comment);
}

function releaseSteps(): WorkflowStep[] {
  return workflowJobs(readWorkflow("release.yml")).flatMap(jobSteps);
}

function publishStep(): WorkflowStep {
  for (const step of releaseSteps()) {
    if (step["name"] === "Publish package" && typeof step.run === "string") {
      return step;
    }
  }
  throw new Error("release workflow must contain the Publish package step");
}

function publishScript(): string {
  const script = publishStep().run;
  if (script === undefined) {
    throw new Error("Publish package must have a script");
  }
  return script;
}

function runBash(script: string, cwd: string, environment: NodeJS.ProcessEnv) {
  return spawnSync("bash", ["-euo", "pipefail", "-c", script], {
    cwd,
    encoding: "utf8",
    env: environment,
  });
}

function isolatedEnvironment(overrides: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const inherited = Object.entries(process.env).filter(
    ([name, value]) => value !== undefined && !name.startsWith("GIT_"),
  );
  return Object.fromEntries(
    [...inherited, ...Object.entries(overrides)].filter(([, value]) => value !== undefined),
  );
}

function runPublishWithFakePnpm(overrides: NodeJS.ProcessEnv) {
  return withTemporaryDirectory("nyaucast-release-publish-", (directory) => {
    const bin = join(directory, "bin");
    const callsFile = join(directory, "pnpm-calls.txt");
    mkdirSync(bin);
    writeFileSync(join(directory, "package.json"), '{"version":"0.0.0"}\n');
    writeFileSync(
      join(bin, "pnpm"),
      `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(callsFile)}\n`,
    );
    chmodSync(join(bin, "pnpm"), 0o755);
    const path = process.env["PATH"];
    if (path === undefined) {
      throw new Error("PATH is required");
    }

    const result = runBash(
      publishScript(),
      directory,
      isolatedEnvironment({ ...overrides, PATH: `${bin}:${path}` }),
    );
    return { result, calls: readFileSync(callsFile, "utf8").trim() };
  });
}

describe("K1 three identical check surfaces", () => {
  test("local, pre-push, and CI cannot silently diverge from the canonical check", () => {
    const manifest = readJson(join(packageRoot, "package.json"));
    const scripts = requireRecord(manifest["scripts"], "package scripts");
    const prePush = readFileSync(join(packageRoot, ".vite-hooks/pre-push"), "utf8").trim();
    const ciRuns = workflowJobs(readWorkflow("ci.yml"))
      .flatMap(jobSteps)
      .flatMap((step) => (typeof step.run === "string" ? [step.run.trim()] : []))
      .filter((command) => command.includes("check"));

    expect(typeof scripts["check"]).toBe("string");
    expect(prePush).toBe(canonicalCheckCommand);
    expect(ciRuns).toEqual([canonicalCheckCommand]);
  });

  // CI は同じ check を shard ごとに走らせる（#715）。shard の集合が 1/N〜N/N を漏れなく重複なく覆わないと、
  // どの job も pass したまま、一部のテストが CI で一度も走らなくなる。
  test("the CI shards cover every test file exactly once", () => {
    const quality = workflowJobs(readWorkflow("ci.yml")).find(
      (job) => job["strategy"] !== undefined,
    );
    const strategy = requireRecord(quality?.["strategy"], "quality strategy");
    const shards = requireRecord(strategy["matrix"], "quality matrix")["shard"];
    const environment = requireRecord(quality?.["env"], "quality env");

    expect(Array.isArray(shards)).toBe(true);
    const count = (shards as unknown[]).length;
    expect([...(shards as number[])].sort((left, right) => left - right)).toEqual(
      Array.from({ length: count }, (_, at) => at + 1),
    );
    // 分母は matrix の数から取る。shard の数を書くのは matrix の一覧だけ
    expect(environment["VITEST_SHARD"]).toBe("${{ matrix.shard }}/${{ strategy.job-total }}");

    const manifest = readJson(join(packageRoot, "package.json"));
    const testGates = checkGates(
      requireRecord(manifest["scripts"], "package scripts") as Record<string, string>,
    )
      .map(({ gate }) => gate)
      .filter((gate) => gate.startsWith("vp test"));
    // VITEST_SHARD の無いローカル・pre-push では、shard の引数が消えて全件が走る
    expect(testGates).toEqual(["vp test run ${VITEST_SHARD:+--shard=$VITEST_SHARD}"]);
  });

  // ルールセット「main: CI 必須」は quality という名前の check を必須にしている。shard の job の名前は
  // shard ごとに変わるので、すべての shard の成功を要求する quality job が無いと PR がマージできなくなる。
  test("a job named quality passes only when every CI shard passes", () => {
    const jobs = requireRecord(readWorkflow("ci.yml")["jobs"], "CI jobs");
    const quality = requireRecord(jobs["quality"], "quality job");
    const shardJob = Object.keys(jobs).find((id) => id !== "quality");

    expect(shardJob).toBeDefined();
    expect(requireRecord(jobs[shardJob ?? ""], "shard job")["strategy"]).toBeDefined();
    expect(quality["needs"]).toBe(shardJob);
    expect(quality["if"]).toBe("always()");
    expect(JSON.stringify(quality["steps"])).toContain(`\${{ needs.${shardJob}.result }}`);
    expect(JSON.stringify(quality["steps"])).toContain('= \\"success\\"');
  });

  test("the declared check gate set includes the lockfile gate without duplicates", () => {
    const manifest = readJson(join(packageRoot, "package.json"));
    const scripts = requireRecord(manifest["scripts"], "package scripts");
    const gates = checkGates(scripts as Record<string, string>);

    expect(gates.map(({ gate }) => gate)).toContain("pnpm run lockfile:check");
    expect(new Set(gates.map(({ gate }) => gate)).size).toBe(gates.length);
    // script の名前や正規表現が何にも当たらないと、そのゲートは何も検査せずに通る
    for (const { commands, gate } of gates) {
      expect(commands.length, gate).toBeGreaterThan(0);
    }
  });

  // 互いに依存しない静的ゲートは、テストの直前に 1 つの正規表現のゲートとしてまとめて並行に走らせる（#748）
  test("the gate right before the tests runs several scripts at once", () => {
    const manifest = readJson(join(packageRoot, "package.json"));
    const gates = checkGates(
      requireRecord(manifest["scripts"], "package scripts") as Record<string, string>,
    );
    const tests = gates.findIndex(({ gate }) => gate.startsWith("vp test"));

    expect(gates[tests - 1]?.gate).toMatch(/^pnpm run '\/.+\/'$/u);
    expect(gates[tests - 1]?.commands.length).toBeGreaterThan(1);
  });

  // pnpm が並行に走らせた script の 1 つが失敗したら、check はそこで止まって失敗する（最初に失敗したゲートで止まる）
  test("a gate that runs several scripts at once fails when one of them fails", () => {
    withTemporaryDirectory("nyaucast-parallel-gate-", (directory) => {
      writeFileSync(
        join(directory, "package.json"),
        JSON.stringify({
          name: "parallel-gate",
          private: true,
          scripts: {
            "fails:check": "exit 3",
            "passes:check": "exit 0",
            "slow:check": "sleep 20",
            check: "pnpm run '/^(fails|passes|slow):check$/' && echo after-the-gate",
          },
        }),
      );
      const started = Date.now();
      const result = spawnSync("pnpm", ["run", "check"], { cwd: directory, encoding: "utf8" });

      expect(result.status).not.toBe(0);
      expect(result.stdout).not.toContain("after-the-gate");
      // 遅い script の終わりを待たずに止まる
      expect(Date.now() - started).toBeLessThan(10_000);
    });
  });

  test("the dependency graph remains visible in a single-document lockfile", () => {
    const lockfile = requireRecord(
      parse(readFileSync(join(packageRoot, "pnpm-lock.yaml"), "utf8")),
      "pnpm lockfile",
    );
    const rootImporter = requireRecord(
      requireRecord(lockfile["importers"], "lockfile importers")["."],
      "root importer",
    );

    expect(
      Object.keys(requireRecord(rootImporter["dependencies"], "root dependencies")),
    ).not.toHaveLength(0);
  });

  // runtime 依存を fallow で黙らせる例外は 1 件も無い。#694 が先に dependencies へ入れた alchemy も、
  // 呼ぶ側（src/cloudflare/alchemy.ts）が入った #695 で ignoreDependencies から外した。
  const fallowSilencedRuntimeDependencies: ReadonlyArray<string> = [];

  test("runtime dependencies cannot be silenced through fallow", () => {
    const manifest = readJson(join(packageRoot, "package.json"));
    const fallow = readJson(join(packageRoot, ".fallowrc.json"));
    const dependencies = Object.keys(
      manifest["dependencies"] === undefined
        ? {}
        : requireRecord(manifest["dependencies"], "runtime dependencies"),
    );
    const ignored = fallow["ignoreDependencies"];
    if (!Array.isArray(ignored)) {
      throw new TypeError("ignoreDependencies must be an array");
    }

    // 完全一致で比べる。部分一致にすると 2 件目を黙らせても気付けない
    expect(
      dependencies.filter((dependency) => ignored.includes(dependency)).toSorted(),
      "runtime 依存は ignoreDependencies ではなく、使う側を足して直す",
    ).toEqual([...fallowSilencedRuntimeDependencies].toSorted());
  });

  // semantic モードは識別子を同一視するので、Effect の定型（Tool.make・Context.Service・
  // Schema.TaggedError）どうしが重複に見える。除外で黙らせると完全な複製も見落とすため、
  // 識別子を区別するモード + near で定型を避け、除外は持たない。threshold は重複率の上限で、
  // 0 は「上限なし」なので、小さい正の値でないと重複がゲートを落とさない。
  test("src code cannot be silenced from duplicate detection", () => {
    const duplicates = requireRecord(readFallowConfig()["duplicates"], "duplicates");
    const fix = "重複は除外ではなく共通化で直す";

    expect(srcPatterns(duplicates["ignore"]), fix).toEqual([]);
    expect(duplicates["ignoredClones"] ?? [], fix).toEqual([]);
    expect(["weak", "mild", "strict"], "semantic は Effect の定型に当たる").toContain(
      duplicates["mode"],
    );
    expect(duplicates["near"], "near が無いと改名した複製を見落とす").toBe(true);
    expect(duplicates["threshold"], "0 は上限なしで、重複がゲートを落とさない").toBeGreaterThan(0);
    expect(duplicates["threshold"]).toBeLessThanOrEqual(0.01);
  });

  test("src code cannot be silenced from complexity checks", () => {
    const health = requireRecord(readFallowConfig()["health"], "health");
    const fix = "上限を超えた関数は分けて直す";

    expect(srcPatterns(health["ignore"]), fix).toEqual([]);
    expect(health["thresholdOverrides"] ?? [], fix).toEqual([]);
    expect(health["suggestInlineSuppression"], "抑止コメントの案を出さない").toBe(false);
    expect(health["maxCyclomatic"]).toBeLessThanOrEqual(5);
    expect(health["maxCognitive"]).toBeLessThanOrEqual(5);
    expect(health["maxCrap"]).toBeLessThanOrEqual(30);
  });

  // ADR-0005 決定 7: Chrome を使ってよいのは video_render_cut と video_preview_cut だけ（tool 名の列挙で限定する）
  test("only the two Chrome tools and the wiring can import the Chrome supply", () => {
    const config = readFallowConfig();
    const boundaries = requireRecord(config["boundaries"], "boundaries");
    const zones = new Map(
      (Array.isArray(boundaries["zones"]) ? boundaries["zones"] : []).map((zone) => {
        const record = requireRecord(zone, "zone");
        return [record["name"], record["patterns"]] as const;
      }),
    );
    const fix = "Chrome を使う tool を増やすなら、ADR-0005 決定 7 の改訂を同じ差分に含める";

    expect(zones.get("chrome")).toEqual(
      expect.arrayContaining(["src/lib/chrome.ts", "src/lib/cdp.ts", "src/lib/chrome-pin.ts"]),
    );
    expect(zones.get("chrome-users"), fix).toEqual([
      "src/tools/explainer/video.renderCut.ts",
      "src/tools/explainer/video.previewCut.ts",
      "src/compositions/capture.ts",
    ]);
    expect(zones.get("wiring"), "Layer を組む entry point と handler の配線だけ").toEqual([
      "src/index.ts",
      "src/mcp.ts",
    ]);
    expect(zones.get("core"), "残りの src はすべて境界の内側に入れる").toEqual(["src/**"]);

    const importersOfChrome = (Array.isArray(boundaries["rules"]) ? boundaries["rules"] : [])
      .map((rule) => requireRecord(rule, "rule"))
      .filter((rule) =>
        [rule["allow"], rule["allowTypeOnly"]].some(
          (targets) => Array.isArray(targets) && targets.includes("chrome"),
        ),
      )
      .map((rule) => rule["from"]);
    expect(importersOfChrome.toSorted(), fix).toEqual(["chrome-users", "wiring"]);

    const rules = requireRecord(config["rules"], "rules");
    expect(rules["boundary-violation"], "境界の違反はゲートを落とす").toBe("error");
  });

  test("dependency and suppression findings fail the gate instead of warning", () => {
    const rules = requireRecord(readFallowConfig()["rules"], "rules");

    expect(Object.fromEntries(enforcedFallowRules.map((rule) => [rule, rules[rule]]))).toEqual(
      Object.fromEntries(enforcedFallowRules.map((rule) => [rule, "error"])),
    );
  });

  test("src code carries no inline suppression of duplication or complexity", () => {
    const suppressions = readdirSync(join(packageRoot, "src"), { recursive: true })
      .map(String)
      .filter((path) => path.endsWith(".ts"))
      .flatMap((path) =>
        silencingSuppressions(readFileSync(join(packageRoot, "src", path), "utf8")).map(
          (comment) => `src/${path}: ${comment}`,
        ),
      );

    expect(suppressions, "重複と複雑度の違反は抑止せずに直す").toEqual([]);
  });
});

describe("K2 release guard", () => {
  test("a release commit outside main is rejected before publish", () => {
    withTemporaryDirectory("nyaucast-release-ancestor-", (directory) => {
      const environment = isolatedEnvironment({
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
      });
      const git = (...arguments_: string[]) => {
        const result = spawnSync("git", arguments_, {
          cwd: directory,
          encoding: "utf8",
          env: environment,
        });
        if (result.status !== 0) {
          throw new Error(result.stderr);
        }
        return result.stdout.trim();
      };
      git("init", "--initial-branch=main");
      git("config", "user.name", "Release Contract");
      git("config", "user.email", "release@example.invalid");
      writeFileSync(join(directory, "main.txt"), "reviewed\n");
      git("add", "main.txt");
      git("commit", "-m", "reviewed");
      const main = git("rev-parse", "HEAD");
      writeFileSync(join(directory, "candidate.txt"), "unreviewed\n");
      git("add", "candidate.txt");
      git("commit", "-m", "unreviewed");
      const candidate = git("rev-parse", "HEAD");
      git("update-ref", "refs/remotes/origin/main", main);

      const result = spawnSync(
        "bash",
        [join(packageRoot, ".github/scripts/check-release-ancestor.sh"), candidate, "origin/main"],
        { cwd: directory, encoding: "utf8", env: environment },
      );
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("is not an ancestor");

      const steps = releaseSteps();
      const guardIndex = steps.findIndex(
        (step) => typeof step.run === "string" && step.run.includes("check-release-ancestor.sh"),
      );
      const publishIndex = steps.findIndex((step) => step["name"] === "Publish package");
      expect(guardIndex).toBeGreaterThanOrEqual(0);
      expect(guardIndex).toBeLessThan(publishIndex);
    });
  });

  test("a tag whose version differs from package.json stops before publish", () => {
    const result = runBash(
      publishScript(),
      packageRoot,
      isolatedEnvironment({
        DRY_RUN: "false",
        GITHUB_EVENT_NAME: "push",
        GITHUB_REF_NAME: "v999.0.0",
      }),
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("does not match package version");
  });

  test("manual dispatch can invoke only a dry-run staged publish", () => {
    const { result, calls } = runPublishWithFakePnpm({
      DRY_RUN: "true",
      GITHUB_EVENT_NAME: "workflow_dispatch",
      GITHUB_REF_NAME: "main",
    });

    expect(requireRecord(publishStep()["env"], "publish environment")["DRY_RUN"]).toBe(
      "${{ github.event_name == 'workflow_dispatch' }}",
    );
    expect(result.status).toBe(0);
    expect(calls).toBe("stage publish --dry-run --no-git-checks");
  });

  test("a matching release tag stages the package instead of publishing it directly", () => {
    const { result, calls } = runPublishWithFakePnpm({
      DRY_RUN: "false",
      GITHUB_EVENT_NAME: "push",
      GITHUB_REF_NAME: "v0.0.0",
    });

    expect(result.status).toBe(0);
    expect(calls).toBe("stage publish --no-git-checks");
  });

  test("package metadata identifies the package name and the single bin entry", () => {
    const manifest = readJson(join(packageRoot, "package.json"));
    expect(manifest["name"]).toBe("nyaucast");
    expect(manifest["bin"]).toEqual({ nyaucast: "bin/nyaucast.js" });
  });

  test("package metadata identifies the trusted publishing repository", () => {
    const manifest = readJson(join(packageRoot, "package.json"));
    expect(manifest["repository"]).toEqual({
      type: "git",
      url: trustedRepositoryUrl,
    });
  });

  test("package metadata declares Apache-2.0 as the only license", () => {
    const manifest = readJson(join(packageRoot, "package.json"));
    expect(manifest["license"]).toBe("Apache-2.0");
  });

  test("LICENSE carries the Apache-2.0 text and NOTICE carries the copyright", () => {
    const license = readFileSync(join(packageRoot, "LICENSE"), "utf8");
    const notice = readFileSync(join(packageRoot, "NOTICE"), "utf8");
    expect(license).toMatch(/Apache License\s+Version 2\.0, January 2004/);
    expect(notice).toContain("Copyright 2026 daiki-beppu");
  });
});

describe("K4 credential and concurrency contracts", () => {
  test("every checkout refuses to persist credentials", () => {
    const checkoutSteps = readdirSync(join(packageRoot, ".github/workflows"))
      .filter((name) => /\.ya?ml$/.test(name))
      .flatMap((name) => workflowJobs(readWorkflow(name)))
      .flatMap(jobSteps)
      .filter((step) => typeof step.uses === "string" && step.uses.startsWith("actions/checkout@"));

    expect(checkoutSteps.length).toBeGreaterThan(0);
    for (const step of checkoutSteps) {
      expect(step.with?.["persist-credentials"]).toBe(false);
    }
  });

  // pnpm/setup は既定で lockfile が無くても install して lockfile を作り、成功してしまう（#739）
  test("every pnpm/setup install requires the lockfile", () => {
    const setupSteps = readdirSync(join(packageRoot, ".github/workflows"))
      .filter((name) => /\.ya?ml$/.test(name))
      .flatMap((name) => workflowJobs(readWorkflow(name)))
      .flatMap(jobSteps)
      .filter((step) => typeof step.uses === "string" && step.uses.startsWith("pnpm/setup@"));

    expect(setupSteps.length).toBeGreaterThan(0);
    for (const step of setupSteps) {
      expect(step.with?.["require-lockfile"]).toBe(true);
    }
  });

  test("CI and release concurrency groups cannot collide", () => {
    const ci = readWorkflow("ci.yml");
    const release = readWorkflow("release.yml");
    const quality = workflowJobs(ci).find((job) => job["runs-on"] !== undefined);
    if (quality === undefined) {
      throw new Error("CI quality job must exist");
    }
    const ciGroup = requireRecord(quality["concurrency"], "CI concurrency")["group"];
    const releaseGroup = requireRecord(release["concurrency"], "release concurrency")["group"];
    if (typeof ciGroup !== "string" || typeof releaseGroup !== "string") {
      throw new TypeError("concurrency groups must be strings");
    }

    expect(ci["concurrency"]).toBeUndefined();
    expect(ciGroup.toLowerCase()).not.toBe(releaseGroup.toLowerCase());
    expect(ciGroup.split("${{")[0]?.toLowerCase()).not.toBe(
      releaseGroup.split("${{")[0]?.toLowerCase(),
    );
  });
});

describe("Chrome download cache in CI", () => {
  const qualitySteps = () => {
    const quality = workflowJobs(readWorkflow("ci.yml")).find(
      (job) => job["runs-on"] !== undefined,
    );
    if (quality === undefined) {
      throw new Error("CI quality job must exist");
    }
    return jobSteps(quality);
  };
  // フォントや Vitest の cache も actions/cache を使うので、Chrome の cache は id で特定する。
  const isChromeCache = (step: ReturnType<typeof qualitySteps>[number]) =>
    step["id"] === "chrome-cache";
  const cacheStep = () => {
    const step = qualitySteps().find(isChromeCache);
    if (
      step === undefined ||
      typeof step.uses !== "string" ||
      !step.uses.startsWith("actions/cache@")
    ) {
      throw new Error(
        "CI quality job must restore a Chrome cache with actions/cache (id: chrome-cache)",
      );
    }
    return step;
  };
  const pinStep = () => {
    const step = qualitySteps().find((candidate) => candidate["id"] === "chrome-pin");
    if (step === undefined || typeof step.run !== "string") {
      throw new Error("CI quality job must have a run step with id chrome-pin");
    }
    return step;
  };

  test("the cache step runs before the check and is pinned to a commit SHA", () => {
    const steps = qualitySteps();
    const check = steps.findIndex((step) => step.run?.trim() === canonicalCheckCommand);

    const cache = steps.findIndex(isChromeCache);

    expect(cache).toBeGreaterThanOrEqual(0);
    expect(cache).toBeLessThan(check);
    expect(cacheStep().uses).toMatch(/^actions\/cache@[0-9a-f]{40}$/);
  });

  test("the cache directory is the one the runtime downloads Chrome into", () => {
    expect(cacheStep().with?.["path"]).toBe(chromeCacheDirectory("~"));
  });

  test("the cache key carries the pinned build id that the pin step extracts from the pin file", () => {
    const key = cacheStep().with?.["key"];
    expect(key).toContain("steps.chrome-pin.outputs.build-id");

    const result = withTemporaryDirectory("nyaucast-chrome-pin-", (directory) => {
      const output = join(directory, "github-output");
      writeFileSync(output, "");
      const run = runBash(
        pinStep().run ?? "",
        packageRoot,
        isolatedEnvironment({ GITHUB_OUTPUT: output }),
      );
      return { output: readFileSync(output, "utf8"), run };
    });

    expect(result.run.status).toBe(0);
    expect(result.output.trim()).toBe(`build-id=${chromeHeadlessShellBuildId}`);
  });

  test("the runner's preinstalled Chrome is not used", () => {
    for (const step of qualitySteps()) {
      expect(JSON.stringify(step)).not.toMatch(/browser-actions|setup-chrome|google-chrome/u);
    }
  });
});
