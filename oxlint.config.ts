import core from "ultracite/oxlint/core";

export default {
  ...core,
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
      // scripts/ はリポジトリ自身を検査する開発ツールで、出荷物ではない。
      // test/** と同じ扱いにする。YAML パースの型付けは境界で 1 回だけ行う。
      files: ["scripts/**/*.ts"],
      rules: {
        "eslint/func-style": "off",
        "typescript/no-unsafe-type-assertion": "off",
      },
    },
    {
      // src/index.ts は bin ランチャの委譲先として存在するだけで、中身は
      // #1 (tracer) で MCP tool のフラットな import 配列になる (ADR-0001)。
      files: ["src/index.ts"],
      rules: {
        "unicorn/no-empty-file": "off",
      },
    },
  ],
};
