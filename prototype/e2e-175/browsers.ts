// issue #175 プロトタイプ: @puppeteer/browsers による Chrome 供給（Bun 上での動作検証を兼ねる）
// キャッシュは @puppeteer/browsers の標準位置 (~/.cache/puppeteer) に置き、再実行時の再 DL を避ける
import { homedir } from "node:os";
import { join } from "node:path";
import { Browser, computeExecutablePath, install } from "@puppeteer/browsers";

// research #174 §5 で実測に使われた Chrome for Testing Stable の pin
export const CHROME_BUILD = "151.0.7922.71";

const cacheDir = join(homedir(), ".cache", "puppeteer");

export async function ensureBrowser(browser: "chrome" | "chrome-headless-shell"): Promise<string> {
	const b = browser === "chrome" ? Browser.CHROME : Browser.CHROMEHEADLESSSHELL;
	await install({ browser: b, buildId: CHROME_BUILD, cacheDir });
	return computeExecutablePath({ browser: b, buildId: CHROME_BUILD, cacheDir });
}
