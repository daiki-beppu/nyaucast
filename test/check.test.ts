import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const packageRoot = resolve(import.meta.dirname, "..");
const subprocessTimeoutMilliseconds = 20_000;
const invalidCheckScriptMessage =
  "check script must contain only bun run commands joined by &&";

/**
 * 「ローカルで CI を再現する」を指示する facet。
 *
 * `tayk-write-tests.md` / `tayk-reproduce.md` はここに含めない。あの 2 つの `bun test` は
 * ゲートの再現ではなく **red の観測**（ADR-0008 決定 5 / 9 / 10）であり、まだ実装が無い状態で
 * 全ゲートを通すことは設計上できない。
 */
const gateInstructingFacetPaths = [
  ".takt/facets/policies/tayk-toolchain.md",
  ".takt/facets/instructions/tayk-implement.md",
  ".takt/facets/instructions/tayk-repair.md",
] as const;
const replanMonitorInstructionPath =
  ".takt/facets/instructions/tayk-loop-monitor-replan.md";
const planContractPath = ".takt/facets/output-contracts/tayk-plan.md";

/**
 * ゲート集合の複製を検出する表記。`test` は red 観測にも使うため対象外。
 *
 * `lint` だけ後読みで絞るのは、`lint:fix` が fix 系でありゲートの複製ではないため。
 * 末尾改行で代用すると、行末以外に現れた `bun run lint` を取りこぼす。
 */
const enumeratedGateCommands = [
  /bun run typecheck/,
  /bun run lint(?![\w:-])/,
  /bun run format:check/,
  /bun run fallow/,
] as const;

setDefaultTimeout(60_000);

function withTemporaryDirectory(run: (directory: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "tayk-check-"));

  try {
    run(directory);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

function readRepositoryFile(relativePath: string): string {
  return readFileSync(join(packageRoot, relativePath), "utf-8");
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

function tokenizeCheckScript(checkScript: string): string[][] {
  const shellWord =
    /(?:[^\s'"\\;&|<>#$`()?*[\]{}~]+|'[^'\r\n]*'|"(?:\\[^\r\n]|[^"\\$`\r\n])*"|\\[^\r\n])+/y;
  const commands: string[][] = [];
  let command: string[] = [];
  let index = 0;

  while (index < checkScript.length) {
    const whitespace = /^[ \t]+/.exec(checkScript.slice(index));
    if (whitespace !== null) {
      index += whitespace[0].length;
      continue;
    }

    if (checkScript.startsWith("&&", index)) {
      if (command.length === 0) {
        throw new Error(invalidCheckScriptMessage);
      }
      commands.push(command);
      command = [];
      index += 2;
      continue;
    }

    shellWord.lastIndex = index;
    const word = shellWord.exec(checkScript);
    if (word === null) {
      throw new Error(invalidCheckScriptMessage);
    }
    command.push(word[0]);
    index = shellWord.lastIndex;
  }

  if (command.length === 0) {
    throw new Error(invalidCheckScriptMessage);
  }
  commands.push(command);
  return commands;
}

function decodeShellWord(word: string): string {
  let decoded = "";
  let quote: "'" | '"' | null = null;

  for (let index = 0; index < word.length; index += 1) {
    const character = word[index];
    if (character === "'" && quote !== '"') {
      quote = quote === "'" ? null : "'";
      continue;
    }
    if (character === '"' && quote !== "'") {
      quote = quote === '"' ? null : '"';
      continue;
    }
    if (character === "\\" && quote !== "'") {
      const escaped = word[index + 1];
      if (escaped === undefined) {
        throw new Error(invalidCheckScriptMessage);
      }
      decoded +=
        quote !== '"' || '$`"\\'.includes(escaped) ? escaped : `\\${escaped}`;
      index += 1;
      continue;
    }
    decoded += character;
  }

  return decoded;
}

function deriveExpectedGateNames(checkScript: string | undefined): string[] {
  if (checkScript === undefined || checkScript.trim() === "") {
    throw new Error(invalidCheckScriptMessage);
  }

  return tokenizeCheckScript(checkScript).map((command) => {
    const executable = command[0];
    const subcommand = command[1];
    const rawGateName = command[2];

    if (
      executable === undefined ||
      subcommand === undefined ||
      decodeShellWord(executable) !== "bun" ||
      decodeShellWord(subcommand) !== "run" ||
      rawGateName === undefined
    ) {
      throw new Error(invalidCheckScriptMessage);
    }

    const gateName = decodeShellWord(rawGateName);
    if (gateName === "" || gateName.startsWith("-")) {
      throw new Error(invalidCheckScriptMessage);
    }

    return gateName;
  });
}

function quoteShellArgument(argument: string): string {
  return `'${argument.replaceAll("'", "'\\''")}'`;
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

describe("check command", () => {
  // REQ-114-01 / REQ-114-02 / TC-114-01A
  test("should run every check-derived gate exactly once in declaration order", () => {
    const checkScript = readPackageScripts()["check"];

    if (checkScript === undefined) {
      throw new Error("package.json must declare a check script");
    }

    const expectedGates = deriveExpectedGateNames(checkScript);

    withTemporaryDirectory((directory) => {
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
      withTemporaryDirectory((directory) => {
        createCheckFixture(directory, checkScript);

        const result = runCheck(directory, failingIndex);
        const expectedPrefix = derivedGates.slice(0, failingIndex + 1);

        expect(result.exitCode).not.toBe(0);
        expect(result.executedGates).toEqual(expectedPrefix);
      });
    }
  });

  // REQ-114-03 / TC-114-03A
  test.each([
    ["bun run alpha", ["alpha"]],
    ["bun run __proto__", ["__proto__"]],
    [
      " \tbun   run alpha --flag && bun run added argument\t ",
      ["alpha", "added"],
    ],
    [
      `bun run alpha --label "quality && gate" "left || right" "left \\| right" "a;b" "&" && bun run beta 'literal;value'`,
      ["alpha", "beta"],
    ],
    ["bun run alpha escaped\\|pipe", ["alpha"]],
    [
      `b\\un "run" "alpha'beta" "say \\"hi\\"" '$() is literal'`,
      ["alpha'beta"],
    ],
    [
      `bun run "alpha*beta" '?' '[a]' '{left,right}' '~' escaped\\* escaped\\? escaped\\[a\\] escaped\\{left,right\\} escaped\\~`,
      ["alpha*beta"],
    ],
  ])(
    "should follow the gates derived from %p without fixture changes",
    (checkScript, expectedGates) => {
      withTemporaryDirectory((directory) => {
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

  // REQ-114-01 / TC-114-01B / TC-114-01C
  test.each([
    [undefined],
    [""],
    ["   "],
    ["bun run"],
    ['bun run ""'],
    ["bun run --silent"],
    ["bun run -b alpha"],
    ["&& bun run alpha"],
    ["bun run alpha &&"],
    ["bun run alpha && && bun run beta"],
    ["bun run alpha && echo skipped"],
    ["bun run alpha || bun run beta"],
    ["bun run alpha | bun run beta"],
    ["bun run alpha & bun run beta"],
    ["bun run alpha; bun run beta"],
    ["bun run alpha\nbun run beta"],
    ["bun run alpha > ignored"],
    ["bun run alpha < input"],
    ["bun run alpha $(echo injected)"],
    ["bun run alpha `echo injected`"],
    ["bun run alpha # ignored"],
    ['bun run alpha "unterminated'],
    ["bun run alpha 'unterminated"],
    ["bun run alpha dangling\\"],
    ["bun run alpha $EXPANDED_ARGUMENT"],
    ["bun run alpha (echo nested)"],
    ["bun run *"],
    ["bun run alpha ?"],
    ["bun run [a]*"],
    ["bun run ~"],
    ["bun run {alpha,beta}"],
  ])(
    "should reject an invalid check script before fixture creation",
    (checkScript) => {
      expect(() => deriveExpectedGateNames(checkScript)).toThrow(
        "check script must contain only bun run commands joined by &&"
      );
    }
  );

  // REQ-114-03 / TC-114-03B
  test("should fail each repeated script occurrence by its position", () => {
    const repeatedGates = ["typecheck", "lint", "typecheck"];
    const checkScript = repeatedGates
      .map((gate) => `bun run ${gate}`)
      .join(" && ");

    for (const failingIndex of repeatedGates.keys()) {
      withTemporaryDirectory((directory) => {
        createCheckFixture(directory, checkScript);

        const result = runCheck(directory, failingIndex);
        const expectedPrefix = repeatedGates.slice(0, failingIndex + 1);

        expect(result.exitCode).not.toBe(0);
        expect(result.executedGates).toEqual(expectedPrefix);
      });
    }
  });

  // REQ-114-03 / TC-114-03C
  test("should stop at a failing __proto__ script", () => {
    const gates = ["alpha", "__proto__", "beta"];
    const checkScript = gates.map((gate) => `bun run ${gate}`).join(" && ");

    withTemporaryDirectory((directory) => {
      createCheckFixture(directory, checkScript);

      const result = runCheck(directory, 1);

      expect(result.exitCode).not.toBe(0);
      expect(result.executedGates).toEqual(["alpha", "__proto__"]);
    });
  });

  // REQ-82-02
  test("should leave the gate set undefined outside package.json", () => {
    const workflow = readRepositoryFile(".github/workflows/ci.yml");

    expect(workflow).toContain("bun run check");
    for (const command of enumeratedGateCommands) {
      expect(workflow).not.toMatch(command);
    }
  });

  // REQ-82-03
  test("should run the gates before push", () => {
    const configuration = readRepositoryFile("lefthook.yml");

    expect(configuration).toContain("pre-push:");
    expect(configuration).toContain("bun run check");
  });

  // REQ-82-04
  test("should point takt facets at the single gate command", () => {
    for (const facetPath of gateInstructingFacetPaths) {
      const facet = readRepositoryFile(facetPath);

      expect(facet).toContain("bun run check");
      for (const command of enumeratedGateCommands) {
        expect(facet).not.toMatch(command);
      }
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

describe("replan monitor report boundary", () => {
  // REQ-121-01 / TC-121-01 / P-121-01
  test("should use only parent-visible reports as monitor inputs", () => {
    const instruction = readRepositoryFile(replanMonitorInstructionPath);

    expect(instruction).not.toContain("intake-brief.md");
    expect(instruction).not.toContain("実装ブリーフ");
    expect(instruction).toContain("Report Directory 内の `plan.md`");
  });

  // REQ-121-02 / TC-121-02 / P-121-02
  test("should read unresolved issue details from the plan handoff", () => {
    const instruction = readRepositoryFile(replanMonitorInstructionPath);

    expect(instruction).toContain(
      "`plan.md` の「ブリーフからの引き継ぎ」に記録された issue の未決事項"
    );
  });

  // REQ-121-03 / TC-121-03 / P-121-03
  test("should require every intake handoff in the plan contract", () => {
    const contract = readRepositoryFile(planContractPath);
    const handoffSection = /## ブリーフからの引き継ぎ[\s\S]*?(?=\n## )/.exec(
      contract
    )?.[0];

    expect(handoffSection).toBeDefined();
    expect(handoffSection).toContain("確定している決定");
    expect(handoffSection).toContain("制約");
    expect(handoffSection).toContain("ブリーフの対象外");
    expect(contract).toContain("「ブリーフからの引き継ぎ」も省略不可");
  });

  // REQ-121-04 / TC-121-04 / P-121-04
  test("should keep callable child report exploration out of the instruction", () => {
    const instruction = readRepositoryFile(replanMonitorInstructionPath);

    expect(instruction).not.toMatch(/(?:intake-brief\.md|実装ブリーフ)/);
  });
});
