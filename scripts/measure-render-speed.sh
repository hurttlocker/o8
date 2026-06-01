#!/usr/bin/env bash
set -euo pipefail

port=$(cat "$HOME/.o8/api-port" 2>/dev/null || echo 3001)
base_url="${BASE_URL:-http://127.0.0.1:$port}"
bootstrap_settle_seconds="${BOOTSTRAP_SETTLE_SECONDS:-5}"

extract_bootstrap_attr() {
  local body_path="$1"
  local attr="$2"

  awk -v attr="$attr" '
    /data-cortex-bootstrap-marker="page"/ {
      pattern = "data-cortex-bootstrap-" attr "=\"[^\"]*\"";
      if (match($0, pattern)) {
        value = substr($0, RSTART, RLENGTH);
        sub("^data-cortex-bootstrap-" attr "=\"", "", value);
        sub("\"$", "", value);
        print value;
        exit 0;
      }
    }
  ' "$body_path"
}

measure() {
  local phase="$1"
  local label="$2"
  local path="$3"
  local headers
  local body
  local timings
  headers="$(mktemp)"
  body="$(mktemp)"

  timings="$(curl -sS -L -D "$headers" -o "$body" -w '%{time_starttransfer} %{time_total} %{http_code} %{num_redirects} %{url_effective}' "$base_url$path")"
  read -r ttfb total code redirects final_url <<< "$timings"

  local server_timing source state refreshed_at
  server_timing="$(awk 'tolower($0) ~ /^server-timing:/ {sub(/^[^:]*:[[:space:]]*/, ""); gsub(/\r$/, ""); value=$0} END {print value}' "$headers")"
  source="$(awk 'tolower($0) ~ /^x-cortex-bootstrap-source:/ {sub(/^[^:]*:[[:space:]]*/, ""); gsub(/\r$/, ""); value=$0} END {print value}' "$headers")"
  state="$(awk 'tolower($0) ~ /^x-cortex-bootstrap-state:/ {sub(/^[^:]*:[[:space:]]*/, ""); gsub(/\r$/, ""); value=$0} END {print value}' "$headers")"
  refreshed_at="$(awk 'tolower($0) ~ /^x-cortex-bootstrap-refreshed-at:/ {sub(/^[^:]*:[[:space:]]*/, ""); gsub(/\r$/, ""); value=$0} END {print value}' "$headers")"
  if [[ -z "${source:-}" ]]; then
    source="$(extract_bootstrap_attr "$body" source || true)"
  fi
  if [[ -z "${state:-}" ]]; then
    state="$(extract_bootstrap_attr "$body" state || true)"
  fi
  if [[ -z "${refreshed_at:-}" ]]; then
    refreshed_at="$(extract_bootstrap_attr "$body" refreshed-at || true)"
  fi

  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$phase" "$label" "$ttfb" "$total" "$code" "$redirects" "$final_url" "${source:-}" "${state:-}" "${refreshed_at:-}" "${server_timing:-}"
  rm -f "$headers"
  rm -f "$body"
}

printf 'phase\tlabel\tttfb\ttotal\tcode\tredirects\tfinal_url\tsource\tstate\trefreshed_at\tserver_timing\n'

measure cold '/' '/'
measure warm '/' '/'
measure cold '/dashboard' '/dashboard'
measure warm '/dashboard' '/dashboard'
measure cold '/mobile' '/mobile'
measure warm '/mobile' '/mobile'
# /api/command-center/bootstrap returns 404 on the current build; keep it out of the benchmark rows.
measure cold '/api/mobile/bootstrap?fresh=1' '/api/mobile/bootstrap?fresh=1'
sleep "$bootstrap_settle_seconds"
measure warm '/api/mobile/bootstrap' '/api/mobile/bootstrap'
