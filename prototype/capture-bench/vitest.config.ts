import { defineConfig } from "vite-plus";

export default defineConfig({ test: { include: ["prototype/capture-bench/*.test.ts"] } });
