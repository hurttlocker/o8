#!/usr/bin/env bash
set -euo pipefail

n="${N:-20}"
cli_path="$HOME/cortex-ide/cli/dist/o8.mjs"
commands=("--help" "status" "doctor")

is_expected_exit() {
  case "$1" in
    0|2|3|4|5) return 0 ;;
    *) return 1 ;;
  esac
}

percentiles() {
  local samples_path="$1"

  awk '
    {
      values[++count] = $1;
    }
    END {
      if (count == 0) {
        print "na\tna\tna";
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
      printf "%.0f\t%.0f\t%.0f\n", values[1], nearest_rank(0.50), nearest_rank(0.95);
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

run_once() {
  local cmd="$1"
  local time_path="$2"
  local stderr_path="$3"
  local exit_code

  TIMEFORMAT='%3R'
  set +e
  { time node "$cli_path" "$cmd" >/dev/null 2>"$stderr_path"; } 2>"$time_path"
  exit_code=$?
  set -e

  return "$exit_code"
}

measure_command() {
  local cmd="$1"
  local samples_path
  local time_path
  local stderr_path
  local exit_code
  local elapsed_seconds
  local elapsed_ms
  local min_ms
  local median_ms
  local p95_ms

  samples_path="$(mktemp)"
  time_path="$(mktemp)"
  stderr_path="$(mktemp)"

  for ((run = 1; run <= n; run++)); do
    if run_once "$cmd" "$time_path" "$stderr_path"; then
      exit_code=0
    else
      exit_code=$?
    fi

    if ! is_expected_exit "$exit_code"; then
      printf '%s\tskipped\texit=%s\n' "$cmd" "$exit_code"
      rm -f "$samples_path" "$time_path" "$stderr_path"
      return 0
    fi

    if (( run == 1 )); then
      continue
    fi

    elapsed_seconds="$(awk 'NF { value = $1 } END { print value }' "$time_path")"
    elapsed_ms="$(awk -v seconds="$elapsed_seconds" 'BEGIN { printf "%.0f", seconds * 1000 }')"
    printf '%s\n' "$elapsed_ms" >> "$samples_path"
  done

  IFS=$'\t' read -r min_ms median_ms p95_ms <<< "$(percentiles "$samples_path")"
  printf '%s\t%s\t%s\t%s\t%s\n' "$cmd" "$((n - 1))" "$min_ms" "$median_ms" "$p95_ms"
  rm -f "$samples_path" "$time_path" "$stderr_path"
}

printf 'cmd\tsamples\tmin_ms\tmedian_ms\tp95_ms\n'
for cmd in "${commands[@]}"; do
  measure_command "$cmd"
done
