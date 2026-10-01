#!/bin/sh
set -eu

if ! git rev-parse --show-toplevel >/dev/null 2>&1; then
  printf 'Verification receipt: selected folder is not a Git repository.\n' >&2
  exit 2
fi

printf 'Verification receipt\n'
printf 'Observed at: '; date -u '+%Y-%m-%dT%H:%M:%SZ'
printf 'Commit: '; git rev-parse HEAD
printf 'Tracked changes: '; git diff --name-only HEAD -- . | wc -l | tr -d ' '
printf 'Untracked files: '; git ls-files --others --exclude-standard | wc -l | tr -d ' '
