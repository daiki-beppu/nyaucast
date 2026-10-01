import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, test } from "vite-plus/test";

import { withTemporaryDirectory } from "./helpers";

const packageRoot = resolve(import.meta.dirname, "..");
const channel = "deepfocus365";
const clientSecret = "CLIENT_SECRET_SENTINEL";

function runAuthCli(
  workingDirectory: string,
  homeDirectory: string,
  arguments_: string[],
  environment: NodeJS.ProcessEnv = {},
) {
  return spawnSync(
    process.execPath,
    [
      "--conditions=nyaucast-source",
      "--experimental-strip-types",
      resolve(packageRoot, "bin", "nyaucast.js"),
      "auth",
      ...arguments_,
    ],
    {
      cwd: workingDirectory,
      encoding: "utf8",
      env: { ...process.env, ...environment, HOME: homeDirectory },
      timeout: 10_000,
    },
  );
}

describe("nyaucast auth CLI", () => {
  test.each([{ arguments_: [] }, { arguments_: [channel, "extra"] }])(
    "requires exactly one channel argument",
    ({ arguments_ }) => {
      withTemporaryDirectory("nyaucast-auth-cli-args-", (directory) => {
        const result = runAuthCli(directory, directory, arguments_);

        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("usage: nyaucast auth <channel>");
      });
    },
  );

  test("reports the fixed client secrets location without using environment or repository fallbacks", () => {
    withTemporaryDirectory("nyaucast-auth-cli-location-", (directory) => {
      const homeDirectory = join(directory, "home");
      const repository = join(directory, "channel-repository");
      const repositoryAuth = join(repository, "auth");
      mkdirSync(homeDirectory, { recursive: true });
      mkdirSync(repositoryAuth, { recursive: true });
      writeFileSync(
        join(repositoryAuth, "client_secrets.json"),
        JSON.stringify({ installed: { client_secret: clientSecret } }),
      );
      const result = runAuthCli(repository, homeDirectory, [channel], {
        CLIENT_SECRETS_DIR: repositoryAuth,
        CLIENT_SECRETS_JSON: JSON.stringify({ installed: { client_secret: clientSecret } }),
      });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(`~/.config/nyaucast/${channel}/client_secrets.json`);
      expect(result.stderr).not.toContain(homeDirectory);
      expect(result.stderr).not.toContain(repositoryAuth);
      expect(result.stderr).not.toContain(clientSecret);
      expect(result.stdout).not.toContain(clientSecret);
    });
  });
});
