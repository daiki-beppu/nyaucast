import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";

const responseTimeout = 10_000;
const terminationGracePeriod = 1_000;

interface JsonRpcResponse {
  error?: unknown;
  id?: number;
  result?: unknown;
}

export function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function routeJsonRpcResponse(
  response: JsonRpcResponse,
  responses: Map<number, JsonRpcResponse>,
  waiters: Map<number, (response: JsonRpcResponse) => void>,
): void {
  if (typeof response.id !== "number") {
    return;
  }
  const waiter = waiters.get(response.id);
  if (waiter === undefined) {
    responses.set(response.id, response);
    return;
  }
  waiters.delete(response.id);
  waiter(response);
}

export function createJsonRpcClient(process_: ChildProcessWithoutNullStreams) {
  let buffered = "";
  const responses = new Map<number, JsonRpcResponse>();
  const waiters = new Map<number, (response: JsonRpcResponse) => void>();
  process_.stdout.setEncoding("utf8");
  process_.stdout.on("data", (chunk: string) => {
    buffered += chunk;
    const lines = buffered.split("\n");
    buffered = lines.pop() ?? "";
    for (const line of lines.filter((value) => value.length > 0)) {
      const response = requireRecord(JSON.parse(line), "JSON-RPC response") as JsonRpcResponse;
      routeJsonRpcResponse(response, responses, waiters);
    }
  });

  return {
    responseFor: async (id: number): Promise<JsonRpcResponse> => {
      const existing = responses.get(id);
      if (existing !== undefined) {
        responses.delete(id);
        return existing;
      }
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const response = new Promise<JsonRpcResponse>((resolveResponse, reject) => {
        timeout = setTimeout(() => {
          waiters.delete(id);
          reject(new Error(`timed out waiting for JSON-RPC response ${id}`));
        }, responseTimeout);
        waiters.set(id, (value) => {
          clearTimeout(timeout);
          resolveResponse(value);
        });
      });
      const exited = once(process_, "exit").then(([code, signal]) => {
        throw new Error(
          `MCP server exited before response ${id}: code=${String(code)} signal=${String(signal)}`,
        );
      });
      return Promise.race([response, exited]).finally(() => clearTimeout(timeout));
    },
    writeMessage: (message: Record<string, unknown>): void => {
      process_.stdin.write(`${JSON.stringify(message)}\n`);
    },
  };
}

export async function stopChildProcess(process_: ChildProcessWithoutNullStreams): Promise<void> {
  process_.stdin.end();
  if (process_.exitCode !== null || process_.signalCode !== null) {
    return;
  }

  const exited = once(process_, "exit").then(() => true as const);
  process_.kill("SIGTERM");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const graceElapsed = new Promise<false>((resolveElapsed) => {
    timer = setTimeout(() => resolveElapsed(false), terminationGracePeriod);
  });
  const stopped = await Promise.race([exited, graceElapsed]);
  clearTimeout(timer);
  if (!stopped) {
    process_.kill("SIGKILL");
    await exited;
  }
}
