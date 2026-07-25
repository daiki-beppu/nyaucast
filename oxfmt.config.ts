import ultracite from "ultracite/oxfmt";

export default {
  ...ultracite,
  ignorePatterns: [
    ...(ultracite.ignorePatterns ?? []),
    "CONTEXT.md",
    "docs/agents/**",
    "prototype/**",
  ],
};
