import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "@effect/vitest";

import { postAwaitingReasons, postStatuses } from "../src/posts/post-state.ts";
import {
  checkCliCommands,
  checkCodecs,
  checkFailureTags,
  checkFrontmatter,
  checkToolNames,
  firstColumnCodesOfTable,
  knownNames,
  skillsRootOfPackage,
} from "./codec-support.ts";
import { withTemporaryDirectory } from "./helpers.ts";

const known = knownNames();
const codecName = "explainer-lifecycle";

// ---- 出荷済み codec の共通アサーション。explainer-lifecycle と distribution は同じ形で検査する。 ----

const expectReferenceFilesReadable = (skillRoot: string, referenceFiles: readonly string[]) => {
  for (const file of ["SKILL.md", ...referenceFiles]) {
    expect(() => readFileSync(join(skillRoot, file), "utf8")).not.toThrow();
  }
};

const expectSelfContained = (skillRoot: string) => {
  const entry = readFileSync(join(skillRoot, "SKILL.md"), "utf8");
  expect(entry).not.toMatch(/docs\//);
};

const validFrontmatter = `---\nname: ${codecName}\ndescription: 解説動画を企画する\n---\n\n# body\n`;

describe("known names come from the real definitions", () => {
  test("tools, CLI paths and failure tags are collected", () => {
    expect(known.tools.has("video_write_plan")).toBe(true);
    expect(known.tools.has("video_status")).toBe(true);
    expect(known.tools.has("video_check_title")).toBe(true);
    expect(known.cli.get("nyaucast video")).toBe(true);
    expect(known.cli.get("nyaucast video produce")).toBe(false);
    expect(known.cli.has("nyaucast video abandon")).toBe(true);
    expect(known.cli.has("nyaucast video publish")).toBe(true);
    expect(known.cli.has("nyaucast collection")).toBe(false);
    expect(known.cli.has("nyaucast video thumbnail")).toBe(true);
    expect(known.cli.has("nyaucast auth status")).toBe(true);
    // 複数行の定義も拾う
    expect(known.tags.has("ChromeUnavailable")).toBe(true);
    // CLI だけが出す失敗も拾う
    expect(known.tags.has("ThumbnailSelectionRequired")).toBe(true);
    // 確認待ちの理由と投稿の状態は、Schema.Literals(postAwaitingReasons) のような変数渡しでは
    // 正規表現が拾えないため、post-state.ts の実物の配列から直接合流する。
    expect(known.literals.has("tolerance_exceeded")).toBe(true);
    expect(known.literals.has("awaiting_check")).toBe(true);
  });
});

describe("post state literals (confirmation-pending reasons and post statuses)", () => {
  test.each([...postAwaitingReasons, ...postStatuses])(
    "%s is recognized as a known name wherever it is written in markdown",
    (literal) => {
      const text = [
        `\`${literal}\` になったら人間に確かめてもらう。`,
        `${literal} という語が地の文にもある。`,
        "| 理由 |",
        "| --- |",
        `| ${literal} |`,
        "```",
        literal,
        "```",
      ].join("\n");
      expect(checkToolNames(text, known.tools, known.literals)).toEqual([]);
    },
  );

  test("a typo of a post state literal is still a violation in every position, while the correct spelling and a neighboring literal are not", () => {
    const text = [
      "地の文の tolerance_exceded は綴り違い。",
      "`tolerance_exceded`",
      "```",
      "tolerance_exceded",
      "```",
      "~~~",
      "tolerance_exceded",
      "~~~",
      "| 理由 | `tolerance_exceded` |",
      "正しい綴りの tolerance_exceeded と `account_mismatch` は違反にならない。",
    ].join("\n");
    const violations = checkToolNames(text, known.tools, known.literals);
    expect(violations.filter((name) => name === "tolerance_exceded")).toHaveLength(5);
    expect(violations).not.toContain("tolerance_exceeded");
    expect(violations).not.toContain("account_mismatch");
  });
});

describe("MCP tool names", () => {
  test("existing names in prose and tables pass", () => {
    const text = "`video_write_plan` で企画を書く。\n\n| tool |\n| --- |\n| video_status |\n";
    expect(checkToolNames(text, known.tools, known.literals)).toEqual([]);
  });

  test("schema literals such as too_small are not tool names", () => {
    const text = "`too_small` `not_16_9` `too_large` が理由。";
    expect(checkToolNames(text, known.tools, known.literals)).toEqual([]);
    expect(checkToolNames(text, known.tools, new Set()).toSorted()).toEqual([
      "not_16_9",
      "too_large",
      "too_small",
    ]);
  });

  test("a typo in prose and a dotted camelCase name are violations; look-alikes are not", () => {
    const text = [
      "video_write_plann で企画を書く。",
      "`viedo_write_plan` と `vidoe_write_plan` は接頭辞のタイポ。",
      "foobar_generate_video を呼ぶ。`upload_video_now` も存在しない。",
      "`video.writePlan` は agent から見える名前ではない。",
      "`too_small` `not_16_9` `config/channel/video.json` `explainer-lifecycle`",
    ].join("\n");
    expect(checkToolNames(text, known.tools, known.literals).toSorted()).toEqual([
      "foobar_generate_video",
      "upload_video_now",
      "video.writePlan",
      "video_write_plann",
      "vidoe_write_plan",
      "viedo_write_plan",
    ]);
  });
});

describe("CLI commands", () => {
  test("existing commands in inline code and in both fence styles pass", () => {
    const text = [
      "`nyaucast video thumbnail <id> 2-1`",
      "```sh",
      "$ nyaucast video produce V1",
      "```",
      "~~~",
      "nyaucast auth status",
      "~~~",
    ].join("\n");
    expect(checkCliCommands(text, known.cli)).toEqual([]);
  });

  test("existing commands in prose, and words that stop at the root, pass", () => {
    const text = "nyaucast video produce を人間が叩く。nyaucast の MCP tool を使う。";
    expect(checkCliCommands(text, known.cli)).toEqual([]);
  });

  test("unknown subcommands are violations in inline code, prose and an unclosed fence", () => {
    const text = [
      "`nyaucast video prodce <id>` と `nyaucast video upload <id>`。",
      "地の文の nyaucast video uplaod を叩く。",
      "```sh",
      "nyaucast vido produce V1",
    ].join("\n");
    expect(checkCliCommands(text, known.cli).toSorted()).toEqual([
      "nyaucast video prodce",
      "nyaucast video uplaod",
      "nyaucast video upload",
      "nyaucast vido",
    ]);
  });

  // SCN-C15-N1（この issue #554 の計画）: 新しい `nyaucast post` のサブコマンド名が `video publish`
  // と混ざらないこと、および存在しないパスが検出されることの確認。`nyaucast post publish` という
  // コマンドは存在しない(この issue が足すのは cancel / run-now / mark-published の 3 つ)。
  test("a command name that mixes an existing root with another root's subcommand is a violation", () => {
    const text = "`nyaucast post publish <id>` で投稿を公開する。";
    expect(checkCliCommands(text, known.cli)).toEqual(["nyaucast post publish"]);
  });
});

describe("failure tags", () => {
  test("existing tags pass", () => {
    expect(
      checkFailureTags("`ThumbnailSelectionRequired` と `ChromeUnavailable`", known.tags),
    ).toEqual([]);
  });

  test("an unknown tag is a violation; other words are not", () => {
    const text = "`ThumbnailSelectionMissing`。YouTube と TikTok、`TTY`、`SKILL.md`、`NO-GO`。";
    expect(checkFailureTags(text, known.tags)).toEqual(["ThumbnailSelectionMissing"]);
  });
});

describe("frontmatter", () => {
  test("the prescribed shape passes", () => {
    expect(checkFrontmatter(validFrontmatter, codecName)).toEqual([]);
  });

  const variants: [string, string][] = [
    ["no frontmatter", "# body\n"],
    ["a blank line before ---", `\n${validFrontmatter}`],
    ["an extra key", validFrontmatter.replace("---\n\n#", "version: 1\n---\n\n#")],
    ["a name that differs from the directory", validFrontmatter.replace(codecName, "other")],
    ["an uppercase name", validFrontmatter.replace(codecName, "Explainer_Lifecycle")],
    ["a closing line that is not only ---", validFrontmatter.replace("\n---\n", "\n---junk\n")],
    ["an empty description", `---\nname: ${codecName}\ndescription: ""\n---\n`],
    [
      "a 1025 character description",
      `---\nname: ${codecName}\ndescription: ${"a".repeat(1025)}\n---\n`,
    ],
  ];

  test.each(variants)("%s is a violation", (_label, content) => {
    expect(checkFrontmatter(content, codecName)).not.toEqual([]);
  });

  test("a closing --- without a trailing newline passes", () => {
    expect(checkFrontmatter(`---\nname: ${codecName}\ndescription: x\n---`, codecName)).toEqual([]);
  });

  test("a 1024 character description passes", () => {
    const content = `---\nname: ${codecName}\ndescription: ${"a".repeat(1024)}\n---\n`;
    expect(checkFrontmatter(content, codecName)).toEqual([]);
  });
});

describe("skills directory", () => {
  const writeCodec = (root: string, body: string) => {
    mkdirSync(join(root, codecName), { recursive: true });
    writeFileSync(join(root, codecName, "SKILL.md"), `${validFrontmatter}${body}`);
  };

  test("a clean codec has no violations", () => {
    withTemporaryDirectory("nyaucast-codec-clean-", (root) => {
      writeCodec(root, "`video_write_plan` → `nyaucast video produce <id>`\n");
      expect(checkCodecs(root, known)).toEqual([]);
    });
  });

  test("a stray file directly under skills/ is a layout violation", () => {
    withTemporaryDirectory("nyaucast-codec-layout-", (root) => {
      writeCodec(root, "");
      writeFileSync(join(root, "README.md"), "# skills\n");
      expect(checkCodecs(root, known).map(({ kind, subject }) => ({ kind, subject }))).toEqual([
        { kind: "layout", subject: "README.md" },
      ]);
    });
  });

  test("a directory without SKILL.md is a layout violation", () => {
    withTemporaryDirectory("nyaucast-codec-empty-", (root) => {
      mkdirSync(join(root, "empty-codec"));
      expect(checkCodecs(root, known).map(({ kind }) => kind)).toEqual(["layout"]);
    });
  });

  test("names in references/ are checked too", () => {
    withTemporaryDirectory("nyaucast-codec-references-", (root) => {
      writeCodec(root, "");
      mkdirSync(join(root, codecName, "references"));
      writeFileSync(join(root, codecName, "references", "plan.md"), "video_write_plann を呼ぶ。\n");
      expect(checkCodecs(root, known).map(({ kind, subject }) => ({ kind, subject }))).toEqual([
        { kind: "tool", subject: "video_write_plann" },
      ]);
    });
  });
});

// skills/ 直下に置かれた出荷済み codec 全体を 1 件で検査する。per-codec への絞り込みは行わない
// (絞り込むと skills/ 直下の layout 違反が両 codec のテストから脱落する)。
describe("the shipped skills directory", () => {
  test("has no violations across every shipped codec", () => {
    expect(checkCodecs(skillsRootOfPackage, known)).toEqual([]);
  });
});

describe("the shipped explainer-lifecycle codec", () => {
  const skillRoot = join(skillsRootOfPackage, codecName);
  const referenceFiles = ["references/plan.md", "references/produce.md", "references/failures.md"];

  test("has an entry point and one reference per section", () => {
    expectReferenceFilesReadable(skillRoot, referenceFiles);
  });

  test("tells the agent to ask a human for the approval commands and to abandon after approval", () => {
    const entry = readFileSync(join(skillRoot, "SKILL.md"), "utf8");
    expect(entry).toContain("video_write_plan");
    expect(entry).toContain("nyaucast video produce");
    expect(entry).toContain("nyaucast video abandon");
    expect(entry).toContain("force");
  });

  test("is self-contained: it does not link into docs/", () => {
    expectSelfContained(skillRoot);
  });
});

describe("the shipped distribution codec", () => {
  const codec = "distribution";
  const skillRoot = join(skillsRootOfPackage, codec);
  const referenceFiles = [
    "references/drafts.md",
    "references/publish.md",
    "references/failures.md",
  ];
  const failuresPath = join(skillRoot, "references", "failures.md");

  test("has an entry point and one reference per publish-section file", () => {
    expectReferenceFilesReadable(skillRoot, referenceFiles);
  });

  test("is self-contained: it does not link into docs/", () => {
    expectSelfContained(skillRoot);
  });

  // 対応表が postAwaitingReasons のすべてを覆う（issue #558）。実物の配列から列挙するので、
  // 理由が増えれば新しいケースが追加され、対応表の理由の列に無ければ落ちる。説明文（2列目・地の文）
  // に同じ語が残っていても、対応表の1列目でなければ対象にならない。
  test.each(postAwaitingReasons)(
    "the failure reference documents the confirmation-pending reason %s",
    (reason) => {
      const failuresText = readFileSync(failuresPath, "utf8");
      const reasonColumn = firstColumnCodesOfTable(failuresText);
      expect(reasonColumn).toContain(reason);
    },
  );
});
