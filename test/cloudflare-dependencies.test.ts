import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

import { assert, describe, it } from "@effect/vitest";

import { cfExecutablePath } from "../src/lib/cf-bin.ts";

const packageRoot = resolve(import.meta.dirname, "..");

interface CloudflareDependencyManifest {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

const readManifest = (): CloudflareDependencyManifest =>
  JSON.parse(
    readFileSync(join(packageRoot, "package.json"), "utf8"),
  ) as CloudflareDependencyManifest;

describe("Cloudflare environment dependencies (ADR-0012 decision 7)", () => {
  it.each(["alchemy", "cf"])(
    "depends on %s as a runtime dependency pinned to an exact version, not a range",
    (name) => {
      const manifest = readManifest();

      // 範囲の記号（^ ~ > < * x ||）を含まない exact pin であること。beta / preview の pre-release 識別子は許す。
      assert.match(manifest.dependencies[name] ?? "", /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u);
      assert.notProperty(manifest.devDependencies, name);
      assert.notProperty(manifest.optionalDependencies ?? {}, name);
    },
  );

  it("adds the sharp-libvips LGPL-3.0 notice to NOTICE", () => {
    const notice = readFileSync(join(packageRoot, "NOTICE"), "utf8");

    assert.include(notice, "sharp-libvips");
    assert.include(notice, "LGPL-3.0");
  });
});

describe("cf executable resolution (ADR-0012 decision 7)", () => {
  it("resolves to an absolute path supplied by nyaucast's own dependencies", () => {
    const executable = cfExecutablePath();

    assert.isTrue(isAbsolute(executable));
    assert.isTrue(existsSync(executable));
  });

  it("can be spawned as a child process to report its pinned version, without relying on the user's PATH", () => {
    const executable = cfExecutablePath();
    const pinnedVersion = readManifest().dependencies["cf"];
    assert.isDefined(pinnedVersion);

    // PATH を空にして、利用者の PATH の cf に頼っていないことを直接観測する。
    const result = spawnSync(process.execPath, [executable, "--version"], {
      encoding: "utf8",
      env: { ...process.env, PATH: "" },
      timeout: 10_000,
    });

    if (result.error !== undefined || result.status !== 0) {
      throw new Error(
        `cf --version failed\nstdout:\n${String(result.stdout)}\nstderr:\n${String(result.stderr)}`,
        { cause: result.error },
      );
    }
    assert.include(result.stdout, pinnedVersion);
  });
});

// 契約（issue #695 の plan、完了契約 C2。ADR-0012 決定3「文書に無い Layer の組み立てを1つのアダプタの
// モジュールに閉じ込める」。src/cloudflare/alchemy.test.ts もこのファイルも `alchemy` を直接 import しない
// ことで、要件4「アダプタの1モジュールだけ」を運用上も保つ）。
describe("Alchemy import containment (issue #695 decision 1, ADR-0012 decision 3)", () => {
  it("only src/cloudflare/alchemy.ts imports from the alchemy package", () => {
    // 部分一致（「含まれていること」だけ）では2本目の import に気付けないため、完全一致で比べる。
    const alchemyImportPattern = /from\s+["']alchemy(?:\/[^"']*)?["']/u;
    const importers = readdirSync(join(packageRoot, "src"), { recursive: true })
      .map(String)
      .filter((path) => path.endsWith(".ts"))
      .filter((path) =>
        alchemyImportPattern.test(readFileSync(join(packageRoot, "src", path), "utf8")),
      )
      .map((path) => `src/${path}`)
      .sort();

    assert.deepStrictEqual(importers, ["src/cloudflare/alchemy.ts"]);
  });

  // 禁止された形（issue #695 設計指針 1 行目・ADR-0012 Considered Options）: 下流リポに
  // `alchemy.run.ts` を置き、alchemy の CLI に読ませる形。リポジトリが追跡・無視していない
  // ファイルを git に列挙させて、その名前のファイルが 1 件も無いことを観測する。
  it("ships no alchemy.run.ts anywhere in the repository", () => {
    const listed = spawnSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
      cwd: packageRoot,
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.strictEqual(listed.status, 0, String(listed.stderr));

    const matches = listed.stdout
      .split("\n")
      .filter((path) => path.endsWith("alchemy.run.ts"))
      .sort();
    assert.deepStrictEqual(matches, []);
  });
});
