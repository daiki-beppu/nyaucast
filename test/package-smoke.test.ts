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
      "video_assemble_composition",
      "video_exclude_thumbnail",
      "video_fetch_topic_candidates",
      "video_generate_thumbnails",
      "video_mix_audio_track",
      "video_preview_cut",
      "video_recommend_short_cut",
      "video_render_cut",
      "video_status",
      "video_synthesize_narration",
      "video_withdraw_short",
      "video_write_diagram",
      "video_write_plan",
      "video_write_post_draft",
      "video_write_script",
      "video_write_short",
    ]);
    expect(localDatabaseCreated).toBe(true);
    // codec は tarball に入り、下流の相対 symlink（.claude → .agents → node_modules）越しに読める
    expect(packedPaths).toEqual(
      expect.arrayContaining([
        "skills/explainer-lifecycle/SKILL.md",
        "skills/explainer-lifecycle/references/plan.md",
        "skills/explainer-lifecycle/references/produce.md",
        "skills/explainer-lifecycle/references/failures.md",
        // distribution codec（issue #558）も同じ 2 段の相対 symlink 越しに読める
        "skills/distribution/SKILL.md",
        "skills/distribution/references/drafts.md",
        "skills/distribution/references/publish.md",
        "skills/distribution/references/failures.md",
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
