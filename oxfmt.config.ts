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
  // ultracite は `never`（prose を 1 行に畳んでソフトラップに任せる）を指定するが、
  // takt の facet は LLM へのプロンプトで、行の分かち書きが指示の構造そのものになる。
  // 畳まれると禁止事項が前の文に埋没するため、既存の改行を保つ。
  proseWrap: "preserve",
};
