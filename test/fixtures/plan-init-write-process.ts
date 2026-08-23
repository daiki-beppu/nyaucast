import { mock } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { PlanInitDependencies } from "../../src/tools/plan.init";

const [mode, channelRoot, signalDirectory, observationMode] = Bun.argv.slice(2);
if (
  mode === undefined ||
  channelRoot === undefined ||
  signalDirectory === undefined
) {
  throw new Error("mode, channel root, and signal directory are required");
}
if (observationMode !== undefined && observationMode !== "observe-lock") {
  throw new Error(`unsupported observation mode: ${observationMode}`);
}
const observesLock = observationMode === "observe-lock";
if (observesLock && mode === "force") {
  throw new Error("force mode cannot observe a competing lock request");
}

const waitForFile = async (filePath: string): Promise<void> => {
  if (existsSync(filePath)) {
    return;
  }
  await Bun.sleep(5);
  await waitForFile(filePath);
};

const { withProcessSharedWriteLock } = await import("../../src/db/write-lock");
let observationEnabled = false;
if (observesLock) {
  await mock.module("../../src/db/write-lock", () => ({
    withProcessSharedWriteLock: async <Value>(
      canonicalRoot: string,
      localStorePath: string,
      execute: () => Promise<Value>
    ): Promise<Value> => {
      if (!observationEnabled) {
        return await withProcessSharedWriteLock(
          canonicalRoot,
          localStorePath,
          execute
        );
      }
      const pending = withProcessSharedWriteLock(
        canonicalRoot,
        localStorePath,
        async () => {
          writeFileSync(path.join(signalDirectory, `${mode}-lock-entered`), "");
          return await execute();
        }
      );
      writeFileSync(path.join(signalDirectory, `${mode}-lock-requested`), "");
      return await pending;
    },
  }));
}

const { appendApproval, appendRejection, closeLocalStore, openLocalStore } =
  await import("../../src/db/local-store");
const { initializePlan, nodePlanInitFileSystem } =
  await import("../../src/tools/plan.init");
const store = await openLocalStore(channelRoot);
try {
  if (observesLock) {
    writeFileSync(path.join(signalDirectory, `${mode}-ready`), "");
    await waitForFile(path.join(signalDirectory, `${mode}-start`));
    observationEnabled = true;
  }
  const dependencies: PlanInitDependencies = {
    channelRoot,
    createCollectionId: () => "550e8400-e29b-41d4-a716-446655440000",
    createOperationToken: () => `operation-${process.pid}`,
    fileSystem: nodePlanInitFileSystem,
    store,
  };

  if (mode === "force") {
    const pausedStore: PlanInitDependencies["store"] = {
      serializedWrite: async (execute, afterCommit) =>
        await store.serializedWrite(execute, async (committed) => {
          await Bun.write(path.join(signalDirectory, "force-paused"), "");
          await waitForFile(path.join(signalDirectory, "release-force"));
          return await afterCommit(committed);
        }),
    };
    const result = await initializePlan(
      { force: true, title: "Night Drive" },
      { ...dependencies, store: pausedStore }
    );
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else if (mode === "force-before-commit") {
    const pausedStore: PlanInitDependencies["store"] = {
      serializedWrite: async (execute, afterCommit) =>
        await store.serializedWrite(async (transaction) => {
          const committed = await execute(transaction);
          await Bun.write(
            path.join(signalDirectory, "force-before-commit-paused"),
            ""
          );
          await waitForFile(
            path.join(signalDirectory, "release-force-before-commit")
          );
          return committed;
        }, afterCommit),
    };
    const result = await initializePlan(
      { force: true, title: "Night Drive" },
      { ...dependencies, store: pausedStore }
    );
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else if (mode === "initialize") {
    const result = await initializePlan({ title: "Night Drive" }, dependencies);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else if (mode === "approval" || mode === "rejection") {
    const append = mode === "approval" ? appendApproval : appendRejection;
    await append(store, "550e8400-e29b-41d4-a716-446655440000", "produce");
    process.stdout.write(`${JSON.stringify({ appended: mode })}\n`);
  } else {
    throw new Error(`unsupported mode: ${mode}`);
  }
} finally {
  await closeLocalStore(store);
}
