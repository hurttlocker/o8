# o8 Benchmark Scorecard

Version: 0.1.252
Git SHA: ad123f1a
Timestamp: 2026-06-02T04:34:39.364Z
Node: v22.22.2
Prior: scorecard-0.1.251-e5d24652.json

## Speed
| Metric | Value | Prior | Direction | Delta |
| --- | ---: | ---: | --- | --- |
| dashboard_cold_ttfb_ms | 35 | 44 | lower-better | unchanged |
| dashboard_warm_ttfb_ms | 25 | 20 | lower-better | unchanged |
| bootstrap_warm_total_ms | 9 | 344 | lower-better | improved |
| cli_status_median_ms | 629 | 1006 | lower-better | improved |
| mcp_client_minus_server_p50_ms | null | null | lower-better | baseline |
| socket_avg_conns | 3.07 | 20.63 | informational | informational |

## Memory
| Metric | Value | Prior | Direction | Delta |
| --- | ---: | ---: | --- | --- |
| overall_full_accuracy | 0.686 | null | higher-better | baseline |
| delta_full_vs_strongGrep | 0.291 | null | higher-better | baseline |
| ownership_full_accuracy | 0.536 | null | higher-better | baseline |
| decisions_full_accuracy | 0.72 | null | higher-better | baseline |
| processes_full_accuracy | 0.8 | null | higher-better | baseline |
| incidents_full_accuracy | 0.384 | null | higher-better | baseline |
| specs_full_accuracy | 0.774 | null | higher-better | baseline |
| cross-repo_full_accuracy | 0.4 | null | higher-better | baseline |
| literal-lookup_full_accuracy | 1 | null | higher-better | baseline |

## Governance
_manual — not run this release_

## Coding
_manual — not run this release_
