#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo "usage: check-release-ancestor.sh <candidate> <reference>" >&2
  exit 2
fi

candidate=$1
reference=$2

if ! candidate_commit=$(git rev-parse --verify "${candidate}^{commit}" 2>/dev/null); then
  echo "release candidate is not a commit: $candidate" >&2
  exit 1
fi

if ! reference_commit=$(git rev-parse --verify "${reference}^{commit}" 2>/dev/null); then
  echo "release reference is not a commit: $reference" >&2
  exit 1
fi

if git merge-base --is-ancestor "$candidate_commit" "$reference_commit"; then
  exit 0
fi

echo "release candidate $candidate is not an ancestor of $reference" >&2
exit 1
