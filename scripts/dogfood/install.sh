#!/bin/bash
# Install stable home-directory entrypoints while keeping the repo copies as the
# source of truth. Existing owner artifacts are moved to a timestamped backup.
set -euo pipefail

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)
INSTALL_HOME="${O8_DOGFOOD_INSTALL_HOME:-$HOME}"
STATE_DIR="${O8_DOGFOOD_STATE_DIR:-$INSTALL_HOME/.o8}"
STAMP=$(date +%Y%m%d-%H%M%S)
BACKUP_DIR="$STATE_DIR/dogfood-artifact-backups/$STAMP"

install_link() {
  local source="$1"
  local target="$2"
  if [ -L "$target" ] && [ "$(readlink "$target")" = "$source" ]; then
    return 0
  fi
  if [ -e "$target" ] || [ -L "$target" ]; then
    mkdir -p "$BACKUP_DIR"
    mv "$target" "$BACKUP_DIR/$(basename "$target")"
  fi
  ln -s "$source" "$target"
}

mkdir -p "$INSTALL_HOME" "$STATE_DIR"
install_link "$SCRIPT_DIR/loop.sh" "$INSTALL_HOME/o8-dogfood-loop.sh"
install_link "$SCRIPT_DIR/gate.sh" "$INSTALL_HOME/o8-dogfood-gate.sh"
install_link "$SCRIPT_DIR/stop.sh" "$INSTALL_HOME/o8-dogfood-stop.sh"
install_link "$SCRIPT_DIR/queue-sync.sh" "$INSTALL_HOME/o8-dogfood-queue-sync.sh"
install_link "$SCRIPT_DIR/prompt.md" "$INSTALL_HOME/o8-dogfood-loop-prompt.md"

echo "Installed guarded dogfood entrypoints from $SCRIPT_DIR"
[ -d "$BACKUP_DIR" ] && echo "Previous artifacts are recoverable at $BACKUP_DIR"
