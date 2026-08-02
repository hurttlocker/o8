# o8 Benchmark Scorecard

Version: 0.1.652
Git SHA: 057d6aebe
Timestamp: 2026-08-02T07:34:00.145Z
Node: v22.22.2
Prior: scorecard-0.1.652-ba0df2b0c.json
Governance scope: This benchmark measures the AI review tier. It does not measure the human approval gate above it.

## Speed
| Metric | Value | N | Prior | Direction | Delta |
| --- | ---: | ---: | ---: | --- | --- |
| dashboard_cold_ttfb_ms | 12 | - | 12 | lower-better | unchanged |
| dashboard_warm_ttfb_ms | 9 | - | 9 | lower-better | unchanged |
| bootstrap_warm_total_ms | 3 | - | 3 | lower-better | unchanged |
| cli_status_median_ms | 233 | - | 233 | lower-better | unchanged |
| mcp_client_minus_server_p50_ms | null | - | null | lower-better | baseline |
| socket_avg_conns | 5.58 | - | 5.58 | informational | informational |

## Memory
| Metric | Value | N | Prior | Direction | Delta |
| --- | ---: | ---: | ---: | --- | --- |
| overall_full_accuracy | 0.313 | - | null | higher-better | baseline |
| delta_full_vs_strongGrep | 0.232 | - | null | higher-better | baseline |
| ownership_full_accuracy | 0.51 | - | null | higher-better | baseline |
| decisions_full_accuracy | 0.47 | - | null | higher-better | baseline |
| processes_full_accuracy | 0.74 | - | null | higher-better | baseline |
| incidents_full_accuracy | 0.2 | - | null | higher-better | baseline |
| specs_full_accuracy | 0.07 | - | null | higher-better | baseline |
| cross-repo_full_accuracy | 0.39 | - | null | higher-better | baseline |
| literal-lookup_full_accuracy | 0 | - | null | higher-better | baseline |

## Governance
| Metric | Value | N | Prior | Direction | Delta |
| --- | ---: | ---: | ---: | --- | --- |
| catch_rate | 1 | 3/3 | null | higher-better | baseline |
| false_positive_rate | 1 | 2/2 | null | lower-better | baseline |

## Coding
_manual — not run this release_

> **MEMORY TRACK INVALID** — stale ground truth (#1681); values nulled, not a regression baseline.
>
> **GOVERNANCE — read counts, not rates.** N=3 planted / 2 clean. The gate blocked zero clean diffs: one clean control was correctly approved with a non-blocking nit (counted as a false positive by the strict rule), the other returned inconclusive. "100% false-positive rate" without this detail would misinform.
