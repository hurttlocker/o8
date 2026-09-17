#!/usr/bin/env bash
# Keeps one open issue for the weekly resource-owning integration lane (#2391).
#   weekly-integration-issue.sh open "<reason>"   open the issue, or comment on the open one
#   weekly-integration-issue.sh close "<reason>"  close the open issue, if any
# Needs GH_TOKEN with issues: write. Dedupes on a fixed body marker.
set -euo pipefail

action="${1:?open|close}"
reason="${2:?reason}"
marker='<!-- o8-weekly-integration-lane -->'
title='Weekly integration lane did not pass'
run_url="${GITHUB_SERVER_URL:-https://github.com}/${GITHUB_REPOSITORY:?}/actions/runs/${GITHUB_RUN_ID:?}"

existing="$(gh issue list --repo "$GITHUB_REPOSITORY" --state open --search "\"$title\" in:title" \
  --limit 20 --json number,body --jq "[.[] | select(.body | contains(\"$marker\"))][0].number // empty")"

if [ "$action" = open ]; then
  if [ -n "$existing" ]; then
    gh issue comment "$existing" --repo "$GITHUB_REPOSITORY" --body "$reason

Run: $run_url"
    echo "[weekly-integration] commented on #$existing"
  else
    gh issue create --repo "$GITHUB_REPOSITORY" --title "$title" --body "$marker
The weekly whole-suite run of the resource-owning integration tests did not pass.

$reason

Run: $run_url

This issue is maintained by the CI workflow. It is closed automatically after a weekly run passes."
    echo "[weekly-integration] opened issue"
  fi
elif [ "$action" = close ]; then
  if [ -n "$existing" ]; then
    gh issue close "$existing" --repo "$GITHUB_REPOSITORY" --comment "$reason

Run: $run_url"
    echo "[weekly-integration] closed #$existing"
  fi
else
  echo "usage: weekly-integration-issue.sh open|close <reason>" >&2
  exit 2
fi
