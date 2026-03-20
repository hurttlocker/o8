#!/usr/bin/env bash
set -euo pipefail

base_url="${BASE_URL:-http://127.0.0.1:3001}"
bootstrap_settle_seconds="${BOOTSTRAP_SETTLE_SECONDS:-5}"

measure() {
  local phase="$1"
  local label="$2"
  local path="$3"
  local headers
  local body
  local timings
  headers="$(mktemp)"
  body="$(mktemp)"

  timings="$(curl -sS -D "$headers" -o "$body" -w '%{time_starttransfer} %{time_total} %{http_code}' "$base_url$path")"
  read -r ttfb total code <<< "$timings"

  local server_timing source state refreshed_at
  server_timing="$(awk 'BEGIN{IGNORECASE=1} /^server-timing:/ {sub(/^[^:]*:[[:space:]]*/, ""); gsub(/\r$/, ""); value=$0} END {print value}' "$headers")"
  source="$(awk 'BEGIN{IGNORECASE=1} /^x-cortex-bootstrap-source:/ {sub(/^[^:]*:[[:space:]]*/, ""); gsub(/\r$/, ""); value=$0} END {print value}' "$headers")"
  state="$(awk 'BEGIN{IGNORECASE=1} /^x-cortex-bootstrap-state:/ {sub(/^[^:]*:[[:space:]]*/, ""); gsub(/\r$/, ""); value=$0} END {print value}' "$headers")"
  refreshed_at="$(awk 'BEGIN{IGNORECASE=1} /^x-cortex-bootstrap-refreshed-at:/ {sub(/^[^:]*:[[:space:]]*/, ""); gsub(/\r$/, ""); value=$0} END {print value}' "$headers")"
  if [[ -z "${source:-}" ]]; then
    source="$(perl -ne 'if (/data-cortex-bootstrap-marker=\"page\"/ && /data-cortex-bootstrap-source=\"([^\"]+)\"/) { print $1; exit 0 }' "$body" || true)"
  fi
  if [[ -z "${state:-}" ]]; then
    state="$(perl -ne 'if (/data-cortex-bootstrap-marker=\"page\"/ && /data-cortex-bootstrap-state=\"([^\"]+)\"/) { print $1; exit 0 }' "$body" || true)"
  fi
  if [[ -z "${refreshed_at:-}" ]]; then
    refreshed_at="$(perl -ne 'if (/data-cortex-bootstrap-marker=\"page\"/ && /data-cortex-bootstrap-refreshed-at=\"([^\"]*)\"/) { print $1; exit 0 }' "$body" || true)"
  fi

  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$phase" "$label" "$ttfb" "$total" "$code" "${source:-}" "${state:-}" "${refreshed_at:-}" "${server_timing:-}"
  rm -f "$headers"
  rm -f "$body"
}

echo -e 'phase\tlabel\tttfb\ttotal\tcode\tsource\tstate\trefreshed_at\tserver_timing'

measure cold '/' '/'
measure warm '/' '/'
measure cold '/mobile' '/mobile'
measure warm '/mobile' '/mobile'
measure cold '/api/command-center/bootstrap?fresh=1' '/api/command-center/bootstrap?fresh=1'
sleep "$bootstrap_settle_seconds"
measure warm '/api/command-center/bootstrap' '/api/command-center/bootstrap'
measure cold '/api/mobile/bootstrap?fresh=1' '/api/mobile/bootstrap?fresh=1'
sleep "$bootstrap_settle_seconds"
measure warm '/api/mobile/bootstrap' '/api/mobile/bootstrap'
