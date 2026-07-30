// issue #175 プロトタイプ: composition 配信用の最小静的サーバ（gsap は node_modules から供給）
import { join } from "node:path";

const compositionsDir = join(import.meta.dir, "compositions");
const gsapPath = join(import.meta.dir, "..", "..", "node_modules", "gsap", "dist", "gsap.min.js");

export function startServer(): { origin: string; stop: () => void } {
	const server = Bun.serve({
		port: 0,
		fetch(req) {
			const path = new URL(req.url).pathname;
			if (path === "/gsap.min.js") return new Response(Bun.file(gsapPath));
			return new Response(Bun.file(join(compositionsDir, path.replace(/[^\w.-]/g, ""))));
		},
	});
	return { origin: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}
