import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { assert, describe, expect, it } from "@effect/vitest";
import { parse } from "yaml";

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

const production = (files: string[]) => files.filter((file) => !file.endsWith(".test.ts"));
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
    const gates = String(scripts["check"])
      .split("&&")
      .map((gate) => gate.trim());

    const diagnosticGates = gates.filter((gate) => {
      const script = gate.startsWith("pnpm run ") ? scripts[gate.slice("pnpm run ".length)] : gate;
      return script?.includes("effect-tsgo") === true && script.includes("diagnostics");
    });
    assert.strictEqual(diagnosticGates.length, 1);
  });

  describe("under src/", () => {
    const sources = sourceFiles("src");

    it("has no throw statement (comments, descriptions and test fakes included)", () => {
      assert.deepStrictEqual(filesMatching(sources, /\bthrow\b/u), []);
    });

    it("imports no zod", () => {
      assert.deepStrictEqual(filesMatching(sources, /zod/u), []);
    });

    it("imports no Drizzle and no official MCP SDK", () => {
      assert.deepStrictEqual(filesMatching(sources, /drizzle-orm|@modelcontextprotocol/u), []);
    });

    it("parses no arguments by hand", () => {
      assert.deepStrictEqual(filesMatching(sources, /process\.argv/u), []);
    });

    it("keeps the HTTP boundary on HttpClient rather than a fetch function", () => {
      assert.isFalse(/\bfetch\b/u.test(contents("src/youtube/client.ts")));
    });

    it("calls an Effect runner (runMain, runPromise, runSync, runFork) only from the entry point", () => {
      const runners = filesMatching(production(sources), /\brun(?:Main|Promise|Sync|Fork)\b/u);

      assert.deepStrictEqual(runners, ["src/index.ts"]);
      expect(contents("src/index.ts").match(/\bNodeRuntime\.runMain\b/gu)).toHaveLength(1);
    });

    it("reads the time from the Clock, never from Date.now() or an argument-less new Date()", () => {
      assert.deepStrictEqual(filesMatching(production(sources), /Date\.now\(|new Date\(\)/u), []);
    });

    it("opens the libSQL client in exactly one place: the local store", () => {
      assert.deepStrictEqual(filesMatching(sources, /LibsqlClient|@libsql\/client/u), [
        "src/db/local-store.ts",
      ]);
    });

    it("keeps migrations as hand-written <id>_<name> modules", () => {
      const migrations = readdirSync(join(packageRoot, "src", "db", "migrations"));

      assert.isAtLeast(migrations.filter((name) => /^\d{4}_.+\.ts$/u.test(name)).length, 1);
    });

    it("converts wire names by hand nowhere: tools are declared with their wire names", () => {
      assert.deepStrictEqual(filesMatching(sources, /wireName/u), []);
    });

    it("keeps one tool definition file and one test file per tool", () => {
      const tools = readdirSync(join(packageRoot, "src", "tools"));
      const definitions = tools.filter((name) => !name.endsWith(".test.ts"));

      for (const definition of definitions) {
        assert.include(tools, definition.replace(/\.ts$/u, ".test.ts"));
      }
      assert.deepStrictEqual(definitions.toSorted(), [
        "collection.status.ts",
        "explainer.fetchTopicCandidates.ts",
        "explainer.mixAudioTrack.ts",
        "explainer.synthesizeNarration.ts",
        "explainer.writePlan.ts",
        "explainer.writeScript.ts",
        "plan.checkTitle.ts",
        "plan.init.ts",
        "video.excludeThumbnail.ts",
        "video.generateThumbnails.ts",
        "video.status.ts",
      ]);
    });
  });

  describe("under test/ and src/", () => {
    it("imports the test API from @effect/vitest, not from vite-plus/test", () => {
      assert.deepStrictEqual(
        filesMatching(
          [...sourceFiles("src"), ...sourceFiles("test")].filter(
            (file) => file !== "test/effect-migration.test.ts",
          ),
          /vite-plus\/test/u,
        ),
        [],
      );
    });
  });
});
