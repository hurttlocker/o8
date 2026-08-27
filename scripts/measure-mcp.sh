#!/usr/bin/env bash
set -euo pipefail

port=$(cat "$HOME/.o8/api-port" 2>/dev/null || echo 3001)
base_url="${BASE_URL:-http://127.0.0.1:$port}"
# The liveness route intentionally does not expose Server-Timing. Use the
# authenticated repository snapshot, whose `total` timing lets this harness
# separate server work from client/transport overhead.
route="${ROUTE:-/api/panel/repos}"
n="${N:-20}"
token="$(cat "$HOME/.o8/ws-token" 2>/dev/null || true)"

percentiles() {
  local samples_path="$1"

  awk '
    {
      values[++count] = $1;
    }
    END {
      if (count == 0) {
        print "na\tna";
        exit 0;
      }
      for (i = 1; i <= count; i++) {
        for (j = i + 1; j <= count; j++) {
          if (values[j] < values[i]) {
            tmp = values[i];
            values[i] = values[j];
            values[j] = tmp;
          }
        }
      }
      printf "%.0f\t%.0f\n", nearest_rank(0.50), nearest_rank(0.95);
    }
    function nearest_rank(p, idx) {
      idx = int(count * p);
      if (idx < count * p) idx++;
      if (idx < 1) idx = 1;
      if (idx > count) idx = count;
      return values[idx];
    }
  ' "$samples_path"
}

server_timing_ms() {
  local headers_path="$1"

  awk '
    tolower($0) ~ /^server-timing:/ {
      sub(/^[^:]*:[[:space:]]*/, "");
      gsub(/\r$/, "");
      value = $0;
    }
    END {
      if (match(value, /dur=[0-9.]+/)) {
        print substr(value, RSTART + 4, RLENGTH - 4);
      }
    }
  ' "$headers_path"
}

client_samples="$(mktemp)"
overhead_samples="$(mktemp)"
headers_path="$(mktemp)"
body_path="$(mktemp)"

for ((run = 1; run <= n; run++)); do
  total_seconds="$(curl -sS -D "$headers_path" -o "$body_path" -w '%{time_total}' -H "Authorization: Bearer $token" "$base_url$route")"
  total_ms="$(awk -v seconds="$total_seconds" 'BEGIN { printf "%.0f", seconds * 1000 }')"
  printf '%s\n' "$total_ms" >> "$client_samples"

  server_ms="$(server_timing_ms "$headers_path")"
  if [[ -n "${server_ms:-}" ]]; then
    awk -v client="$total_ms" -v server="$server_ms" 'BEGIN {
      overhead = client - server;
      if (overhead < 0) overhead = 0;
      printf "%.0f\n", overhead;
    }' >> "$overhead_samples"
  fi
done

IFS=$'\t' read -r client_p50 client_p95 <<< "$(percentiles "$client_samples")"
IFS=$'\t' read -r overhead_p50 overhead_p95 <<< "$(percentiles "$overhead_samples")"

printf 'route\t%s\n' "$route"
printf 'samples\t%s\n' "$n"
printf 'metric\tp50_ms\tp95_ms\n'
printf 'client_total\t%s\t%s\n' "$client_p50" "$client_p95"
printf 'client_minus_server\t%s\t%s\n' "$overhead_p50" "$overhead_p95"

rm -f "$client_samples" "$overhead_samples" "$headers_path" "$body_path"
