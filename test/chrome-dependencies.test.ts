import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { assert, describe, it } from "@effect/vitest";

import { chromeHeadlessShellBuildId } from "../src/lib/chrome-pin.ts";

const packageRoot = resolve(import.meta.dirname, "..");

describe("Chrome supply", () => {
  it("declares @puppeteer/browsers as a runtime dependency with an exact version", () => {
    const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };

    assert.match(manifest.dependencies["@puppeteer/browsers"] ?? "", /^\d+\.\d+\.\d+$/u);
    assert.notProperty(manifest.devDependencies, "@puppeteer/browsers");
  });

  it("pins a chrome-headless-shell build id in src/lib", () => {
    assert.match(chromeHeadlessShellBuildId, /^\d+(\.\d+){3}$/u);
  });
});
