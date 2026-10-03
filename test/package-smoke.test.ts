import { describe, expect, test } from "@effect/vitest";

import { inspectInstalledPackage } from "./package-smoke-support.ts";

describe("K3 package smoke", () => {
  test("a published tarball serves MCP tools and migrates its local store", async () => {
    const { allowedRoots, localDatabaseCreated, packedPaths, toolNames } =
      await inspectInstalledPackage();

    expect(toolNames.toSorted()).toEqual([
      "collection_status",
      "explainer_assemble_composition",
      "explainer_fetch_topic_candidates",
      "explainer_mix_audio_track",
      "explainer_synthesize_narration",
      "explainer_write_diagram",
      "explainer_write_plan",
      "explainer_write_script",
      "plan_check_title",
      "plan_init",
      "video_exclude_thumbnail",
      "video_generate_thumbnails",
      "video_status",
    ]);
    expect(localDatabaseCreated).toBe(true);
    expect(packedPaths).not.toContainEqual(expect.stringMatching(/\.test\.ts$/));
    expect(packedPaths).not.toContainEqual(expect.stringMatching(/^src\//));
    expect(packedPaths).toEqual(
      expect.arrayContaining([
        "package.json",
        "bin/nyaucast.js",
        "dist/index.js",
        "LICENSE",
        "NOTICE",
        "README.md",
      ]),
    );
    // マイグレーションは手書きの TypeScript モジュールとして dist に入る。drizzle/*.sql は同梱しない
    expect(packedPaths).toContainEqual(
      expect.stringMatching(/^dist\/db\/migrations\/\d{4}_.+\.js$/),
    );
    expect(packedPaths).not.toContainEqual(expect.stringMatching(/^drizzle\//));
    const npmMetadata = new Set(["package.json", "README.md", "LICENSE"]);
    for (const path of packedPaths.filter((path) => !npmMetadata.has(path))) {
      expect(allowedRoots.some((root) => path === root || path.startsWith(`${root}/`))).toBe(true);
    }
  }, 120_000);
});
