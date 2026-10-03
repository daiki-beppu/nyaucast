import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, test } from "@effect/vitest";

import {
  localDatabasePath,
  openLocalStoreOnce,
  readRows,
  seedCollection as insertSeed,
  withTemporaryDirectoryAsync,
} from "./helpers.ts";

const collectionId = "01JCOLLECTION00000000000000";
const packageRoot = resolve(import.meta.dirname, "..");

function seedCollection(channelRoot: string): Promise<void> {
  return insertSeed(channelRoot, { id: collectionId, title: "Night Drive" });
}

const approvalRows = (channelRoot: string) => readRows(localDatabasePath(channelRoot), "approvals");
const rejectionRows = (channelRoot: string) =>
  readRows(localDatabasePath(channelRoot), "rejections");

function runCollectionCli(
  channelRoot: string,
  arguments_: string[],
  environment: NodeJS.ProcessEnv,
) {
  return spawnSync(
    process.execPath,
    [
      "--conditions=nyaucast-source",
      "--experimental-strip-types",
      resolve(packageRoot, "bin", "nyaucast.js"),
      "collection",
      ...arguments_,
    ],
    {
      cwd: channelRoot,
      encoding: "utf8",
      env: environment,
      timeout: 10_000,
    },
  );
}

function cliEnvironment(path: string): NodeJS.ProcessEnv {
  return { ...process.env, PATH: path };
}

describe("nyaucast collection CLI", () => {
  test.each(["produce", "publish"] as const)(
    "%s records one approval and repeated execution succeeds without another record",
    async (gate) => {
      await withTemporaryDirectoryAsync("nyaucast-collection-approval-", async (channelRoot) => {
        await seedCollection(channelRoot);

        const first = runCollectionCli(channelRoot, [gate, collectionId], cliEnvironment(""));
        expect(first.status).toBe(0);
        expect(first.stdout).toMatch(/[ぁ-んァ-ヶ一-龠]/u);
        expect(first.stdout).toMatch(/してください/u);
        expect(
          first.stdout.startsWith(`承認を記録しました: collection ${collectionId} / gate=${gate}`),
        ).toBe(true);
        expect(rejectionRows(channelRoot)).toEqual([]);
        expect(first.stdout).toContain(`collection ${collectionId} / gate=${gate}`);
        expect(first.stdout).toContain(
          `Claude Code で collection ${collectionId} の ${gate} 区間を実行してください。`,
        );

        const repeated = runCollectionCli(channelRoot, [gate, collectionId], cliEnvironment(""));
        expect(repeated.status).toBe(0);
        expect(repeated.stdout).toMatch(/既に.*承認/u);

        expect(approvalRows(channelRoot)).toMatchObject([{ collection_id: collectionId, gate }]);
      });
    },
  );

  test.each(["produce", "publish"] as const)("%s does not invoke an agent", async (gate) => {
    await withTemporaryDirectoryAsync("nyaucast-collection-no-agent-", async (channelRoot) => {
      await seedCollection(channelRoot);
      const invocationRecord = resolve(channelRoot, "agent-invocation");
      const agentExecutable = resolve(channelRoot, "claude");
      writeFileSync(agentExecutable, '#!/bin/sh\n: > "$AGENT_INVOCATION_RECORD"\n');
      chmodSync(agentExecutable, 0o755);

      const result = runCollectionCli(channelRoot, [gate, collectionId], {
        ...cliEnvironment(channelRoot),
        AGENT_INVOCATION_RECORD: invocationRecord,
      });

      expect(result.status).toBe(0);
      expect(existsSync(invocationRecord)).toBe(false);
    });
  });

  test("reject treats produce as the rejection gate rather than an approval command", async () => {
    await withTemporaryDirectoryAsync("nyaucast-collection-reject-", async (channelRoot) => {
      await seedCollection(channelRoot);

      const result = runCollectionCli(
        channelRoot,
        ["reject", "produce", collectionId],
        cliEnvironment(""),
      );

      expect(result.status).toBe(0);
      expect(result.stdout).toBe(
        `NO-GO を記録しました: collection ${collectionId} / gate=produce\n` +
          "この collection は produce ゲートで停止します。判断を覆して先へ進める場合は\n" +
          `nyaucast collection produce ${collectionId} を実行してください（NO-GO より後に承認を積むと覆ります）。\n`,
      );
      expect(approvalRows(channelRoot)).toEqual([]);
      expect(rejectionRows(channelRoot)).toMatchObject([
        { collection_id: collectionId, gate: "produce" },
      ]);
    });
  });

  test("repeating a current rejection reports success without appending a row", async () => {
    await withTemporaryDirectoryAsync("nyaucast-collection-repeat-reject-", async (channelRoot) => {
      await seedCollection(channelRoot);
      expect(
        runCollectionCli(channelRoot, ["reject", "publish", collectionId], cliEnvironment(""))
          .status,
      ).toBe(0);

      const repeated = runCollectionCli(
        channelRoot,
        ["reject", "publish", collectionId],
        cliEnvironment(""),
      );

      expect(repeated.status).toBe(0);
      expect(repeated.stdout).toBe(
        `既に NO-GO 済みです: collection ${collectionId} / gate=publish（記録は追加していません）\n`,
      );
      expect(rejectionRows(channelRoot)).toHaveLength(1);
    });
  });

  test("reject appends a new record after approval has overturned the previous rejection", async () => {
    await withTemporaryDirectoryAsync(
      "nyaucast-collection-reject-after-approval-",
      async (channelRoot) => {
        await seedCollection(channelRoot);
        expect(
          runCollectionCli(channelRoot, ["reject", "produce", collectionId], cliEnvironment(""))
            .status,
        ).toBe(0);
        expect(
          runCollectionCli(channelRoot, ["produce", collectionId], cliEnvironment("")).status,
        ).toBe(0);

        const rejectedAgain = runCollectionCli(
          channelRoot,
          ["reject", "produce", collectionId],
          cliEnvironment(""),
        );

        expect(rejectedAgain.status).toBe(0);
        expect(rejectedAgain.stdout).toBe(
          `NO-GO を記録しました: collection ${collectionId} / gate=produce\n` +
            "この collection は produce ゲートで停止します。判断を覆して先へ進める場合は\n" +
            `nyaucast collection produce ${collectionId} を実行してください（NO-GO より後に承認を積むと覆ります）。\n`,
        );
        expect(rejectionRows(channelRoot)).toHaveLength(2);
      },
    );
  });

  test("rejects an invalid rejection gate without writing a gate fact", async () => {
    await withTemporaryDirectoryAsync("nyaucast-collection-invalid-gate-", async (channelRoot) => {
      await seedCollection(channelRoot);

      const result = runCollectionCli(
        channelRoot,
        ["reject", "archive", collectionId],
        cliEnvironment(""),
      );

      expect(result.error).toBeUndefined();
      expect(result.signal).toBeNull();
      expect(typeof result.status).toBe("number");
      expect(result.status).not.toBe(0);
      // 候補値（produce / publish）が示されること。文言は effect/cli の出力に従う
      expect(result.stderr).toContain("produce");
      expect(result.stderr).toContain("publish");
      expect(approvalRows(channelRoot)).toEqual([]);
      expect(rejectionRows(channelRoot)).toEqual([]);
    });
  });

  test("rejects an extra argument without writing a gate fact", async () => {
    await withTemporaryDirectoryAsync("nyaucast-collection-extra-arg-", async (channelRoot) => {
      await seedCollection(channelRoot);

      const result = runCollectionCli(
        channelRoot,
        ["produce", collectionId, "extra"],
        cliEnvironment(""),
      );

      expect(result.error).toBeUndefined();
      expect(result.signal).toBeNull();
      expect(typeof result.status).toBe("number");
      expect(result.status).not.toBe(0);
      expect(approvalRows(channelRoot)).toEqual([]);
      expect(rejectionRows(channelRoot)).toEqual([]);
    });
  });

  test("a failure is reported as the tag and facts, without a stack trace", async () => {
    await withTemporaryDirectoryAsync("nyaucast-collection-failure-shape-", async (channelRoot) => {
      await openLocalStoreOnce(channelRoot);

      const result = runCollectionCli(
        channelRoot,
        ["produce", "01JMISSING0000000000000000"],
        cliEnvironment(""),
      );

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("CollectionNotFound");
      expect(result.stderr).toContain("01JMISSING0000000000000000");
      expect(result.stderr).not.toMatch(/\n\s+at /u);
      expect(result.stdout).toBe("");
    });
  });

  test.each([
    { arguments_: ["produce", "01JMISSING0000000000000000"] },
    { arguments_: ["reject", "produce", "01JMISSING0000000000000000"] },
  ])("rejects a command for a missing collection", async ({ arguments_ }) => {
    await withTemporaryDirectoryAsync("nyaucast-collection-missing-", async (channelRoot) => {
      await openLocalStoreOnce(channelRoot);

      const result = runCollectionCli(channelRoot, arguments_, cliEnvironment(""));

      expect(result.error).toBeUndefined();
      expect(result.signal).toBeNull();
      expect(typeof result.status).toBe("number");
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("01JMISSING0000000000000000");
      expect(approvalRows(channelRoot)).toEqual([]);
      expect(rejectionRows(channelRoot)).toEqual([]);
    });
  });
});
