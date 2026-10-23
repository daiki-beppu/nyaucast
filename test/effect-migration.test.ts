import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { assert, describe, expect, it } from "@effect/vitest";
import { parse } from "yaml";

import { checkGates } from "./check-gates.ts";

const packageRoot = resolve(import.meta.dirname, "..");
const exactVersion = /^\d+\.\d+\.\d+$/u;

type JsonRecord = Record<string, unknown>;

function requireRecord(value: unknown, label: string): JsonRecord {
  assert.isTrue(typeof value === "object" && value !== null && !Array.isArray(value), label);
  return value as JsonRecord;
}

function manifest(): JsonRecord {
  return requireRecord(
    JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")),
    "manifest",
  );
}

function section(name: "dependencies" | "devDependencies"): Record<string, string> {
  return requireRecord(manifest()[name] ?? {}, name) as Record<string, string>;
}

function sourceFiles(directory: string): string[] {
  return readdirSync(join(packageRoot, directory), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => relative(packageRoot, join(entry.parentPath, entry.name)))
    .toSorted();
}

const contents = (file: string) => readFileSync(join(packageRoot, file), "utf8");
const filesMatching = (files: string[], pattern: RegExp) =>
  files.filter((file) => pattern.test(contents(file)));

describe("full migration to Effect 4.0", () => {
  const removedPackages = ["zod", "drizzle-orm", "drizzle-kit", "@modelcontextprotocol/sdk"];

  it("drops zod, Drizzle and the official MCP SDK from every dependency section", () => {
    for (const name of removedPackages) {
      assert.notProperty(section("dependencies"), name);
      assert.notProperty(section("devDependencies"), name);
    }
  });

  it("drops them from the lockfile's root importer as well", () => {
    const lockfile = requireRecord(
      parse(readFileSync(join(packageRoot, "pnpm-lock.yaml"), "utf8")),
      "lockfile",
    );
    const importer = requireRecord(
      requireRecord(lockfile["importers"], "importers")["."],
      "root importer",
    );
    for (const name of removedPackages) {
      assert.notProperty(requireRecord(importer["dependencies"] ?? {}, "dependencies"), name);
      assert.notProperty(requireRecord(importer["devDependencies"] ?? {}, "devDependencies"), name);
    }
  });

  it("leaves nothing of the Drizzle toolchain behind", () => {
    const scripts = requireRecord(manifest()["scripts"], "scripts");

    assert.notProperty(scripts, "db:generate");
    assert.isFalse(existsSync(join(packageRoot, "drizzle.config.ts")));
    assert.isFalse(existsSync(join(packageRoot, "drizzle")));
    assert.notInclude(manifest()["files"] as string[], "drizzle");
    assert.isFalse(existsSync(join(packageRoot, "src", "db", "schema.ts")));
  });

  it("exact-pins effect and every @effect/* package", () => {
    const all = { ...section("dependencies"), ...section("devDependencies") };
    const effectPackages = Object.entries(all).filter(
      ([name]) => name === "effect" || name.startsWith("@effect/"),
    );

    assert.isAtLeast(effectPackages.length, 4);
    for (const [name, version] of effectPackages) {
      expect(version, name).toMatch(exactVersion);
    }
  });

  it("ships the runtime Effect packages as dependencies and the test and diagnostic tools as devDependencies", () => {
    for (const name of ["effect", "@effect/platform-node", "@effect/sql-libsql"]) {
      assert.property(section("dependencies"), name);
    }
    for (const name of ["@effect/vitest", "@effect/tsgo"]) {
      assert.property(section("devDependencies"), name);
    }
  });

  it("pins vite-plus to 1.0", () => {
    expect(section("devDependencies")["vite-plus"]).toMatch(/^1\.0\.\d+$/u);
  });

  it("runs the @effect/tsgo diagnostics inside check", () => {
    const scripts = requireRecord(manifest()["scripts"], "scripts") as Record<string, string>;

    const diagnostics = checkGates(scripts)
      .flatMap(({ commands }) => commands)
      .filter((command) => command.includes("effect-tsgo") && command.includes("diagnostics"));
    assert.strictEqual(diagnostics.length, 1);
  });

  describe("under src/", () => {
    const sources = sourceFiles("src");

    it("keeps migrations as hand-written <id>_<name> modules", () => {
      const migrations = readdirSync(join(packageRoot, "src", "db", "migrations"));

      assert.isAtLeast(migrations.filter((name) => /^\d{4}_.+\.ts$/u.test(name)).length, 1);
    });

    it("converts wire names by hand nowhere: tools are declared with their wire names", () => {
      assert.deepStrictEqual(filesMatching(sources, /wireName/u), []);
    });

    it("keeps one tool definition file and one test file per tool, in a directory per channel kind", () => {
      const toolsRoot = join(packageRoot, "src", "tools");
      const entries = readdirSync(toolsRoot, { withFileTypes: true });
      assert.deepStrictEqual(
        entries.filter((entry) => !entry.isDirectory()).map((entry) => entry.name),
        [],
      );
      assert.deepStrictEqual(entries.map((entry) => entry.name).toSorted(), [
        "collection",
        "explainer",
      ]);

      const definitionsOf = (kind: string) => {
        const files = readdirSync(join(toolsRoot, kind));
        const definitions = files.filter((name) => !name.endsWith(".test.ts"));
        for (const definition of definitions) {
          assert.include(files, definition.replace(/\.ts$/u, ".test.ts"));
        }
        return definitions.toSorted();
      };

      assert.deepStrictEqual(definitionsOf("collection"), [
        "video.checkTitle.ts",
        "video.status.ts",
        "video.writePlan.ts",
      ]);
      assert.deepStrictEqual(definitionsOf("explainer"), [
        "video.assembleComposition.ts",
        "video.excludeThumbnail.ts",
        "video.fetchTopicCandidates.ts",
        "video.generateThumbnails.ts",
        "video.mixAudioTrack.ts",
        "video.previewCut.ts",
        "video.recommendShortCut.ts",
        "video.renderCut.ts",
        "video.status.ts",
        "video.synthesizeNarration.ts",
        "video.withdrawShort.ts",
        "video.writeDiagram.ts",
        "video.writePlan.ts",
        "video.writePostDraft.ts",
        "video.writeScript.ts",
        "video.writeShort.ts",
      ]);
    });
  });
});
