import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, test } from "vite-plus/test";

import { createCollectionStore } from "../src/db/collections";
import { openLocalStore } from "../src/db/local-store";
import { approvals, rejections } from "../src/db/schema";
import { withTemporaryDirectoryAsync } from "./helpers";

const collectionId = "01JCOLLECTION00000000000000";
const packageRoot = resolve(import.meta.dirname, "..");

async function seedCollection(channelRoot: string): Promise<void> {
  const store = await openLocalStore(channelRoot);
  try {
    await createCollectionStore(store).create({ id: collectionId, title: "Night Drive" });
  } finally {
    await store.close();
  }
}

function runCollectionCli(
  channelRoot: string,
  arguments_: string[],
  environment: NodeJS.ProcessEnv,
) {
  return spawnSync(
    process.execPath,
    [
      "--conditions=nyacast-source",
      "--experimental-strip-types",
      resolve(packageRoot, "bin", "nyacast.js"),
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

describe("nyacast collection CLI", () => {
  test.each(["produce", "publish"] as const)(
    "%s records one approval and repeated execution succeeds without another record",
    async (gate) => {
      await withTemporaryDirectoryAsync("nyacast-collection-approval-", async (channelRoot) => {
        await seedCollection(channelRoot);

        const first = runCollectionCli(channelRoot, [gate, collectionId], cliEnvironment(""));
        expect(first.status).toBe(0);
        expect(first.stdout).toMatch(/[ぁ-んァ-ヶ一-龠]/u);
        expect(first.stdout).toMatch(/してください/u);
        expect(first.stdout).toContain(`collection ${collectionId} / gate=${gate}`);
        expect(first.stdout).toContain(
          `Claude Code で collection ${collectionId} の ${gate} 区間を実行してください。`,
        );

        const repeated = runCollectionCli(channelRoot, [gate, collectionId], cliEnvironment(""));
        expect(repeated.status).toBe(0);
        expect(repeated.stdout).toMatch(/既に.*承認/u);

        const store = await openLocalStore(channelRoot);
        try {
          await expect(store.db.select().from(approvals)).resolves.toMatchObject([
            { collectionId, gate },
          ]);
        } finally {
          await store.close();
        }
      });
    },
  );

  test.each(["produce", "publish"] as const)("%s does not invoke an agent", async (gate) => {
    await withTemporaryDirectoryAsync("nyacast-collection-no-agent-", async (channelRoot) => {
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
    await withTemporaryDirectoryAsync("nyacast-collection-reject-", async (channelRoot) => {
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
          `nyacast collection produce ${collectionId} を実行してください（NO-GO より後に承認を積むと覆ります）。\n`,
      );
      const store = await openLocalStore(channelRoot);
      try {
        await expect(store.db.select().from(approvals)).resolves.toEqual([]);
        await expect(store.db.select().from(rejections)).resolves.toMatchObject([
          { collectionId, gate: "produce" },
        ]);
      } finally {
        await store.close();
      }
    });
  });

  test("repeating a current rejection reports success without appending a row", async () => {
    await withTemporaryDirectoryAsync("nyacast-collection-repeat-reject-", async (channelRoot) => {
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
      const store = await openLocalStore(channelRoot);
      try {
        await expect(store.db.select().from(rejections)).resolves.toHaveLength(1);
      } finally {
        await store.close();
      }
    });
  });

  test("reject appends a new record after approval has overturned the previous rejection", async () => {
    await withTemporaryDirectoryAsync(
      "nyacast-collection-reject-after-approval-",
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
            `nyacast collection produce ${collectionId} を実行してください（NO-GO より後に承認を積むと覆ります）。\n`,
        );
        const store = await openLocalStore(channelRoot);
        try {
          await expect(store.db.select().from(rejections)).resolves.toHaveLength(2);
        } finally {
          await store.close();
        }
      },
    );
  });

  test("rejects an invalid rejection gate without writing a gate fact", async () => {
    await withTemporaryDirectoryAsync("nyacast-collection-invalid-gate-", async (channelRoot) => {
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
      expect(result.stderr).toContain("Invalid option");
      expect(result.stderr).toContain("produce");
      expect(result.stderr).toContain("publish");
      const store = await openLocalStore(channelRoot);
      try {
        await expect(store.db.select().from(approvals)).resolves.toEqual([]);
        await expect(store.db.select().from(rejections)).resolves.toEqual([]);
      } finally {
        await store.close();
      }
    });
  });

  test.each([
    { arguments_: ["produce", "01JMISSING0000000000000000"] },
    { arguments_: ["reject", "produce", "01JMISSING0000000000000000"] },
  ])("rejects a command for a missing collection", async ({ arguments_ }) => {
    await withTemporaryDirectoryAsync("nyacast-collection-missing-", async (channelRoot) => {
      const store = await openLocalStore(channelRoot);
      await store.close();

      const result = runCollectionCli(channelRoot, arguments_, cliEnvironment(""));

      expect(result.error).toBeUndefined();
      expect(result.signal).toBeNull();
      expect(typeof result.status).toBe("number");
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("01JMISSING0000000000000000");
      const reopened = await openLocalStore(channelRoot);
      try {
        await expect(reopened.db.select().from(approvals)).resolves.toEqual([]);
        await expect(reopened.db.select().from(rejections)).resolves.toEqual([]);
      } finally {
        await reopened.close();
      }
    });
  });
});
