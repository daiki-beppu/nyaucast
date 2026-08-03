import { describe, expect, test } from "bun:test";

import { parseYamlRecord } from "./helpers";

const fixturePath = ".takt/workflows/fixture.yaml";

describe("repository YAML loader", () => {
  test("should report the repository path when YAML is malformed", () => {
    expect(() => {
      parseYamlRecord({
        expectedShape: "a workflow object",
        relativePath: fixturePath,
        source: "steps: [",
      });
    }).toThrow(`${fixturePath} must contain valid YAML`);
  });

  test.each(["workflow", "- step", "null"])(
    "should report the expected shape for a non-record root: %s",
    (source) => {
      expect(() => {
        parseYamlRecord({
          expectedShape: "a workflow object",
          relativePath: fixturePath,
          source,
        });
      }).toThrow(`${fixturePath} must contain a workflow object`);
    }
  );
});
