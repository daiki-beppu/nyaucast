import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "@effect/vitest";

import {
  checkCliCommands,
  checkCodecs,
  checkFailureTags,
  checkFrontmatter,
  checkToolNames,
  knownNames,
  skillsRootOfPackage,
} from "./codec-support.ts";
import { withTemporaryDirectory } from "./helpers.ts";

const known = knownNames();
const codecName = "explainer-lifecycle";

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

describe("the shipped explainer-lifecycle codec", () => {
  test("has no violations", () => {
    expect(checkCodecs(skillsRootOfPackage, known)).toEqual([]);
  });

  test("has an entry point and one reference per section", () => {
    for (const file of ["SKILL.md", "references/plan.md", "references/produce.md"]) {
      expect(() => readFileSync(join(skillsRootOfPackage, codecName, file), "utf8")).not.toThrow();
    }
    expect(() =>
      readFileSync(join(skillsRootOfPackage, codecName, "references/failures.md"), "utf8"),
    ).not.toThrow();
  });

  test("tells the agent to ask a human for the approval commands and to abandon after approval", () => {
    const entry = readFileSync(join(skillsRootOfPackage, codecName, "SKILL.md"), "utf8");
    expect(entry).toContain("video_write_plan");
    expect(entry).toContain("nyaucast video produce");
    expect(entry).toContain("nyaucast video abandon");
    expect(entry).toContain("force");
  });

  test("is self-contained: it does not link into docs/", () => {
    const entry = readFileSync(join(skillsRootOfPackage, codecName, "SKILL.md"), "utf8");
    expect(entry).not.toMatch(/docs\//);
  });
});
