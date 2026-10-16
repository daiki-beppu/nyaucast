import { describe, expect, test } from "vitest";

import { findUnlistedBuilds } from "./check-allow-builds.ts";

const workspace = (keys: readonly string[]) =>
  `allowBuilds:\n${keys.map((key) => `  ${key}: true`).join("\n")}\npmOnFail: ignore\n`;

const readme = (keys: readonly string[]) =>
  [
    "## チャンネルリポへの導入",
    "",
    "```yaml",
    "allowBuilds:",
    ...keys.map((key) => `  ${key}: false`),
    "```",
    "",
  ].join("\n");

describe("findUnlistedBuilds", () => {
  test("passes when every allowBuilds key is denied in the README or is dev-only", () => {
    expect(
      findUnlistedBuilds(
        workspace(["actionlint", "core-js", "esbuild", "node-av", "workerd"]),
        readme(["core-js", "node-av", "workerd"]),
      ),
    ).toEqual([]);
  });

  test("reports a key that is neither denied in the README nor dev-only", () => {
    expect(
      findUnlistedBuilds(
        workspace(["core-js", "node-av", "sharp", "workerd"]),
        readme(["core-js", "node-av", "workerd"]),
      ),
    ).toEqual(["sharp"]);
  });

  test("reads the denied list from a code block indented inside a numbered step", () => {
    const steps = readme(["core-js", "node-av", "workerd"])
      .split("\n")
      .map((line) => (line.startsWith("#") || line === "" ? line : `   ${line}`))
      .join("\n");

    expect(findUnlistedBuilds(workspace(["core-js", "node-av", "workerd"]), steps)).toEqual([]);
  });
});
