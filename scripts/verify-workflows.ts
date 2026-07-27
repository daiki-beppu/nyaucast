#!/usr/bin/env bun
/**
 * .takt/workflows/*.yaml の構造検査。
 *
 * `takt workflow doctor` は facet 参照や schema の妥当性を見るが、遷移グラフの性質
 * （到達性・ループ上限の実効性・sub-workflow の返り値の網羅）は見ない。ここはその差分を埋める。
 *
 * 中心にあるのは検査 C と F である。
 *
 * C: takt の cycle 判定は「履歴末尾でパターンが *連続して* threshold 回反復する」厳密一致
 *    なので、cycle の外から再入される step があるとカウントが 1 に戻り、loop monitor の
 *    上限が永久に発火しない。ADR-0006 決定 6 はこの場合に `{step_iteration}` による
 *    自前のラウンド上限を要求している。
 * F: callable sub-workflow の子は専用の report namespace を持ち、親のレポートが見えない。
 *    レポート生成フェーズのプロンプトが探索まで禁じているため、実走行して「ファイルが無い」
 *    で初めて気づくうえ、agent 側のリカバリも効かない（ADR-0006 決定 13）。
 *
 * 使い方: bun run verify-workflows（`bun run check` の 1 ゲートとしても実行される）
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const WORKFLOW_DIR = ".takt/workflows";
const INSTRUCTION_DIR = ".takt/facets/instructions";
/** takt が遷移先として解釈する予約語。実在 step を指さなくてよい */
const RESERVED_TARGETS = new Set(["COMPLETE", "ABORT"]);
/** ラウンド上限の rule を見分ける表記。ADR-0006 決定 6 の二重化はこの形で書く */
const ROUND_CAP_MARKER = "回目以降";

interface Rule {
  condition?: string;
  when?: string;
  next?: string;
  return?: string;
}

interface OutputContracts {
  report?: { name: string; format?: string }[];
}

interface Step {
  name: string;
  kind?: string;
  call?: string;
  mode?: string;
  instruction?: string;
  args?: Record<string, unknown>;
  policy?: string | string[];
  knowledge?: string | string[];
  quality_gates?: string[];
  output_contracts?: OutputContracts;
  parallel?: Step[];
  rules?: Rule[];
}

interface Monitor {
  cycle: string[];
  threshold?: number;
  judge?: { rules?: Rule[] };
}

interface Workflow {
  name: string;
  initial_step?: string;
  subworkflow?: { callable?: boolean; returns?: string[] };
  loop_monitors?: Monitor[];
  steps: Step[];
}

const failures: string[] = [];
const notes: string[] = [];

function fail(workflow: string, check: string, message: string): void {
  failures.push(`[${workflow}] ${check}: ${message}`);
}

function note(workflow: string, check: string, message: string): void {
  notes.push(`[${workflow}] ${check}: ${message}`);
}

/** step から出ていく遷移先（予約語を除いた実 step 名）を集める */
function outgoingTargets(step: Step): string[] {
  return (step.rules ?? [])
    .map((rule) => rule.next)
    .filter(
      (next): next is string =>
        next !== undefined && !RESERVED_TARGETS.has(next)
    );
}

/** step とその parallel 子 step を平坦に並べる */
function flattenSteps(steps: Step[]): Step[] {
  return steps.flatMap((step) => [step, ...(step.parallel ?? [])]);
}

/** その step が出力するレポートのファイル名 */
function reportNames(step: Step): string[] {
  return (step.output_contracts?.report ?? []).map((entry) => entry.name);
}

/**
 * args で子 workflow へ渡す instruction facet 名。
 * これらは子の中で実行されるため、親のレポートは見えない（ADR-0006 決定 13）
 */
function delegatedInstructions(step: Step): string[] {
  const collected: string[] = [];
  for (const [key, value] of Object.entries(step.args ?? {})) {
    if (!key.endsWith("instruction")) {
      continue;
    }
    for (const item of Array.isArray(value) ? value : [value]) {
      if (typeof item === "string") {
        collected.push(item);
      }
    }
  }
  return collected;
}

/** その step が自前のラウンド上限を持つか（ADR-0006 決定 6 の二重化） */
function hasRoundCap(step: Step): boolean {
  return (step.rules ?? []).some((rule) =>
    (rule.condition ?? "").includes(ROUND_CAP_MARKER)
  );
}

/**
 * origins のいずれかから target へ至る最短経路を返す（origins 自身は含まず target を含む）。
 * 到達できなければ null。cycle から流入元へ戻れるか = その流入が往復かどうかの判定に使う。
 */
function shortestPath(
  origins: string[],
  target: string,
  byName: Map<string, Step>
): string[] | null {
  const previous = new Map<string, string>();
  const seen = new Set<string>(origins);
  const queue = [...origins];
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) {
      break;
    }
    const step = byName.get(current);
    if (!step) {
      continue;
    }
    for (const next of outgoingTargets(step)) {
      if (seen.has(next)) {
        continue;
      }
      seen.add(next);
      previous.set(next, current);
      if (next === target) {
        const route = [target];
        let cursor = current;
        let parent = previous.get(cursor);
        while (parent !== undefined) {
          route.unshift(cursor);
          cursor = parent;
          parent = previous.get(cursor);
        }
        return route;
      }
      queue.push(next);
    }
  }
  return null;
}

const files = readdirSync(WORKFLOW_DIR)
  .filter((file) => file.endsWith(".yaml"))
  .toSorted();

const workflows = new Map<string, Workflow>();
for (const file of files) {
  const parsed = Bun.YAML.parse(
    readFileSync(path.join(WORKFLOW_DIR, file), "utf-8")
  ) as Workflow;
  workflows.set(parsed.name, parsed);
}

for (const [name, workflow] of workflows) {
  const steps = workflow.steps ?? [];
  const stepNames = new Set(steps.map((step) => step.name));
  const byName = new Map(steps.map((step) => [step.name, step]));

  // ── A. 遷移先が実在するか ────────────────────────────────────────
  const initial = workflow.initial_step;
  if (initial !== undefined && !stepNames.has(initial)) {
    fail(
      name,
      "A/遷移先の実在",
      `initial_step "${initial}" に対応する step がない`
    );
  }
  for (const step of steps) {
    for (const target of outgoingTargets(step)) {
      if (!stepNames.has(target)) {
        fail(
          name,
          "A/遷移先の実在",
          `${step.name} → "${target}" は実在しない step`
        );
      }
    }
  }
  for (const monitor of workflow.loop_monitors ?? []) {
    for (const member of monitor.cycle) {
      if (!stepNames.has(member)) {
        fail(
          name,
          "A/遷移先の実在",
          `loop monitor の cycle に実在しない step "${member}"`
        );
      }
    }
    for (const rule of monitor.judge?.rules ?? []) {
      if (
        rule.next !== undefined &&
        !RESERVED_TARGETS.has(rule.next) &&
        !stepNames.has(rule.next)
      ) {
        fail(
          name,
          "A/遷移先の実在",
          `loop monitor の rule が実在しない step "${rule.next}" を指す`
        );
      }
    }
  }

  // ── B. initial_step から全 step に到達できるか ──────────────────
  if (initial !== undefined && stepNames.has(initial)) {
    const reached = new Set<string>([initial]);
    const queue = [initial];
    while (queue.length > 0) {
      const head = queue.shift();
      if (head === undefined) {
        break;
      }
      const current = byName.get(head);
      if (!current) {
        continue;
      }
      const fromMonitors = (workflow.loop_monitors ?? [])
        .filter((monitor) => monitor.cycle.includes(current.name))
        .flatMap((monitor) =>
          (monitor.judge?.rules ?? []).map((rule) => rule.next)
        )
        .filter(
          (next): next is string =>
            next !== undefined && !RESERVED_TARGETS.has(next)
        );
      for (const target of [...outgoingTargets(current), ...fromMonitors]) {
        if (!reached.has(target)) {
          reached.add(target);
          queue.push(target);
        }
      }
    }
    for (const step of steps) {
      if (!reached.has(step.name)) {
        fail(name, "B/到達性", `${step.name} は initial_step から到達できない`);
      }
    }
  }

  // ── C. cycle が途切れる往復に、止まる保証があるか ────────────────
  //
  // cycle 内の step に、cycle 上の直前 step 以外から遷移が入ると、履歴に別 step が挟まって
  // カウントが 1 に戻る。ただし流入元が cycle から到達できないなら、それは cycle への
  // 入口であって往復ではない（一度きりなので上限は要らない）。
  //
  // 往復になるのは「cycle → … → 流入元 → cycle」と回れる場合だけである。この往復のどこかに
  // ラウンド上限を持つ step が 1 つでもあれば、monitor が発火しなくても実行は止まる。
  // 1 つもなければ、その往復は max_steps まで回りうる。
  for (const monitor of workflow.loop_monitors ?? []) {
    const { cycle } = monitor;
    for (const [index, member] of cycle.entries()) {
      const predecessor = cycle[(index - 1 + cycle.length) % cycle.length];
      const intruders = steps
        .filter((step) => step.name !== predecessor)
        .filter((step) => outgoingTargets(step).includes(member))
        .map((step) => step.name);

      for (const intruder of intruders) {
        // cycle から流入元へ戻れないなら入口。往復しないので上限は不要
        const back = shortestPath(cycle, intruder, byName);
        if (!back) {
          continue;
        }

        // 往復を構成する step 全体（cycle 本体 + 戻り経路）のどこかに上限が要る
        const loopSteps = new Set([...cycle, ...back]);
        const guards = [...loopSteps];
        const capped = guards.filter((stepName) => {
          const step = byName.get(stepName);
          return step ? hasRoundCap(step) : false;
        });
        // 上限がなくても、この往復に収まる cycle を別の monitor が見ているなら発火する
        const covering = (workflow.loop_monitors ?? []).find(
          (other) =>
            other !== monitor &&
            other.cycle.every((member2) => loopSteps.has(member2))
        );
        const detour = back.join(" → ");
        if (capped.length > 0) {
          note(
            name,
            "C/ループの上限",
            `cycle [${cycle.join(", ")}] は ${detour} → ${member} の往復で途切れうるが、` +
              `${capped.join(" / ")} のラウンド上限で止まる`
          );
        } else if (covering) {
          note(
            name,
            "C/ループの上限",
            `cycle [${cycle.join(", ")}] は ${detour} → ${member} の往復で途切れうるが、` +
              `その往復は monitor [${covering.cycle.join(", ")}] が見ている`
          );
        } else {
          fail(
            name,
            "C/ループの上限",
            `cycle [${cycle.join(", ")}] は ${detour} → ${member} の往復で途切れる。` +
              `takt の cycle 判定は連続一致なので monitor は発火せず、この往復には上限を持つ step が 1 つもない` +
              `（ADR-0006 決定 6）。往復を見る monitor を足すか、どこかに {step_iteration} の上限を置くこと`
          );
        }
      }
    }
  }

  // ── D. sub-workflow の返り値が宣言と呼び出し側で整合するか ────────
  const declaredReturns = new Set(workflow.subworkflow?.returns);
  for (const step of steps) {
    for (const rule of step.rules ?? []) {
      if (rule.return !== undefined && !declaredReturns.has(rule.return)) {
        fail(
          name,
          "D/返り値の整合",
          `${step.name} が return: ${rule.return} を返すが subworkflow.returns に宣言がない`
        );
      }
    }
  }
  for (const step of steps) {
    if (step.kind !== "workflow_call" || step.call === undefined) {
      continue;
    }
    const callee = workflows.get(step.call);
    if (!callee) {
      note(
        name,
        "D/返り値の整合",
        `${step.name} が呼ぶ "${step.call}" は builtin（検査対象外）`
      );
      continue;
    }
    const handled = new Set(
      (step.rules ?? []).map((rule) => rule.condition).filter(Boolean)
    );
    for (const declared of callee.subworkflow?.returns ?? []) {
      if (!handled.has(declared)) {
        fail(
          name,
          "D/返り値の整合",
          `${step.name} は "${step.call}" の返り値 "${declared}" を処理していない`
        );
      }
    }
  }
}

// ── E. 複製された step が食い違っていないか ──────────────────────
//
// 決定 13 により spillover は callable 化できず feature / fix に複製される。ADR が
// Considered Options で自ら挙げた「複製された定義は必ず片方だけ更新される」を機械的に止める。
// rules は戻り先が workflow ごとに異なる（plan / diagnose）ため比較から除く。
const occurrences = new Map<string, { workflow: string; step: Step }[]>();
for (const [name, workflow] of workflows) {
  for (const step of workflow.steps ?? []) {
    if (step.kind === "workflow_call" || step.mode === "system") {
      continue;
    }
    occurrences.set(step.name, [
      ...(occurrences.get(step.name) ?? []),
      { step, workflow: name },
    ]);
  }
}

/** rules を除いた step 定義の指紋。複製どうしはこれが一致していなければならない */
function stepFingerprint(step: Step): string {
  return JSON.stringify({
    instruction: step.instruction,
    knowledge: step.knowledge,
    output_contracts: step.output_contracts,
    policy: step.policy,
    quality_gates: step.quality_gates,
  });
}

for (const [stepName, entries] of occurrences) {
  const [first, ...rest] = entries;
  if (first === undefined || rest.length === 0) {
    continue;
  }
  for (const other of rest) {
    if (stepFingerprint(first.step) === stepFingerprint(other.step)) {
      note(
        other.workflow,
        "E/複製の一致",
        `step "${stepName}" は ${first.workflow} と一致（rules 以外）`
      );
      continue;
    }
    fail(
      other.workflow,
      "E/複製の一致",
      `step "${stepName}" の定義が ${first.workflow} と食い違う（rules 以外）。` +
        `複製を許した step は両方を同時に更新すること（ADR-0006 決定 13）`
    );
  }
}

// ── F. レポート境界をまたぐ参照がないか ──────────────────────────
//
// callable sub-workflow の子は専用の report namespace を持ち、親のレポートは見えない。
// レポート生成フェーズのプロンプトが「Report Directory 内のファイルのみ使用してください。
// 他のレポートディレクトリは検索/参照しないでください」と探索まで禁じているため、
// 実走行して「ファイルが無い」で初めて気づくうえ、agent 側のリカバリも効かない。
//
// instruction が「その workflow が生成しないレポート」をファイル名で参照していたら止める。
// 境界そのものを説明している行（「探さないでください」等）は対象外。
const BOUNDARY_NOTE = /探さないで|見えません|参照しない|存在しません|読めない/u;

const reportOwners = new Map<string, Set<string>>();
for (const [name, workflow] of workflows) {
  for (const step of flattenSteps(workflow.steps ?? [])) {
    for (const reportName of reportNames(step)) {
      reportOwners.set(
        reportName,
        (reportOwners.get(reportName) ?? new Set<string>()).add(name)
      );
    }
  }
}

// instruction facet ごとに「それを実行する workflow」を集める。
// feature / fix で共有している facet は、呼び出し元によって対象レポートが変わる
// （`tayk-review-test-design` が plan.md と diagnosis.md の両方に言及する等）ため、
// 判定は step 単位ではなく facet 単位で行う —— 実行しうる workflow のどれか 1 つでも
// そのレポートを生成するなら、その言及は条件分岐であって境界越えではない。
const facetReaders = new Map<string, Set<string>>();
for (const [name, workflow] of workflows) {
  for (const step of flattenSteps(workflow.steps ?? [])) {
    if (step.instruction !== undefined) {
      facetReaders.set(
        step.instruction,
        (facetReaders.get(step.instruction) ?? new Set()).add(name)
      );
    }
    // args で渡した instruction は子の中で動くので、reader は親ではなく子
    for (const facet of delegatedInstructions(step)) {
      const child = step.call ?? "(child)";
      facetReaders.set(
        facet,
        (facetReaders.get(facet) ?? new Set()).add(child)
      );
    }
  }
}

for (const [facet, readers] of facetReaders) {
  const owner = [...readers].toSorted().join(" / ");
  let body: string;
  try {
    body = readFileSync(path.join(INSTRUCTION_DIR, `${facet}.md`), "utf-8");
  } catch {
    note(
      owner,
      "F/レポート境界",
      `instruction "${facet}" は builtin（検査対象外）`
    );
    continue;
  }
  const flagged = new Set<string>();
  for (const line of body.split("\n")) {
    if (BOUNDARY_NOTE.test(line)) {
      continue;
    }
    for (const [reportName, owners] of reportOwners) {
      if (!line.includes(reportName) || flagged.has(reportName)) {
        continue;
      }
      if ([...readers].some((reader) => owners.has(reader))) {
        continue;
      }
      flagged.add(reportName);
      fail(
        owner,
        "F/レポート境界",
        `instruction "${facet}" が "${reportName}" を参照しているが、` +
          `これを生成するのは ${[...owners].toSorted().join(" / ")} で、${owner} からは読めない` +
          `（ADR-0006 決定 13）`
      );
    }
  }
}

const checked = [...workflows.keys()].toSorted().join(", ");
console.log(`検査対象: ${files.length} workflow (${checked})\n`);

for (const line of notes) {
  console.log(`  note  ${line}`);
}
if (notes.length > 0) {
  console.log("");
}

if (failures.length > 0) {
  for (const line of failures) {
    console.log(`  FAIL  ${line}`);
  }
  console.log(`\n${failures.length} 件の問題が見つかりました。`);
  process.exit(1);
}

console.log(
  "検査 A（遷移先の実在）/ B（到達性）/ C（ループの上限）/ D（返り値の整合）/ " +
    "E（複製の一致）/ F（レポート境界）: すべて pass"
);
