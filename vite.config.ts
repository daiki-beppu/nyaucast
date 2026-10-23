import { defineConfig } from "vite-plus";

import { WeightShardSequencer } from "./vitest.shard.config.ts";

// 構造の検査を lint に置く（ADR-0014 決定 3）。メッセージは理由 1 文と ADR-0014 を含める。
const adr = "ADR-0014";
const banned = (reason: string) => `${reason} (${adr})`;

const bunGlobal = "Bun";
const fetchGlobal = {
  name: "fetch",
  message: banned("HTTP は effect の HttpClient 経由で行う。グローバルの fetch は使わない"),
};
const processArgv = {
  object: "process",
  property: "argv",
  message: banned("引数は effect/unstable/cli で受ける。process.argv は手で読まない"),
};
const processExit = {
  object: "process",
  property: "exit",
  message: banned("終了コードは Effect の失敗で決める。process.exit は呼ばない"),
};
const jsonParse = {
  object: "JSON",
  property: "parse",
  message: banned("JSON は Schema を通して読む。外から来るデータを検証せずに使わない"),
};
const dateNow = {
  object: "Date",
  property: "now",
  message: banned("現在時刻は Clock から取る。Date.now は使わない"),
};
const effectRunners = [
  { object: "Effect", property: "runPromise" },
  { object: "Effect", property: "runSync" },
  { object: "Effect", property: "runFork" },
  { object: "NodeRuntime", property: "runMain" },
].map((entry) => ({
  ...entry,
  message: banned("Effect の実行は入口の src/index.ts だけで行う"),
}));

const bunImports = { group: ["bun:*"] };
const libsqlImports = [
  {
    name: "@libsql/client",
    message: banned("libSQL の client を開くのは src/db/local-store.ts だけ"),
  },
  {
    name: "@effect/sql-libsql",
    importNames: ["LibsqlClient"],
    message: banned("libSQL の client を開くのは src/db/local-store.ts だけ"),
  },
];
const srcImportPaths = [
  { name: "zod", message: banned("スキーマは effect/Schema で書く。zod は使わない") },
  { name: "drizzle-orm", message: banned("DB は effect の sql で扱う。Drizzle は使わない") },
  { name: "drizzle-kit", message: banned("DB は effect の sql で扱う。Drizzle は使わない") },
  {
    name: "vite-plus/test",
    message: banned("テスト API は @effect/vitest から import する"),
  },
];
const srcImportPatterns = [
  bunImports,
  {
    group: ["@modelcontextprotocol/**"],
    message: banned("MCP は effect/unstable/ai の McpServer で書く。公式 SDK は使わない"),
  },
  { group: ["zod/**"], message: banned("スキーマは effect/Schema で書く。zod は使わない") },
  { group: ["drizzle-orm/**"], message: banned("DB は effect の sql で扱う。Drizzle は使わない") },
  {
    group: ["vite-plus/test/**"],
    message: banned("テスト API は @effect/vitest から import する"),
  },
];
const srcProperties = [processArgv, processExit, jsonParse, dateNow, ...effectRunners];

export default defineConfig({
  fmt: {
    ignorePatterns: ["GLOSSARY.md", "docs/agents/**", "docs/research/**", "prototype/**"],
    proseWrap: "preserve",
  },
  lint: {
    ignorePatterns: ["prototype/**"],
    options: {
      typeAware: true,
      typeCheck: true,
    },
    overrides: [
      {
        files: ["*.ts"],
        rules: {
          "no-implicit-globals": "off",
          "no-unused-vars": "off",
        },
      },
      {
        files: ["src/index.ts"],
        rules: {
          "unicorn/no-empty-file": "off",
        },
      },
      {
        files: ["src/**/*.ts", "bin/**/*.js"],
        rules: {
          "no-restricted-globals": ["error", "Bun"],
          "no-restricted-imports": ["error", { patterns: ["bun:*"] }],
        },
      },
      // 後ろの override ほど優先される。例外は必ず src/**/*.ts より後ろに置く
      {
        files: ["src/**/*.ts"],
        rules: {
          "no-restricted-globals": ["error", bunGlobal, fetchGlobal],
          "no-restricted-imports": [
            "error",
            { paths: [...srcImportPaths, ...libsqlImports], patterns: srcImportPatterns },
          ],
          "no-restricted-properties": ["error", ...srcProperties],
        },
      },
      {
        files: ["src/**/*.test.ts"],
        rules: {
          "no-restricted-properties": ["error", processArgv, processExit],
        },
      },
      {
        files: ["src/index.ts"],
        rules: {
          "no-restricted-properties": ["error", processArgv, processExit, jsonParse, dateNow],
        },
      },
      {
        files: ["src/db/local-store.ts"],
        rules: {
          "no-restricted-imports": [
            "error",
            { paths: srcImportPaths, patterns: srcImportPatterns },
          ],
        },
      },
      {
        files: ["test/**/*.ts"],
        rules: {
          "no-restricted-imports": [
            "error",
            {
              paths: [
                {
                  name: "vite-plus/test",
                  message: banned("テスト API は @effect/vitest から import する"),
                },
              ],
            },
          ],
        },
      },
      {
        files: ["bin/**/*.js", "scripts/**/*.ts"],
        rules: {
          "no-restricted-properties": ["error", processExit],
        },
      },
    ],
  },
  staged: {
    "*.{js,jsx,ts,tsx,json,jsonc,md,yml,yaml}": "vp fmt --write --no-error-on-unmatched-pattern",
  },
  test: {
    // CI の shard の分け方（#715）
    sequence: { sequencer: WeightShardSequencer },
    passWithNoTests: true,
    projects: [
      {
        test: {
          name: "unit",
          include: ["src/**/*.test.ts", "scripts/**/*.test.ts"],
        },
      },
      {
        test: {
          name: "contract",
          include: ["test/**/*.test.ts"],
          // プロセスを起動する契約テストは、effect の読み込みを含めて 1 回に数秒かかる
          testTimeout: 30_000,
        },
      },
    ],
  },
});
