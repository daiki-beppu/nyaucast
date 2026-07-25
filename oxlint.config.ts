import { defineConfig } from "oxlint";
import core from "ultracite/oxlint/core";

export default defineConfig({
  ...core,
  // prototype/ は #45 / #46 の検証用コード。結論は docs/research に残っており、
  // 製品コードの type-aware 規則を適用する対象ではない
  ignorePatterns: [...(core.ignorePatterns ?? []), "prototype/**"],
  options: {
    typeAware: true,
  },
  overrides: [
    ...(core.overrides ?? []),
    {
      files: ["*.ts"],
      rules: {
        "no-implicit-globals": "off",
        "no-unused-vars": "off",
      },
    },
    {
      files: ["test/**/*.ts", "bin/**/*.test.ts"],
      rules: {
        "eslint/func-style": "off",
        "eslint/no-await-in-loop": "off",
        "eslint/no-bitwise": "off",
        "eslint/no-template-curly-in-string": "off",
        "eslint/prefer-destructuring": "off",
        "eslint/prefer-named-capture-group": "off",
        "eslint/require-unicode-regexp": "off",
        "typescript/no-unsafe-type-assertion": "off",
        "unicorn/import-style": "off",
        "unicorn/no-await-expression-member": "off",
      },
    },
    {
      files: ["src/index.ts", "bin/**/*.{js,ts}", "test/**/*.ts"],
      rules: {
        "eslint/no-inline-comments": "off",
        "eslint/no-use-before-define": "off",
        "eslint/sort-keys": "off",
        "import/consistent-type-specifier-style": "off",
        "typescript/consistent-type-definitions": "off",
        "typescript/no-unnecessary-type-assertion": "off",
        "typescript/no-unsafe-type-assertion": "off",
        "typescript/non-nullable-type-assertion-style": "off",
        "unicorn/prefer-import-meta-properties": "off",
        "unicorn/prefer-type-error": "off",
        "unicorn/require-module-specifiers": "off",
        "unicorn/text-encoding-identifier-case": "off",
      },
    },
  ],
});
