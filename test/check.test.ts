import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  parseYamlRecord,
  readRepositoryFile,
  withTemporaryDirectory,
} from "./helpers";

// REQ-70-01 / REQ-70-03 / REQ-70-04 / REQ-70-05 / REQ-70-06
// TC-70-01A / TC-70-01B / TC-70-03A / TC-70-03B / TC-70-04A / TC-70-04B / TC-70-05A / TC-70-05B / TC-70-06A
const subprocessTimeoutMilliseconds = 20_000;
const invalidCheckScriptMessage =
  "check script must contain only bun run commands joined by &&";
const ciCheckCommand = "nix develop --command bun run check";
const directTestCommand = "bun run test";
const prePushCommands = {
  check: "bun run check",
  "workflow-doctor": "takt workflow doctor",
} as const;

type FacetCommandScope =
  | { container: "root" }
  | {
      container: "ordered-list-item";
      introduction: string;
      ordinal: number;
    };

const rootFacetCommandScope = { container: "root" } as const;
const completionGateInstruction = "完了前に、CI と同一の検査ゲートを通す:";
const expectedLockfileCheckCommand =
  "bun install --frozen-lockfile --dry-run --ignore-scripts";
const lockfileName = "bun.lock";
const prepareSentinelName = "prepare-ran";

/**
 * 「ローカルで CI を再現する」を指示する facet。
 *
 * `tayk-reproduce.md` はここに含めない。その `bun test` はゲートの再現ではなく
 * **red の観測**であり、まだ実装が無い状態で
 * 全ゲートを通すことは設計上できない。
 */
const gateInstructingFacets = [
  {
    commandScope: rootFacetCommandScope,
    path: ".takt/facets/policies/tayk-toolchain.md",
    sectionHeading: "## 検査ゲート",
  },
  {
    commandScope: {
      container: "ordered-list-item",
      introduction: completionGateInstruction,
      ordinal: 6,
    },
    path: ".takt/facets/instructions/tayk-repair.md",
    sectionHeading: "## 手順",
  },
] as const;

/**
 * ゲート集合の複製を検出する表記。`test` は red 観測にも使うため対象外。
 *
 * `lint` だけ後読みで絞るのは、`lint:fix` が fix 系でありゲートの複製ではないため。
 * 末尾改行で代用すると、行末以外に現れた `bun run lint` を取りこぼす。
 */
const enumeratedGateCommands = [
  /bun run typecheck/,
  /bun run lint(?![\w:-])/,
  /bun run actions:check/,
  /bun run format:check/,
  /bun run format:nix:check/,
  /bun run fallow/,
] as const;

setDefaultTimeout(60_000);

function requireRecord(
  value: unknown,
  description: string
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${description} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireRecordProperty(
  record: Record<string, unknown>,
  property: string,
  description: string
): Record<string, unknown> {
  return requireRecord(record[property], description);
}

function requireArrayProperty(
  record: Record<string, unknown>,
  property: string,
  description: string
): unknown[] {
  const value = record[property];
  if (!Array.isArray(value)) {
    throw new TypeError(`${description} must be an array`);
  }
  return value;
}

function readStepRun(
  step: Record<string, unknown>,
  description: string
): string | undefined {
  const run = step["run"];
  if (run !== undefined && typeof run !== "string") {
    throw new TypeError(`${description}.run must be a string`);
  }
  return run;
}

function extractJobSteps(
  steps: readonly unknown[],
  description: string
): Record<string, unknown>[] {
  return steps.map((step, index) => {
    const stepDescription = `${description}[${index}]`;
    const stepRecord = requireRecord(step, stepDescription);
    readStepRun(stepRecord, stepDescription);
    return stepRecord;
  });
}

function extractJobs(
  jobs: Record<string, unknown>
): Map<
  string,
  { record: Record<string, unknown>; steps: Record<string, unknown>[] }
> {
  return new Map(
    Object.entries(jobs).map(([jobName, job]) => {
      const jobRecord = requireRecord(job, `jobs.${jobName}`);
      const steps = jobRecord["steps"];
      const jobSteps =
        steps === undefined
          ? []
          : extractJobSteps(
              requireArrayProperty(jobRecord, "steps", `jobs.${jobName}.steps`),
              `jobs.${jobName}.steps`
            );
      return [jobName, { record: jobRecord, steps: jobSteps }];
    })
  );
}

function readWorkflowJob(
  workflow: Record<string, unknown>,
  jobName: string
): { record: Record<string, unknown>; steps: Record<string, unknown>[] } {
  const jobs = extractJobs(requireRecordProperty(workflow, "jobs", "jobs"));
  const job = jobs.get(jobName);
  if (job === undefined) {
    throw new Error(`jobs.${jobName} must exist`);
  }
  return job;
}

function readCheckoutSteps(
  workflow: Record<string, unknown>
): Record<string, unknown>[] {
  const jobs = extractJobs(requireRecordProperty(workflow, "jobs", "jobs"));
  return [...jobs.values()].flatMap(({ record, steps }) => {
    // reusable workflow を呼ぶ job は steps を持たない。ここで呼び出し先へ降りないと
    // 「すべての checkout」を名乗る検査が委譲先の checkout を素通りする。
    const delegated = record["uses"];
    if (typeof delegated === "string") {
      if (!delegated.startsWith("./")) {
        throw new Error(
          `jobs.*.uses must reference a workflow inside this repository: ${delegated}`
        );
      }
      return readCheckoutSteps(
        parseYamlRecord({
          expectedShape: "a workflow object",
          relativePath: delegated,
          source: readRepositoryFile(delegated.slice(2)),
        })
      );
    }
    return steps.filter(
      (step) =>
        typeof step["uses"] === "string" &&
        step["uses"].startsWith("actions/checkout@")
    );
  });
}

function validateCompositeAction(source: string): number {
  const action = parseYamlRecord({
    expectedShape: "action",
    relativePath: "action",
    source,
  });
  const runs = requireRecordProperty(action, "runs", "runs");
  const steps = extractJobSteps(
    requireArrayProperty(runs, "steps", "runs.steps"),
    "runs.steps"
  );

  let checkCommandCount = 0;
  for (const [index, step] of steps.entries()) {
    const command = readStepRun(step, `runs.steps[${index}]`);
    if (command === undefined) {
      continue;
    }
    checkCommandCount += command.split(ciCheckCommand).length - 1;
    if (command.includes(directTestCommand)) {
      throw new Error(`composite actions must not run ${directTestCommand}`);
    }
  }
  return checkCommandCount;
}

function validateWorkflowCommands(
  workflows: readonly ReturnType<typeof extractJobs>[],
  actionSources: readonly string[]
): void {
  let checkCommandCount = 0;
  for (const [workflowIndex, jobs] of workflows.entries()) {
    for (const [jobName, job] of jobs) {
      for (const [stepIndex, step] of job.steps.entries()) {
        const command = readStepRun(
          step,
          `workflows[${workflowIndex}].jobs.${jobName}.steps[${stepIndex}]`
        );
        if (command === undefined) {
          continue;
        }
        checkCommandCount += command.split(ciCheckCommand).length - 1;
        if (command.includes(directTestCommand)) {
          throw new Error(`CI jobs must not run ${directTestCommand}`);
        }
        if (enumeratedGateCommands.some((gate) => gate.test(command))) {
          throw new Error("CI jobs must not run individual gates");
        }
      }
    }
  }
  for (const actionSource of actionSources) {
    checkCommandCount += validateCompositeAction(actionSource);
  }
  if (checkCommandCount !== 1) {
    throw new Error(`CI jobs must run ${ciCheckCommand} exactly once`);
  }
}

function validateCiWorkflow(
  source: string,
  relatedWorkflowSources: readonly string[],
  actionSources: readonly string[]
): void {
  const workflow = parseYamlRecord({
    expectedShape: "workflow",
    relativePath: "workflow",
    source,
  });
  const jobs = requireRecordProperty(workflow, "jobs", "jobs");
  const parsedJobs = extractJobs(jobs);
  const qualityJob = parsedJobs.get("quality");

  if (qualityJob === undefined || "if" in qualityJob.record) {
    throw new Error(`jobs.quality.steps must run ${ciCheckCommand}`);
  }

  const checkStep = qualityJob.steps.find(
    (step, index) =>
      readStepRun(step, `jobs.quality.steps[${index}]`) === ciCheckCommand &&
      !("if" in step)
  );
  if (checkStep === undefined) {
    throw new Error(`jobs.quality.steps must run ${ciCheckCommand}`);
  }

  const relatedJobs = relatedWorkflowSources.map((relatedSource, index) => {
    const relatedWorkflow = parseYamlRecord({
      expectedShape: "a workflow object",
      relativePath: `related workflow ${index}`,
      source: relatedSource,
    });
    return extractJobs(requireRecordProperty(relatedWorkflow, "jobs", "jobs"));
  });
  validateWorkflowCommands([parsedJobs, ...relatedJobs], actionSources);
}

function expectInvalidCiConfiguration(
  source: string,
  relatedWorkflowSources: readonly string[],
  compositeActionSources: readonly string[]
): void {
  expect(() => {
    validateCiWorkflow(source, relatedWorkflowSources, compositeActionSources);
  }).toThrow();
}

const hookExecutionLimitProperties = [
  "exclude",
  "exclude_tags",
  "files",
  "only",
  "skip",
] as const;
const commandExecutionLimitProperties = [
  "exclude",
  "file_types",
  "files",
  "glob",
  "only",
  "skip",
  "tags",
] as const;

function rejectExecutionLimits(
  record: Record<string, unknown>,
  properties: readonly string[],
  description: string
): void {
  const property = properties.find((candidate) => candidate in record);
  if (property !== undefined) {
    throw new Error(`${description}.${property} must not limit execution`);
  }
}

function readCommand(
  commands: Record<string, unknown>,
  commandName: keyof typeof prePushCommands
): Record<string, unknown> {
  const command = requireRecordProperty(
    commands,
    commandName,
    `pre-push.commands.${commandName}`
  );
  rejectExecutionLimits(
    command,
    commandExecutionLimitProperties,
    `pre-push.commands.${commandName}`
  );
  return command;
}

function readCommandRun(
  command: Record<string, unknown>,
  commandName: keyof typeof prePushCommands
): string {
  const run = command["run"];
  if (typeof run !== "string") {
    throw new TypeError(
      `pre-push.commands.${commandName}.run must be a string`
    );
  }
  return run;
}

function validatePrePushConfiguration(source: string): void {
  const configuration = parseYamlRecord({
    expectedShape: "a Lefthook configuration object",
    relativePath: "lefthook configuration",
    source,
  });
  const prePush = requireRecordProperty(configuration, "pre-push", "pre-push");
  rejectExecutionLimits(prePush, hookExecutionLimitProperties, "pre-push");
  const commands = requireRecordProperty(
    prePush,
    "commands",
    "pre-push.commands"
  );
  const expectedCommandNames = Object.keys(prePushCommands);
  const commandNames = Object.keys(commands);
  if (
    commandNames.length !== expectedCommandNames.length ||
    commandNames.some(
      (commandName) => !Object.hasOwn(prePushCommands, commandName)
    )
  ) {
    throw new Error("pre-push.commands must match the expected command set");
  }

  for (const [commandName, expectedRun] of Object.entries(prePushCommands)) {
    if (
      readCommandRun(
        readCommand(commands, commandName as keyof typeof prePushCommands),
        commandName as keyof typeof prePushCommands
      ) !== expectedRun
    ) {
      throw new Error(`pre-push.commands.${commandName}.run is invalid`);
    }
  }
}

function readSection(markdown: string, heading: string): string {
  const start = markdown.indexOf(`${heading}\n`);
  if (start === -1) {
    throw new Error(`missing section: ${heading}`);
  }

  const contentStart = start + heading.length + 1;
  const nextHeading = markdown.indexOf("\n## ", contentStart);
  return markdown.slice(
    contentStart,
    nextHeading === -1 ? markdown.length : nextHeading
  );
}

function readFacetInstructionSection(
  source: string,
  sectionHeading: string
): string {
  const section = readSection(source, sectionHeading);
  const exampleHeading = section.search(/^### /m);
  return exampleHeading === -1 ? section : section.slice(0, exampleHeading);
}

function escapeRegularExpression(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function canonicalCheckBlock(commandScope: FacetCommandScope): string {
  if (commandScope.container === "root") {
    return "```\nbun run check\n```";
  }
  return [
    `${commandScope.ordinal}. ${commandScope.introduction}`,
    "   ```",
    "   bun run check",
    "   ```",
  ].join("\n");
}

function canonicalCheckBlockPattern(commandScope: FacetCommandScope): RegExp {
  return new RegExp(
    `^${escapeRegularExpression(canonicalCheckBlock(commandScope))}$`,
    "m"
  );
}

function extractCanonicalShellCommandBlocks(source: string): string[][] {
  return [
    ...source.matchAll(
      /^( *)```(?:bash|sh|shell|zsh)?[ \t]*\n([\s\S]*?)^\1```[ \t]*$/gm
    ),
  ].map((match) => (match[2] ?? "").split(/\r?\n/).map((line) => line.trim()));
}

function validateFacetGate(
  source: string,
  sectionHeading: string,
  commandScope: FacetCommandScope
): void {
  const section = readFacetInstructionSection(source, sectionHeading);
  if (!canonicalCheckBlockPattern(commandScope).test(section)) {
    throw new Error(`${sectionHeading} must run bun run check`);
  }
  const commandBlocks = extractCanonicalShellCommandBlocks(section);
  for (const command of enumeratedGateCommands) {
    if (
      commandBlocks.some((commands) =>
        commands.some((line) => command.test(line))
      )
    ) {
      throw new Error(`${sectionHeading} must not run individual gates`);
    }
  }
}

function withCheckFixture(run: (directory: string) => void): void {
  withTemporaryDirectory("tayk-check-", run);
}

function readPackageScripts(): Record<string, string> {
  const parsed: unknown = JSON.parse(readRepositoryFile("package.json"));

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("package.json must contain a JSON object");
  }

  const scripts = (parsed as Record<string, unknown>)["scripts"];

  if (
    typeof scripts !== "object" ||
    scripts === null ||
    Array.isArray(scripts)
  ) {
    throw new Error("package.json must declare a scripts object");
  }

  return Object.fromEntries(
    Object.entries(scripts as Record<string, unknown>).map(
      ([name, command]) => {
        if (typeof command !== "string") {
          throw new TypeError(`script ${name} must be a string`);
        }
        return [name, command];
      }
    )
  );
}

function deriveExpectedGateNames(checkScript: string | undefined): string[] {
  if (checkScript === undefined || checkScript.trim() === "") {
    throw new Error(invalidCheckScriptMessage);
  }

  const gateName = "([A-Za-z0-9:._-]+)";
  const argument = String.raw`(?:[^\s'"&|;<>$\x60()]+|'[^'\r\n]*'|"[^"\r\n]*")`;
  const command = String.raw`bun[ \t]+run[ \t]+${gateName}(?:[ \t]+${argument})*`;
  const firstCommand = new RegExp(String.raw`[ \t]*${command}[ \t]*`, "y");
  const followingCommand = new RegExp(
    String.raw`&&[ \t]*${command}[ \t]*`,
    "y"
  );
  const gates: string[] = [];
  let index = 0;

  while (index < checkScript.length) {
    const matcher = gates.length === 0 ? firstCommand : followingCommand;
    matcher.lastIndex = index;
    const match = matcher.exec(checkScript);
    const matchedGate = match?.[1];

    if (matchedGate === undefined) {
      throw new Error(invalidCheckScriptMessage);
    }

    gates.push(matchedGate);
    index = matcher.lastIndex;
  }

  return gates;
}

function quoteShellArgument(argument: string): string {
  return `'${argument.replaceAll("'", "'\\''")}'`;
}

function createFacetFixture(
  sectionHeading: string,
  sectionBody: readonly string[],
  beforeSection: readonly string[] = [],
  afterSection: readonly string[] = []
): string {
  return [
    "# Fixture",
    ...beforeSection,
    sectionHeading,
    ...sectionBody,
    "## 次の節",
    ...afterSection,
    "",
  ].join("\n");
}

/**
 * 本物の `check` を各ゲートの stub に対して走らせる fixture を作る。
 *
 * `check` は `bun run test` を含むため、リポジトリ本体でそのまま実行すると
 * このテスト自身を経由して無限に再帰する。合成（順序と fail-fast）だけを見る。
 */
function createCheckFixture(
  directory: string,
  checkScript: string
): Record<string, string> {
  const gateNames = deriveExpectedGateNames(checkScript);

  writeFileSync(
    join(directory, "record.ts"),
    `import { appendFileSync, readFileSync } from "node:fs";

const gate = process.argv[2];
const recordPath = process.env["TAYK_GATE_RECORD"];
const failingIndex = process.env["TAYK_FAILING_INDEX"];

if (gate === undefined || recordPath === undefined || failingIndex === undefined) {
  throw new Error("gate recorder requires a gate, record path, and failing index");
}

const recordedGates = readFileSync(recordPath, "utf-8");
const executionIndex =
  recordedGates === "" ? 0 : recordedGates.split("\\n").length - 1;
appendFileSync(recordPath, \`\${gate}\\n\`);
process.exit(failingIndex === executionIndex.toString() ? 1 : 0);
`
  );

  const scripts = Object.fromEntries([
    ["check", checkScript],
    ...gateNames.map(
      (gate) => [gate, `bun record.ts ${quoteShellArgument(gate)}`] as const
    ),
  ]);

  writeFileSync(
    join(directory, "package.json"),
    `${JSON.stringify({ name: "tayk-check-fixture", private: true, scripts, type: "module", version: "0.0.0" }, null, 2)}\n`
  );

  return scripts;
}

function runCheck(
  directory: string,
  failingIndex: number | null
): { exitCode: number | null; executedGates: string[] } {
  const recordPath = join(directory, "gates.log");
  writeFileSync(recordPath, "");

  const result = Bun.spawnSync([process.execPath, "run", "check"], {
    cwd: directory,
    env: {
      ...process.env,
      TAYK_FAILING_INDEX: failingIndex === null ? "" : failingIndex.toString(),
      TAYK_GATE_RECORD: recordPath,
    },
    killSignal: "SIGKILL",
    stderr: "pipe",
    stdout: "pipe",
    timeout: subprocessTimeoutMilliseconds,
  });

  if (result.exitedDueToTimeout === true) {
    throw new Error(
      `check timed out\nstdout:\n${result.stdout.toString()}\nstderr:\n${result.stderr.toString()}`
    );
  }

  return {
    executedGates: readFileSync(recordPath, "utf-8")
      .split("\n")
      .filter((line) => line !== ""),
    exitCode: result.exitCode,
  };
}

interface LockfileCheckFixture {
  bunEnvironment: Record<string, string | undefined>;
  expectedFollowingGates: string[];
  lockfileBeforeCheck: string;
  recordPath: string;
}

interface LockfileCheckResult {
  executedGates: string[];
  exitCode: number | null;
  stderr: string;
}

function createIsolatedBunEnvironment(
  directory: string
): Record<string, string | undefined> {
  const configDirectory = join(directory, "bun-config");
  const cacheDirectory = join(directory, "bun-cache");
  mkdirSync(configDirectory);
  mkdirSync(cacheDirectory);

  return {
    ...process.env,
    BUN_INSTALL_CACHE_DIR: cacheDirectory,
    XDG_CONFIG_HOME: configDirectory,
  };
}

function runBunInstallForLockfile(
  directory: string,
  bunEnvironment: Record<string, string | undefined>
): void {
  const result = Bun.spawnSync(
    [process.execPath, "install", "--lockfile-only", "--ignore-scripts"],
    {
      cwd: directory,
      env: bunEnvironment,
      killSignal: "SIGKILL",
      stderr: "pipe",
      stdout: "pipe",
      timeout: subprocessTimeoutMilliseconds,
    }
  );

  if (result.exitedDueToTimeout === true || result.exitCode !== 0) {
    throw new Error(
      `lockfile fixture generation failed\nstdout:\n${result.stdout.toString()}\nstderr:\n${result.stderr.toString()}`
    );
  }
}

function writeGateRecorder(directory: string): void {
  writeFileSync(
    join(directory, "record.ts"),
    `import { appendFileSync } from "node:fs";

const gate = process.argv[2];
const recordPath = process.env["TAYK_GATE_RECORD"];

if (gate === undefined || recordPath === undefined) {
  throw new Error("gate recorder requires a gate and record path");
}

appendFileSync(recordPath, \`\${gate}\\n\`);
`
  );
}

function createLocalDependency(
  directory: string,
  dependencyName: string
): string {
  const dependencyDirectory = join(directory, dependencyName);
  mkdirSync(dependencyDirectory);
  writeFileSync(
    join(dependencyDirectory, "package.json"),
    `${JSON.stringify({ name: dependencyName, version: "1.0.0" }, null, 2)}\n`
  );
  return `file:./${dependencyName}`;
}

function createLockfileCheckFixture(
  directory: string,
  makeManifestInconsistent: boolean
): LockfileCheckFixture {
  const repositoryScripts = readPackageScripts();
  const checkScript = repositoryScripts["check"];
  const lockfileCheckCommand = repositoryScripts["lockfile:check"];

  if (checkScript === undefined || lockfileCheckCommand === undefined) {
    throw new Error(
      "package.json must declare check and lockfile:check scripts"
    );
  }

  const gateNames = deriveExpectedGateNames(checkScript);
  const expectedFollowingGates = gateNames.slice(1);
  const recordPath = join(directory, "gates.log");
  const scripts = Object.fromEntries([
    ["prepare", `bun -e "Bun.write('${prepareSentinelName}', '')"`],
    ["check", checkScript],
    ["lockfile:check", lockfileCheckCommand],
    ...expectedFollowingGates.map(
      (gate) => [gate, `bun record.ts ${quoteShellArgument(gate)}`] as const
    ),
  ]);
  const currentDependencyName = "fixture-current-local-dependency";
  const currentDependencyReference = createLocalDependency(
    directory,
    currentDependencyName
  );
  const packageManifest = {
    dependencies: {
      [currentDependencyName]: currentDependencyReference,
    },
    name: "tayk-lockfile-check-fixture",
    private: true,
    scripts,
    type: "module",
    version: "0.0.0",
  };

  writeGateRecorder(directory);
  writeFileSync(recordPath, "");
  writeFileSync(
    join(directory, "package.json"),
    `${JSON.stringify(packageManifest, null, 2)}\n`
  );

  const bunEnvironment = createIsolatedBunEnvironment(directory);
  runBunInstallForLockfile(directory, bunEnvironment);
  const lockfileBeforeCheck = readFileSync(
    join(directory, lockfileName),
    "latin1"
  );

  if (makeManifestInconsistent) {
    const addedDependencyName = "fixture-added-local-dependency";
    const addedDependencyReference = createLocalDependency(
      directory,
      addedDependencyName
    );
    writeFileSync(
      join(directory, "package.json"),
      `${JSON.stringify(
        {
          ...packageManifest,
          dependencies: {
            ...packageManifest.dependencies,
            [addedDependencyName]: addedDependencyReference,
          },
        },
        null,
        2
      )}\n`
    );
  }

  return {
    bunEnvironment,
    expectedFollowingGates,
    lockfileBeforeCheck,
    recordPath,
  };
}

function runLockfileCheckFixture(
  directory: string,
  fixture: LockfileCheckFixture
): LockfileCheckResult {
  const result = Bun.spawnSync([process.execPath, "run", "check"], {
    cwd: directory,
    env: {
      ...fixture.bunEnvironment,
      TAYK_GATE_RECORD: fixture.recordPath,
    },
    killSignal: "SIGKILL",
    stderr: "pipe",
    stdout: "pipe",
    timeout: subprocessTimeoutMilliseconds,
  });

  if (result.exitedDueToTimeout === true) {
    throw new Error(
      `lockfile check timed out\nstdout:\n${result.stdout.toString()}\nstderr:\n${result.stderr.toString()}`
    );
  }

  return {
    executedGates: readFileSync(fixture.recordPath, "utf-8")
      .split("\n")
      .filter((line) => line !== ""),
    exitCode: result.exitCode,
    stderr: result.stderr.toString(),
  };
}

function expectLockfileFixtureStateUnchanged(
  directory: string,
  lockfileBeforeCheck: string
): void {
  expect(existsSync(join(directory, "node_modules"))).toBeFalse();
  expect(existsSync(join(directory, prepareSentinelName))).toBeFalse();
  expect(readFileSync(join(directory, lockfileName), "latin1")).toBe(
    lockfileBeforeCheck
  );
}

describe("check command", () => {
  // REQ-114-01 / REQ-114-02 / TC-114-01A
  test("should run every check-derived gate exactly once in declaration order", () => {
    const checkScript = readPackageScripts()["check"];

    if (checkScript === undefined) {
      throw new Error("package.json must declare a check script");
    }

    const expectedGates = deriveExpectedGateNames(checkScript);

    withCheckFixture((directory) => {
      createCheckFixture(directory, checkScript);

      const result = runCheck(directory, null);

      expect(result).toEqual({
        executedGates: expectedGates,
        exitCode: 0,
      });
    });
  });

  // REQ-114-02 / TC-114-02B
  test("should stop at each failing position in the check-derived gate sequence", () => {
    const checkScript = readPackageScripts()["check"];

    if (checkScript === undefined) {
      throw new Error("package.json must declare a check script");
    }

    const derivedGates = deriveExpectedGateNames(checkScript);

    for (const failingIndex of derivedGates.keys()) {
      withCheckFixture((directory) => {
        createCheckFixture(directory, checkScript);

        const result = runCheck(directory, failingIndex);
        const expectedPrefix = derivedGates.slice(0, failingIndex + 1);

        expect(result.exitCode).not.toBe(0);
        expect(result.executedGates).toEqual(expectedPrefix);
      });
    }
  });

  // REQ-247-01
  test.each([
    ["bun run alpha", ["alpha"]],
    ["bun run alpha && bun run added", ["alpha", "added"]],
  ])(
    "should follow added and removed gates derived from %p without fixture changes",
    (checkScript, expectedGates) => {
      withCheckFixture((directory) => {
        const scripts = createCheckFixture(directory, checkScript);

        const result = runCheck(directory, null);

        expect(Object.keys(scripts)).toEqual([
          "check",
          ...new Set(expectedGates),
        ]);
        expect(result).toEqual({
          executedGates: expectedGates,
          exitCode: 0,
        });
      });
    }
  );

  test("should keep a quoted && inside an argument", () => {
    const checkScript =
      'bun run alpha --label "quality && gate" && bun run beta';

    expect(deriveExpectedGateNames(checkScript)).toEqual(["alpha", "beta"]);
  });

  test("should reject a connector other than &&", () => {
    expect(() => {
      deriveExpectedGateNames("bun run alpha || bun run beta");
    }).toThrow("check script must contain only bun run commands joined by &&");
  });

  // REQ-106-01 / TC-106-01A
  test("should reject a stale lockfile without changing dependency state", () => {
    expect(readPackageScripts()["lockfile:check"]).toBe(
      expectedLockfileCheckCommand
    );

    withCheckFixture((directory) => {
      const fixture = createLockfileCheckFixture(directory, true);

      const result = runLockfileCheckFixture(directory, fixture);
      const normalizedStderr = result.stderr.toLowerCase();

      expect(result.exitCode).not.toBe(0);
      expect(normalizedStderr).toContain("lockfile");
      expect(normalizedStderr).toMatch(
        /(frozen[\s\S]*(change|update)|(change|update)[\s\S]*frozen)/
      );
      expectLockfileFixtureStateUnchanged(
        directory,
        fixture.lockfileBeforeCheck
      );
    });
  });

  // REQ-106-03 / TC-106-03A
  test("should place lockfile:check first in the check-derived gate sequence", () => {
    const checkScript = readPackageScripts()["check"];

    expect(deriveExpectedGateNames(checkScript)[0]).toBe("lockfile:check");
  });

  // REQ-106-03 / TC-106-03B
  test("should stop before every following gate when lockfile validation fails", () => {
    withCheckFixture((directory) => {
      const fixture = createLockfileCheckFixture(directory, true);

      const result = runLockfileCheckFixture(directory, fixture);

      expect(result.exitCode).not.toBe(0);
      expect(result.executedGates).toEqual([]);
      expectLockfileFixtureStateUnchanged(
        directory,
        fixture.lockfileBeforeCheck
      );
    });
  });

  // REQ-106-04 / TC-106-04A
  test("should continue through every following gate when the lockfile is current", () => {
    withCheckFixture((directory) => {
      const fixture = createLockfileCheckFixture(directory, false);

      const result = runLockfileCheckFixture(directory, fixture);

      expect(result.exitCode).toBe(0);
      expect(result.executedGates).toEqual(fixture.expectedFollowingGates);
      expectLockfileFixtureStateUnchanged(
        directory,
        fixture.lockfileBeforeCheck
      );
    });
  });

  // REQ-82-02 / REQ-106-01 / REQ-106-02 / REQ-115-01
  // REQ-294-01 / REQ-294-02
  // TC-106-01C / TC-106-02A / TC-115-01A / TC-115-01D / TC-294-01A / TC-294-02A
  test("should leave the gate set undefined outside package.json", () => {
    const workflow = readRepositoryFile(".github/workflows/ci.yml");
    const releaseWorkflow = readRepositoryFile(".github/workflows/release.yml");
    const setupAction = readRepositoryFile(
      ".github/actions/setup-nix/action.yml"
    );

    expect(() => {
      validateCiWorkflow(workflow, [releaseWorkflow], [setupAction]);
    }).not.toThrow();
    expect(workflow).toContain(ciCheckCommand);

    for (const source of [workflow, setupAction]) {
      expect(source).not.toMatch(/\bbun\s+install\b/);
      expect(source).not.toContain("--frozen-lockfile");
      for (const command of enumeratedGateCommands) {
        expect(source).not.toMatch(command);
      }
    }
  });

  // REQ-82-03 / REQ-106-01 / REQ-115-02 / REQ-308-01
  // TC-106-01B / TC-115-02A / TC-308-01A
  test("should run the gates before push", () => {
    const configuration = readRepositoryFile("lefthook.yml");

    expect(() => {
      validatePrePushConfiguration(configuration);
    }).not.toThrow();
  });

  // REQ-82-04 / REQ-115-04 / TC-115-04A
  test("should point takt facets at the single gate command", () => {
    for (const facetContract of gateInstructingFacets) {
      const facet = readRepositoryFile(facetContract.path);

      expect(() => {
        validateFacetGate(
          facet,
          facetContract.sectionHeading,
          facetContract.commandScope
        );
      }).not.toThrow();
    }
  });

  test("should reject every canonical facet when its check block is removed", () => {
    for (const facetContract of gateInstructingFacets) {
      const facet = readRepositoryFile(facetContract.path);
      const mutatedFacet = facet.replace(
        canonicalCheckBlock(facetContract.commandScope),
        ""
      );

      expect(mutatedFacet).not.toBe(facet);
      expect(() => {
        validateFacetGate(
          mutatedFacet,
          facetContract.sectionHeading,
          facetContract.commandScope
        );
      }).toThrow();
    }
  });

  // REQ-82-05
  test("should keep fix scripts on the rule set of their checking counterpart", () => {
    const scripts = readPackageScripts();
    const lint = scripts["lint"] ?? "";
    const lintFix = scripts["lint:fix"] ?? "";
    const formatCheck = scripts["format:check"] ?? "";
    const formatFix = scripts["format:fix"] ?? "";

    expect(lint).toContain("--type-aware");
    expect(lintFix).toContain("--type-aware");
    expect(lintFix).toContain("--config oxlint.config.ts");
    expect(formatCheck.endsWith(" .")).toBeTrue();
    expect(formatFix.endsWith(" .")).toBeTrue();
  });
});

describe("check entry structure", () => {
  // REQ-115-01 / TC-115-01B
  test.each([
    ["is missing", "jobs:\n  quality: {}\n"],
    ["is null", "jobs:\n  quality:\n    steps: null\n"],
    ["is an object", "jobs:\n  quality:\n    steps: {}\n"],
    ["is a string", "jobs:\n  quality:\n    steps: invalid\n"],
  ])(
    "should reject the CI contract when quality steps %s",
    (_condition, workflow) => {
      expectInvalidCiConfiguration(workflow, [], []);
    }
  );

  // REQ-115-01 / TC-115-01C
  test.each([
    ["is missing", "jobs:\n  quality:\n    steps:\n      - name: Check\n"],
    ["is null", "jobs:\n  quality:\n    steps:\n      - run: null\n"],
    [
      "is an array",
      "jobs:\n  quality:\n    steps:\n      - run: [nix, develop]\n",
    ],
    [
      "is an object",
      "jobs:\n  quality:\n    steps:\n      - run: { command: check }\n",
    ],
  ])(
    "should reject the CI check entry when its run value %s",
    (_condition, workflow) => {
      expectInvalidCiConfiguration(workflow, [], []);
    }
  );

  // REQ-115-01 / TC-115-01E
  test("should reject an individual gate command when another CI job runs it", () => {
    const workflow = [
      "jobs:",
      "  quality:",
      "    steps:",
      "      - run: nix develop --command bun run check",
      "  other:",
      "    steps:",
      "      - run: bun run typecheck",
      "",
    ].join("\n");

    expect(() => {
      validateCiWorkflow(workflow, [], []);
    }).toThrow();
  });

  // REQ-115-01 / TC-115-01F
  test("should ignore an individual gate command when it appears only in a CI comment", () => {
    const workflow = [
      "jobs:",
      "  quality:",
      "    steps:",
      "      - run: nix develop --command bun run check",
      "  # bun run typecheck",
      "",
    ].join("\n");

    expect(() => {
      validateCiWorkflow(workflow, [], []);
    }).not.toThrow();
  });

  // REQ-115-01 / TC-115-01G
  test.each([
    [
      "quality job",
      [
        "jobs:",
        "  quality:",
        "    if: false",
        "    steps:",
        "      - run: nix develop --command bun run check",
        "",
      ].join("\n"),
    ],
    [
      "check step",
      [
        "jobs:",
        "  quality:",
        "    steps:",
        "      - if: false",
        "        run: nix develop --command bun run check",
        "",
      ].join("\n"),
    ],
  ])(
    "should reject check execution limited by if on the %s",
    (_place, workflow) => {
      expect(() => {
        validateCiWorkflow(workflow, [], []);
      }).toThrow();
    }
  );

  // REQ-115-02 / REQ-308-05 / TC-115-02B / TC-308-05A
  test("should reject pre-push when check and workflow doctor commands are swapped", () => {
    const configuration = [
      "pre-push:",
      "  commands:",
      "    check:",
      "      run: takt workflow doctor",
      "    workflow-doctor:",
      "      run: bun run check",
      "",
    ].join("\n");

    expect(() => {
      validatePrePushConfiguration(configuration);
    }).toThrow();
  });

  // REQ-308-02 / TC-308-02A
  test("should reject pre-push when an unexpected command is added", () => {
    const configuration = [
      "pre-push:",
      "  commands:",
      "    check:",
      "      run: bun run check",
      "    workflow-doctor:",
      "      run: takt workflow doctor",
      "    unexpected-command:",
      "      run: echo unexpected",
      "",
    ].join("\n");

    expect(() => {
      validatePrePushConfiguration(configuration);
    }).toThrow();
  });

  // REQ-115-02 / REQ-308-03 / TC-115-02C / TC-308-03A / TC-308-03B
  test.each([
    [
      "check",
      [
        "pre-push:",
        "  commands:",
        "    workflow-doctor:",
        "      run: takt workflow doctor",
        "",
      ].join("\n"),
    ],
    [
      "workflow-doctor",
      [
        "pre-push:",
        "  commands:",
        "    check:",
        "      run: bun run check",
        "",
      ].join("\n"),
    ],
  ])(
    "should reject pre-push when the %s command is missing",
    (_command, configuration) => {
      expect(() => {
        validatePrePushConfiguration(configuration);
      }).toThrow();
    }
  );

  // REQ-115-02 / REQ-308-05 / TC-115-02D / TC-308-05C
  test.each([
    ["pre-push is null", "pre-push: null\n"],
    ["pre-push is an array", "pre-push: []\n"],
    ["commands is missing", "pre-push: {}\n"],
    ["commands is null", "pre-push:\n  commands: null\n"],
    ["commands is an array", "pre-push:\n  commands: []\n"],
    [
      "check is a string",
      [
        "pre-push:",
        "  commands:",
        "    check: bun run check",
        "    workflow-doctor:",
        "      run: takt workflow doctor",
        "",
      ].join("\n"),
    ],
    [
      "workflow-doctor is null",
      [
        "pre-push:",
        "  commands:",
        "    check:",
        "      run: bun run check",
        "    workflow-doctor: null",
        "",
      ].join("\n"),
    ],
    [
      "check run is an object",
      [
        "pre-push:",
        "  commands:",
        "    check:",
        "      run: { command: check }",
        "    workflow-doctor:",
        "      run: takt workflow doctor",
        "",
      ].join("\n"),
    ],
    [
      "workflow-doctor run is an array",
      [
        "pre-push:",
        "  commands:",
        "    check:",
        "      run: bun run check",
        "    workflow-doctor:",
        "      run: [takt, workflow, doctor]",
        "",
      ].join("\n"),
    ],
  ])(
    "should reject the lefthook contract when %s",
    (_condition, configuration) => {
      expect(() => {
        validatePrePushConfiguration(configuration);
      }).toThrow();
    }
  );

  // REQ-115-02 / REQ-308-05 / TC-115-02E / TC-308-05B
  test.each([
    [
      "check has a suffix",
      [
        "pre-push:",
        "  commands:",
        "    check:",
        "      run: bun run check --silent",
        "    workflow-doctor:",
        "      run: takt workflow doctor",
        "",
      ].join("\n"),
    ],
    [
      "workflow doctor has a suffix",
      [
        "pre-push:",
        "  commands:",
        "    check:",
        "      run: bun run check",
        "    workflow-doctor:",
        "      run: takt workflow doctor --fix",
        "",
      ].join("\n"),
    ],
  ])("should reject pre-push when %s", (_condition, configuration) => {
    expect(() => {
      validatePrePushConfiguration(configuration);
    }).toThrow();
  });

  // REQ-115-02 / REQ-308-06 / TC-115-02F / TC-308-06A
  test.each([...hookExecutionLimitProperties])(
    "should reject pre-push when the hook has the %s execution limit",
    (property) => {
      const configuration = [
        "pre-push:",
        `  ${property}: restricted`,
        "  commands:",
        "    check:",
        "      run: bun run check",
        "    workflow-doctor:",
        "      run: takt workflow doctor",
        "",
      ].join("\n");

      expect(() => {
        validatePrePushConfiguration(configuration);
      }).toThrow();
    }
  );

  // REQ-115-02 / REQ-308-06 / TC-115-02G / TC-308-06B
  test.each(
    Object.keys(prePushCommands).flatMap((commandName) =>
      commandExecutionLimitProperties.map(
        (property) => [commandName, property] as const
      )
    )
  )(
    "should reject pre-push when %s has the %s execution limit",
    (commandName, property) => {
      const configuration = [
        "pre-push:",
        "  commands:",
        "    check:",
        "      run: bun run check",
        ...(commandName === "check" ? [`      ${property}: restricted`] : []),
        "    workflow-doctor:",
        "      run: takt workflow doctor",
        ...(commandName === "workflow-doctor"
          ? [`      ${property}: restricted`]
          : []),
        "",
      ].join("\n");

      expect(() => {
        validatePrePushConfiguration(configuration);
      }).toThrow();
    }
  );

  // REQ-115-03 / TC-115-03A
  test("should reject the CI entry when the expected command remains only in a comment", () => {
    const workflow = [
      "jobs:",
      "  quality:",
      "    steps:",
      "      - run: echo skipped",
      "      # run: nix develop --command bun run check",
      "",
    ].join("\n");

    expect(() => {
      validateCiWorkflow(workflow, [], []);
    }).toThrow();
  });

  // REQ-115-03 / TC-115-03B
  test("should reject the CI entry when only another job runs check", () => {
    const workflow = [
      "jobs:",
      "  quality:",
      "    steps:",
      "      - run: echo skipped",
      "  other:",
      "    steps:",
      "      - run: nix develop --command bun run check",
      "",
    ].join("\n");

    expect(() => {
      validateCiWorkflow(workflow, [], []);
    }).toThrow();
  });

  // REQ-115-03 / TC-115-03C
  test("should reject the hook entry when only pre-commit runs check", () => {
    const configuration = [
      "pre-commit:",
      "  commands:",
      "    check:",
      "      run: bun run check",
      "pre-push:",
      "  commands:",
      "    workflow-doctor:",
      "      run: takt workflow doctor",
      "",
    ].join("\n");

    expect(() => {
      validatePrePushConfiguration(configuration);
    }).toThrow();
  });

  // REQ-115-03 / TC-115-03D
  test("should reject the hook entry when check remains only in a comment", () => {
    const configuration = [
      "pre-push:",
      "  commands:",
      "    # check:",
      "    #   run: bun run check",
      "    workflow-doctor:",
      "      run: takt workflow doctor",
      "",
    ].join("\n");

    expect(() => {
      validatePrePushConfiguration(configuration);
    }).toThrow();
  });

  // REQ-115-03 / REQ-294-01 / TC-115-03E / TC-294-01B / TC-294-01C
  test.each([
    [
      "another job",
      "jobs:\n  quality:\n    steps:\n      - run: nix develop --command bun run check\n  other:\n    steps:\n      - run: nix develop --command bun run check\n",
    ],
    [
      "one run block",
      "jobs:\n  quality:\n    steps:\n      - run: |\n          nix develop --command bun run check\n          nix develop --command bun run check\n",
    ],
  ])("should reject duplicate canonical commands in %s", (_place, workflow) => {
    expectInvalidCiConfiguration(workflow, [], []);
  });

  // REQ-294-01 / TC-294-01D
  test("should ignore a canonical command that appears only in a YAML comment", () => {
    const workflow =
      "jobs:\n  quality:\n    steps:\n      # run: nix develop --command bun run check\n      - run: nix develop --command bun run check\n";

    expect(() => {
      validateCiWorkflow(workflow, [], []);
    }).not.toThrow();
  });

  // REQ-294-02 / TC-294-02B
  test("should reject a direct test command in a CI run block", () => {
    const workflow =
      "jobs:\n  quality:\n    steps:\n      - run: nix develop --command bun run check\n  other:\n    steps:\n      - run: |\n          echo preparing\n          bun run test\n";

    expectInvalidCiConfiguration(workflow, [], []);
  });

  // F-0001 / F-0002 / F-0003
  test.each([
    ["canonical command", ciCheckCommand],
    ["direct test command", directTestCommand],
  ])("should reject a %s added to a release job", (_case, command) => {
    const ci =
      "jobs:\n  quality:\n    steps:\n      - run: nix develop --command bun run check\n";
    const release = `jobs:\n  publish:\n    steps:\n      - run: ${command}\n`;

    expectInvalidCiConfiguration(ci, [release], []);
  });

  // REQ-294-02 / TC-294-02C
  test("should reject a direct test command in a composite action run step", () => {
    const action =
      "name: Setup Nix\nruns:\n  using: composite\n  steps:\n    - run: bun run test\n      shell: bash\n";

    expect(() => {
      validateCompositeAction(action);
    }).toThrow();
  });

  // F-0004
  test("should reject a canonical command added to a composite action", () => {
    const workflow =
      "jobs:\n  quality:\n    steps:\n      - run: nix develop --command bun run check\n";
    const action =
      "name: Setup Nix\nruns:\n  using: composite\n  steps:\n    - run: nix develop --command bun run check\n      shell: bash\n";
    expectInvalidCiConfiguration(workflow, [], [action]);
  });

  // REQ-294-02 / TC-294-02D
  test("should ignore direct test commands that appear only in YAML comments", () => {
    const workflow =
      "jobs:\n  quality:\n    steps:\n      # run: bun run test\n      - run: nix develop --command bun run check\n";
    const action =
      "name: Setup Nix\nruns:\n  using: composite\n  steps:\n    # - run: bun run test\n    - uses: example/action@0123456789abcdef\n";

    expect(() => {
      validateCiWorkflow(workflow, [], [action]);
    }).not.toThrow();
  });

  // REQ-294-02 / TC-294-02E
  test.each([
    ["missing", "runs:\n  using: composite\n"],
    ["null", "runs:\n  using: composite\n  steps: null\n"],
    ["object", "runs:\n  using: composite\n  steps: {}\n"],
    ["non-string run", "runs:\n  using: composite\n  steps:\n    - run: {}\n"],
  ])(
    "should reject composite action steps with a %s shape",
    (_case, action) => {
      expect(() => {
        validateCompositeAction(action);
      }).toThrow();
    }
  );

  // REQ-115-04 / TC-115-04B
  test("should accept the canonical facet command block", () => {
    const facet = createFacetFixture("## 手順", [
      "```",
      "bun run check",
      "```",
    ]);

    expect(() => {
      validateFacetGate(facet, "## 手順", rootFacetCommandScope);
    }).not.toThrow();
  });

  // REQ-115-04 / TC-115-04C
  test("should reject a facet when check appears only in another section", () => {
    const facet = createFacetFixture(
      "## 手順",
      ["説明だけです。"],
      [],
      ["```", "bun run check", "```"]
    );

    expect(() => {
      validateFacetGate(facet, "## 手順", rootFacetCommandScope);
    }).toThrow();
  });

  // REQ-115-04 / TC-115-04D
  test("should reject a facet when check appears only in prose", () => {
    const facet = createFacetFixture("## 手順", [
      "完了前に bun run check を実行する。",
    ]);

    expect(() => {
      validateFacetGate(facet, "## 手順", rootFacetCommandScope);
    }).toThrow();
  });

  // REQ-115-04 / TC-115-04E
  test("should reject a facet when check appears only in an example", () => {
    const facet = createFacetFixture("## 手順", [
      "説明だけです。",
      "### 例",
      "```",
      "bun run check",
      "```",
    ]);

    expect(() => {
      validateFacetGate(facet, "## 手順", rootFacetCommandScope);
    }).toThrow();
  });

  // REQ-115-04 / TC-115-04F
  test("should reject individual gates in a facet command block", () => {
    const facet = createFacetFixture("## 手順", [
      "```",
      "bun run check",
      "```",
      "",
      "```",
      "bun run typecheck",
      "```",
    ]);

    expect(() => {
      validateFacetGate(facet, "## 手順", rootFacetCommandScope);
    }).toThrow();
  });
});

describe("GitHub Actions execution constraints", () => {
  // REQ-187-01 / TC-187-01A
  test("should cancel superseded pull request CI runs without colliding with the release group", () => {
    const workflow = parseYamlRecord({
      expectedShape: "a CI workflow object",
      relativePath: ".github/workflows/ci.yml",
      source: readRepositoryFile(".github/workflows/ci.yml"),
    });

    // workflow レベルに置くと workflow_call 経由でも評価され、release の group と
    // 衝突して deadlock する。job レベルであることが要件そのもの。
    expect(workflow["concurrency"]).toBeUndefined();
    expect(readWorkflowJob(workflow, "quality").record["concurrency"]).toEqual({
      "cancel-in-progress": "${{ github.event_name == 'pull_request' }}",
      group: "ci-quality-${{ github.event.pull_request.number || github.ref }}",
    });
  });

  // REQ-187-01 / TC-187-01D
  test("should keep the CI concurrency group distinct from the release group", () => {
    const ciGroup = requireRecordProperty(
      readWorkflowJob(
        parseYamlRecord({
          expectedShape: "a CI workflow object",
          relativePath: ".github/workflows/ci.yml",
          source: readRepositoryFile(".github/workflows/ci.yml"),
        }),
        "quality"
      ).record,
      "concurrency",
      "jobs.quality.concurrency"
    )["group"];
    const releaseGroup = requireRecordProperty(
      parseYamlRecord({
        expectedShape: "a release workflow object",
        relativePath: ".github/workflows/release.yml",
        source: readRepositoryFile(".github/workflows/release.yml"),
      }),
      "concurrency",
      "concurrency"
    )["group"];

    // called workflow では ${{ github.workflow }} が呼び出し元名へ解決され、group 名は
    // 大文字小文字を区別しない。どちらの経路でも release の group と一致しないこと。
    expect(ciGroup).not.toContain("github.workflow");
    expect(String(ciGroup).toLowerCase()).not.toStartWith(
      String(releaseGroup).toLowerCase().split("${{")[0] ?? ""
    );
  });

  // REQ-187-01 / TC-187-01B
  test("should limit CI quality execution to fifteen minutes", () => {
    const workflow = parseYamlRecord({
      expectedShape: "a CI workflow object",
      relativePath: ".github/workflows/ci.yml",
      source: readRepositoryFile(".github/workflows/ci.yml"),
    });

    expect(readWorkflowJob(workflow, "quality").record["timeout-minutes"]).toBe(
      15
    );
  });

  // REQ-187-01 / TC-187-01C
  test("should prevent every CI checkout from persisting credentials", () => {
    const workflow = parseYamlRecord({
      expectedShape: "a CI workflow object",
      relativePath: ".github/workflows/ci.yml",
      source: readRepositoryFile(".github/workflows/ci.yml"),
    });
    const checkoutSteps = readCheckoutSteps(workflow);

    expect(checkoutSteps).not.toHaveLength(0);
    for (const checkout of checkoutSteps) {
      const checkoutOptions = requireRecordProperty(
        checkout,
        "with",
        "checkout.with"
      );
      expect(checkoutOptions["persist-credentials"]).toBe(false);
    }
  });

  // REQ-187-02 / TC-187-02A
  test("should serialize release runs for the same ref without cancellation", () => {
    const workflow = parseYamlRecord({
      expectedShape: "a release workflow object",
      relativePath: ".github/workflows/release.yml",
      source: readRepositoryFile(".github/workflows/release.yml"),
    });
    const concurrency = requireRecordProperty(
      workflow,
      "concurrency",
      "concurrency"
    );

    expect(concurrency).toEqual({
      "cancel-in-progress": false,
      group: "release-${{ github.ref }}",
    });
  });

  // REQ-187-02 / TC-187-02B
  test("should limit release publishing to fifteen minutes", () => {
    const workflow = parseYamlRecord({
      expectedShape: "a release workflow object",
      relativePath: ".github/workflows/release.yml",
      source: readRepositoryFile(".github/workflows/release.yml"),
    });

    expect(readWorkflowJob(workflow, "publish").record["timeout-minutes"]).toBe(
      15
    );
  });

  // REQ-187-02 / TC-187-02C
  test("should prevent every release checkout from persisting credentials", () => {
    const workflow = parseYamlRecord({
      expectedShape: "a release workflow object",
      relativePath: ".github/workflows/release.yml",
      source: readRepositoryFile(".github/workflows/release.yml"),
    });
    const checkoutSteps = readCheckoutSteps(workflow);

    expect(checkoutSteps).not.toHaveLength(0);
    for (const checkout of checkoutSteps) {
      const checkoutOptions = requireRecordProperty(
        checkout,
        "with",
        "checkout.with"
      );
      expect(checkoutOptions["persist-credentials"]).toBe(false);
    }
  });
});
