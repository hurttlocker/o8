# o8 Benchmark Scorecard

Version: 0.1.652
Git SHA: ba0df2b0c
Timestamp: 2026-08-02T05:56:25.601Z
Node: v22.22.2
Prior: scorecard-0.1.252-ad123f1a.json

## Speed
| Metric | Value | Prior | Direction | Delta |
| --- | ---: | ---: | --- | --- |
| dashboard_cold_ttfb_ms | 12 | 35 | lower-better | unchanged |
| dashboard_warm_ttfb_ms | 9 | 25 | lower-better | unchanged |
| bootstrap_warm_total_ms | 3 | 9 | lower-better | unchanged |
| cli_status_median_ms | 233 | 629 | lower-better | improved |
| mcp_client_minus_server_p50_ms | null | null | lower-better | baseline |
| socket_avg_conns | 5.58 | 3.07 | informational | informational |

## Memory
| Metric | Value | Prior | Direction | Delta |
| --- | ---: | ---: | --- | --- |
| overall_full_accuracy | 0.12 | 0.686 | higher-better | regressed |
| delta_full_vs_strongGrep | 0.013 | 0.291 | higher-better | regressed |
| ownership_full_accuracy | 0.18 | 0.536 | higher-better | regressed |
| decisions_full_accuracy | 0 | 0.72 | higher-better | regressed |
| processes_full_accuracy | 0.4 | 0.8 | higher-better | regressed |
| incidents_full_accuracy | 0.1 | 0.384 | higher-better | regressed |
| specs_full_accuracy | 0.03 | 0.774 | higher-better | regressed |
| cross-repo_full_accuracy | 0.2 | 0.4 | higher-better | regressed |
| literal-lookup_full_accuracy | 0 | 1 | higher-better | regressed |

## Governance
_manual — not run this release_

## Coding
_manual — not run this release_
