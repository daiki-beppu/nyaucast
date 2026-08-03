import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readRepositoryFile } from "../helpers";

const instructionPath = ".takt/facets/instructions/tayk-review-gather.md";
const temporaryDirectories: string[] = [];

interface ContractResult {
  readonly exitCode: number;
  readonly stdout: Uint8Array;
}

function readHardCapContract(): string {
  const instruction = readRepositoryFile(instructionPath);
  const match =
    /<!-- executable-contract: gather-hard-cap -->\s*```bash\n([\s\S]*?)```/.exec(
      instruction
    );

  if (match?.[1] === undefined) {
    throw new Error("gather hard cap executable contract is missing");
  }

  return match[1];
}

function runContract(scenario: string): ContractResult {
  const directory = mkdtempSync(join(tmpdir(), "tayk-gather-hard-cap-"));
  temporaryDirectories.push(directory);

  return Bun.spawnSync(
    ["bash", "-c", `${readHardCapContract()}\n${scenario}`],
    {
      cwd: directory,
      stderr: "pipe",
      stdout: "pipe",
    }
  );
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("tayk-review gather hard cap", () => {
  test("[REQ-259-01] should discard partial output when the producer fails", () => {
    const result = runContract(`
if failure_reason=$(capture_with_hard_cap output.json 100000 bash -c 'printf partial; exit 7'); then
  exit 99
fi
printf '%s\n' "$failure_reason"
test ! -e output.json
test ! -e output.json.partial
`);

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain(
      "producer failed: producer_status=7 consumer_status=0 bytes=7"
    );
  });

  test("[REQ-259-02] should classify the hard-cap SIGPIPE by status and byte count", () => {
    const result = runContract(`
if failure_reason=$(capture_with_hard_cap output.json 100000 yes); then
  exit 99
fi
printf '%s\n' "$failure_reason"
test ! -e output.json
test ! -e output.json.partial
`);

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain(
      "hard cap exceeded: producer_status=141 consumer_status=0 bytes=100001 limit=100000"
    );
  });

  test("[REQ-259-03] should reject output when the consumer fails", () => {
    const result = runContract(`
head() {
  command head "$@"
  return 9
}
if failure_reason=$(capture_with_hard_cap output.json 100000 printf complete); then
  exit 99
fi
printf '%s\n' "$failure_reason"
test ! -e output.json
test ! -e output.json.partial
`);

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain(
      "consumer failed: producer_status=0 consumer_status=9 bytes=8"
    );
  });
});
