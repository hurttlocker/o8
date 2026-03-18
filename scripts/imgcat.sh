#!/bin/bash
# imgcat — display images inline in the Cortex IDE terminal
# Sends image request to WS server which delivers IIP directly to xterm.js
# Completely bypasses tmux (which strips image escape sequences)
# Usage: imgcat <file>

if [ -z "$1" ]; then
  echo "Usage: imgcat <file>"
  exit 1
fi

FILE="$1"

# Resolve to absolute path
if [[ "$FILE" == ~* ]]; then
  FILE="${FILE/#\~/$HOME}"
fi
if [[ "$FILE" != /* ]]; then
  FILE="$(cd "$(dirname "$FILE")" 2>/dev/null && pwd)/$(basename "$FILE")"
fi

if [ ! -f "$FILE" ]; then
  echo "File not found: $FILE"
  exit 1
fi

# Get the tmux session name (for routing the image to the right terminal tab)
SESSION=""
if [ -n "$TMUX" ]; then
  SESSION=$(tmux display-message -p '#{session_name}' 2>/dev/null)
fi

if [ -z "$SESSION" ]; then
  echo "Error: must run inside a Cortex IDE terminal (tmux session required)"
  exit 1
fi

# Call the server API to render the image
RESPONSE=$(curl -s -X POST http://localhost:3000/api/panel/terminal-image \
  -H "Content-Type: application/json" \
  -d "{\"filePath\": \"$FILE\", \"sessionName\": \"$SESSION\"}")

ERROR=$(echo "$RESPONSE" | python3 -c "import sys,json; d=json.load(sys.stdin); e=d.get('error',''); print(e) if e else None" 2>/dev/null)
if [ -n "$ERROR" ] && [ "$ERROR" != "None" ]; then
  echo "Error: $ERROR"
  exit 1
fi

echo "📷 Rendering image..."
