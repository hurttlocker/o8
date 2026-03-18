#!/bin/bash
# imgcat — display images inline in the Cortex IDE terminal
# Uses the iTerm2 Inline Image Protocol (IIP)
# Usage: imgcat <file> [width] [height]
#   imgcat screenshot.png
#   imgcat diagram.svg 800 600

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

# iTerm2 Inline Image Protocol escape sequence
# ESC ] 1337 ; File=[args] : base64data ST
printf '\033]1337;File=name=%s;size=%s;inline=1;width=%s;height=%s:%s\a' \
  "$(echo -n "$FILENAME" | base64)" \
  "$FILESIZE" \
  "$WIDTH" \
  "$HEIGHT" \
  "$B64"

echo "" # newline after image
