import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const packageRoot = resolve(import.meta.dirname, "../..");
const contractPath = ".takt/facets/output-contracts/tayk-review-summary.md";
const instructionPath = ".takt/facets/instructions/tayk-review-publish.md";

interface PullRequestComment {
  author: { login: string };
  body: string;
  url: string;
}

function readRepositoryFile(relativePath: string): string {
  return readFileSync(join(packageRoot, relativePath), "utf-8");
}

function extractMarkerTemplate(): string {
  const contract = readRepositoryFile(contractPath);
  const marker = /<!-- tayk-review-publication: [^\n]+ -->/.exec(contract)?.[0];

  if (marker === undefined) {
    throw new Error(`${contractPath} must declare the publication marker`);
  }
  return marker;
}

function renderMarker(runId: string): string {
  return extractMarkerTemplate()
    .replace("{PR番号}", "254")
    .replace("{N}", "4")
    .replace("{run ID}", runId);
}

function extractCommentSelectionFilter(): string {
  const instruction = readRepositoryFile(instructionPath);
  const command =
    /--rawfile expected "\$SUMMARY_PATH" \\\n\s*'([\s\S]*?)'/m.exec(
      instruction
    );

  if (command?.[1] === undefined) {
    throw new Error(
      `${instructionPath} must select comments with the documented jq command`
    );
  }
  return command[1];
}

function selectPublicationComments(
  comments: PullRequestComment[],
  expectedBody: string,
  login: string
): PullRequestComment[] {
  const directory = mkdtempSync(join(tmpdir(), "tayk-review-publication-"));
  const expectedPath = join(directory, "review-summary.md");
  const commentsPath = join(directory, "comments.json");

  try {
    writeFileSync(expectedPath, expectedBody);
    writeFileSync(commentsPath, JSON.stringify({ comments }));
    const process = Bun.spawnSync(
      [
        "jq",
        "--arg",
        "login",
        login,
        "--rawfile",
        "expected",
        expectedPath,
        extractCommentSelectionFilter(),
      ],
      {
        stderr: "pipe",
        stdin: Bun.file(commentsPath),
        stdout: "pipe",
      }
    );

    if (process.exitCode !== 0) {
      throw new Error(process.stderr.toString());
    }
    return JSON.parse(process.stdout.toString()) as PullRequestComment[];
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

describe("tayk-review publication identity", () => {
  test("[REQ-255-01] should generate different markers for independent runs", () => {
    const firstMarker = renderMarker("run-20260803-a");
    const retriedMarker = renderMarker("run-20260803-a");
    const secondMarker = renderMarker("run-20260803-b");

    expect(retriedMarker).toBe(firstMarker);
    expect(firstMarker).not.toBe(secondMarker);
    expect(firstMarker).toContain("run-20260803-a");
    expect(secondMarker).toContain("run-20260803-b");
  });

  test("[REQ-255-02] should reject a marker-only comment from the current user", () => {
    const login = "tayk-operator";
    const marker = renderMarker("run-20260803-a");
    const expectedBody = `${marker}\n# complete review summary`;
    const comments = [
      {
        author: { login },
        body: marker,
        url: "https://example.test/marker-only",
      },
    ];

    const selected = selectPublicationComments(comments, expectedBody, login);

    expect(selected).toEqual([]);
  });

  test("[REQ-255-03] should reject an exact-body comment from another user", () => {
    const login = "tayk-operator";
    const expectedBody = `${renderMarker("run-20260803-a")}\n# complete review summary`;
    const comments = [
      {
        author: { login: "third-party" },
        body: expectedBody,
        url: "https://example.test/third-party",
      },
    ];

    const selected = selectPublicationComments(comments, expectedBody, login);

    expect(selected).toEqual([]);
  });

  test("[REQ-255-04] should recover only the current user's exact body", () => {
    const login = "tayk-operator";
    const expectedBody = `${renderMarker("run-20260803-a")}\n# complete review summary`;
    const expectedComment = {
      author: { login },
      body: expectedBody,
      url: "https://example.test/exact-publication",
    };

    const selected = selectPublicationComments(
      [
        {
          author: { login },
          body: renderMarker("run-20260803-a"),
          url: "https://example.test/marker-only",
        },
        {
          author: { login: "third-party" },
          body: expectedBody,
          url: "https://example.test/third-party",
        },
        expectedComment,
      ],
      expectedBody,
      login
    );

    expect(selected).toEqual([expectedComment]);
  });
});
