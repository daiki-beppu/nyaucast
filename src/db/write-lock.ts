import { createClient } from "@libsql/client";
import type { Transaction } from "@libsql/client";

import { assertManagedPath } from "../channel-root";
import { localFileUrl } from "./local-file-url";

const retryDelayMilliseconds = 10;

const isBusy = (error: unknown): boolean =>
  error instanceof Error &&
  "code" in error &&
  (error.code === "SQLITE_BUSY" || error.code === "SQLITE_BUSY_TIMEOUT");

const acquireTransaction = async (
  client: ReturnType<typeof createClient>
): Promise<Transaction> => {
  try {
    return await client.transaction("write");
  } catch (error) {
    if (!isBusy(error)) {
      throw error;
    }
    await Bun.sleep(retryDelayMilliseconds);
    return await acquireTransaction(client);
  }
};

const closeAfterFailure = (
  client: ReturnType<typeof createClient>,
  error: unknown,
  message: string
): never => {
  try {
    client.close();
  } catch (cleanupError) {
    // AggregateError retains both failures where a single cause cannot.
    // oxlint-disable-next-line preserve-caught-error
    throw new AggregateError([error, cleanupError], message, {
      cause: cleanupError,
    });
  }
  throw error;
};

interface Closable {
  close: () => void;
}

const closeResources = (resources: readonly Closable[]): unknown[] => {
  const errors: unknown[] = [];
  for (const resource of resources) {
    try {
      resource.close();
    } catch (error) {
      errors.push(error);
    }
  }
  return errors;
};

export const withProcessSharedWriteLock = async <Value>(
  canonicalRoot: string,
  localStorePath: string,
  execute: () => Promise<Value>
): Promise<Value> => {
  const lockPath = `${localStorePath}.write-lock`;
  assertManagedPath(canonicalRoot, lockPath, "file");
  const client = createClient({ url: localFileUrl(lockPath) });
  try {
    assertManagedPath(canonicalRoot, lockPath, "file");
  } catch (error) {
    closeAfterFailure(
      client,
      error,
      "process-shared lock validation and cleanup failed"
    );
  }

  const transaction = await acquireTransaction(client).catch((error: unknown) =>
    closeAfterFailure(
      client,
      error,
      "process-shared lock acquisition and cleanup failed"
    )
  );

  let result: Value;
  try {
    result = await execute();
  } catch (error) {
    const cleanupErrors = closeResources([transaction, client]);
    if (cleanupErrors.length > 0) {
      // AggregateError retains the operation error as both the first error and cause.
      // oxlint-disable-next-line preserve-caught-error
      throw new AggregateError(
        [error, ...cleanupErrors],
        "write operation and process-shared lock cleanup failed",
        { cause: error }
      );
    }
    throw error;
  }

  const cleanupErrors = closeResources([transaction, client]);
  if (cleanupErrors.length > 0) {
    throw new AggregateError(
      cleanupErrors,
      "process-shared lock cleanup failed"
    );
  }
  return result;
};
