#!/bin/bash
# imgcat — display images inline in the Cortex IDE terminal
# Uses the iTerm2 Inline Image Protocol (IIP)
# Wraps in tmux passthrough when running inside tmux
# Usage: imgcat <file> [width] [height]

if [ -z "$1" ]; then
  echo "Usage: imgcat <file> [width] [height]"
  exit 1
fi

FILE="$1"
WIDTH="${2:-auto}"
HEIGHT="${3:-auto}"

if [ ! -f "$FILE" ]; then
  echo "File not found: $FILE"
  exit 1
fi

# Base64 encode the file
B64=$(base64 < "$FILE")
FILESIZE=$(wc -c < "$FILE" | tr -d ' ')
FILENAME=$(basename "$FILE")

# Build the IIP escape sequence
IIP=$(printf '\033]1337;File=name=%s;size=%s;inline=1;width=%s;height=%s:%s\a' \
  "$(echo -n "$FILENAME" | base64)" \
  "$FILESIZE" \
  "$WIDTH" \
  "$HEIGHT" \
  "$B64")

if [ -n "$TMUX" ]; then
  # Inside tmux — wrap in DCS passthrough sequence
  # tmux requires: set-option allow-passthrough on
  printf '\033Ptmux;'
  printf '%s' "$IIP" | sed 's/\033/\033\033/g'
  printf '\033\\'
else
  printf '%s' "$IIP"
fi

echo "" # newline after image
