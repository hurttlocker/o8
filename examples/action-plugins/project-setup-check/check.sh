#!/bin/sh
set -eu

if ! git rev-parse --show-toplevel >/dev/null 2>&1; then
  printf 'Project setup check: selected folder is not a Git repository.\n' >&2
  exit 2
fi

printf 'Project setup check\n'
printf 'Git: '; git --version
if command -v node >/dev/null 2>&1; then
  printf 'Node: '; node --version
else
  printf 'Node: unavailable\n'
fi
if command -v npm >/dev/null 2>&1; then
  printf 'npm: '; npm --version
else
  printf 'npm: unavailable\n'
fi
if [ -f AGENTS.md ]; then printf 'Repository instructions: present\n'; else printf 'Repository instructions: absent\n'; fi
if [ -f package.json ]; then printf 'Node package: present\n'; else printf 'Node package: absent\n'; fi
