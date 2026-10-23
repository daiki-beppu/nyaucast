import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { assert, describe, it } from "@effect/vitest";

import config from "../vite.config.ts";

const packageRoot = resolve(import.meta.dirname, "..");
const oxlint = join(packageRoot, "node_modules", ".bin", "oxlint");

type RestrictedRule =
  | "no-restricted-globals"
  | "no-restricted-imports"
  | "no-restricted-properties";

interface Fixture {
  readonly file: string;
  readonly code: string;
  /** このファイルに出るべき違反の規則（昇順）。通るなら空。 */
  readonly violations: readonly RestrictedRule[];
  /** 既存の Bun の禁止は、この issue の対象外なのでメッセージを縛らない。 */
  readonly existing?: true;
}

const rejected = (file: string, rule: RestrictedRule, code: string): Fixture => ({
  file,
  code,
  violations: [rule],
});
const allowed = (file: string, code: string): Fixture => ({ file, code, violations: [] });

const imports = "no-restricted-imports";
const properties = "no-restricted-properties";
const globals = "no-restricted-globals";

const fixtures: readonly Fixture[] = [
  // zod
  rejected("src/zod.ts", imports, 'import { z } from "zod";\nexport const a = z;\n'),
  // Drizzle と公式 MCP SDK
  rejected(
    "src/drizzle-orm.ts",
    imports,
    'import { sql } from "drizzle-orm";\nexport const a = sql;\n',
  ),
  rejected(
    "src/drizzle-kit.ts",
    imports,
    'import { defineConfig } from "drizzle-kit";\nexport const a = defineConfig;\n',
  ),
  rejected(
    "src/mcp-sdk.ts",
    imports,
    'import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";\nexport const a = McpServer;\n',
  ),
  // vite-plus/test は src と test のどちらでも禁止
  rejected(
    "src/vite-plus-test.ts",
    imports,
    'import { it } from "vite-plus/test";\nexport const a = it;\n',
  ),
  rejected(
    "test/vite-plus-test.ts",
    imports,
    'import { it } from "vite-plus/test";\nexport const a = it;\n',
  ),
  allowed("test/effect-vitest.ts", 'import { it } from "@effect/vitest";\nexport const a = it;\n'),
  // libSQL client は local store だけ
  rejected(
    "src/libsql-client.ts",
    imports,
    'import { createClient } from "@libsql/client";\nexport const a = createClient;\n',
  ),
  rejected(
    "src/libsql-client-class.ts",
    imports,
    'import { LibsqlClient } from "@effect/sql-libsql";\nexport const a = LibsqlClient;\n',
  ),
  // local store に認める例外は libSQL の 2 つの import だけ。ほかの禁止（zod、JSON.parse）は掛かり続ける
  {
    file: "src/db/local-store.ts",
    code: 'import { createClient } from "@libsql/client";\nimport { LibsqlClient } from "@effect/sql-libsql";\nimport { z } from "zod";\nexport const a = [createClient, LibsqlClient, z, JSON.parse("1")];\n',
    violations: [imports, properties],
  },
  allowed(
    "src/libsql-migrator.ts",
    'import { LibsqlMigrator } from "@effect/sql-libsql";\nexport const a = LibsqlMigrator;\n',
  ),
  // process.argv: テストにも掛かる
  rejected("src/argv.ts", properties, "export const a = process.argv;\n"),
  rejected("src/argv.test.ts", properties, "export const a = process.argv;\n"),
  // グローバルの fetch
  rejected("src/fetch.ts", globals, 'export const a = fetch("https://example.com");\n'),
  allowed("src/fetch-in-string.ts", "export const a = `fetch(url)`;\n"),
  // Effect の実行関数: テスト以外の src では禁止、entry point は例外
  rejected(
    "src/run-promise.ts",
    properties,
    'import { Effect } from "effect";\nexport const a = Effect.runPromise(Effect.void);\n',
  ),
  rejected(
    "src/run-sync.ts",
    properties,
    'import { Effect } from "effect";\nexport const a = Effect.runSync(Effect.void);\n',
  ),
  rejected(
    "src/run-fork.ts",
    properties,
    'import { Effect } from "effect";\nexport const a = Effect.runFork(Effect.void);\n',
  ),
  rejected(
    "src/run-main.ts",
    properties,
    'import { NodeRuntime } from "@effect/platform-node";\nexport const a = NodeRuntime.runMain(program);\n',
  ),
  allowed(
    "src/run-promise.test.ts",
    'import { Effect } from "effect";\nexport const a = Effect.runPromise(Effect.void);\n',
  ),
  allowed(
    "src/run-sync.test.ts",
    'import { Effect } from "effect";\nexport const a = Effect.runSync(Effect.void);\n',
  ),
  allowed(
    "src/run-fork.test.ts",
    'import { Effect } from "effect";\nexport const a = Effect.runFork(Effect.void);\n',
  ),
  allowed(
    "src/run-main.test.ts",
    'import { NodeRuntime } from "@effect/platform-node";\nexport const a = NodeRuntime.runMain(program);\n',
  ),
  // entry point に認める例外は実行関数 4 種だけ。ほかの禁止（JSON.parse、Date.now）は掛かり続ける
  {
    file: "src/index.ts",
    code: 'import { Effect } from "effect";\nimport { NodeRuntime } from "@effect/platform-node";\nexport const a = [Effect.runPromise(Effect.void), Effect.runSync(Effect.void), Effect.runFork(Effect.void), NodeRuntime.runMain(program), JSON.parse("1"), Date.now()];\n',
    violations: [properties, properties],
  },
  // Date.now: テスト以外の src では禁止
  rejected("src/date-now.ts", properties, "export const a = Date.now();\n"),
  allowed("src/date-now.test.ts", "export const a = Date.now();\n"),
  // JSON.parse: テスト以外の src では禁止。文字列の中とテストは対象外
  rejected("src/json-parse.ts", properties, 'export const a = JSON.parse("1");\n'),
  allowed("src/json-parse.test.ts", 'export const a = JSON.parse("1");\n'),
  allowed(
    "src/json-parse-in-template.ts",
    'export const a = `<script>JSON.parse(document.getElementById("nc-data").textContent)</script>`;\n',
  ),
  allowed("test/json-parse.ts", 'export const a = JSON.parse("1");\n'),
  // process.exit: src・bin・scripts のすべてで禁止。process.exitCode は対象外
  rejected("src/exit.ts", properties, "process.exit(1);\n"),
  rejected("src/exit.test.ts", properties, "process.exit(1);\n"),
  rejected("bin/exit.js", properties, "process.exit(1);\n"),
  rejected("scripts/exit.ts", properties, "process.exit(1);\n"),
  allowed("scripts/exit-code.ts", "process.exitCode = 1;\n"),
  // 既存の Bun の禁止を維持する
  {
    ...rejected("src/bun-global.ts", globals, 'export const a = Bun.file("x");\n'),
    existing: true,
  },
  {
    ...rejected("bin/bun-global.js", globals, 'export const a = Bun.file("x");\n'),
    existing: true,
  },
  {
    ...rejected(
      "src/bun-import.ts",
      imports,
      'import { Database } from "bun:sqlite";\nexport const a = Database;\n',
    ),
    existing: true,
  },
  {
    ...rejected(
      "bin/bun-import.js",
      imports,
      'import { Database } from "bun:sqlite";\nexport const a = Database;\n',
    ),
    existing: true,
  },
  {
    ...rejected("src/bun-global.test.ts", globals, 'export const a = Bun.file("x");\n'),
    existing: true,
  },
];

interface Diagnostic {
  readonly message: string;
  /** 規則の message オプションは help（globals は message）に入る。 */
  readonly help?: string;
  readonly code: string;
  readonly filename: string;
}

function lintFixtures(): readonly Diagnostic[] {
  const root = mkdtempSync(join(tmpdir(), "nyaucast-lint-"));
  try {
    for (const fixture of fixtures) {
      const target = join(root, fixture.file);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, fixture.code);
    }
    // oxlint は設定ファイルのあるディレクトリを基準に override の files を解釈する
    writeFileSync(
      join(root, ".oxlintrc.json"),
      JSON.stringify({ overrides: config.lint?.overrides ?? [] }),
    );
    const run = spawnSync(oxlint, ["-c", ".oxlintrc.json", "--format=json", "."], {
      cwd: root,
      encoding: "utf8",
    });
    assert.isUndefined(run.error, "oxlint を起動できる");
    return (JSON.parse(run.stdout) as { diagnostics: Diagnostic[] }).diagnostics.filter(
      (diagnostic) => diagnostic.code.startsWith("eslint(no-restricted-"),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const diagnostics = lintFixtures();

describe("lint rules for the structural checks (ADR-0014)", () => {
  for (const fixture of fixtures) {
    const found = diagnostics.filter((diagnostic) => diagnostic.filename === fixture.file);

    it(
      fixture.violations.length === 0
        ? `accepts ${fixture.file}`
        : `rejects ${fixture.file} with ${fixture.violations.join(", ")}`,
      () => {
        assert.deepStrictEqual(
          found.map((diagnostic) => diagnostic.code.replace(/^eslint\((.*)\)$/u, "$1")).toSorted(),
          [...fixture.violations],
        );
        if (!fixture.existing) {
          for (const diagnostic of found) {
            assert.include(`${diagnostic.message} ${diagnostic.help ?? ""}`, "ADR-0014");
          }
        }
      },
    );
  }

  it("uses only the three restricted-* rules for the new bans", () => {
    const used = new Set(
      (config.lint?.overrides ?? []).flatMap((override) => Object.keys(override.rules ?? {})),
    );

    assert.isFalse(used.has("no-restricted-syntax"));
    for (const rule of [
      "no-restricted-globals",
      "no-restricted-imports",
      "no-restricted-properties",
    ]) {
      assert.isTrue(used.has(rule), rule);
    }
  });
});
