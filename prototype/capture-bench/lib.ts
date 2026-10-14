// issue #790: 撮影ベンチの部品。src/compositions/capture.ts と同じ手順（seek → double rAF と 50 ms の race → Page.captureScreenshot）を、
// Effect を使わない素の CDP で再現する。起動フラグは src/lib/chrome.ts の launchFlags と同じものに、比べるフラグを足す。
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

export const chromeExecutable = join(
  homedir(),
  ".cache/nyaucast/chrome/chrome-headless-shell/mac_arm-154.0.8037.92/chrome-headless-shell-mac-arm64/chrome-headless-shell",
);

export const flagSets: Record<string, string[]> = {
  none: [],
  dfrl: ["--disable-frame-rate-limit"],
  racsbd: ["--run-all-compositor-stages-before-draw"],
  both: ["--disable-frame-rate-limit", "--run-all-compositor-stages-before-draw"],
};

export interface Browser {
  readonly process: ChildProcess;
  readonly send: (method: string, params?: object, sessionId?: string) => Promise<any>;
  readonly waitEvent: (method: string, sessionId?: string) => Promise<any>;
  readonly close: () => Promise<void>;
}

export const launch = async (extraFlags: readonly string[]): Promise<Browser> => {
  const userData = mkdtempSync(join(tmpdir(), "nyaucast-bench-chrome-"));
  const child = spawn(
    chromeExecutable,
    [
      "--remote-debugging-port=0",
      `--user-data-dir=${userData}`,
      "--hide-scrollbars",
      "--force-color-profile=srgb",
      "--font-render-hinting=none",
      "--disable-gpu",
      ...extraFlags,
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  const url = await new Promise<string>((resolve, reject) => {
    let buffer = "";
    child.stderr!.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      const match = /DevTools listening on (ws:\/\/\S+)/u.exec(buffer);
      if (match) resolve(match[1]!);
    });
    child.on("exit", () => reject(new Error("chrome exited")));
  });
  const ws = new WebSocket(url);
  await new Promise((resolve) => ws.addEventListener("open", resolve, { once: true }));
  let nextId = 1;
  const pending = new Map<number, (value: any) => void>();
  const waiters: { method: string; sessionId?: string; resolve: (value: any) => void }[] = [];
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (message.id !== undefined) {
      const done = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) throw new Error(JSON.stringify(message.error));
      done?.(message.result);
      return;
    }
    const index = waiters.findIndex(
      (w) => w.method === message.method && w.sessionId === message.sessionId,
    );
    if (index >= 0) waiters.splice(index, 1)[0]!.resolve(message.params);
  });
  return {
    process: child,
    send: (method, params = {}, sessionId) =>
      new Promise((resolve) => {
        const id = nextId++;
        pending.set(id, resolve);
        ws.send(JSON.stringify({ id, method, params, sessionId }));
      }),
    waitEvent: (method, sessionId) =>
      new Promise((resolve) => waiters.push({ method, sessionId, resolve })),
    close: async () => {
      ws.close();
      child.kill("SIGKILL");
      await new Promise((resolve) => child.once("exit", resolve));
      rmSync(userData, { force: true, recursive: true });
    },
  };
};

export interface Tab {
  readonly browser: Browser;
  readonly sessionId: string;
}

export const openTab = async (browser: Browser, file: string): Promise<Tab> => {
  const { targetId } = await browser.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await browser.send("Target.attachToTarget", { flatten: true, targetId });
  await browser.send("Page.enable", {}, sessionId);
  await browser.send("Network.enable", {}, sessionId);
  await browser.send(
    "Network.setBlockedURLs",
    { urls: ["http://*", "https://*", "ws://*", "wss://*"] },
    sessionId,
  );
  const loaded = browser.waitEvent("Page.loadEventFired", sessionId);
  await browser.send("Page.navigate", { url: `file://${file}` }, sessionId);
  await loaded;
  await browser.send(
    "Emulation.setDeviceMetricsOverride",
    { deviceScaleFactor: 1, height: 1080, mobile: false, width: 1920 },
    sessionId,
  );
  // フォントの読み込みを待つ（初回の撮影にフォントの読み込みの時間を混ぜない）
  await browser.send(
    "Runtime.evaluate",
    { awaitPromise: true, expression: "document.fonts.ready.then(() => true)" },
    sessionId,
  );
  return { browser, sessionId };
};

const seekExpression = (seconds: number) => `(async (t) => {
  window.__hf.seek(t);
  const frame = new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const timeout = new Promise((resolve) => setTimeout(resolve, 50));
  await Promise.race([frame, timeout]);
})(${JSON.stringify(seconds)})`;

export interface Format {
  readonly name: string;
  readonly params: object;
}

export const formats: Record<string, Format> = {
  png: { name: "png", params: { format: "png" } },
  pngFast: { name: "pngFast", params: { format: "png", optimizeForSpeed: true } },
  webp100: { name: "webp100", params: { format: "webp", quality: 100 } },
  webp: { name: "webp", params: { format: "webp" } },
};

export const captureAt = async (tab: Tab, seconds: number, format: Format = formats.png!) => {
  await tab.browser.send(
    "Runtime.evaluate",
    { awaitPromise: true, expression: seekExpression(seconds), returnByValue: true },
    tab.sessionId,
  );
  const { data } = await tab.browser.send("Page.captureScreenshot", format.params, tab.sessionId);
  return Buffer.from(data, "base64");
};

// ---- Chrome のプロセス木の CPU 時間（秒）。ps の TIME 列を、起動したプロセスの子孫すべてについて足す ----

const parseTime = (text: string) => {
  // [[dd-]hh:]mm:ss.ss
  const parts = text.split(":").map(Number);
  return parts.reduce((total, part) => total * 60 + part, 0);
};

export const treeCpuSeconds = (rootPids: readonly number[]) => {
  const rows = execFileSync("ps", ["-A", "-o", "pid=,ppid=,time="], { encoding: "utf8" })
    .trim()
    .split("\n")
    .map((line) => line.trim().split(/\s+/u))
    .map(([pid, ppid, time]) => ({ pid: Number(pid), ppid: Number(ppid), time: parseTime(time!) }));
  const inTree = new Set(rootPids);
  let grew = true;
  while (grew) {
    grew = false;
    for (const row of rows) {
      if (!inTree.has(row.pid) && inTree.has(row.ppid)) {
        inTree.add(row.pid);
        grew = true;
      }
    }
  }
  return rows.filter((row) => inTree.has(row.pid)).reduce((total, row) => total + row.time, 0);
};

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
