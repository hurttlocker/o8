# o8 Benchmark Scorecard

Version: 0.1.652
Git SHA: 7a1931a46
Timestamp: 2026-08-02T21:29:58.528Z
Node: v22.22.2
Prior: scorecard-0.1.652-057d6aebe.json
Governance scope: This benchmark measures the AI review tier. It does not measure the human approval gate above it.

## Speed
| Metric | Value | N | Prior | Direction | Delta |
| --- | ---: | ---: | ---: | --- | --- |
| dashboard_cold_ttfb_ms | 16 | - | 12 | lower-better | unchanged |
| dashboard_warm_ttfb_ms | 11 | - | 9 | lower-better | unchanged |
| bootstrap_warm_total_ms | 22 | - | 3 | lower-better | unchanged |
| cli_status_median_ms | 353 | - | 233 | lower-better | regressed |
| mcp_client_minus_server_p50_ms | null | - | null | lower-better | baseline |
| socket_avg_conns | 5.87 | - | 5.58 | informational | informational |

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
| catch_rate | 1 | 10/10 | 1 | higher-better | unchanged |
| clean_diffs_blocked | 0 | 0/10 | null | lower-better | baseline |
| clean_diffs_with_any_finding | 0.2 | 2/10 | 1 | lower-better | improved |

## Coding
| Metric | Value | N | Prior | Direction | Delta |
| --- | ---: | ---: | ---: | --- | --- |
| decisive_contract_wins | 0 | 0/0 | null | higher-better | baseline |
| contract_excellent_outputs | 0 | 0/0 | null | higher-better | baseline |
