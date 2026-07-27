import ultracite from "ultracite/oxfmt";

export default {
  ...ultracite,
  ignorePatterns: [
    ...(ultracite.ignorePatterns ?? []),
    "CONTEXT.md",
    "docs/agents/**",
    // 調査記録は上流コードを行番号付きで逐語引用する。整形すると引用が原典と
    // 一致しなくなり、根拠資料としての検証可能性が壊れる。
    "docs/research/**",
    "prototype/**",
  ],
};
