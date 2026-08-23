import assert from "node:assert/strict";
import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";

type ManagedLeafType = "directory" | "file";
type ManagedPathAssertion = (
  canonicalRoot: string,
  targetPath: string,
  leafType: ManagedLeafType
) => void;

const descendantRelative = (input: {
  canonicalRoot: string;
  candidate: string;
  errorMessage: string;
}): string => {
  const { canonicalRoot, candidate, errorMessage } = input;
  const relative = path.relative(canonicalRoot, candidate);
  assert.ok(
    [
      relative !== "",
      relative !== "..",
      !relative.startsWith(`..${path.sep}`),
      !path.isAbsolute(relative),
    ].every(Boolean),
    errorMessage
  );
  return relative;
};

export const assertManagedPath: ManagedPathAssertion = (
  canonicalRoot,
  targetPath,
  leafType
) => {
  const resolvedTarget = path.resolve(targetPath);
  const segments = descendantRelative({
    candidate: resolvedTarget,
    canonicalRoot,
    errorMessage: "managed path must be a channel-root descendant",
  }).split(path.sep);
  let current = canonicalRoot;
  for (const [index, segment] of segments.entries()) {
    current = path.normalize(`${current}${path.sep}${segment}`);
    const metadata = lstatSync(current, { throwIfNoEntry: false });
    if (metadata === undefined) {
      return;
    }

    assert.ok(
      !metadata.isSymbolicLink(),
      "managed paths must not contain symbolic links"
    );
    descendantRelative({
      candidate: realpathSync(current),
      canonicalRoot,
      errorMessage: "managed path resolves outside the channel root",
    });

    const expectedType = index === segments.length - 1 ? leafType : "directory";
    const matchesExpectedType = {
      directory: metadata.isDirectory(),
      file: metadata.isFile(),
    }[expectedType];
    assert.ok(
      matchesExpectedType,
      `managed path component must be a ${expectedType}`
    );
  }
};

export const canonicalizeChannelRoot = (channelRoot: string): string => {
  const canonicalRoot = realpathSync(channelRoot);
  assert.ok(
    lstatSync(canonicalRoot).isDirectory(),
    "channel root must be a directory"
  );
  return canonicalRoot;
};
