// issue #175 プロトタイプ: Bun ネイティブ WebSocket による素の CDP クライアント
// research #174 §8 の「200〜400 行で足りる」見積りの実証を兼ねる
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type CdpMessage = {
	id?: number;
	method?: string;
	params?: Record<string, unknown>;
	sessionId?: string;
	result?: Record<string, unknown>;
	error?: { code: number; message: string };
};

type Pending = {
	resolve: (v: Record<string, unknown>) => void;
	reject: (e: Error) => void;
	method: string;
};

export class CdpConnection {
	#ws: WebSocket;
	#nextId = 1;
	#pending = new Map<number, Pending>();
	#listeners = new Map<string, Set<(params: Record<string, unknown>, sessionId?: string) => void>>();

	private constructor(ws: WebSocket) {
		this.#ws = ws;
		ws.addEventListener("message", (ev) => {
			const msg = JSON.parse(String(ev.data)) as CdpMessage;
			if (msg.id !== undefined) {
				const p = this.#pending.get(msg.id);
				if (!p) return;
				this.#pending.delete(msg.id);
				if (msg.error) p.reject(new Error(`CDP ${p.method}: ${msg.error.message} (${msg.error.code})`));
				else p.resolve(msg.result ?? {});
			} else if (msg.method) {
				const set = this.#listeners.get(msg.method);
				if (set) for (const fn of set) fn(msg.params ?? {}, msg.sessionId);
			}
		});
	}

	static connect(url: string): Promise<CdpConnection> {
		const ws = new WebSocket(url);
		return new Promise((resolve, reject) => {
			ws.addEventListener("open", () => resolve(new CdpConnection(ws)), { once: true });
			ws.addEventListener("error", () => reject(new Error(`WebSocket connect failed: ${url}`)), { once: true });
		});
	}

	send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<Record<string, unknown>> {
		const id = this.#nextId++;
		return new Promise((resolve, reject) => {
			this.#pending.set(id, { resolve, reject, method });
			this.#ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
		});
	}

	on(method: string, fn: (params: Record<string, unknown>, sessionId?: string) => void): () => void {
		let set = this.#listeners.get(method);
		if (!set) {
			set = new Set();
			this.#listeners.set(method, set);
		}
		set.add(fn);
		return () => set.delete(fn);
	}

	// sessionId が一致する（未指定なら任意の）イベントを 1 回だけ待つ
	once(method: string, sessionId?: string): Promise<Record<string, unknown>> {
		return new Promise((resolve) => {
			const off = this.on(method, (params, sid) => {
				if (sessionId !== undefined && sid !== sessionId) return;
				off();
				resolve(params);
			});
		});
	}

	close() {
		this.#ws.close();
	}
}

export type Chrome = {
	conn: CdpConnection;
	kill: () => void;
};

// --remote-debugging-port=0 で起動し、stderr の "DevTools listening on ws://…" を拾う
export async function launchChrome(executablePath: string, extraArgs: string[] = []): Promise<Chrome> {
	const userDataDir = mkdtempSync(join(tmpdir(), "tayk-proto-chrome-"));
	const proc = Bun.spawn(
		[
			executablePath,
			"--headless=new",
			"--remote-debugging-port=0",
			`--user-data-dir=${userDataDir}`,
			"--no-first-run",
			"--no-default-browser-check",
			"--mute-audio",
			"--hide-scrollbars",
			// CfT（フル Chrome）は Safe Storage 鍵を macOS キーチェーンに作ろうとしてダイアログを出す。
			// 使い捨てプロファイルには不要なので puppeteer と同じく mock keychain に逃がす
			"--use-mock-keychain",
			"--password-store=basic",
			"--force-device-scale-factor=1",
			// タブ並列時に background tab の描画がスロットルされるのを防ぐ
			"--disable-background-timer-throttling",
			"--disable-backgrounding-occluded-windows",
			"--disable-renderer-backgrounding",
			...extraArgs,
			"about:blank",
		],
		{ stderr: "pipe", stdout: "ignore" },
	);

	const wsUrl = await new Promise<string>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("Chrome の DevTools URL が 20s 以内に得られなかった")), 20_000);
		let buf = "";
		const decoder = new TextDecoder();
		(async () => {
			for await (const chunk of proc.stderr) {
				buf += decoder.decode(chunk);
				const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
				if (m) {
					clearTimeout(timer);
					resolve(m[1]);
					break;
				}
			}
		})().catch(reject);
	});

	const conn = await CdpConnection.connect(wsUrl);
	return {
		conn,
		kill: () => {
			conn.close();
			proc.kill();
		},
	};
}

export class Page {
	#conn: CdpConnection;
	#sessionId: string;

	private constructor(conn: CdpConnection, sessionId: string) {
		this.#conn = conn;
		this.#sessionId = sessionId;
	}

	static async open(conn: CdpConnection, url: string, width: number, height: number): Promise<Page> {
		// width/height は createTarget に渡さない（headless=new の chrome では新規 window 以外で position/size 指定が
		// エラーになる）。viewport は下の Emulation.setDeviceMetricsOverride が固定する
		const { targetId } = (await conn.send("Target.createTarget", { url: "about:blank" })) as {
			targetId: string;
		};
		const { sessionId } = (await conn.send("Target.attachToTarget", { targetId, flatten: true })) as {
			sessionId: string;
		};
		const page = new Page(conn, sessionId);
		await page.send("Page.enable");
		await page.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
		const loaded = conn.once("Page.loadEventFired", sessionId);
		await page.send("Page.navigate", { url });
		await loaded;
		return page;
	}

	send(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
		return this.#conn.send(method, params, this.#sessionId);
	}

	async evaluate<T>(expression: string): Promise<T> {
		const r = (await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })) as {
			result?: { value?: T };
			exceptionDetails?: { text: string; exception?: { description?: string } };
		};
		if (r.exceptionDetails) {
			throw new Error(`evaluate 失敗: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
		}
		return r.result?.value as T;
	}

	async screenshot(opts: { format: "png" | "jpeg"; quality?: number; optimizeForSpeed?: boolean }): Promise<Uint8Array> {
		const { data } = (await this.send("Page.captureScreenshot", { ...opts })) as { data: string };
		return Uint8Array.from(Buffer.from(data, "base64"));
	}

	async close() {
		await this.send("Page.close").catch(() => {});
	}
}
