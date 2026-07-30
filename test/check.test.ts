import { describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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

function normalizeMarkdownText(value: string): string {
  return value.replaceAll("**", "").replaceAll(/\s+/g, " ").trim();
}

function readMarkdownTableRows(markdown: string): string[][] {
  const rows = markdown
    .split("\n")
    .filter((line) => line.trim().startsWith("|"))
    .map((line) =>
      line.trim().slice(1, -1).split("|").map(normalizeMarkdownText)
    );

  if (
    rows.length < 2 ||
    rows[1] === undefined ||
    !rows[1].every((cell) => /^:?-{3,}:?$/.test(cell))
  ) {
    throw new Error("missing markdown table");
  }

  return rows.slice(2);
}

function readDefinitionRows(
  markdown: string
): { definition: string; term: string }[] {
  return [...markdown.matchAll(/^(?:- )?\*\*([^*\r\n]+)\*\*: (.+)$/gm)].map(
    (match) => {
      const term = match[1];
      const definition = match[2];

      if (term === undefined || definition === undefined) {
        throw new Error("invalid definition row");
      }

      return {
        definition: normalizeMarkdownText(definition),
        term: normalizeMarkdownText(term),
      };
    }
  );
}

function readNumberedDecision(markdown: string, number: number): string {
  const prefix = `${number}. `;
  const line = markdown
    .split("\n")
    .find((candidate) => candidate.startsWith(prefix));

  if (line === undefined) {
    throw new Error(`missing decision: ${number}`);
  }

  return normalizeMarkdownText(line.slice(prefix.length));
}

function readCodecReleaseStatements(markdown: string): string[] {
  return markdown
    .split("。")
    .map(normalizeMarkdownText)
    .filter((sentence) => sentence.includes("codec"));
}

function extractBacktickPaths(markdown: string, prefix: string): string[] {
  return [...markdown.matchAll(/`([^`\r\n]+)`/g)]
    .map((match) => match[1])
    .filter((path): path is string => path?.startsWith(prefix) === true);
}

function listAdrPaths(): string[] {
  return readdirSync(join(packageRoot, "docs/adr"))
    .filter((name) => /^\d{4}-.*\.md$/.test(name))
    .toSorted()
    .map((name) => `docs/adr/${name}`);
}

function assertDomainArchitectureContract(markdown: string): void {
  const terms = readSection(markdown, "## 中核用語");
  const avoidedTerms = readSection(markdown, "## 禁止語（`_Avoid_`）");

  expect(readDefinitionRows(terms)).toEqual([
    {
      definition:
        "tayk が expose する型付き操作。agent が直接呼ぶ第一級インターフェース。primitive tool 1 層と、local store への読み口で構成される。ドット表記 (`benchmark.collect`) が正書で、MCP wire 名はアンダースコア変換した `benchmark_collect`。",
      term: "MCP tool",
    },
    {
      definition:
        "単一操作の細粒度 tool。`audio.master` / `thumbnail.generate` 等",
      term: "primitive tool",
    },
    {
      definition:
        "廃止された粗粒度の MCP tool。区間を歩くのは knowledge codec を読んだ agent であり、tool ではない",
      term: "workflow tool",
    },
    {
      definition:
        "core の MCP tool を各プロトコルへ橋渡しする薄いラッパ。MCP (primary) と CLI (`tayk <cmd>`) の 2 本。",
      term: "adapter",
    },
    {
      definition:
        "「いつ・どの MCP tool を・どう使うか」の知識パッケージ。tool の description が WHAT、codec が WHEN/HOW。5 本構成。",
      term: "knowledge codec",
    },
    {
      definition:
        "1 本の YouTube 動画としてまとめられる楽曲群とその成果物一式。",
      term: "collection",
    },
    {
      definition:
        "`TTP 収集・分析 → 企画 →[GO/NO-GO]→ サムネ生成 →[GO/NO-GO]→ 音源生成 → MIX/マスタリング → 動画生成 → upload → 公開後運用`。",
      term: "collection lifecycle",
    },
    {
      definition:
        "「徹底的にパクる」。benchmark チャンネルの当たりパターンを分析し自チャンネルの企画へ転写する戦略。分析に留まらず転写までを含む。",
      term: "TTP",
    },
    {
      definition:
        "`<CHANNEL_DIR>/data/local.db` の libSQL embedded DB。時系列データとコレクション状態 (②) の SSOT。",
      term: "local store",
    },
    {
      definition:
        "local store が兼ねる読み取り専用クエリ面。① ④ のミラーを含むが SSOT ではない。",
      term: "read model",
    },
    {
      definition:
        "ADR-0001 を確定させるために最初に end-to-end で通す垂直スライス = plan 区間。",
      term: "tracer",
    },
    {
      definition:
        "first-party 2 リポで collection フルライフサイクル 1 周を tayk だけで実走させる受け入れ検証。`v0.1.0` の唯一のリリースゲート。",
      term: "dogfood",
    },
    {
      definition:
        "リリースをブロックする欠陥は 3 種のみ — ①誤公開・誤メタデータ ②データ破壊 ③auth 破壊。これ以外はブロックせず issue 化する。",
      term: "critical regression",
    },
  ]);
  expect(
    readMarkdownTableRows(avoidedTerms).filter((row) =>
      row.some((cell) => cell.includes("tool"))
    )
  ).toEqual([["workflow tool", "primitive tool"]]);
}

function assertAdrReviewTerminologyContract(markdown: string): void {
  const terminology = readSection(markdown, "## 用語（CONTEXT.md）");

  expect(readMarkdownTableRows(terminology)).toEqual([
    [
      "`<対象ファイル>`",
      "workflow tool",
      "廃止済み。primitive tool 1 層と事実だけを返す読み口を使う",
    ],
  ]);
}

function assertDesignArchitectureContract(markdown: string): void {
  const procedure = readSection(markdown, "## 手順");

  expect(readMarkdownTableRows(procedure)).toEqual([
    [
      "要求の充足",
      "要件 ID ごとの方針が、その要件を実際に満たすか。方針が抽象すぎて実装が一意に決まらない箇所はないか",
    ],
    [
      "責務の配置",
      "業務ロジックが core にあり、adapter が薄いままか。MCP tool が primitive tool 1 層で、読み口が事実だけを返すか",
    ],
    [
      "データの流れ",
      "入出力の型が決まっているか。SSOT が データ 4 分類 のどれに当たるかが明示されているか",
    ],
    [
      "失敗の設計",
      "失敗経路が設計されているか。エラーが内部 throw → 境界変換になっているか",
    ],
    [
      "変更の広がり",
      "1 要件の実装が想定外に多くのファイルへ波及していないか。波及するなら、その必然性が説明されているか",
    ],
    [
      "未来への負債",
      "いま入れると後で剥がしにくくなる構造（暗黙の状態・グローバル・双方向依存）がないか",
    ],
  ]);
}

function assertAgentCodecReleaseContract(markdown: string): void {
  const scope = readSection(markdown, "## v0.1.0 のスコープ");

  expect(readCodecReleaseStatements(scope)).toEqual([
    "`collection-lifecycle` codec は v0.1 の中心成果物とする",
    "それ以外（自チャンネル実績分析 / dashboard / Remotion / `collection-lifecycle` 以外の codec）は v0.2 以降に 1 リリース 1 テーマで直列に積む",
  ]);
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

describe("Issue #84 agent-facing architecture contracts", () => {
  // REQ-84-01 / TC-01
  test("should index every current ADR and define the tracer as the plan interval", () => {
    const knowledge = readRepositoryFile(".takt/facets/knowledge/tayk-adr.md");
    const index = readSection(knowledge, "## 判定前に必ず読むファイル");
    const decisionSeven = readSection(
      knowledge,
      "## ADR-0001 の決定に対する違反パターン"
    );

    const indexedAdrs = extractBacktickPaths(index, "docs/adr/")
      .filter((path) => path.endsWith(".md"))
      .toSorted();

    expect(indexedAdrs).toEqual(listAdrPaths());
    expect(readMarkdownTableRows(decisionSeven).at(-1)).toEqual([
      "決定 7（tracer 完走までの規約確定・黙って逸脱しない）",
      "tracer（plan 区間）未完走の段階で追加の制約を課す。ADR を改訂せずに逸脱する",
    ]);
  });

  // REQ-84-02 / TC-02
  test("should define one primitive tool layer, factual reads, and the plan tracer", () => {
    const knowledge = readRepositoryFile(
      ".takt/facets/knowledge/tayk-domain.md"
    );

    assertDomainArchitectureContract(knowledge);
  });

  // REQ-84-04 / TC-04
  test("should keep ADR-0001 provisional until the plan interval tracer completes", () => {
    const adr = readRepositoryFile("docs/adr/0001-thin-architecture.md");
    const decision = readSection(adr, "## Decision");
    const consequences = readSection(adr, "## Consequences");
    const tracerConsequences = consequences
      .split("\n")
      .filter((line) => line.startsWith("- ") && line.includes("tracer"))
      .map((line) => normalizeMarkdownText(line.slice(2)));

    expect(readNumberedDecision(decision, 7)).toBe(
      "本規約の確定は tracer（plan 区間）の end-to-end 完走をもって行う。tracer 実装中に破綻した項目は本 ADR を改訂して直す（黙って逸脱しない）"
    );
    expect(tracerConsequences).toEqual([
      "tracer（plan 区間）が本規約の最初の適用対象。ディレクトリ規約（`src/tools/<domain>.<name>.ts` 等）は tracer 実装で確定させ、本 ADR に追記する",
    ]);
  });

  // REQ-84-05 / TC-05
  test("should reserve v0.1 for collection-lifecycle and defer other codecs", () => {
    const instructions = readRepositoryFile("AGENTS.md");

    assertAgentCodecReleaseContract(instructions);
  });

  // REQ-84-06 / TC-06
  test("should use only a neutral implementation target in the plan contract", () => {
    const contract = readRepositoryFile(
      ".takt/facets/output-contracts/tayk-plan.md"
    );
    const implementationPlan = readSection(contract, "## 実装方針");

    expect(
      readMarkdownTableRows(implementationPlan).map((row) => row[1])
    ).toEqual(["`<対象ファイル>`"]);
  });

  // REQ-84-07 / TC-07
  test("should use only neutral implementation and test targets in test design", () => {
    const contract = readRepositoryFile(
      ".takt/facets/output-contracts/tayk-test-design.md"
    );
    const cases = readSection(contract, "## 要件 ↔ テストケース対応");
    const placement = readSection(contract, "## テストファイル配置");

    expect(readMarkdownTableRows(cases).map((row) => row[3])).toEqual([
      "`<対象ファイル>`",
    ]);
    expect(
      readMarkdownTableRows(placement).map((row) => row.slice(0, 2))
    ).toEqual([["`<テストファイル>`", "`<対象ファイル>`"]]);
  });

  // REQ-84-09 / TC-09
  test("should give ADR reviewers the current index and primitive tool terminology", () => {
    const contract = readRepositoryFile(
      ".takt/facets/output-contracts/tayk-adr-conformance-review.md"
    );
    const index = readSection(contract, "## 照合した ADR");
    const evidence = readSection(
      contract,
      "## 再走査証跡（2回目以降のレビューで必須）"
    );

    const indexedAdrs = extractBacktickPaths(index, "docs/adr/")
      .filter((path) => path.endsWith(".md"))
      .toSorted();

    expect(indexedAdrs).toEqual(listAdrPaths());
    assertAdrReviewTerminologyContract(contract);
    expect(readMarkdownTableRows(evidence)).toEqual([
      ["ADR-0001 決定 1", "`<対象ファイル>`（1 ファイルに凝集）"],
    ]);
  });

  // REQ-84-10 / TC-10
  test("should review designs against primitive tools and factual reads", () => {
    const instruction = readRepositoryFile(
      ".takt/facets/instructions/tayk-review-design-arch.md"
    );

    assertDesignArchitectureContract(instruction);
  });

  // REQ-84-11 / TC-21
  test("should keep the codec release boundary in ADR knowledge", () => {
    const knowledge = readRepositoryFile(".takt/facets/knowledge/tayk-adr.md");
    const scope = readSection(knowledge, "## スコープの規律");

    expect(readCodecReleaseStatements(scope)).toEqual([
      "その中心成果物は `collection-lifecycle` codec とする",
      "これに不要な拡張（自チャンネル実績分析 / dashboard / Remotion / `collection-lifecycle` 以外の 4 本の codec）は v0.2 以降へ送る",
    ]);
  });

  test("should reject an alias orchestration layer in the domain definitions", () => {
    const knowledge = readRepositoryFile(
      ".takt/facets/knowledge/tayk-domain.md"
    );
    const contradictoryKnowledge = knowledge.replace(
      "**knowledge codec**:",
      "- **orchestration layer**: primitive tool を束ねる粗粒度の現行層\n\n**knowledge codec**:"
    );

    expect(() => {
      assertDomainArchitectureContract(contradictoryKnowledge);
    }).toThrow();
  });

  test("should reject a contradictory workflow tool recommendation", () => {
    const contract = readRepositoryFile(
      ".takt/facets/output-contracts/tayk-adr-conformance-review.md"
    );
    const contradictoryContract = contract.replace(
      "| `<対象ファイル>` | workflow tool | 廃止済み。primitive tool 1 層と事実だけを返す読み口を使う |",
      "| `<対象ファイル>` | workflow tool | 廃止済み。primitive tool 1 層と事実だけを返す読み口を使う |\n| `<別の対象>` | orchestration tool | primitive tool を束ねる現行推奨層 |"
    );

    expect(() => {
      assertAdrReviewTerminologyContract(contradictoryContract);
    }).toThrow();
  });

  test("should reject an additional coarse-grained tool review layer", () => {
    const instruction = readRepositoryFile(
      ".takt/facets/instructions/tayk-review-design-arch.md"
    );
    const contradictoryInstruction = instruction.replace(
      "| データの流れ | 入出力の型が決まっているか。",
      "| データの流れ | orchestration tool が primitive tool を束ねる現行層か。入出力の型が決まっているか。"
    );

    expect(() => {
      assertDesignArchitectureContract(contradictoryInstruction);
    }).toThrow();
  });

  test("should reject collection-lifecycle from the deferred codec set", () => {
    const instructions = readRepositoryFile("AGENTS.md");
    const contradictoryInstructions = instructions.replace(
      "**それ以外（自チャンネル実績分析 / dashboard / Remotion / `collection-lifecycle` 以外の codec）は v0.2 以降**に 1 リリース 1 テーマで直列に積む。",
      "**それ以外（自チャンネル実績分析 / dashboard / Remotion / `collection-lifecycle` 以外の codec）は v0.2 以降**に 1 リリース 1 テーマで直列に積む。`collection-lifecycle` codec は v0.2 以降へ送る。"
    );

    expect(() => {
      assertAgentCodecReleaseContract(contradictoryInstructions);
    }).toThrow();
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
