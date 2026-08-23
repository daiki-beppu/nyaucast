import { mock } from "bun:test";
import { existsSync } from "node:fs";
import * as fileSystemPromises from "node:fs/promises";
import path from "node:path";

const [channelRoot, signalDirectory] = Bun.argv.slice(2);
if (channelRoot === undefined || signalDirectory === undefined) {
  throw new Error("channel root and signal directory are required");
}

const waitForFile = async (filePath: string): Promise<void> => {
  if (existsSync(filePath)) {
    return;
  }
  await Bun.sleep(5);
  await waitForFile(filePath);
};

const originalLink = fileSystemPromises.link;
await mock.module("node:fs/promises", () => ({
  ...fileSystemPromises,
  link: async (existingPath: string, newPath: string): Promise<void> => {
    await originalLink(existingPath, newPath);
    await Bun.write(path.join(signalDirectory, "candidate-published"), "");
    await waitForFile(path.join(signalDirectory, "release-candidate"));
  },
}));

const { closeLocalStore, openLocalStore } =
  await import("../../src/db/local-store");
const store = await openLocalStore(channelRoot);
await closeLocalStore(store);
