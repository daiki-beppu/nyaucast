import { readFileSync } from "node:fs";
import { join } from "node:path";

import { assert, describe, it } from "@effect/vitest";

const packageRoot = join(import.meta.dirname, "..");
const read = (file: string) => readFileSync(join(packageRoot, file), "utf8");

// ADR-0011 決定 10 の文面。node-av を依存に加える差分で、NOTICE と README の「ライセンス」節に同時に付ける。
const gplNotice =
  "nyaucast のソースは Apache-2.0 で提供する。実行には GPLv3 でライセンスされた node-av（libx264 を含むビルド）が必要で、nyaucast を node-av と一緒に頒布・実行する場合、全体は GPLv3 の条件に従う。";

const licenseSection = (readme: string) => {
  const start = readme.indexOf("## ライセンス");
  const rest = readme.slice(start + 1);
  const next = rest.search(/\n## /u);
  return next === -1 ? rest : rest.slice(0, next);
};

describe("audio dependencies (ADR-0005 decisions 1 and 2)", () => {
  const manifest = JSON.parse(read("package.json")) as {
    dependencies: Record<string, string>;
  };

  it.each(["mediabunny", "@mediabunny/server", "@audio/loudness-lufs"])(
    "depends on %s as a runtime dependency pinned to an exact version",
    (name) => {
      assert.match(manifest.dependencies[name] ?? "", /^\d+\.\d+\.\d+$/u);
    },
  );
});

describe("the GPL notice (ADR-0011 decision 10)", () => {
  it("is in NOTICE together with the copyright line", () => {
    const notice = read("NOTICE");

    assert.include(notice, "Copyright 2026 daiki-beppu");
    assert.include(notice, gplNotice);
  });

  it("is in the license section of the README", () => {
    assert.include(licenseSection(read("README.md")), gplNotice);
  });
});
