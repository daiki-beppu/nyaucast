import { defineConfig } from "vite-plus";

import { SizeShardSequencer } from "./vitest.shard.config.ts";

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
    ],
  },
  staged: {
    "*.{js,jsx,ts,tsx,json,jsonc,md,yml,yaml}": "vp fmt --write --no-error-on-unmatched-pattern",
  },
  test: {
    // CI の shard の分け方（#715）
    sequence: { sequencer: SizeShardSequencer },
    passWithNoTests: true,
    projects: [
      {
        test: {
          name: "unit",
          include: ["src/**/*.test.ts"],
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
