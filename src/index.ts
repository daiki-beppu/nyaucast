import { startMcpServer } from "./mcp";

const command = process.argv.at(2);

if (command === "mcp") {
  await startMcpServer(process.cwd());
} else if (command !== undefined) {
  throw new Error(`unsupported tayk command: ${command}`);
}
