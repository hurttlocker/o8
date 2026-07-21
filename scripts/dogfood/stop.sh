#!/bin/bash
set -euo pipefail
SOURCE=${BASH_SOURCE[0]}
while [ -h "$SOURCE" ]; do
  SOURCE_DIR=$(CDPATH='' cd -- "$(dirname -- "$SOURCE")" && pwd -P)
  SOURCE=$(readlink "$SOURCE")
  case "$SOURCE" in /*) ;; *) SOURCE="$SOURCE_DIR/$SOURCE" ;; esac
done
SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$SOURCE")" && pwd -P)
exec "$SCRIPT_DIR/loop.sh" --stop
