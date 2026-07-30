// issue #175 プロトタイプ: seek 方式の capture セッション（cdp.ts の上に載る薄い層）
import { Page, type CdpConnection } from "./cdp";

export type SettleMode = "raf" | "none";

export type CaptureFormat = { format: "png" | "jpeg"; quality?: number; optimizeForSpeed?: boolean };

export class CaptureSession {
	page: Page;
	duration: number;

	private constructor(page: Page, duration: number) {
		this.page = page;
		this.duration = duration;
	}

	static async open(conn: CdpConnection, url: string, width = 1920, height = 1080): Promise<CaptureSession> {
		const page = await Page.open(conn, url, width, height);
		await page.evaluate<boolean>("window.__ready");
		const duration = await page.evaluate<number>("window.__hf.duration");
		return new CaptureSession(page, duration);
	}

	// seek → 描画確定待ち（double rAF）→ screenshot
	// headless では damage の無いフレームで rAF が発火しないことがあるため 50ms の timeout と race する
	async captureAt(t: number, fmt: CaptureFormat, settle: SettleMode = "raf"): Promise<Uint8Array> {
		const settleExpr =
			settle === "raf"
				? "Promise.race([new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))), new Promise(r => setTimeout(r, 50))])"
				: "Promise.resolve()";
		await this.page.evaluate(`Promise.resolve(window.__hf.seek(${t})).then(() => ${settleExpr})`);
		return this.page.screenshot(fmt);
	}

	close(): Promise<void> {
		return this.page.close();
	}
}
