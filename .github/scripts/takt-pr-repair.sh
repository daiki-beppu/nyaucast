#!/usr/bin/env bash

set -euo pipefail

pr_number="${1:-}"
if ! [[ "$pr_number" =~ ^[1-9][0-9]*$ ]]; then
  echo "invalid PR number" >&2
  exit 1
fi

tasks_file=".takt/tasks.yaml"

mcp_result_contains() {
  local response="$1"
  local expected="$2"
  printf '%s' "$response" | jq -e -s --arg expected "$expected" '
    any(.[];
      .id == 2
      and (.error == null)
      and (.result.isError != true)
      and (([.result.content[]?.text?] | join("\n")) | contains($expected))
    )
  ' >/dev/null
}

tasks_before=""
if [ -f "$tasks_file" ]; then
  tasks_before="$(sha256sum "$tasks_file" | cut -d' ' -f1)"
fi

bunx --bun takt@0.52.0 --workflow pr-repair add --pr "$pr_number"

tasks_after=""
if [ -f "$tasks_file" ]; then
  tasks_after="$(sha256sum "$tasks_file" | cut -d' ' -f1)"
fi

if [ "$tasks_before" = "$tasks_after" ]; then
  pr_context="$(gh pr view "$pr_number" --json headRefName,baseRefName)"
  head_branch="$(jq -r '.headRefName // empty' <<< "$pr_context")"
  base_branch="$(jq -r '.baseRefName // empty' <<< "$pr_context")"
  if [ -z "$head_branch" ] || [ -z "$base_branch" ]; then
    echo "PR #$pr_number has no usable branch context for CI-only repair" >&2
    exit 1
  fi

  ci_evidence="$(gh pr checks "$pr_number" --json name,state,conclusion,link)"
  if [ -z "$ci_evidence" ] || [ "$ci_evidence" = "[]" ]; then
    echo "PR #$pr_number has no CI evidence for repair" >&2
    exit 1
  fi

  repair_task="Repair PR #$pr_number CI failure. Inspect the current PR and failed CI checks, reproduce the failure, and make the smallest root-cause repair. CI failed without review comments. Exact CI evidence: $ci_evidence"
  enqueue_request="$(jq -cn \
    --arg cwd "$PWD" \
    --arg task "$repair_task" \
    --arg workflow "pr-repair" \
    --arg branch "$head_branch" \
    --arg base_branch "$base_branch" \
    --argjson pr_number "$pr_number" \
    '{jsonrpc:"2.0",id:2,method:"tools/call",params:{name:"takt_enqueue_task",arguments:{cwd:$cwd,task:$task,workflow:$workflow,worktree:true,autoPr:true,taskContext:{branch:$branch,baseBranch:$base_branch,prNumber:$pr_number}}}}')"
  enqueue_response="$(printf '%s\n%s\n' \
    '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"tayk-ci","version":"1"}}}' \
    '{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}' \
    "$enqueue_request" \
    | bunx --bun --package takt@0.52.0 takt-mcp)"
  if ! mcp_result_contains "$enqueue_response" '"taskName":'; then
    echo "TAKT MCP did not create a repair task for PR #$pr_number" >&2
    exit 1
  fi

  tasks_after=""
  if [ -f "$tasks_file" ]; then
    tasks_after="$(sha256sum "$tasks_file" | cut -d' ' -f1)"
  fi
  if [ "$tasks_before" = "$tasks_after" ]; then
    echo "TAKT did not persist a repair task for PR #$pr_number" >&2
    exit 1
  fi
fi

run_request='{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"takt_run_next_task","arguments":{"cwd":"'"$PWD"'","provider":"codex"}}}'
run_response="$(printf '%s\n%s\n%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"tayk-ci","version":"1"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}' \
  "$run_request" \
  | bunx --bun --package takt@0.52.0 takt-mcp)"
if ! mcp_result_contains "$run_response" '"ran":true'; then
  echo "TAKT MCP did not run the repair task for PR #$pr_number" >&2
  exit 1
fi
