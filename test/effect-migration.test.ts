import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { assert, describe, expect, it } from "@effect/vitest";
import { parse } from "yaml";

import { checkGates } from "./check-gates.ts";

const packageRoot = resolve(import.meta.dirname, "..");

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

    it("converts wire names by hand nowhere: tools are declared with their wire names", () => {
      assert.deepStrictEqual(filesMatching(sources, /wireName/u), []);
    });
  });
});
