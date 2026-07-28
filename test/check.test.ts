import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const packageRoot = resolve(import.meta.dirname, "..");
const subprocessTimeoutMilliseconds = 20_000;

/**
 * `check` が満たすべき契約（ゲートの集合と順序）を、テスト側から固定した期待値。
 * 定義そのものは `package.json` の `check` script にあり、ゲートを増減したらここが落ちる。
 * 呼び出し元（ci.yml / lefthook / takt facets）はこの列挙を複製せず `bun run check` を呼ぶ。
 */
const gateScriptNames = [
  "typecheck",
  "lint",
  "format:check",
  "test",
  "verify-workflows",
  "fallow",
] as const;

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
  ".takt/facets/instructions/tayk-ci-fix.md",
  ".takt/facets/instructions/tayk-repair.md",
  ".takt/facets/instructions/tayk-review-fix.md",
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
  /bun run format:check/,
  /bun run verify-workflows/,
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

/**
 * 本物の `check` を各ゲートの stub に対して走らせる fixture を作る。
 *
 * `check` は `bun run test` を含むため、リポジトリ本体でそのまま実行すると
 * このテスト自身を経由して無限に再帰する。合成（順序と fail-fast）だけを見る。
 */
function createCheckFixture(directory: string, checkScript: string): void {
  writeFileSync(
    join(directory, "record.ts"),
    `import { appendFileSync } from "node:fs";

const gate = process.argv[2] ?? "";
appendFileSync(process.env["TAYK_GATE_RECORD"] ?? "", \`\${gate}\\n\`);
process.exit(process.env["TAYK_FAILING_GATE"] === gate ? 1 : 0);
`
  );

  const scripts: Record<string, string> = { check: checkScript };
  for (const gate of gateScriptNames) {
    scripts[gate] = `bun record.ts ${gate}`;
  }

  writeFileSync(
    join(directory, "package.json"),
    `${JSON.stringify({ name: "tayk-check-fixture", private: true, scripts, type: "module", version: "0.0.0" }, null, 2)}\n`
  );
}

function runCheck(
  directory: string,
  failingGate: string | null
): { exitCode: number | null; executedGates: string[] } {
  const recordPath = join(directory, "gates.log");
  writeFileSync(recordPath, "");

  const result = Bun.spawnSync([process.execPath, "run", "check"], {
    cwd: directory,
    env: {
      ...process.env,
      TAYK_FAILING_GATE: failingGate ?? "",
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
  // REQ-82-01
  test("should run every gate in order and stop at the first failure", () => {
    const checkScript = readPackageScripts()["check"];

    if (checkScript === undefined) {
      throw new Error("package.json must declare a check script");
    }

    withTemporaryDirectory((directory) => {
      createCheckFixture(directory, checkScript);

      const passed = runCheck(directory, null);
      expect(passed.exitCode).toBe(0);
      expect(passed.executedGates).toEqual([...gateScriptNames]);

      const failed = runCheck(directory, "format:check");
      expect(failed.exitCode).not.toBe(0);
      expect(failed.executedGates).toEqual([
        "typecheck",
        "lint",
        "format:check",
      ]);
    });
  });

  // REQ-82-02
  test("should leave the gate set undefined outside package.json", () => {
    const workflow = readRepositoryFile(".github/workflows/ci.yml");

    expect(workflow).toContain("bun run check");
    for (const command of enumeratedGateCommands) {
      expect(workflow).not.toMatch(command);
    }
    expect(workflow).not.toContain("scripts/verify-workflows.ts");
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
      expect(facet).not.toContain("bun scripts/verify-workflows.ts");
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
