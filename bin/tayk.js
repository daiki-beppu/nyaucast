#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const entrypoint = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const result = spawnSync("bun", [entrypoint, ...process.argv.slice(2)], {
  stdio: "inherit",
});

if (result.error) {
  if ("code" in result.error && result.error.code === "ENOENT") {
    console.error(
      "Bun is required to run tayk. Install Bun from https://bun.sh/docs/installation",
    );
  } else {
    console.error(`Failed to start Bun: ${result.error.message}`);
  }
  process.exitCode = 1;
} else if (result.signal) {
  process.kill(process.pid, result.signal);
} else {
  process.exitCode = result.status ?? 1;
}
