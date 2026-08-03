import { describe, expect, test } from "bun:test";

import { parseYamlRecord } from "./helpers";

const fixturePath = ".takt/workflows/fixture.yaml";

describe("repository YAML loader", () => {
  test("should report the repository path when YAML is malformed", () => {
    expect(() => {
      parseYamlRecord("steps: [", fixturePath, "a workflow object");
    }).toThrow(`${fixturePath} must contain valid YAML`);
  });

  test.each(["workflow", "- step", "null"])(
    "should report the expected shape for a non-record root: %s",
    (source) => {
      expect(() => {
        parseYamlRecord(source, fixturePath, "a workflow object");
      }).toThrow(`${fixturePath} must contain a workflow object`);
    }
  );
});
