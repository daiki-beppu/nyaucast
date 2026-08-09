import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseYamlRecord, withTemporaryDirectory } from "./helpers";

type IsEqual<Left, Right> = [Left] extends [Right]
  ? [Right] extends [Left]
    ? true
    : false
  : false;

const fixturePath = ".takt/workflows/fixture.yaml";

function requireCreatedDirectory(directory: string | undefined): string {
  if (directory === undefined) {
    throw new Error("the helper did not expose its created directory");
  }
  return directory;
}

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

describe("temporary directory lifecycle", () => {
  test("TC-309-01 / P-309-03 / REQ-309-01: should remove the created directory and preserve the error when the callback throws", () => {
    const callbackError = new Error("callback failed");
    let createdDirectory: string | undefined;
    let thrownError: unknown;

    try {
      withTemporaryDirectory("tayk-helper-callback-error-", (directory) => {
        createdDirectory = directory;
        throw callbackError;
      });
    } catch (error) {
      thrownError = error;
    }

    expect(thrownError).toBe(callbackError);
    expect(existsSync(requireCreatedDirectory(createdDirectory))).toBe(false);
  });

  test("TC-309-02 / P-309-01 / REQ-309-02: should remove the created directory and preserve the error when the normalizer throws", () => {
    const normalizerError = new Error("normalizer failed");
    let createdDirectory: string | undefined;
    let callbackCallCount = 0;
    let thrownError: unknown;

    try {
      try {
        withTemporaryDirectory(
          "tayk-helper-normalizer-error-",
          () => {
            callbackCallCount += 1;
          },
          (directory) => {
            createdDirectory = directory;
            throw normalizerError;
          }
        );
      } catch (error) {
        thrownError = error;
      }

      expect(thrownError).toBe(normalizerError);
      expect(callbackCallCount).toBe(0);
      expect(existsSync(requireCreatedDirectory(createdDirectory))).toBe(false);
    } finally {
      if (createdDirectory !== undefined) {
        rmSync(createdDirectory, { force: true, recursive: true });
      }
    }
  });

  test("TC-309-03 / P-309-02 / REQ-309-03: should remove only the created directory when the normalizer returns another path", () => {
    const normalizedDirectory = mkdtempSync(
      join(tmpdir(), "tayk-helper-normalized-")
    );
    let createdDirectory: string | undefined;
    let callbackDirectory: string | undefined;

    try {
      withTemporaryDirectory(
        "tayk-helper-created-",
        (directory) => {
          callbackDirectory = directory;
        },
        (directory) => {
          createdDirectory = directory;
          return normalizedDirectory;
        }
      );

      expect(callbackDirectory).toBe(normalizedDirectory);
      expect({
        createdDirectoryExists: existsSync(
          requireCreatedDirectory(createdDirectory)
        ),
        normalizedDirectoryExists: existsSync(normalizedDirectory),
      }).toEqual({
        createdDirectoryExists: false,
        normalizedDirectoryExists: true,
      });
    } finally {
      if (createdDirectory !== undefined) {
        rmSync(createdDirectory, { force: true, recursive: true });
      }
      rmSync(normalizedDirectory, { force: true, recursive: true });
    }
  });

  test("TC-309-04 / P-309-04 / REQ-309-04: should keep the created directory during the callback and remove it after normal completion", () => {
    let createdDirectory: string | undefined;
    let existedDuringCallback = false;

    withTemporaryDirectory("tayk-helper-success-", (directory) => {
      createdDirectory = directory;
      existedDuringCallback = existsSync(directory);
    });

    expect(existedDuringCallback).toBe(true);
    expect(existsSync(requireCreatedDirectory(createdDirectory))).toBe(false);
  });

  test("TC-309-05 / REQ-309-05: should retain the public parameter and return types", () => {
    type ExpectedParameters = [
      prefix: string,
      execute: (directory: string) => void,
      normalize?: ((directory: string) => string) | undefined,
    ];
    const parametersMatch: IsEqual<
      Parameters<typeof withTemporaryDirectory>,
      ExpectedParameters
    > = true;
    const returnTypeMatches: IsEqual<
      ReturnType<typeof withTemporaryDirectory>,
      void
    > = true;

    expect(parametersMatch).toBe(true);
    expect(returnTypeMatches).toBe(true);
  });
});
