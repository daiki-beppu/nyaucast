// issue #790: 併用（both）で 1 つの Chrome に 2 タブを開くと、撮影が返らなくなることの再現。実行: node prototype/capture-bench/hang.ts <composition.html>
import { captureAt, flagSets, launch, openTab } from "./lib.ts";
const file = process.argv[2]!;
const b = await launch(flagSets.both!);
const t1 = await openTab(b, file); console.log("tab1 open");
const t2 = await openTab(b, file); console.log("tab2 open");
const timed = async (label: string, p: Promise<unknown>) => { const s = performance.now(); const r = await Promise.race([p.then(() => "ok"), new Promise((r) => setTimeout(() => r("TIMEOUT"), 5000))]); console.log(label, r, Math.round(performance.now() - s)); };
await timed("tab2 shot", captureAt(t2, 1));
await timed("tab1 shot", captureAt(t1, 1));
await timed("parallel", Promise.all([captureAt(t1, 2), captureAt(t2, 3)]));
await b.close(); process.exit(0);
