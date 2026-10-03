import { Predicate } from "effect";

/**
 * CLI の境界が stderr に出す 1 行。失敗のタグと事実の field だけを出し、stack・cause・message は出さない。
 * タグを持たない値（想定外の失敗）は固定の名前だけにする。
 */
export function describeFailure(failure: unknown): string {
  if (!Predicate.hasProperty(failure, "_tag") || typeof failure._tag !== "string") {
    return "UnexpectedFailure";
  }
  const facts = Object.fromEntries(Object.entries(failure).filter(([key]) => key !== "_tag"));
  return Object.keys(facts).length === 0
    ? failure._tag
    : `${failure._tag} ${JSON.stringify(facts)}`;
}
