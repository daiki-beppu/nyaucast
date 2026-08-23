import { describe, expect, test } from "bun:test";
import path from "node:path";

import { localFileUrl } from "./local-file-url";

describe("local file URL", () => {
  test("preserves literal percent sequences in filesystem paths", () => {
    const filePath = path.join(
      path.parse(process.cwd()).root,
      "channel-%2e%2e%2Fvictim",
      "data",
      "local.db"
    );

    const url = new URL(localFileUrl(filePath));

    expect(url.protocol).toBe("file:");
    expect(url.pathname).toContain("channel-%252e%252e%252Fvictim");
  });
});
