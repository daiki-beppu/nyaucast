/** check script のゲート（`&&` で区切った 1 つ 1 つ）。 */
export interface CheckGate {
  readonly gate: string;
  /** ゲートが走らせるコマンド。`pnpm run <name>` は script の中身に、`pnpm run '/<regex>/'` は当たる script すべての中身に展開する。 */
  readonly commands: readonly string[];
}

// 互いに依存しないゲートは、pnpm の正規表現による実行でまとめて並行に走らせる（#748）
const selectorPattern = /^'\/(.+)\/'$/u;

/** package.json の check script を、ゲートごとのコマンドに展開する。 */
export const checkGates = (scripts: Readonly<Record<string, string>>): CheckGate[] =>
  (scripts["check"] ?? "")
    .split("&&")
    .map((gate) => gate.trim())
    .map((gate) => {
      if (!gate.startsWith("pnpm run ")) return { commands: [gate], gate };
      const selector = gate.slice("pnpm run ".length);
      const pattern = selectorPattern.exec(selector)?.[1];
      const names =
        pattern === undefined
          ? [selector]
          : Object.keys(scripts).filter((name) => new RegExp(pattern, "u").test(name));
      return { commands: names.flatMap((name) => scripts[name] ?? []), gate };
    });
