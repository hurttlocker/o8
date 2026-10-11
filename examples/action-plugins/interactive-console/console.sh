#!/bin/sh
set -eu
printf 'Interactive plugin console. Type a line, or quit to exit.\n'
while IFS= read -r line; do
  if [ "$line" = quit ]; then exit 0; fi
  printf 'You typed: %s\n' "$line"
done
