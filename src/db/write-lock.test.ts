import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { createClient } from "@libsql/client";

import { withProcessSharedWriteLock } from "./write-lock";

const temporaryDirectories: string[] = [];

const channelFixture = (): string => {
  const directory = realpathSync(
    mkdtempSync(path.join(tmpdir(), "tayk-write-lock-"))
  );
  temporaryDirectories.push(directory);
  mkdirSync(path.join(directory, "data"));
  return directory;
};

interface ClosePrototype {
  close: () => void;
}

const isClosePrototype = (value: unknown): value is ClosePrototype =>
  typeof value === "object" &&
  value !== null &&
  "close" in value &&
  typeof value.close === "function";

const closePrototypeFor = (resource: object): ClosePrototype => {
  const prototype: unknown = Object.getPrototypeOf(resource);
  if (!isClosePrototype(prototype)) {
    throw new TypeError("libSQL resource prototype must provide close()");
  }
  return prototype;
};

const installCleanupSpies = async (failures: {
  client?: Error | undefined;
  transaction?: Error | undefined;
}): Promise<{ events: string[]; restore: () => void }> => {
  const probeDirectory = channelFixture();
  const probeClient = createClient({
    url: pathToFileURL(path.join(probeDirectory, "probe.db")).href,
  });
  const probeTransaction = await probeClient.transaction("write");
  const clientPrototype = closePrototypeFor(probeClient);
  const transactionPrototype = closePrototypeFor(probeTransaction);
  const originalClientClose = clientPrototype.close;
  const originalTransactionClose = transactionPrototype.close;
  probeTransaction.close();
  probeClient.close();

  const events: string[] = [];
  const transactionCloseSpy = spyOn(
    transactionPrototype,
    "close"
  ).mockImplementation(function closeTransaction(this: unknown) {
    originalTransactionClose.call(this);
    events.push("transaction");
    if (failures.transaction !== undefined) {
      throw failures.transaction;
    }
  });
  const clientCloseSpy = spyOn(clientPrototype, "close").mockImplementation(
    function closeClient(this: unknown) {
      originalClientClose.call(this);
      events.push("client");
      if (failures.client !== undefined) {
        throw failures.client;
      }
    }
  );

  return {
    events,
    restore: () => {
      transactionCloseSpy.mockRestore();
      clientCloseSpy.mockRestore();
    },
  };
};

const rejectedValue = async (operation: Promise<unknown>): Promise<unknown> => {
  try {
    await operation;
  } catch (error) {
    return error;
  }
  throw new Error("operation unexpectedly succeeded");
};

const requireAggregateError = (value: unknown): AggregateError => {
  expect(value).toBeInstanceOf(AggregateError);
  if (!(value instanceof AggregateError)) {
    throw new TypeError("expected AggregateError");
  }
  return value;
};

const operationError = new Error("operation failed");
const transactionCleanupError = new Error("transaction cleanup failed");
const clientCleanupError = new Error("client cleanup failed");

const successfulOperation = async (): Promise<string> => {
  await Promise.resolve();
  return "saved";
};

const failingOperation = async (): Promise<never> => {
  await Promise.resolve();
  throw operationError;
};

const cleanupFailureCases = [
  {
    execute: successfulOperation,
    expectedCause: undefined,
    expectedErrors: [transactionCleanupError],
    failures: { transaction: transactionCleanupError },
    name: "retains a transaction cleanup failure after operation success",
  },
  {
    execute: successfulOperation,
    expectedCause: undefined,
    expectedErrors: [clientCleanupError],
    failures: { client: clientCleanupError },
    name: "retains a client cleanup failure after operation success",
  },
  {
    execute: successfulOperation,
    expectedCause: undefined,
    expectedErrors: [transactionCleanupError, clientCleanupError],
    failures: {
      client: clientCleanupError,
      transaction: transactionCleanupError,
    },
    name: "retains both cleanup failures after operation success",
  },
  {
    execute: failingOperation,
    expectedCause: operationError,
    expectedErrors: [operationError, transactionCleanupError],
    failures: { transaction: transactionCleanupError },
    name: "retains the operation and transaction cleanup failures",
  },
  {
    execute: failingOperation,
    expectedCause: operationError,
    expectedErrors: [operationError, clientCleanupError],
    failures: { client: clientCleanupError },
    name: "retains the operation and client cleanup failures",
  },
  {
    execute: failingOperation,
    expectedCause: operationError,
    expectedErrors: [
      operationError,
      transactionCleanupError,
      clientCleanupError,
    ],
    failures: {
      client: clientCleanupError,
      transaction: transactionCleanupError,
    },
    name: "retains the operation and both cleanup failures",
  },
];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("withProcessSharedWriteLock", () => {
  test("returns the operation value after closing transaction and client", async () => {
    const channelRoot = channelFixture();
    const cleanup = await installCleanupSpies({});
    const value = { saved: true };

    try {
      const result = await withProcessSharedWriteLock(
        channelRoot,
        path.join(channelRoot, "data", "local.db"),
        async () => {
          await Promise.resolve();
          return value;
        }
      );

      expect(result).toBe(value);
      expect(cleanup.events).toEqual(["transaction", "client"]);
    } finally {
      cleanup.restore();
    }
  });

  test("preserves the operation error after closing transaction and client", async () => {
    const channelRoot = channelFixture();
    const cleanup = await installCleanupSpies({});

    try {
      const error = await rejectedValue(
        withProcessSharedWriteLock(
          channelRoot,
          path.join(channelRoot, "data", "local.db"),
          failingOperation
        )
      );

      expect(error).toBe(operationError);
      expect(cleanup.events).toEqual(["transaction", "client"]);
    } finally {
      cleanup.restore();
    }
  });

  test.each(cleanupFailureCases)(
    "$name",
    async ({ execute, expectedCause, expectedErrors, failures }) => {
      const channelRoot = channelFixture();
      const cleanup = await installCleanupSpies(failures);

      try {
        const error = await rejectedValue(
          withProcessSharedWriteLock(
            channelRoot,
            path.join(channelRoot, "data", "local.db"),
            execute
          )
        );

        const aggregateError = requireAggregateError(error);
        expect(aggregateError.errors).toEqual(expectedErrors);
        expect(aggregateError.cause).toBe(expectedCause);
        expect(cleanup.events).toEqual(["transaction", "client"]);
      } finally {
        cleanup.restore();
      }
    }
  );
});
