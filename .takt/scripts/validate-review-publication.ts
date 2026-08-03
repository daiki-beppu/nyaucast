import { readFileSync } from "node:fs";

export interface ReviewPublicationEvidence {
  reviewTarget: string;
  publicationMarker: string;
  commentUrl: string;
}

export interface ValidatedReviewPublication {
  status: "posted";
  pr_number: number;
  round: number;
  publication_identity: string;
  comment_url: string;
  publication_marker: string;
  failure_reason: "";
}

interface ReviewTargetIdentity {
  prNumber: number;
  round: number;
}

interface MarkerIdentity extends ReviewTargetIdentity {
  runId: string;
}

interface CommentIdentity {
  owner: string;
  repository: string;
  prNumber: number;
  commentId: string;
}

const markerPattern =
  /^<!-- tayk-review-publication: PR #(?<prNumber>[1-9][0-9]*) \/ round (?<round>[1-9][0-9]*) \/ run (?<runId>[A-Za-z0-9][A-Za-z0-9._-]*) -->$/u;

const requiredIntegerMatch = (
  source: string,
  pattern: RegExp,
  field: string
): number => {
  const value = pattern.exec(source)?.groups?.["value"];
  if (value === undefined) {
    throw new Error(`review target must contain a valid ${field}`);
  }
  return Number(value);
};

const parseReviewTarget = (reviewTarget: string): ReviewTargetIdentity => ({
  prNumber: requiredIntegerMatch(
    reviewTarget,
    /^\|\s*番号\s*\|\s*#(?<value>[1-9][0-9]*)\s*\|/mu,
    "PR number"
  ),
  round: requiredIntegerMatch(
    reviewTarget,
    /^\|\s*ラウンド\s*\|\s*(?<value>[1-9][0-9]*)\s*\|/mu,
    "round"
  ),
});

const parseMarker = (publicationMarker: string): MarkerIdentity => {
  const match = markerPattern.exec(publicationMarker);
  const prNumber = match?.groups?.["prNumber"];
  const round = match?.groups?.["round"];
  const runId = match?.groups?.["runId"];
  if (prNumber === undefined || round === undefined || runId === undefined) {
    throw new Error(
      "publication marker does not satisfy the tayk-review contract"
    );
  }
  return {
    prNumber: Number(prNumber),
    round: Number(round),
    runId,
  };
};

const parseCommentUrl = (commentUrl: string): CommentIdentity => {
  let parsed: URL;
  try {
    parsed = new URL(commentUrl);
  } catch {
    throw new Error(
      "comment URL must identify a github.com pull request comment"
    );
  }

  const path =
    /^\/(?<owner>[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)\/(?<repository>[A-Za-z0-9._-]+)\/pull\/(?<prNumber>[1-9][0-9]*)$/u.exec(
      parsed.pathname
    );
  const comment = /^#issuecomment-(?<commentId>[1-9][0-9]*)$/u.exec(
    parsed.hash
  );
  const owner = path?.groups?.["owner"];
  const repository = path?.groups?.["repository"];
  const prNumber = path?.groups?.["prNumber"];
  const commentId = comment?.groups?.["commentId"];
  if (
    parsed.protocol !== "https:" ||
    parsed.hostname !== "github.com" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    owner === undefined ||
    repository === undefined ||
    prNumber === undefined ||
    commentId === undefined
  ) {
    throw new Error(
      "comment URL must identify a github.com pull request comment"
    );
  }
  return {
    commentId,
    owner,
    prNumber: Number(prNumber),
    repository,
  };
};

const assertMatchingIdentity = (
  target: ReviewTargetIdentity,
  marker: MarkerIdentity,
  comment: CommentIdentity
): void => {
  if (marker.prNumber !== target.prNumber) {
    throw new Error(
      `publication marker PR #${marker.prNumber} does not match review target PR #${target.prNumber}`
    );
  }
  if (marker.round !== target.round) {
    throw new Error(
      `publication marker round ${marker.round} does not match review target round ${target.round}`
    );
  }
  if (comment.prNumber !== target.prNumber) {
    throw new Error(
      `comment URL PR #${comment.prNumber} does not match review target PR #${target.prNumber}`
    );
  }
};

export const validateReviewPublication = (
  evidence: ReviewPublicationEvidence
): ValidatedReviewPublication => {
  const target = parseReviewTarget(evidence.reviewTarget);
  const marker = parseMarker(evidence.publicationMarker);
  const comment = parseCommentUrl(evidence.commentUrl);
  assertMatchingIdentity(target, marker, comment);

  return {
    comment_url: evidence.commentUrl,
    failure_reason: "",
    pr_number: target.prNumber,
    publication_identity: `github:${comment.owner}/${comment.repository}:pull:${target.prNumber}:round:${target.round}:comment:${comment.commentId}:run:${marker.runId}`,
    publication_marker: evidence.publicationMarker,
    round: target.round,
    status: "posted",
  };
};

const requiredOption = (arguments_: string[], option: string): string => {
  const index = arguments_.indexOf(option);
  const value = arguments_[index + 1];
  if (index === -1 || value === undefined || value.startsWith("--")) {
    throw new Error(`${option} is required`);
  }
  return value;
};

const extractPublicationMarker = (summary: string): string => {
  const markers = summary.match(/<!-- tayk-review-publication: [^\n]+ -->/gu);
  if (markers?.length !== 1 || markers[0] === undefined) {
    throw new Error(
      "review summary must contain exactly one publication marker"
    );
  }
  return markers[0];
};

const run = (arguments_: string[]): void => {
  const targetPath = requiredOption(arguments_, "--review-target");
  const summaryPath = requiredOption(arguments_, "--summary");
  const commentUrl = requiredOption(arguments_, "--comment-url");
  const summary = readFileSync(summaryPath, "utf-8");
  const result = validateReviewPublication({
    commentUrl,
    publicationMarker: extractPublicationMarker(summary),
    reviewTarget: readFileSync(targetPath, "utf-8"),
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
};

if (import.meta.main) {
  try {
    run(process.argv.slice(2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
