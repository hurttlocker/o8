#!/usr/bin/env bash
set -euo pipefail

port=$(cat "$HOME/.o8/api-port" 2>/dev/null || echo 3001)
duration_seconds="${1:-30}"
samples="$(awk -v duration="$duration_seconds" 'BEGIN {
  if (duration <= 0) duration = 30;
  printf "%d", int((duration * 2) + 0.999999);
}')"
sum=0
max=0

count_established() {
  local count

  count="$(lsof -nP -iTCP@127.0.0.1 -sTCP:ESTABLISHED 2>/dev/null | grep ":$port" | wc -l | awk '{print $1}' || true)"
  printf '%s' "${count:-0}"
}

# WKWebView has an effective per-origin socket budget around ~6 connections; watch for starvation near that ceiling.
printf 'sample\telapsed_s\testablished_conn_count\tport\n'
for ((sample = 1; sample <= samples; sample++)); do
  elapsed="$(awk -v sample="$sample" 'BEGIN { printf "%.1f", (sample - 1) * 0.5 }')"
  count="$(count_established)"
  sum=$((sum + count))
  if (( count > max )); then
    max="$count"
  fi
  printf '%s\t%s\t%s\t%s\n' "$sample" "$elapsed" "$count" "$port"
  if (( sample < samples )); then
    sleep 0.5
  fi
done

avg="$(awk -v sum="$sum" -v samples="$samples" 'BEGIN {
  if (samples == 0) print "0.00";
  else printf "%.2f", sum / samples;
}')"
printf 'max\t%s\n' "$max"
printf 'avg\t%s\n' "$avg"
