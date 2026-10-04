import { describe, expect, test } from "@effect/vitest";

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { inspectInstalledPackage } from "./package-smoke-support.ts";

describe("K3 package smoke", () => {
  test("a published tarball serves MCP tools and migrates its local store", async () => {
    const {
      allowedRoots,
      installedCodecSkill,
      linkedCodecSkill,
      localDatabaseCreated,
      packedPaths,
      toolNames,
    } = await inspectInstalledPackage();

    expect(toolNames.toSorted()).toEqual([
      "collection_status",
      "explainer_assemble_composition",
      "explainer_fetch_topic_candidates",
      "explainer_mix_audio_track",
      "explainer_preview_cut",
      "explainer_render_cut",
      "explainer_synthesize_narration",
      "explainer_withdraw_short",
      "explainer_write_diagram",
      "explainer_write_plan",
      "explainer_write_script",
      "explainer_write_short",
      "plan_check_title",
      "plan_init",
      "video_exclude_thumbnail",
      "video_generate_thumbnails",
      "video_status",
    ]);
    expect(localDatabaseCreated).toBe(true);
    // codec は tarball に入り、下流の相対 symlink（.claude → .agents → node_modules）越しに読める
    expect(packedPaths).toEqual(
      expect.arrayContaining([
        "skills/explainer-lifecycle/SKILL.md",
        "skills/explainer-lifecycle/references/plan.md",
        "skills/explainer-lifecycle/references/produce.md",
        "skills/explainer-lifecycle/references/failures.md",
      ]),
    );
    const shippedSkill = readFileSync(
      join(resolve(import.meta.dirname, ".."), "skills", "explainer-lifecycle", "SKILL.md"),
      "utf8",
    );
    expect(installedCodecSkill).toBe(shippedSkill);
    expect(linkedCodecSkill).toBe(shippedSkill);
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
